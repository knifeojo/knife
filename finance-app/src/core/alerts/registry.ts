import { createHash } from "node:crypto";
import { MONEY_RE } from "./money";
import { FirstBankSmsParser } from "./firstbank-sms";
import { GenericFallbackParser } from "./fallback";
import { GTBankEmailParser } from "./email-adapter";
import { GTBankSmsParser } from "./gtbank-sms";
import { isAllowedSmsSender, isBankMarketing, isKnownBankSender, smsSenderIds } from "./senders";
import { ProvidusSmsParser } from "./providus-sms";
import { SterlingSmsParser } from "./sterling-sms";
import { STUB_PARSERS } from "./stubs";
import type { AlertMessage, AlertParser, ParseAlertOutcome } from "./types";

export const FALLBACK = new GenericFallbackParser();

export const ALERT_PARSERS: AlertParser[] = [
  new GTBankEmailParser(),
  new GTBankSmsParser(),
  new FirstBankSmsParser(),
  new SterlingSmsParser(),
  new ProvidusSmsParser(),
  ...STUB_PARSERS,
];

export function parsersFor(msg: AlertMessage): AlertParser[] {
  const sender = msg.sender.trim().toLowerCase();
  const domain = sender.includes("@") ? sender.slice(sender.lastIndexOf("@") + 1) : sender;
  return ALERT_PARSERS.filter((p) => {
    if (!p.channels.includes(msg.channel) || p.stub) return false;
    return p.senders.some((s) => {
      const n = s.toLowerCase();
      return n === sender || n === domain || domain.endsWith(`.${n}`);
    });
  });
}

/**
 * Deterministic: first matching parser for this channel+sender wins.
 * Known bank senders that no parser can read become `unparsed` (Review).
 * The generic fallback is last and always `review` (never auto-posts).
 */
export function parseAlert(msg: AlertMessage, parsers: AlertParser[] = ALERT_PARSERS): ParseAlertOutcome {
  if (msg.channel === "sms" && !isAllowedSmsSender(msg.sender)) return { status: "skipped" };
  if (isBankMarketing(msg.body, msg.subject)) return { status: "skipped" };

  const pool = parsers === ALERT_PARSERS ? parsersFor(msg) : parsers.filter((p) => p.channels.includes(msg.channel) && !p.stub);
  for (const parser of pool) {
    if (!parser.canParse(msg)) continue;
    try {
      const tx = parser.parse(msg);
      if (!tx) return { status: "failed", parser: parser.name };
      if (!tx.autoPost) return { status: "review", parser: parser.name, transaction: tx };
      return { status: "parsed", parser: parser.name, transaction: tx };
    } catch {
      return { status: "failed", parser: parser.name };
    }
  }

  if (FALLBACK.canParse(msg)) {
    const tx = FALLBACK.parse(msg);
    if (tx) return { status: "review", parser: FALLBACK.name, transaction: tx };
  }

  if (isKnownBankSender(msg.sender, msg.channel)) {
    const text = `${msg.subject ?? ""}\n${msg.body}`;
    if (!MONEY_RE.test(text)) return { status: "skipped" };
    return { status: "unparsed", reason: "known_sender" };
  }
  return { status: "skipped" };
}

export function alertSourceId(msg: AlertMessage, explicit?: string): string {
  if (explicit) return explicit.slice(0, 200);
  if (msg.id) return msg.id.slice(0, 200);
  return createHash("sha256").update(`${msg.channel}|${msg.sender}|${msg.body}|${msg.receivedAt.toISOString()}`).digest("hex");
}

/** JSON the phone (and tests) consume so device and server stay on the same senders/parsers. */
export function parserRegistryJson() {
  return {
    version: 1,
    smsSenders: smsSenderIds(),
    blocked: ["303", "GloDataSale", "GLO-ROAM", "VIDEO", "getmigo", "MYD ALERT"],
    parsers: ALERT_PARSERS.map((p) => ({
      name: p.name,
      institution: p.institution,
      channels: [...p.channels],
      senders: [...p.senders],
      stub: !!p.stub,
    })),
  };
}
