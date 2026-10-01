// Structured logger that redacts anything sensitive before it reaches stdout.
// Never pass email bodies or full transaction rows; pass ids and counts.

const SENSITIVE_KEYS = /token|secret|password|authorization|cookie|code|body|html|text|account|bvn|pin|otp|refresh|access/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth]";
  if (typeof value === "string") {
    return value
      .replace(/ya29\.[\w.-]+/g, "[redacted-token]")
      .replace(/1\/\/[\w.-]{20,}/g, "[redacted-token]")
      .replace(/\b\d{10}\b/g, "[redacted-nuban]");
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
    return out;
  }
  return value;
}

type Level = "info" | "warn" | "error";

function emit(level: Level, event: string, data?: Record<string, unknown>) {
  if (process.env.NODE_ENV === "test") return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...(data ? (redact(data) as object) : {}) });
  (level === "error" ? console.error : console.log)(line);
}

export const log = {
  info: (event: string, data?: Record<string, unknown>) => emit("info", event, data),
  warn: (event: string, data?: Record<string, unknown>) => emit("warn", event, data),
  error: (event: string, data?: Record<string, unknown>) => emit("error", event, data),
  redact,
};
