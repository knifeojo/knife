// In-memory fixed window. Enough to slow password guessing on a single self-hosted process.
// It resets on restart and is not shared across instances; put the server behind a real limiter
// before exposing it beyond a private network.

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export function rateLimit(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSec: 0 };
  }
  if (current.count >= limit) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  }
  current.count += 1;
  return { allowed: true, retryAfterSec: 0 };
}

export function resetRateLimits() {
  buckets.clear();
}

export const LOGIN_LIMIT = { limit: 8, windowMs: 15 * 60_000 };
export const SIGNUP_LIMIT = { limit: 5, windowMs: 60 * 60_000 };
