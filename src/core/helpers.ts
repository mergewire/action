/**
 * Helper utilities vendored from the MergeWire internal package.
 *
 * This file exists so that apps/action has zero private dependencies
 * and can be published as a standalone open-source GitHub Action.
 */

import { VALID_ACTIONS, type Severity, type ResourceAction, type RoutingPayload, type Resource, type Summary } from './types.js'

// ============================================================================
// Severity Comparison
// ============================================================================

const SEVERITY_ORDER: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
}

export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_ORDER[a] - SEVERITY_ORDER[b]
}

export function isMoreSevere(a: Severity, b: Severity): boolean {
  return compareSeverity(a, b) > 0
}

export function meetsSeverityThreshold(severity: Severity, minimum: Severity): boolean {
  return compareSeverity(severity, minimum) >= 0
}

export function maxSeverity(severities: Severity[]): Severity {
  if (severities.length === 0) return 'low'
  return severities.reduce((max, current) => (isMoreSevere(current, max) ? current : max))
}

// ============================================================================
// Action Normalization
// ============================================================================

export function isReplacementAction(actions: string[]): boolean {
  if (actions.length !== 2) return false
  const sorted = [...actions].sort()
  return sorted[0] === 'create' && sorted[1] === 'delete'
}

export function normalizeActions(actions: string[], importingId?: string): ResourceAction[] {
  if (isReplacementAction(actions)) return ['replace']

  if (importingId && actions.includes('no-op')) return ['import']

  return actions.filter((a): a is ResourceAction => (VALID_ACTIONS as readonly string[]).includes(a))
}

export function normalizeResourceActions(resource: Resource): Resource {
  return {
    ...resource,
    actions: normalizeActions(resource.actions, resource.importingId),
  }
}

// ============================================================================
// Routing Summary Builders
// ============================================================================

export function calculateSummary(resources: Resource[]): Summary {
  let creates = 0
  let updates = 0
  let deletes = 0
  let replaces = 0
  let imports = 0

  for (const resource of resources) {
    const normalized = normalizeActions(resource.actions, resource.importingId)
    if (normalized.includes('create')) creates++
    if (normalized.includes('update')) updates++
    if (normalized.includes('delete')) deletes++
    if (normalized.includes('replace')) replaces++
    if (normalized.includes('import')) imports++
  }

  return { creates, updates, deletes, replaces, imports }
}

export function buildSummaryString(summary: Summary): string {
  const parts: string[] = []
  if (summary.creates > 0) parts.push(`${summary.creates} create(s)`)
  if (summary.updates > 0) parts.push(`${summary.updates} update(s)`)
  if (summary.deletes > 0) parts.push(`${summary.deletes} delete(s)`)
  if (summary.replaces > 0) parts.push(`${summary.replaces} replace(s)`)
  if (summary.imports > 0) parts.push(`${summary.imports} import(s)`)
  if (parts.length === 0) return 'no changes'
  return parts.join(', ')
}

export function hasChanges(summary: Summary): boolean {
  return (
    summary.creates > 0 ||
    summary.updates > 0 ||
    summary.deletes > 0 ||
    summary.replaces > 0 ||
    summary.imports > 0
  )
}

// ============================================================================
// Payload Sanitization
// ============================================================================

const SENSITIVE_FIELDS = [
  'before',
  'after',
  'variables',
  'values',
  'planned_values',
  'prior_state',
  'configuration',
  'sensitive_values',
]

function stripSensitiveFields(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(stripSensitiveFields)

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_FIELDS.includes(key)) continue
    result[key] = stripSensitiveFields(value)
  }
  return result
}

export function sanitizePayload<T>(payload: T): T {
  return stripSensitiveFields(payload) as T
}

export function assertSafePayload(payload: RoutingPayload): void {
  const obj = payload as unknown as Record<string, unknown>

  for (const field of SENSITIVE_FIELDS) {
    if (field in obj) {
      throw new Error(
        `Sensitive field "${field}" detected in payload. ` +
          `This indicates raw Terraform plan data may have leaked into the routing payload.`
      )
    }
  }

  for (let i = 0; i < payload.resources.length; i++) {
    const resource = payload.resources[i] as unknown as Record<string, unknown>
    for (const field of SENSITIVE_FIELDS) {
      if (field in resource) {
        throw new Error(
          `Sensitive field "${field}" detected in resource[${i}]. ` +
            `This indicates raw Terraform plan data may have leaked into the routing payload.`
        )
      }
    }
  }
}

// ============================================================================
// Stable Serialization
// ============================================================================

function sortKeysReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce(
      (sorted, k) => {
        sorted[k] = (value as Record<string, unknown>)[k]
        return sorted
      },
      {} as Record<string, unknown>
    )
}

export function stableSerialize(obj: unknown): string {
  return JSON.stringify(obj, sortKeysReplacer)
}

export function createPayloadKey(payload: RoutingPayload): string {
  const normalized = {
    requestId: payload.requestId,
    source: payload.source,
    repo: payload.repo,
    pullRequest: payload.pullRequest,
    evaluationTarget: payload.evaluationTarget,
    changedFiles: [...payload.changedFiles].sort(),
    summary: payload.summary,
    resources: [...payload.resources].sort((a, b) => a.address.localeCompare(b.address)),
  }
  return stableSerialize(normalized)
}

// ============================================================================
// Validation Helpers
// ============================================================================

export function isValidSeverity(value: string): value is Severity {
  return value === 'low' || value === 'medium' || value === 'high'
}

export function isValidResourceActions(actions: string[]): actions is ResourceAction[] {
  return actions.every((a) => (VALID_ACTIONS as readonly string[]).includes(a))
}

export function coerceSeverity(value: string): Severity {
  if (isValidSeverity(value)) return value
  return 'low'
}
