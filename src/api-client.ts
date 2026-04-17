/**
 * API Client
 *
 * Handles HMAC signing and API communication with the backend.
 */

import * as core from "@actions/core";
import * as crypto from "crypto";
import type { RoutingPayload, EvaluationResult } from "./core/types.js";
import { stableSerialize } from "./core/helpers.js";

export interface SendResult {
  status: "accepted" | "duplicate" | "skipped" | "failed";
  message?: string;
  evaluation?: EvaluationResult;
}

interface ApiResponse {
  status: "accepted" | "duplicate" | "skipped" | "error";
  message?: string;
  requestId?: string;
  evaluation?: EvaluationResult;
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string"))];
}

function normalizeEvaluation(
  evaluation: EvaluationResult | undefined,
): EvaluationResult | undefined {
  if (!evaluation) {
    return undefined;
  }

  const evidence = Array.isArray(evaluation.evidence) ? evaluation.evidence : [];
  const matchedRuleIds = Array.isArray(evaluation.matchedRuleIds)
    ? uniqueStrings(evaluation.matchedRuleIds)
    : uniqueStrings(evidence.map((item) => item?.ruleId));

  return {
    ...evaluation,
    matchedRuleIds,
    requestedReviewers: {
      users: Array.isArray(evaluation.requestedReviewers?.users)
        ? evaluation.requestedReviewers.users
        : [],
      teams: Array.isArray(evaluation.requestedReviewers?.teams)
        ? evaluation.requestedReviewers.teams
        : [],
    },
    evidence,
  };
}

/**
 * Send the routing payload to the API with HMAC signing
 */
export async function sendPayload(
  apiUrl: string,
  apiKey: string,
  payload: RoutingPayload,
): Promise<SendResult> {
  const url = `${apiUrl.replace(/\/$/, "")}/ingest`;
  const body = stableSerialize(payload);

  // Keep sending the legacy signature header for backward compatibility while
  // the backend transitions from global HMAC secrets to workspace API keys.
  const signature = signPayload(body, apiKey);

  core.debug(`Sending payload to ${url}`);
  core.debug(`Request ID: ${payload.requestId}`);
  core.debug(`Signature: ${signature.slice(0, 16)}...`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
      "X-Signature": signature,
      "X-Request-Id": payload.requestId,
      "X-Source": "github-actions",
    },
    body,
  });

  // Handle HTTP errors
  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");

    // Check for duplicate (409 Conflict)
    if (response.status === 409) {
      return {
        status: "duplicate",
        message: "Request already processed",
      };
    }

    return {
      status: "failed",
      message: `HTTP ${response.status}: ${errorText.slice(0, 200)}`,
    };
  }

  // Parse response
  let data: ApiResponse;
  try {
    data = (await response.json()) as ApiResponse;
  } catch {
    // Non-JSON success response is acceptable
    return { status: "accepted" };
  }

  // Map API response status to our result status
  switch (data.status) {
    case "accepted":
      return {
        status: "accepted",
        message: data.message,
        evaluation: normalizeEvaluation(data.evaluation),
      };
    case "duplicate":
      return {
        status: "duplicate",
        message: data.message,
        evaluation: normalizeEvaluation(data.evaluation),
      };
    case "skipped":
      return {
        status: "skipped",
        message: data.message,
        evaluation: normalizeEvaluation(data.evaluation),
      };
    case "error":
      return { status: "failed", message: data.message };
    default:
      // Unknown status, but HTTP was OK
      return { status: "accepted", evaluation: normalizeEvaluation(data.evaluation) };
  }
}

/**
 * Sign a payload using HMAC-SHA256
 */
export function signPayload(payload: string, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(payload, "utf8");
  return `sha256=${hmac.digest("hex")}`;
}

/**
 * Verify a payload signature (for testing purposes)
 */
export function verifySignature(
  payload: string,
  secret: string,
  signature: string,
): boolean {
  const expected = signPayload(payload, secret);
  try {
    const normalized = signature.startsWith("sha256=")
      ? signature
      : `sha256=${signature}`;
    return crypto.timingSafeEqual(
      Buffer.from(normalized),
      Buffer.from(expected),
    );
  } catch {
    return false;
  }
}

/**
 * Generate a test request ID for idempotency testing
 */
export function generateRequestId(): string {
  return crypto.randomUUID();
}
