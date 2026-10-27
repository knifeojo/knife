import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { EmailMessage } from "../types";
import type { EmailSource } from "../providers/types";
import { imapPassword } from "./secrets";
import { BANK_SENDERS } from "./senders";

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
}

export type ImapFactory = (cfg: ImapConfig) => ImapClientLike;

export interface ImapClientLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  mailboxOpen(path: string): Promise<unknown>;
  search(query: Record<string, unknown>): Promise<number[] | false | undefined>;
  fetch(
    range: number[] | string,
    query: Record<string, unknown>,
  ): AsyncIterable<{ source?: Buffer; uid?: number; envelope?: { from?: { address?: string }[]; subject?: string; date?: Date } }>;
}

export function defaultImapFactory(cfg: ImapConfig): ImapClientLike {
  return new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 993,
    auth: { user: cfg.user, pass: cfg.password },
    logger: false,
  }) as unknown as ImapClientLike;
}

export class ImapEmailSource implements EmailSource {
  readonly source = "imap" as const;

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

  private async withClient<T>(fn: (c: ImapClientLike) => Promise<T>): Promise<T> {
    const client = this.factory(this.cfg);
    await client.connect();
    try {
      await client.mailboxOpen("INBOX");
      return await fn(client);
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async listMessageIds({ after, max = 500 }: { query: string; after?: Date; max?: number }): Promise<string[]> {
    return this.withClient(async (c) => {
      const query: Record<string, unknown> = { seen: false };
      if (after) query.since = after;
      // Broad search (SINCE), then filter by known bank From in fetch. Read-only: we never set flags.
      const orFrom = BANK_SENDERS.filter((s) => s.channel !== "sms").map((s) => ({ from: s.id }));
      if (orFrom.length) query.or = orFrom;
      delete query.seen;
      const uids = (await c.search(after ? { since: after } : {})) || [];
      return uids.slice(0, max).map(String);
    });
  }

  async getMessage(id: string): Promise<EmailMessage> {
    return this.withClient(async (c) => {
      const uid = Number(id);
      for await (const msg of c.fetch(uid, { source: true, envelope: true, uid: true })) {
        if (!msg.source) throw new Error("IMAP message has no source");
        const parsed = await simpleParser(msg.source);
        return {
          id,
          from: parsed.from?.text ?? msg.envelope?.from?.[0]?.address ?? "",
          subject: parsed.subject ?? msg.envelope?.subject ?? "",
          date: parsed.date ?? msg.envelope?.date ?? new Date(),
          text: parsed.text || undefined,
          html: typeof parsed.html === "string" ? parsed.html : undefined,
        };
      }
      throw new Error(`IMAP message ${id} not found`);
    });
  }
}

export function yahooImapDefaults() {
  return { host: "imap.mail.yahoo.com", port: 993 };
}
