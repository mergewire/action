/**
 * Client-side Slack notifications for the MergeWire GitHub Action.
 *
 * Reads the slack-webhooks input (named webhook URLs), cross-references
 * matched rule IDs from the evaluation result against .mergewire.yml, and
 * sends Block Kit messages to the appropriate channels.
 *
 * All sending is best-effort: failures log warnings but never fail the Action.
 */

import * as core from '@actions/core'
import { readFile } from 'fs/promises'
import yaml from 'js-yaml'
import type { EvaluationResult } from './core/types.js'

// ============================================================================
// Types
// ============================================================================

interface SlackBlock {
  type: string
  text?: { type: string; text: string }
  fields?: Array<{ type: string; text: string }>
}

interface SlackMessage {
  text: string
  blocks: SlackBlock[]
}

// Minimal shape we need from .mergewire.yml rules — no full Zod validation here
// since the API already validated the config. We only need id and notify.slack.
interface MinimalRule {
  id: string
  notify?: {
    slack?: string
    slackFinance?: boolean
  }
}

interface MinimalConfig {
  rules?: MinimalRule[]
}

// ============================================================================
// Webhook input parsing
// ============================================================================

/**
 * Parse the multiline slack-webhooks action input into a name→url map.
 *
 * Format (one per line):
 *   alerts=https://hooks.slack.com/services/T.../B.../xxx
 *   general=https://hooks.slack.com/services/T.../B.../yyy
 *
 * Lines that are blank, start with #, or do not match the pattern are silently skipped.
 * Non-HTTPS URLs are rejected.
 */
export function parseSlackWebhooks(input: string): Map<string, string> {
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
      core.warning(`slack-webhooks: skipping "${name}" — URL must start with https://`)
      continue
    }

    webhooks.set(name, url)
  }

  return webhooks
}

// ============================================================================
// Config channel resolution
// ============================================================================

/**
 * Read .mergewire.yml and return the deduplicated list of slack channel names
 * referenced by the matched rules.
 */
export async function resolveSlackChannels(
  configPath: string,
  matchedRuleIds: string[]
): Promise<string[]> {
  if (matchedRuleIds.length === 0) return []

  let raw: string
  try {
    raw = await readFile(configPath, 'utf-8')
  } catch {
    // No config file present — nothing to resolve
    return []
  }

  let parsed: unknown
  try {
    parsed = yaml.load(raw)
  } catch {
    core.warning('slack-sender: could not parse .mergewire.yml, skipping Slack channel resolution')
    return []
  }

  if (!parsed || typeof parsed !== 'object') return []

  const config = parsed as MinimalConfig
  if (!Array.isArray(config.rules)) return []

  const matchedIdSet = new Set(matchedRuleIds)
  const channels = new Set<string>()

  for (const rule of config.rules) {
    if (
      rule &&
      typeof rule === 'object' &&
      typeof rule.id === 'string' &&
      matchedIdSet.has(rule.id) &&
      rule.notify?.slack
    ) {
      channels.add(rule.notify.slack)
    }
  }

  return [...channels]
}

// ============================================================================
// Slack message building
// ============================================================================

const SEVERITY_EMOJI: Record<string, string> = {
  low: '🔵',
  medium: '🟡',
  high: '🔴',
}

const SEVERITY_LABEL: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

function buildSlackMessage(options: {
  repository: { owner: string; name: string }
  prNumber: number
  prUrl: string
  severity: string
  evaluation: EvaluationResult
}): SlackMessage {
  const { owner, name } = options.repository
  const emoji = SEVERITY_EMOJI[options.severity] ?? '⚪'
  const label = SEVERITY_LABEL[options.severity] ?? options.severity.toUpperCase()
  const severityText = `${emoji} *${label} Severity*`
  const repoRef = `*${owner}/${name}*`
  const prRef = `<${options.prUrl}|#${options.prNumber}>`

  // Build evidence summary (up to 3 items)
  const evidence = options.evaluation.evidence ?? []
  const evidenceLines = evidence.slice(0, 3).map((item) => {
    const summary =
      item.summary && item.summary.length > 100 ? item.summary.slice(0, 97) + '...' : item.summary
    return `• *${item.title}*${summary ? `: ${summary}` : ''}`
  })
  if (evidence.length > 3) {
    evidenceLines.push(`_...and ${evidence.length - 3} more_`)
  }
  const evidenceText =
    evidenceLines.length > 0 ? evidenceLines.join('\n') : '_No specific evidence provided_'

  // Build reviewers summary
  const reviewers = options.evaluation.requestedReviewers
  const reviewerParts: string[] = []
  if (reviewers?.users?.length) reviewerParts.push(...reviewers.users.map((u) => `@${u}`))
  if (reviewers?.teams?.length) reviewerParts.push(...reviewers.teams.map((t) => `@${t}`))
  const reviewersText =
    reviewerParts.length > 0 ? reviewerParts.join(', ') : '_No reviewers requested_'

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${severityText} — Terraform Review Required`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Repository:*\n${repoRef}` },
        { type: 'mrkdwn', text: `*Pull Request:*\n${prRef}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Evidence:*\n${evidenceText}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Requested Reviewers:*\n${reviewersText}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `<${options.prUrl}|View Pull Request>` },
    },
  ]

  return {
    text: `${emoji} ${label} severity alert: ${owner}/${name}#${options.prNumber}`,
    blocks,
  }
}

// ============================================================================
// Webhook delivery
// ============================================================================

async function sendWebhook(
  webhookUrl: string,
  payload: SlackMessage
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => 'unknown')
      return { success: false, error: `Slack webhook returned ${response.status}: ${body}` }
    }

    const body = await response.text().catch(() => '')
    if (body !== 'ok') {
      return { success: false, error: `Slack webhook returned unexpected response: ${body}` }
    }

    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: `Failed to send Slack webhook: ${message}` }
  }
}

// ============================================================================
// Main orchestration
// ============================================================================

/**
 * Send Slack notifications for matched rules that specify notify.slack.
 *
 * Reads .mergewire.yml at configPath, cross-references matchedRuleIds,
 * resolves channel names to webhook URLs from the webhookMap, and sends
 * Block Kit messages. All operations are best-effort.
 */
export async function sendRuleSlackNotifications(options: {
  webhookMap: Map<string, string>
  matchedRuleIds: string[]
  configPath: string
  evaluation: EvaluationResult
  repository: { owner: string; name: string }
  prNumber: number
  githubServerUrl: string
}): Promise<void> {
  const {
    webhookMap,
    matchedRuleIds,
    configPath,
    evaluation,
    repository,
    prNumber,
    githubServerUrl,
  } = options

  if (webhookMap.size === 0) return
  if (matchedRuleIds.length === 0) {
    core.info('  No matched rules — skipping Slack notifications')
    return
  }

  const channels = await resolveSlackChannels(configPath, matchedRuleIds)

  if (channels.length === 0) {
    core.info('  No rules with notify.slack found among matched rules — skipping')
    return
  }

  const prUrl = `${githubServerUrl}/${repository.owner}/${repository.name}/pull/${prNumber}`
  const message = buildSlackMessage({
    repository,
    prNumber,
    prUrl,
    severity: evaluation.severity,
    evaluation,
  })

  for (const channel of channels) {
    const webhookUrl = webhookMap.get(channel)
    if (!webhookUrl) {
      core.warning(
        `  slack-webhooks: no webhook URL configured for channel "${channel}" — skipping`
      )
      continue
    }

    const result = await sendWebhook(webhookUrl, message)
    if (result.success) {
      core.info(`  Slack notification sent to channel "${channel}"`)
    } else {
      core.warning(`  Failed to send Slack to channel "${channel}": ${result.error}`)
    }
  }
}
