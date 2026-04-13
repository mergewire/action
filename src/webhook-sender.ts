/**
 * Client-side generic webhooks for the MergeWire GitHub Action.
 *
 * Reads the webhooks input (named webhook URLs), cross-references
 * matched rule IDs from the evaluation result against .mergewire.yml, and
 * sends HTTP POST messages to the appropriate URLs securely.
 *
 * All sending is best-effort: failures log warnings but never fail the Action.
 */

import * as core from '@actions/core'
import { readFile } from 'fs/promises'
import yaml from 'js-yaml'
import * as crypto from 'crypto'
import type { EvaluationResult } from './core/types.js'

// ============================================================================
// Types
// ============================================================================

// Minimal shape we need from .mergewire.yml rules
interface MinimalRule {
  id: string
  notify?: {
    webhook?: string
  }
}

interface MinimalConfig {
  rules?: MinimalRule[]
}

export interface WebhookPayload {
  repository: string
  prNumber: number
  prUrl: string
  severity: string
  evaluation: EvaluationResult
  issuedAt: string
  requestId: string
}

// ============================================================================
// Webhook input parsing
// ============================================================================

/**
 * Parse the multiline webhooks action input into a name→url map.
 */
export function parseWebhooks(input: string): Map<string, string> {
  const webhooks = new Map<string, string>()
  if (!input.trim()) return webhooks

  for (const line of input.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const eqIndex = trimmed.indexOf('=')
    if (eqIndex < 1) continue

    const name = trimmed.slice(0, eqIndex).trim()
    const url = trimmed.slice(eqIndex + 1).trim()

    if (!name) continue
    if (!url.startsWith('https://')) {
      core.warning(`webhooks: skipping "${name}" — URL must start with https://`)
      continue
    }

    webhooks.set(name, url)
  }

  return webhooks
}

// ============================================================================
// Config hook resolution
// ============================================================================

/**
 * Read .mergewire.yml and return the deduplicated list of webhook names
 * referenced by the matched rules.
 */
export async function resolveWebhooks(
  configPath: string,
  matchedRuleIds: string[]
): Promise<string[]> {
  if (matchedRuleIds.length === 0) return []

  let raw: string
  try {
    raw = await readFile(configPath, 'utf-8')
  } catch {
    // No config file present
    return []
  }

  let parsed: unknown
  try {
    parsed = yaml.load(raw)
  } catch {
    core.warning('webhook-sender: could not parse .mergewire.yml, skipping webhook resolution')
    return []
  }

  if (!parsed || typeof parsed !== 'object') return []

  const config = parsed as MinimalConfig
  if (!Array.isArray(config.rules)) return []

  const matchedIdSet = new Set(matchedRuleIds)
  const hooks = new Set<string>()

  for (const rule of config.rules) {
    if (
      rule &&
      typeof rule === 'object' &&
      typeof rule.id === 'string' &&
      matchedIdSet.has(rule.id) &&
      rule.notify?.webhook
    ) {
      hooks.add(rule.notify.webhook)
    }
  }

  return [...hooks]
}

// ============================================================================
// Webhook delivery
// ============================================================================

function signPayload(payloadJson: string, apiKey: string): string {
  const hmac = crypto.createHmac('sha256', apiKey)
  hmac.update(payloadJson, 'utf8')
  return `sha256=${hmac.digest('hex')}`
}

async function sendWebhook(
  webhookUrl: string,
  payload: WebhookPayload,
  webhookSecret?: string
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const payloadJson = JSON.stringify(payload)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'user-agent': 'mergewire-action/1.0',
    }

    if (webhookSecret) {
      const signature = signPayload(payloadJson, webhookSecret)
      headers['x-mergewire-signature'] = signature
    }

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: payloadJson,
      signal: AbortSignal.timeout(10000),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => 'unknown')
      return { success: false, error: `Webhook returned ${response.status}: ${body}` }
    }

    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: `Failed to send webhook: ${message}` }
  }
}

// ============================================================================
// Main orchestration
// ============================================================================

export async function sendRuleWebhooks(options: {
  webhookMap: Map<string, string>
  matchedRuleIds: string[]
  configPath: string
  evaluation: EvaluationResult
  repository: { owner: string; name: string }
  prNumber: number
  webhookSecret?: string
  requestId: string
  githubServerUrl: string
}): Promise<void> {
  const {
    webhookMap,
    matchedRuleIds,
    configPath,
    evaluation,
    repository,
    prNumber,
    webhookSecret,
    requestId,
    githubServerUrl,
  } = options

  if (webhookMap.size === 0) return
  if (matchedRuleIds.length === 0) {
    core.info('  No matched rules — skipping webhooks')
    return
  }

  const hooks = await resolveWebhooks(configPath, matchedRuleIds)

  if (hooks.length === 0) {
    core.info('  No rules with notify.webhook found among matched rules — skipping')
    return
  }

  const prUrl = `${githubServerUrl}/${repository.owner}/${repository.name}/pull/${prNumber}`

  const payload: WebhookPayload = {
    repository: `${repository.owner}/${repository.name}`,
    prNumber,
    prUrl,
    severity: evaluation.severity,
    evaluation,
    issuedAt: new Date().toISOString(),
    requestId,
  }

  const promises = hooks.map(async (hookName) => {
    const webhookUrl = webhookMap.get(hookName)
    if (!webhookUrl) {
      core.warning(`  webhooks: no webhook URL configured for name "${hookName}" — skipping`)
      return
    }

    const result = await sendWebhook(webhookUrl, payload, webhookSecret)
    if (result.success) {
      core.info(`  Webhook sent to "${hookName}"`)
    } else {
      core.warning(`  Failed to send webhook to "${hookName}": ${result.error}`)
    }
  })

  await Promise.allSettled(promises)
}
