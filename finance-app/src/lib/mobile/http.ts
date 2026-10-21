import { NextResponse } from "next/server";
import { sessionFromToken, type SessionUser } from "@/lib/auth";

const PRIVATE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export function apiJson(body: unknown, status = 200, extra?: Record<string, string>) {
  return NextResponse.json(body, { status, headers: { ...PRIVATE_HEADERS, ...extra } });
}

export function apiError(status: number, error: string, extra?: Record<string, string>) {
  return apiJson({ error }, status, extra);
}

const BEARER = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/;

/** Mobile clients send the session token here. The web cookie is intentionally ignored. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  return BEARER.exec(header.trim())?.[1] ?? null;
}

export type ApiAuth = { user: SessionUser; token: string; expiresAt: Date } | { response: NextResponse };

export async function requireApiUser(req: Request): Promise<ApiAuth> {
  const token = bearerToken(req);
  if (!token) return { response: apiError(401, "Sign in required") };
  const session = await sessionFromToken(token);
  if (!session) return { response: apiError(401, "Sign in required") };
  return { user: session.user, token, expiresAt: session.expiresAt };
}

export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  const raw = (forwarded ? forwarded.split(",")[0] : req.headers.get("x-real-ip")) ?? "local";
  const cleaned = raw.trim().slice(0, 64).replace(/[^0-9a-fA-F.:]/g, "");
  return cleaned || "local";
}

export type ParsedJson = { ok: true; body: Record<string, unknown> } | { ok: false; response: NextResponse };

export async function readJsonObject(req: Request): Promise<ParsedJson> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) return { ok: false, response: apiError(415, "Send JSON") };
  const len = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > 20_000) return { ok: false, response: apiError(413, "Request is too large") };
  try {
    const body: unknown = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, response: apiError(400, "Send a JSON object") };
    return { ok: true, body: body as Record<string, unknown> };
  } catch {
    return { ok: false, response: apiError(400, "Send a JSON object") };
  }
}

export function publicUser(user: { id: string; email: string; name: string | null; isDemo: boolean }) {
  return { id: user.id, email: user.email, name: user.name, isDemo: user.isDemo };
}
