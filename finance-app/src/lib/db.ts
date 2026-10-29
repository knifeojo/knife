import { Prisma, PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient; sqlitePragmas?: boolean };

export const db = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

function isBusyError(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === "P1008" || e.code === "P2034") return true;
  }
  const message = e instanceof Error ? e.message : String(e);
  return /SQLITE_BUSY|database is locked|database locked|P1008|P2034/i.test(message);
}

async function applySqlitePragmas(): Promise<void> {
  if (globalForPrisma.sqlitePragmas) return;
  globalForPrisma.sqlitePragmas = true;
  try {
    await db.$queryRawUnsafe("PRAGMA journal_mode=WAL");
    await db.$queryRawUnsafe("PRAGMA busy_timeout=8000");
    await db.$queryRawUnsafe("PRAGMA synchronous=NORMAL");
  } catch {
    globalForPrisma.sqlitePragmas = false;
  }
}

/** Retry SQLite write contention instead of failing a sync that already imported rows. */
export async function withBusyRetry<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  await applySqlitePragmas();
  let delay = 20;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isBusyError(e) || i === attempts - 1) throw e;
      await new Promise((resolve) => setTimeout(resolve, delay + Math.floor(Math.random() * delay)));
      delay = Math.min(delay * 2, 1000);
    }
  }
  throw last;
}
