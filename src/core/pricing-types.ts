/**
 * Pricing types vendored from the MergeWire internal package.
 *
 * This file exists so that apps/action has zero private dependencies
 * and can be published as a standalone open-source GitHub Action.
 */

import type { ResourceAction } from './types.js'

export type PricingProvider = 'aws' | 'gcp' | 'azure'

export type PricingFamily = 'vm_compute' | 'managed_db' | 'cache' | 'block_storage'

export type UnpricedReason =
  | 'unsupported_resource'
  | 'missing_dimensions'
  | 'catalog_miss'
  | 'extraction_error'

export interface StorageDimensions {
  sizeGiB: number
  storageClass?: string
  iops?: number
  throughputMbps?: number
}

export interface VMComputePricingDimensions {
  sku: string
  osDiscriminator?: string
}

export interface ManagedDbPricingDimensions {
  engine: string
  sku: string
  deploymentModel?: string
  highAvailability?: boolean
  storage: StorageDimensions
}

export interface CachePricingDimensions {
  engine: string
  sku: string
  tier?: string
  highAvailability?: boolean
  replicaCount?: number
}

export interface BlockStoragePricingDimensions {
  sku: string
  sizeGiB: number
  iops?: number
  throughputMbps?: number
}

export type PricingDimensions =
  | VMComputePricingDimensions
  | ManagedDbPricingDimensions
  | CachePricingDimensions
  | BlockStoragePricingDimensions

export interface PricingResource {
  address: string
  type: string
  action: ResourceAction
  provider: PricingProvider
  region: string
  pricingFamily: PricingFamily
  before?: PricingDimensions | null
  after?: PricingDimensions | null
  metadata?: Record<string, unknown>
  unpricedReason?: UnpricedReason
  unpricedDetails?: string
}

export interface PricingPayload {
  pricingResources: PricingResource[]
}

export type ComponentType =
  | 'vm_compute_base'
  | 'managed_db_base'
  | 'managed_db_storage'
  | 'cache_base'
  | 'block_storage_capacity'
  | 'block_storage_iops'
  | 'block_storage_throughput'

export type PricingUnit = 'hour' | 'gib_month' | 'iops_month' | 'mbps_month'

export interface ResolvedPricingComponent {
  componentType: ComponentType
  pricingUnit: PricingUnit
  quantity: number
  unitPriceUsd: number
  monthlyCostUsd: number
  matchAttributes: Record<string, string>
}

export interface ResourceCost {
  address: string
  type: string
  action: ResourceAction
  pricingFamily: PricingFamily
  monthlyBeforeUsd: number
  monthlyAfterUsd: number
  monthlyDeltaUsd: number
  pricingDetails: {
    provider: PricingProvider
    region: string
    before: PricingDimensions | null
    after: PricingDimensions | null
    beforeComponents: ResolvedPricingComponent[]
    afterComponents: ResolvedPricingComponent[]
  }
}

export interface CostSummary {
  totalMonthlyDeltaUsd: number
  totalMonthlyBeforeUsd: number
  totalMonthlyAfterUsd: number
  resourceCosts: ResourceCost[]
  unpricedResources: PricingResource[]
}
