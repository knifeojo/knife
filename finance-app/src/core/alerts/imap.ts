import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { EmailMessage } from "../types";
import type { EmailSource, ImapFolderCursorMap } from "../providers/types";
import { attachmentsFromMailparser } from "./attachments";
import { imapPassword } from "./secrets";
import { BANK_SENDERS } from "./senders";
import { detectStatementEmail, statementSenderDomains } from "./statement-mail";

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
}

export type ImapFactory = (cfg: ImapConfig) => ImapClientLike;

export interface ImapMailboxInfo {
  path: string;
  specialUse?: string | null;
  name?: string;
}

export interface ImapFetchMessage {
  source?: Buffer;
  uid?: number;
  envelope?: { from?: { address?: string }[]; subject?: string; date?: Date };
  bodyStructure?: unknown;
}

export interface ImapClientLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  mailboxOpen(path: string): Promise<{ uidValidity?: bigint | number | string; path?: string } | unknown>;
  mailboxClose?(): Promise<unknown>;
  list?(options?: Record<string, unknown>): Promise<ImapMailboxInfo[]>;
  search(query: Record<string, unknown>, options?: { uid?: boolean }): Promise<number[] | false | undefined>;
  fetchOne(
    seq: string | number,
    query: Record<string, unknown>,
    options?: { uid?: boolean },
  ): Promise<ImapFetchMessage | false>;
  fetch?(
    range: string | number[],
    query: Record<string, unknown>,
    options?: { uid?: boolean },
  ): AsyncIterable<ImapFetchMessage>;
}

export const IMAP_BATCH_SIZE = 25;
export const IMAP_SOCKET_TIMEOUT_MS = 90_000;
export const IMAP_CONNECTION_TIMEOUT_MS = 20_000;
export const IMAP_GREETING_TIMEOUT_MS = 16_000;
export const IMAP_MAX_RECONNECT = 5;

const SKIP_SPECIAL = new Set(["\\SENT", "\\TRASH", "\\JUNK", "\\DRAFTS", "\\FLAGGED"]);
const KEEP_SPECIAL = new Set(["\\INBOX", "\\ARCHIVE", "\\ALL"]);

export function yahooImapDefaults() {
  return { host: "imap.mail.yahoo.com", port: 993 };
}

export function imapClientOptions(cfg: ImapConfig) {
  return {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 993,
    auth: { user: cfg.user, pass: cfg.password },
    logger: false as const,
    socketTimeout: IMAP_SOCKET_TIMEOUT_MS,
    greetingTimeout: IMAP_GREETING_TIMEOUT_MS,
    connectionTimeout: IMAP_CONNECTION_TIMEOUT_MS,
    connectTimeout: IMAP_CONNECTION_TIMEOUT_MS,
  };
}

export function defaultImapFactory(cfg: ImapConfig): ImapClientLike {
  return new ImapFlow(imapClientOptions(cfg) as never) as unknown as ImapClientLike;
}

/** IMAP FROM clauses for known bank email domains (OR). */
export function bankEmailFromQuery(): { from: string }[] {
  return BANK_SENDERS.filter((s) => s.channel !== "sms").map((s) => ({ from: s.id }));
}

/** Bank alert domains plus statement senders (Deel, the wallet provider, and the banks). */
export function imapFromClauses(): { from: string }[] {
  const domains = [...new Set([...bankEmailFromQuery().map((clause) => clause.from), ...statementSenderDomains()])];
  return domains.map((from) => ({ from }));
}

export function isRelevantImapFolder(box: ImapMailboxInfo): boolean {
  const special = (box.specialUse ?? "").toUpperCase();
  if (SKIP_SPECIAL.has(special)) return false;
  if (KEEP_SPECIAL.has(special)) return true;
  const path = `${box.path ?? ""} ${box.name ?? ""}`.toLowerCase();
  if (/\b(sent|trash|deleted|junk|spam|draft|outbox|bulk)\b/.test(path)) return false;
  return /\binbox\b/.test(path) || path.includes("archive") || path.includes("all mail") || path.includes("allmail");
}

export function relevantImapFolders(boxes: ImapMailboxInfo[]): string[] {
  const paths = boxes.filter(isRelevantImapFolder).map((box) => box.path).filter(Boolean);
  if (!paths.some((path) => path.toUpperCase() === "INBOX")) paths.unshift("INBOX");
  return [...new Set(paths)];
}

export function encodeImapMessageId(folder: string, uid: number): string {
  return `${encodeURIComponent(folder)}:${uid}`;
}

export function decodeImapMessageId(id: string): { folder: string; uid: number } | null {
  const sep = id.lastIndexOf(":");
  if (sep <= 0) {
    const uid = Number(id);
    return Number.isInteger(uid) && uid > 0 ? { folder: "INBOX", uid } : null;
  }
  const uid = Number(id.slice(sep + 1));
  if (!Number.isInteger(uid) || uid <= 0) return null;
  try {
    return { folder: decodeURIComponent(id.slice(0, sep)), uid };
  } catch {
    return { folder: id.slice(0, sep), uid };
  }
}

export function imapMessageIdAliases(id: string): string[] {
  const parsed = decodeImapMessageId(id);
  if (!parsed) return [id];
  const encoded = encodeImapMessageId(parsed.folder, parsed.uid);
  const aliases = [id, encoded];
  if (parsed.folder.toUpperCase() === "INBOX") aliases.push(String(parsed.uid));
  return [...new Set(aliases)];
}

export function isImapDisconnectError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
  return /connection not available|socket timeout|etimedout|econnreset|econnrefused|epipe|not connected|no connection|closed|overquota|temporarily unavailable|server unavailable/i.test(
    `${message} ${code}`,
  );
}

export function imapReconnectDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}

export function attachmentNamesFromStructure(node: unknown): string[] {
  const names: string[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const o = n as Record<string, unknown>;
    const disp = o.dispositionParameters as Record<string, string> | undefined;
    const params = o.parameters as Record<string, string> | undefined;
    const filename =
      (typeof disp?.filename === "string" && disp.filename) ||
      (typeof params?.name === "string" && params.name) ||
      (typeof o.filename === "string" && o.filename) ||
      "";
    if (filename) names.push(filename);
    const children = o.childNodes ?? o.children ?? o.parts;
    if (Array.isArray(children)) for (const child of children) walk(child);
  };
  walk(node);
  return names;
}

function uidValidityOf(opened: unknown): string | undefined {
  if (!opened || typeof opened !== "object") return undefined;
  const value = (opened as { uidValidity?: bigint | number | string }).uidValidity;
  return value == null ? undefined : String(value);
}

function fromQuery(): Record<string, unknown> {
  const froms = imapFromClauses();
  if (froms.length >= 2) return { or: froms };
  if (froms.length === 1) return froms[0];
  return {};
}

export interface StatementCandidate {
  folder: string;
  uid: number;
  from: string;
  date: Date;
  filenames: string[];
}

export function formatStatementCandidateLine(c: StatementCandidate): string {
  const date = Number.isNaN(c.date.getTime()) ? "" : c.date.toISOString().slice(0, 10);
  const files = c.filenames.join(", ") || "(no attachments)";
  return `${date}\t${c.from}\t${c.folder}\t${files}`;
}

export class ImapEmailSource implements EmailSource {
  readonly source = "imap" as const;
  private live?: ImapClientLike;
  private liveFolder?: string;
  private sessionDepth = 0;
  private readonly validity = new Map<string, string>();

  constructor(
    private readonly cfg: ImapConfig,
    private readonly factory: ImapFactory = defaultImapFactory,
  ) {}

  static fromConnection(conn: { id: string; imapHost?: string | null; imapPort?: number | null; imapUser?: string | null }): ImapEmailSource {
    const password = imapPassword(conn.id);
    if (!conn.imapHost || !conn.imapUser || !password) throw new Error("IMAP is not fully configured (host/user in settings, password in the local secret file).");
    return new ImapEmailSource({
      host: conn.imapHost,
      port: conn.imapPort ?? 993,
      user: conn.imapUser,
      password,
    });
  }

  folderUidValidity(folder: string): string | undefined {
    return this.validity.get(folder);
  }

  async beginSession(): Promise<void> {
    this.sessionDepth++;
    await this.ensureLive();
  }

  async endSession(): Promise<void> {
    this.sessionDepth = Math.max(0, this.sessionDepth - 1);
    if (this.sessionDepth === 0) await this.dropLive();
  }

  async listMessageIds({ after, max = 500, folderCursors }: { query: string; after?: Date; max?: number; folderCursors?: ImapFolderCursorMap }): Promise<string[]> {
    return this.run(async (client) => {
      const folders = await this.foldersOf(client);
      const ids: string[] = [];
      for (const folder of folders) {
        if (ids.length >= max) break;
        try {
          const opened = await this.openFolder(client, folder);
          const validity = uidValidityOf(opened);
          if (validity) this.validity.set(folder, validity);
          const stored = folderCursors?.[folder];
          const cursor = stored && stored.uidValidity && validity && stored.uidValidity !== validity ? 0 : stored?.uid ?? 0;
          const query: Record<string, unknown> = { ...fromQuery() };
          if (after) query.since = after;
          const uids = ((await client.search(query, { uid: true })) || []).filter((uid) => uid > cursor).sort((a, b) => a - b);
          for (const uid of uids) {
            ids.push(encodeImapMessageId(folder, uid));
            if (ids.length >= max) break;
          }
        } catch (e) {
          if (isImapDisconnectError(e)) throw e;
          // Skip a folder Yahoo will not open; still search the rest.
        }
      }
      return ids;
    });
  }

  async getMessage(id: string): Promise<EmailMessage> {
    return this.run(async (client) => {
      const parsedId = decodeImapMessageId(id) ?? { folder: "INBOX", uid: Number(id) };
      if (!Number.isInteger(parsedId.uid) || parsedId.uid <= 0) throw new Error(`IMAP message ${id} not found`);
      await this.openFolder(client, parsedId.folder);
      const msg = await client.fetchOne(String(parsedId.uid), { source: true, envelope: true }, { uid: true });
      if (!msg || !msg.source) throw new Error(`IMAP message ${id} not found`);
      return this.toEmail(encodeImapMessageId(parsedId.folder, parsedId.uid), msg);
    });
  }

  async listStatementCandidates({ after, max = 500 }: { after?: Date; max?: number } = {}): Promise<StatementCandidate[]> {
    return this.run(async (client) => {
      const folders = await this.foldersOf(client);
      const out: StatementCandidate[] = [];
      for (const folder of folders) {
        if (out.length >= max) break;
        try {
          const opened = await this.openFolder(client, folder);
          const validity = uidValidityOf(opened);
          if (validity) this.validity.set(folder, validity);
          const query: Record<string, unknown> = { ...fromQuery() };
          if (after) query.since = after;
          const uids = ((await client.search(query, { uid: true })) || []).sort((a, b) => a - b);
          for (const batch of chunk(uids, IMAP_BATCH_SIZE)) {
            const peeked = await this.peek(client, batch);
            for (const msg of peeked) {
              const from = envelopeFrom(msg);
              const filenames = attachmentNamesFromStructure(msg.bodyStructure);
              const hit = detectStatementEmail({ from, subject: msg.envelope?.subject ?? "", filenames });
              if (!hit) continue;
              out.push({
                folder,
                uid: msg.uid ?? 0,
                from,
                date: msg.envelope?.date ?? new Date(0),
                filenames,
              });
              if (out.length >= max) return out;
            }
          }
        } catch (e) {
          if (isImapDisconnectError(e)) throw e;
        }
      }
      return out;
    });
  }

  private async peek(client: ImapClientLike, uids: number[]): Promise<ImapFetchMessage[]> {
    const query = { envelope: true, bodyStructure: true };
    if (client.fetch) {
      const out: ImapFetchMessage[] = [];
      for await (const msg of client.fetch(uids, query, { uid: true })) out.push(msg);
      return out;
    }
    const out: ImapFetchMessage[] = [];
    for (const uid of uids) {
      const msg = await client.fetchOne(String(uid), query, { uid: true });
      if (msg) out.push(msg);
    }
    return out;
  }

  private async toEmail(id: string, msg: ImapFetchMessage): Promise<EmailMessage> {
    const parsed = await simpleParser(msg.source!);
    return {
      id,
      from: parsed.from?.text ?? msg.envelope?.from?.[0]?.address ?? "",
      subject: parsed.subject ?? msg.envelope?.subject ?? "",
      date: parsed.date ?? msg.envelope?.date ?? new Date(),
      text: parsed.text || undefined,
      html: typeof parsed.html === "string" ? parsed.html : undefined,
      attachments: attachmentsFromMailparser(parsed.attachments),
    };
  }

  private async foldersOf(client: ImapClientLike): Promise<string[]> {
    if (!client.list) return ["INBOX"];
    try {
      const boxes = await client.list();
      return relevantImapFolders(boxes ?? []);
    } catch {
      return ["INBOX"];
    }
  }

  private async openFolder(client: ImapClientLike, folder: string): Promise<unknown> {
    if (this.liveFolder === folder) return undefined;
    const opened = await client.mailboxOpen(folder);
    this.liveFolder = folder;
    return opened;
  }

  private async ensureLive(): Promise<ImapClientLike> {
    if (this.live) return this.live;
    const client = this.factory(this.cfg);
    await client.connect();
    this.live = client;
    this.liveFolder = undefined;
    return client;
  }

  private async dropLive(): Promise<void> {
    const client = this.live;
    this.live = undefined;
    this.liveFolder = undefined;
    if (client) await Promise.resolve(client.logout()).catch(() => {});
  }

  private async run<T>(fn: (client: ImapClientLike) => Promise<T>): Promise<T> {
    let delay = 1000;
    let last: unknown;
    for (let attempt = 0; attempt < IMAP_MAX_RECONNECT; attempt++) {
      try {
        const client = await this.ensureLive();
        const result = await fn(client);
        if (this.sessionDepth === 0) await this.dropLive();
        return result;
      } catch (e) {
        last = e;
        await this.dropLive();
        if (!isImapDisconnectError(e) || attempt === IMAP_MAX_RECONNECT - 1) throw e;
        await sleep(delay);
        delay = imapReconnectDelayMs(attempt + 1);
      }
    }
    throw last;
  }
}

function envelopeFrom(msg: ImapFetchMessage): string {
  return msg.envelope?.from?.[0]?.address ?? "";
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function sleep(ms: number): Promise<void> {
  if (process.env.NODE_ENV === "test") return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
