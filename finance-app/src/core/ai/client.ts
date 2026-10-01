import Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/db";

// One place for model choice and availability. AI features need BOTH a server API key and the
// user's consent (Settings), because they send transaction descriptions to Anthropic.

export const MODEL = "claude-opus-5-5";
// Server-side refusal fallback: if a request is declined by a safety classifier, the API reruns it
// on a fallback model inside the same call. Default routing, no model list to maintain.
export const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };

export function aiConfigured(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export async function aiAllowed(userId: string): Promise<boolean> {
  if (!aiConfigured()) return false;
  const u = await db.user.findUnique({ where: { id: userId }, select: { aiConsent: true } });
  return !!u?.aiConsent;
}

let client: Anthropic | undefined;
export function anthropic(): Anthropic {
  return (client ??= new Anthropic());
}

/** Long digit runs (account numbers, session ids) are removed before anything leaves the server. */
export function redactNarration(s: string): string {
  return s.replace(/\d{6,}/g, "#").replace(/\s+/g, " ").trim().slice(0, 200);
}
