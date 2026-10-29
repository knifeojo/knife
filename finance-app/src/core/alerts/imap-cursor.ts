import { db, withBusyRetry } from "@/lib/db";
import type { ImapFolderCursorMap } from "../providers/types";

export async function loadImapFolderCursors(connectionId: string): Promise<ImapFolderCursorMap> {
  const rows = await db.imapFolderCursor.findMany({ where: { connectionId } });
  const out: ImapFolderCursorMap = {};
  for (const row of rows) out[row.folder] = { uid: row.uid, uidValidity: row.uidValidity };
  return out;
}

export async function saveImapFolderCursor(
  connectionId: string,
  folder: string,
  uid: number,
  uidValidity?: string,
): Promise<void> {
  await withBusyRetry(() =>
    db.imapFolderCursor.upsert({
      where: { connectionId_folder: { connectionId, folder } },
      update: { uid, ...(uidValidity ? { uidValidity } : {}) },
      create: { connectionId, folder, uid, uidValidity: uidValidity ?? null },
    }),
  );
}
