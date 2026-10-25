import Anthropic from "@anthropic-ai/sdk";
import { MODEL, anthropic, cloudKeySet } from "./client";
import { AiUnavailableError } from "./ollama";

// The only way out to the cloud model. Callers build their payload with a Redactor (./redact.ts)
// before calling cloudCreate; nothing in this file sees raw ledger data.

export type CreateMessage = (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => Promise<Anthropic.Beta.BetaMessage>;

/** Outages, bad keys and rate limits become AiUnavailableError, so callers fall back to local. */
export function cloudError(e: unknown): unknown {
  if (e instanceof Anthropic.APIConnectionError) return new AiUnavailableError("Could not reach Anthropic.");
  if (e instanceof Anthropic.APIError && (e.status === 401 || e.status === 403 || e.status === 429 || (e.status ?? 0) >= 500)) {
    return new AiUnavailableError(`Anthropic returned ${e.status}.`);
  }
  return e;
}

export const cloudCreate: CreateMessage = async (params) => {
  if (!cloudKeySet()) throw new AiUnavailableError("ANTHROPIC_API_KEY is not set.");
  try {
    return await anthropic().beta.messages.create(params);
  } catch (e) {
    throw cloudError(e);
  }
};

export interface CloudStatus {
  provider: "anthropic";
  model: string;
  /** Whether ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) is set. The key itself is never returned. */
  keySet: boolean;
  reachable: boolean;
  message: string;
}

const CACHE_MS = 60_000;
let cached: { at: number; status: CloudStatus } | undefined;

/** Whether the cloud model answers with this key. Never throws; cached for a minute. */
export async function cloudStatus(opts: { env?: Record<string, string | undefined>; check?: () => Promise<unknown> } = {}): Promise<CloudStatus> {
  const base = { provider: "anthropic" as const, model: MODEL };
  if (!cloudKeySet(opts.env)) {
    return { ...base, keySet: false, reachable: false, message: "ANTHROPIC_API_KEY is not set. Cloud features run locally or stay off." };
  }
  if (!opts.check && cached && Date.now() - cached.at < CACHE_MS) return cached.status;
  const check = opts.check ?? (() => anthropic().models.list({ limit: 1 }, { timeout: 4_000, maxRetries: 0 }));
  let status: CloudStatus;
  try {
    await check();
    status = { ...base, keySet: true, reachable: true, message: "Anthropic answered. Requests are redacted before they leave this machine." };
  } catch (e) {
    const message =
      e instanceof Anthropic.APIConnectionError ? "Could not reach Anthropic from this machine."
      : e instanceof Anthropic.AuthenticationError ? "Anthropic rejected ANTHROPIC_API_KEY (401). Check the key."
      : e instanceof Anthropic.APIError ? `Anthropic returned ${e.status}.`
      : "Could not check Anthropic.";
    status = { ...base, keySet: true, reachable: false, message };
  }
  if (!opts.check) cached = { at: Date.now(), status };
  return status;
}
