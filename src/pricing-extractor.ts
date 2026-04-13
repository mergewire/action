/**
 * Pricing Extractor
 *
 * Extracts pricing-relevant resources from Terraform plan JSON.
 *
 * CRITICAL: This module must NEVER include:
 * - before/after value objects
 * - variable values
 * - provider attribute payloads
 * - full plan JSON
 *
 * Only pricing-safe metadata is extracted.
 */

import type {
  BlockStoragePricingDimensions,
  CachePricingDimensions,
  ManagedDbPricingDimensions,
  PricingFamily,
  PricingResource,
  VMComputePricingDimensions,
} from './core/pricing-types.js'
import type { ResourceAction } from './core/types.js'
import { normalizeActions } from './core/helpers.js'

const SUPPORTED_RESOURCE_TYPES = new Set([
  'aws_instance',
  'aws_db_instance',
  'aws_elasticache_replication_group',
  'aws_elasticache_cluster',
  'aws_ebs_volume',
  'google_compute_instance',
  'google_sql_database_instance',
  'google_redis_instance',
  'google_compute_disk',
  'azurerm_linux_virtual_machine',
  'azurerm_windows_virtual_machine',
  'azurerm_postgresql_flexible_server',
  'azurerm_mysql_flexible_server',
  'azurerm_redis_cache',
  'azurerm_managed_disk',
])

type FamilyDimensions =
  | VMComputePricingDimensions
  | ManagedDbPricingDimensions
  | CachePricingDimensions
  | BlockStoragePricingDimensions

interface ExtractedDimensions {
  provider: PricingResource['provider']
  pricingFamily: PricingFamily
  regionBefore?: string
  regionAfter?: string
  before?: FamilyDimensions
  after?: FamilyDimensions
}

/**
 * Extract pricing resources from a Terraform plan JSON object
 */
export function extractPricingResources(planJson: unknown): PricingResource[] {
  if (!planJson || typeof planJson !== 'object') {
    return []
  }

  const plan = planJson as Record<string, unknown>
  const resourceChanges = plan.resource_changes

  if (!Array.isArray(resourceChanges)) {
    return []
  }

  const pricingResources: PricingResource[] = []

  for (const change of resourceChanges) {
    if (!change || typeof change !== 'object') {
      continue
    }

    const resourceChange = change as Record<string, unknown>
    const changeData = resourceChange.change as Record<string, unknown> | undefined

    if (!changeData) {
      continue
    }

    const actions = changeData.actions as string[] | undefined
    if (!actions || !Array.isArray(actions) || actions.length === 0) {
      continue
    }

    const importing = changeData.importing as Record<string, unknown> | undefined
    const importingId = importing?.id as string | undefined

    if (actions.length === 1 && actions[0] === 'no-op' && !importingId) {
      continue
    }

    const type = resourceChange.type as string
    if (!SUPPORTED_RESOURCE_TYPES.has(type)) {
      continue
    }

    const address = resourceChange.address as string
    if (!address) {
      continue
    }

    const normalizedActions = normalizeActions(actions, importingId)
    const action = determineSingleAction(normalizedActions)

    const before = changeData.before as Record<string, unknown> | undefined | null
    const after = changeData.after as Record<string, unknown> | undefined | null
    const extracted = extractDimensions(type, before, after)

    const pricingResource = buildPricingResource(address, type, action, extracted)
    pricingResources.push(pricingResource)
  }

  return pricingResources
}

function determineSingleAction(normalizedActions: ResourceAction[]): ResourceAction {
  if (normalizedActions.includes('replace')) return 'replace'
  if (normalizedActions.includes('update')) return 'update'
  if (normalizedActions.includes('create')) return 'create'
  if (normalizedActions.includes('delete')) return 'delete'
  if (normalizedActions.includes('import')) return 'import'
  return normalizedActions[0] ?? 'no-op'
}

function buildPricingResource(
  address: string,
  type: string,
  action: ResourceAction,
  extracted: ExtractedDimensions
): PricingResource {
  const state = selectBeforeAfterState(
    action,
    extracted.regionBefore,
    extracted.regionAfter,
    extracted.before,
    extracted.after
  )

  const missing: string[] = []
  if (!state.region) missing.push('region')

  if (action === 'create' && !state.after) missing.push('after dimensions')
  if (action === 'delete' && !state.before) missing.push('before dimensions')
  if ((action === 'update' || action === 'replace') && (!state.before || !state.after)) {
    if (!state.before) missing.push('before dimensions')
    if (!state.after) missing.push('after dimensions')
  }
  if (action === 'import' && !state.after) missing.push('after dimensions')

  return {
    address,
    type,
    action,
    provider: extracted.provider,
    region: state.region ?? '',
    pricingFamily: extracted.pricingFamily,
    ...(state.before !== undefined ? { before: state.before } : {}),
    ...(state.after !== undefined ? { after: state.after } : {}),
    ...(missing.length > 0
      ? {
          unpricedReason: 'missing_dimensions' as const,
          unpricedDetails: `Missing ${missing.join(' and ')}`,
        }
      : {}),
  }
}

function extractDimensions(
  type: string,
  before: Record<string, unknown> | undefined | null,
  after: Record<string, unknown> | undefined | null
): ExtractedDimensions {
  switch (type) {
    case 'aws_instance':
      return {
        provider: 'aws',
        pricingFamily: 'vm_compute',
        regionBefore: extractAwsRegion(before),
        regionAfter: extractAwsRegion(after),
        before: extractAwsVmDimensions(before),
        after: extractAwsVmDimensions(after),
      }

    case 'google_compute_instance':
      return {
        provider: 'gcp',
        pricingFamily: 'vm_compute',
        regionBefore: extractGcpRegion(before),
        regionAfter: extractGcpRegion(after),
        before: extractGcpVmDimensions(before),
        after: extractGcpVmDimensions(after),
      }

    case 'azurerm_linux_virtual_machine':
      return {
        provider: 'azure',
        pricingFamily: 'vm_compute',
        regionBefore: extractString(before, 'location'),
        regionAfter: extractString(after, 'location'),
        before: extractAzureVmDimensions(before, 'linux'),
        after: extractAzureVmDimensions(after, 'linux'),
      }

    case 'azurerm_windows_virtual_machine':
      return {
        provider: 'azure',
        pricingFamily: 'vm_compute',
        regionBefore: extractString(before, 'location'),
        regionAfter: extractString(after, 'location'),
        before: extractAzureVmDimensions(before, 'windows'),
        after: extractAzureVmDimensions(after, 'windows'),
      }

    case 'aws_db_instance':
      return {
        provider: 'aws',
        pricingFamily: 'managed_db',
        regionBefore: extractAwsRegion(before),
        regionAfter: extractAwsRegion(after),
        before: extractAwsDbDimensions(before),
        after: extractAwsDbDimensions(after),
      }

    case 'google_sql_database_instance':
      return {
        provider: 'gcp',
        pricingFamily: 'managed_db',
        regionBefore: extractGcpSqlRegion(before),
        regionAfter: extractGcpSqlRegion(after),
        before: extractGcpSqlDimensions(before),
        after: extractGcpSqlDimensions(after),
      }

    case 'azurerm_postgresql_flexible_server':
      return {
        provider: 'azure',
        pricingFamily: 'managed_db',
        regionBefore: extractString(before, 'location'),
        regionAfter: extractString(after, 'location'),
        before: extractAzureFlexibleServerDimensions(before, 'postgres'),
        after: extractAzureFlexibleServerDimensions(after, 'postgres'),
      }

    case 'azurerm_mysql_flexible_server':
      return {
        provider: 'azure',
        pricingFamily: 'managed_db',
        regionBefore: extractString(before, 'location'),
        regionAfter: extractString(after, 'location'),
        before: extractAzureFlexibleServerDimensions(before, 'mysql'),
        after: extractAzureFlexibleServerDimensions(after, 'mysql'),
      }

    case 'aws_elasticache_replication_group':
      return {
        provider: 'aws',
        pricingFamily: 'cache',
        regionBefore: extractAwsRegionFromArray(before, [
          'preferred_cache_cluster_azs',
          'availability_zones',
        ]),
        regionAfter: extractAwsRegionFromArray(after, [
          'preferred_cache_cluster_azs',
          'availability_zones',
        ]),
        before: extractAwsElastiCacheReplicationGroupDimensions(before),
        after: extractAwsElastiCacheReplicationGroupDimensions(after),
      }

    case 'aws_elasticache_cluster':
      return {
        provider: 'aws',
        pricingFamily: 'cache',
        regionBefore:
          extractAwsRegion(before) ??
          extractAwsRegionFromArray(before, ['preferred_availability_zones']),
        regionAfter:
          extractAwsRegion(after) ??
          extractAwsRegionFromArray(after, ['preferred_availability_zones']),
        before: extractAwsElastiCacheClusterDimensions(before),
        after: extractAwsElastiCacheClusterDimensions(after),
      }

    case 'google_redis_instance':
      return {
        provider: 'gcp',
        pricingFamily: 'cache',
        regionBefore: extractString(before, 'region'),
        regionAfter: extractString(after, 'region'),
        before: extractGcpRedisDimensions(before),
        after: extractGcpRedisDimensions(after),
      }

    case 'azurerm_redis_cache':
      return {
        provider: 'azure',
        pricingFamily: 'cache',
        regionBefore: extractString(before, 'location'),
        regionAfter: extractString(after, 'location'),
        before: extractAzureRedisDimensions(before),
        after: extractAzureRedisDimensions(after),
      }

    case 'aws_ebs_volume':
      return {
        provider: 'aws',
        pricingFamily: 'block_storage',
        regionBefore: extractAwsRegion(before),
        regionAfter: extractAwsRegion(after),
        before: extractAwsEbsDimensions(before),
        after: extractAwsEbsDimensions(after),
      }

    case 'google_compute_disk':
      return {
        provider: 'gcp',
        pricingFamily: 'block_storage',
        regionBefore: extractGcpRegion(before),
        regionAfter: extractGcpRegion(after),
        before: extractGcpDiskDimensions(before),
        after: extractGcpDiskDimensions(after),
      }

    case 'azurerm_managed_disk':
      return {
        provider: 'azure',
        pricingFamily: 'block_storage',
        regionBefore: extractString(before, 'location'),
        regionAfter: extractString(after, 'location'),
        before: extractAzureManagedDiskDimensions(before),
        after: extractAzureManagedDiskDimensions(after),
      }

    default:
      return {
        provider: 'aws',
        pricingFamily: 'vm_compute',
      }
  }
}

function extractAwsVmDimensions(
  obj: Record<string, unknown> | undefined | null
): VMComputePricingDimensions | undefined {
  const sku = extractString(obj, 'instance_type')
  return sku ? { sku } : undefined
}

function extractGcpVmDimensions(
  obj: Record<string, unknown> | undefined | null
): VMComputePricingDimensions | undefined {
  const sku = extractLastSegment(extractString(obj, 'machine_type'))
  return sku ? { sku } : undefined
}

function extractAzureVmDimensions(
  obj: Record<string, unknown> | undefined | null,
  osDiscriminator: 'linux' | 'windows'
): VMComputePricingDimensions | undefined {
  const sku = extractString(obj, 'size')
  return sku ? { sku, osDiscriminator } : undefined
}

function extractAwsDbDimensions(
  obj: Record<string, unknown> | undefined | null
): ManagedDbPricingDimensions | undefined {
  const sku = extractString(obj, 'instance_class')
  const engine = normalizeEngine(extractString(obj, 'engine'))
  const sizeGiB = extractNumber(obj, 'allocated_storage')

  if (!sku || !engine || !sizeGiB) {
    return undefined
  }

  const highAvailability = extractBoolean(obj, 'multi_az')
  const deploymentModel = highAvailability ? 'multi_az' : 'single_az'

  return {
    engine,
    sku,
    deploymentModel,
    highAvailability,
    storage: {
      sizeGiB,
      storageClass: extractString(obj, 'storage_type') ?? 'gp2',
      iops: extractNumber(obj, 'iops'),
      throughputMbps: extractNumber(obj, 'storage_throughput'),
    },
  }
}

function extractGcpSqlDimensions(
  obj: Record<string, unknown> | undefined | null
): ManagedDbPricingDimensions | undefined {
  const settings = extractFirstBlock(obj, 'settings')
  const sku = extractString(settings, 'tier')
  const engine = normalizeGcpDatabaseVersion(extractString(obj, 'database_version'))
  const sizeGiB = extractNumber(settings, 'disk_size')

  if (!sku || !engine || !sizeGiB) {
    return undefined
  }

  const availabilityType = normalizeValue(extractString(settings, 'availability_type'))
  const highAvailability = availabilityType === 'regional'

  return {
    engine,
    sku,
    deploymentModel: availabilityType,
    highAvailability,
    storage: {
      sizeGiB,
      storageClass: normalizeValue(extractString(settings, 'disk_type')),
    },
  }
}

function extractAzureFlexibleServerDimensions(
  obj: Record<string, unknown> | undefined | null,
  engine: 'postgres' | 'mysql'
): ManagedDbPricingDimensions | undefined {
  const sku = extractString(obj, 'sku_name')
  const storageMb = extractNumber(obj, 'storage_mb')

  if (!sku || !storageMb) {
    return undefined
  }

  const highAvailability = extractAzureHighAvailability(obj)
  const deploymentModel = highAvailability ? 'zone_redundant' : 'single_zone'

  return {
    engine,
    sku,
    deploymentModel,
    highAvailability,
    storage: {
      sizeGiB: storageMb / 1024,
      storageClass: normalizeValue(extractString(obj, 'storage_tier')),
      iops: extractNumber(obj, 'iops'),
    },
  }
}

function extractAwsElastiCacheReplicationGroupDimensions(
  obj: Record<string, unknown> | undefined | null
): CachePricingDimensions | undefined {
  const sku = extractString(obj, 'node_type')
  if (!sku) return undefined

  const totalNodes = getAwsReplicationGroupNodeCount(obj)
  const highAvailability =
    extractBoolean(obj, 'automatic_failover_enabled') ||
    extractBoolean(obj, 'multi_az_enabled') ||
    totalNodes > 1

  return {
    engine: normalizeEngine(extractString(obj, 'engine')) ?? 'redis',
    sku,
    highAvailability,
    replicaCount: totalNodes > 0 ? totalNodes - 1 : undefined,
  }
}

function extractAwsElastiCacheClusterDimensions(
  obj: Record<string, unknown> | undefined | null
): CachePricingDimensions | undefined {
  const sku = extractString(obj, 'node_type')
  if (!sku) return undefined

  const numCacheNodes = extractNumber(obj, 'num_cache_nodes') ?? 1
  return {
    engine: normalizeEngine(extractString(obj, 'engine')) ?? 'redis',
    sku,
    highAvailability: numCacheNodes > 1,
    replicaCount: numCacheNodes > 1 ? numCacheNodes - 1 : 0,
  }
}

function extractGcpRedisDimensions(
  obj: Record<string, unknown> | undefined | null
): CachePricingDimensions | undefined {
  const memorySizeGiB = extractNumber(obj, 'memory_size_gb')
  const tier = normalizeValue(extractString(obj, 'tier'))

  if (!memorySizeGiB) {
    return undefined
  }

  const highAvailability = tier === 'standard_ha'
  return {
    engine: 'redis',
    sku: `${memorySizeGiB}gib`,
    tier,
    highAvailability,
    replicaCount: extractNumber(obj, 'replica_count') ?? (highAvailability ? 1 : 0),
  }
}

function extractAzureRedisDimensions(
  obj: Record<string, unknown> | undefined | null
): CachePricingDimensions | undefined {
  const tier = extractString(obj, 'sku_name')
  const family = extractString(obj, 'family')
  const capacity = extractNumber(obj, 'capacity')

  if (!tier || !family || capacity === undefined) {
    return undefined
  }

  const highAvailability = tier.toLowerCase() !== 'basic'
  return {
    engine: 'redis',
    sku: `${tier}:${family}:${capacity}`,
    tier: normalizeValue(tier),
    highAvailability,
    replicaCount: highAvailability ? 1 : 0,
  }
}

function extractAwsEbsDimensions(
  obj: Record<string, unknown> | undefined | null
): BlockStoragePricingDimensions | undefined {
  const sku = extractString(obj, 'type')
  const sizeGiB = extractNumber(obj, 'size')

  if (!sku || !sizeGiB) {
    return undefined
  }

  return {
    sku,
    sizeGiB,
    iops: extractNumber(obj, 'iops'),
    throughputMbps: extractNumber(obj, 'throughput'),
  }
}

function extractGcpDiskDimensions(
  obj: Record<string, unknown> | undefined | null
): BlockStoragePricingDimensions | undefined {
  const sku = extractLastSegment(extractString(obj, 'type'))
  const sizeGiB = extractNumber(obj, 'size')

  if (!sku || !sizeGiB) {
    return undefined
  }

  return {
    sku,
    sizeGiB,
    iops: extractNumber(obj, 'provisioned_iops'),
    throughputMbps: extractNumber(obj, 'provisioned_throughput'),
  }
}

function extractAzureManagedDiskDimensions(
  obj: Record<string, unknown> | undefined | null
): BlockStoragePricingDimensions | undefined {
  const storageAccountType = extractString(obj, 'storage_account_type')
  const sizeGiB = extractNumber(obj, 'disk_size_gb')

  if (!storageAccountType || !sizeGiB) {
    return undefined
  }

  const normalizedDisk = normalizeAzureManagedDiskSku(storageAccountType, sizeGiB)

  return {
    sku: normalizedDisk.sku,
    sizeGiB: normalizedDisk.billedSizeGiB,
    iops: extractNumber(obj, 'disk_iops_read_write'),
    throughputMbps: extractNumber(obj, 'disk_mbps_read_write'),
  }
}

function selectBeforeAfterState(
  action: ResourceAction,
  regionBefore: string | undefined,
  regionAfter: string | undefined,
  before: FamilyDimensions | undefined,
  after: FamilyDimensions | undefined
) {
  switch (action) {
    case 'create':
      return {
        region: regionAfter ?? regionBefore,
        before: null,
        after: after ?? null,
      }
    case 'delete':
      return {
        region: regionBefore ?? regionAfter,
        before: before ?? null,
        after: null,
      }
    case 'import':
      if (before) {
        return {
          region: regionAfter ?? regionBefore,
          before,
          after: after ?? null,
        }
      }

      return {
        region: regionAfter ?? regionBefore,
        before: null,
        after: after ?? null,
      }
    case 'update':
    case 'replace':
    default:
      return {
        region: regionAfter ?? regionBefore,
        before: before ?? null,
        after: after ?? null,
      }
  }
}

function extractString(
  obj: Record<string, unknown> | undefined | null,
  key: string
): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const value = obj[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function extractNumber(
  obj: Record<string, unknown> | undefined | null,
  key: string
): number | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const value = obj[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length > 0) {
    const numeric = Number(value)
    return Number.isFinite(numeric) ? numeric : undefined
  }
  return undefined
}

function extractBoolean(
  obj: Record<string, unknown> | undefined | null,
  key: string
): boolean | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const value = obj[key]
  return typeof value === 'boolean' ? value : undefined
}

function extractFirstBlock(
  obj: Record<string, unknown> | undefined | null,
  key: string
): Record<string, unknown> | undefined {
  if (!obj || typeof obj !== 'object') return undefined

  const value = obj[key]
  if (Array.isArray(value)) {
    const [first] = value as unknown[]
    return first && typeof first === 'object' ? (first as Record<string, unknown>) : undefined
  }

  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function extractStringArray(
  obj: Record<string, unknown> | undefined | null,
  key: string
): string[] | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const value = obj[key]
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

function extractAwsRegion(obj: Record<string, unknown> | undefined | null): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined

  const explicit = extractString(obj, 'region')
  if (explicit) return explicit

  const availabilityZone = extractString(obj, 'availability_zone')
  return availabilityZone ? availabilityZone.replace(/[a-z]$/, '') : undefined
}

function extractAwsRegionFromArray(
  obj: Record<string, unknown> | undefined | null,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const values = extractStringArray(obj, key)
    const first = values?.[0]
    if (first) {
      return first.replace(/[a-z]$/, '')
    }
  }

  return undefined
}

function extractGcpRegion(obj: Record<string, unknown> | undefined | null): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined

  const explicitRegion = extractString(obj, 'region')
  if (explicitRegion) return explicitRegion

  const zone = extractString(obj, 'zone')
  return zone ? zone.replace(/-[a-z]$/, '') : undefined
}

function extractGcpSqlRegion(obj: Record<string, unknown> | undefined | null): string | undefined {
  const explicitRegion = extractString(obj, 'region')
  if (explicitRegion) return explicitRegion

  const settings = extractFirstBlock(obj, 'settings')
  const locationPreference = extractFirstBlock(settings, 'location_preference')
  const zone = extractString(locationPreference, 'zone')
  return zone ? zone.replace(/-[a-z]$/, '') : undefined
}

function extractLastSegment(value: string | undefined): string | undefined {
  if (!value) return undefined
  const segment = value.split('/').pop()
  return segment && segment.length > 0 ? segment : value
}

function normalizeEngine(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_')
}

function normalizeGcpDatabaseVersion(value: string | undefined): string | undefined {
  if (!value) return undefined
  if (value.startsWith('POSTGRES')) return 'postgres'
  if (value.startsWith('MYSQL')) return 'mysql'
  if (value.startsWith('SQLSERVER')) return 'sqlserver'
  return normalizeEngine(value)
}

function normalizeValue(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_')
}

function normalizeAzureManagedDiskSku(storageAccountType: string, requestedSizeGiB: number) {
  if (storageAccountType.startsWith('UltraSSD')) {
    return {
      sku: storageAccountType,
      billedSizeGiB: mapUltraDiskSize(requestedSizeGiB),
    }
  }

  const diskTypePrefix = storageAccountType.split('_')[0]
  const diskName = mapAzureManagedDiskName(diskTypePrefix, requestedSizeGiB)

  return {
    sku: diskName ? `${storageAccountType}:${diskName}` : storageAccountType,
    billedSizeGiB: diskName ? mapAzureManagedDiskSize(diskTypePrefix, diskName) : requestedSizeGiB,
  }
}

const AZURE_MANAGED_DISK_SIZE_MAP = {
  Standard: [
    ['S4', 32],
    ['S6', 64],
    ['S10', 128],
    ['S15', 256],
    ['S20', 512],
    ['S30', 1024],
    ['S40', 2048],
    ['S50', 4096],
    ['S60', 8192],
    ['S70', 16384],
    ['S80', 32767],
  ],
  StandardSSD: [
    ['E1', 4],
    ['E2', 8],
    ['E3', 16],
    ['E4', 32],
    ['E6', 64],
    ['E10', 128],
    ['E15', 256],
    ['E20', 512],
    ['E30', 1024],
    ['E40', 2048],
    ['E50', 4096],
    ['E60', 8192],
    ['E70', 16384],
    ['E80', 32767],
  ],
  Premium: [
    ['P1', 4],
    ['P2', 8],
    ['P3', 16],
    ['P4', 32],
    ['P6', 64],
    ['P10', 128],
    ['P15', 256],
    ['P20', 512],
    ['P30', 1024],
    ['P40', 2048],
    ['P50', 4096],
    ['P60', 8192],
    ['P70', 16384],
    ['P80', 32767],
  ],
} as const

function mapAzureManagedDiskName(
  diskTypePrefix: string,
  requestedSizeGiB: number
): string | undefined {
  const diskSizes =
    AZURE_MANAGED_DISK_SIZE_MAP[diskTypePrefix as keyof typeof AZURE_MANAGED_DISK_SIZE_MAP]
  if (!diskSizes) return undefined

  for (const [name, size] of diskSizes) {
    if (size >= requestedSizeGiB) {
      return name
    }
  }

  return undefined
}

function mapAzureManagedDiskSize(diskTypePrefix: string, diskName: string): number {
  const diskSizes =
    AZURE_MANAGED_DISK_SIZE_MAP[diskTypePrefix as keyof typeof AZURE_MANAGED_DISK_SIZE_MAP]
  const match = diskSizes?.find(([name]) => name === diskName)
  return match?.[1] ?? 0
}

const AZURE_ULTRA_DISK_SIZES = [4, 8, 16, 32, 64, 128, 256, 512]
const AZURE_ULTRA_DISK_SIZE_STEP = 1024
const AZURE_ULTRA_DISK_MAX_SIZE = 65536

function mapUltraDiskSize(requestedSizeGiB: number): number {
  if (requestedSizeGiB >= AZURE_ULTRA_DISK_MAX_SIZE) {
    return AZURE_ULTRA_DISK_MAX_SIZE
  }

  for (const size of AZURE_ULTRA_DISK_SIZES) {
    if (size >= requestedSizeGiB) {
      return size
    }
  }

  return Math.ceil(requestedSizeGiB / AZURE_ULTRA_DISK_SIZE_STEP) * AZURE_ULTRA_DISK_SIZE_STEP
}

function extractAzureHighAvailability(
  obj: Record<string, unknown> | undefined | null
): boolean | undefined {
  const block = extractFirstBlock(obj, 'high_availability')
  const mode = normalizeValue(extractString(block, 'mode'))

  if (!mode) return undefined
  return mode !== 'disabled' && mode !== 'same_zone'
}

function getAwsReplicationGroupNodeCount(obj: Record<string, unknown> | undefined | null): number {
  const numCacheClusters = extractNumber(obj, 'num_cache_clusters')
  if (numCacheClusters) return numCacheClusters

  const numNodeGroups = extractNumber(obj, 'num_node_groups')
  const replicasPerNodeGroup = extractNumber(obj, 'replicas_per_node_group')
  if (numNodeGroups && replicasPerNodeGroup !== undefined) {
    return numNodeGroups * (replicasPerNodeGroup + 1)
  }

  return 1
}
