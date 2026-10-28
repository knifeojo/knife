import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { LEGACY_GIVING_SUBCATEGORIES, categorize, inferHolderName, type UserRule } from "./categorize";
import { accountKey, amountsMatch, computeFingerprint, findFuzzyMatch, pickStatementAmountMatch, pickStatementReplay, statementCoversDate } from "./dedup";
import { parseEmail } from "./parsers";
import type { EmailSource } from "./providers/types";
import { emailSearchQueries } from "./alerts/statement-mail";
import { INITIAL_LOOKBACK_DAYS, MAX_MESSAGES_PER_SYNC } from "./sources";
import type { KnownPerson } from "./people-match";
import { extractPayoutQuote } from "./fx/quotes";
import { storeQuotedRate } from "./fx/realised";
import { pairOwnTransfers } from "./transfers";
import type { CanonicalTransaction } from "./types";

export type IngestResult =
  | { status: "created"; transactionId: string }
  | { status: "duplicate"; transactionId: string; matchType: "source" | "exact" | "fuzzy" };

/** Names of the user, for spotting transfers between their own accounts (reordered names included). */
export async function loadOwners(userId: string): Promise<string[]> {
  const [accts, user, mes] = await Promise.all([
    db.account.findMany({ where: { userId, holderName: { not: null } }, select: { holderName: true } }),
    db.user.findUnique({ where: { id: userId }, select: { name: true } }),
    db.person.findMany({
      where: { userId, relationship: "me" },
      select: { displayName: true, aliases: { where: { rejected: false }, select: { name: true } } },
    }),
  ]);
  const names = [
    ...accts.map((a) => a.holderName!),
    ...(user?.name ? [user.name] : []),
    ...mes.flatMap((p) => [p.displayName, ...p.aliases.map((a) => a.name)]),
  ];
  return [...new Set(names.filter(Boolean))];
}

/** The owner's learned rules (MerchantAlias) plus the people they told Ledger about. */
export async function loadUserRules(userId: string): Promise<UserRule[]> {
  const [aliases, people] = await Promise.all([
    db.merchantAlias.findMany({
      where: { userId },
      select: { pattern: true, canonicalName: true, category: true, subcategory: true },
    }),
    loadKnownPeople(userId),
  ]);
  return [...aliases, ...people.map((p) => ({ pattern: `person:${p.id}`, canonicalName: p.displayName, category: null, subcategory: null, person: p }))];
}

export async function loadKnownPeople(userId: string): Promise<KnownPerson[]> {
  const rows = await db.person.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    include: { aliases: { select: { name: true, key: true, rejected: true } } },
  });
  return rows.map((p) => ({
    id: p.id, displayName: p.displayName, relationship: p.relationship, vendorCategory: p.vendorCategory, vendorSubcategory: p.vendorSubcategory, aliases: p.aliases,
  }));
}

async function upsertAccount(userId: string, tx: CanonicalTransaction) {
  const known = await db.account.findMany({ where: { userId, institution: tx.institution, currency: tx.currency } });
  if (!tx.accountLast4) {
    // Alert without an account number: attach to the user's only matching account if unambiguous.
    const real = known.filter((a) => a.maskedAccountNumber !== "PRIMARY");
    if (real.length === 1) return real[0];
  } else {
    // Masked and full numbers for the same account ("533" vs "3533") resolve to one account.
    const digits = tx.accountLast4;
    const match = known.find((a) => {
      const d = a.maskedAccountNumber.replace(/\D/g, "");
      return d && (d.endsWith(digits) || digits.endsWith(d));
    });
    if (match) {
      const d = match.maskedAccountNumber.replace(/\D/g, "");
      if (digits.length > d.length) {
        return db.account.update({
          where: { id: match.id },
          data: { maskedAccountNumber: `****${digits}`, accountName: `${tx.institution} ${tx.currency} ••${digits}` },
        });
      }
      return match;
    }
  }
  const masked = tx.accountLast4 ? `****${tx.accountLast4}` : "PRIMARY";
  return db.account.upsert({
    where: { userId_institution_maskedAccountNumber: { userId, institution: tx.institution, maskedAccountNumber: masked } },
    update: {},
    create: {
      userId,
      institution: tx.institution,
      maskedAccountNumber: masked,
      accountName: `${tx.institution} ${tx.currency} ${tx.accountLast4 ? `••${tx.accountLast4}` : "account"}`,
      currency: tx.currency,
    },
  });
}

/**
 * When the same transaction arrives again with a fuller description (e.g. a statement re-read with a
 * better reader, or the full statement after a short extract), upgrade the stored description and the
 * payee. Labels the user set and links stay; rows labelled by rules are re-labelled from the new text.
 */
async function enrich(userId: string, transactionId: string, tx: CanonicalTransaction, userRules?: UserRule[], owners?: string[]) {
  const existing = await db.transaction.findUnique({ where: { id: transactionId } });
  if (!existing || tx.description === existing.description) return;
  // Re-reading the SAME kind of document (statement vs statement): the newer reading wins, so earlier
  // reader mistakes are corrected. Across sources (alert vs statement) only a richer version wins —
  // except a statement is the source of truth and always upgrades the stored fields.
  if (existing.source !== tx.source && tx.source !== "statement") {
    if (tx.description.length <= existing.description.length) return;
    const words = (s: string) => s.toUpperCase().replace(/\d{6,}/g, " ").split(/[^A-Z0-9]+/).filter((w) => w.length >= 3);
    const oldWords = words(existing.description);
    const newWords = new Set(words(tx.description));
    if (oldWords.length && oldWords.filter((w) => newWords.has(w)).length / oldWords.length < 0.8) return;
  }
  const c = categorize({ description: tx.description, type: tx.type }, userRules ?? (await loadUserRules(userId)), owners ?? (await loadOwners(userId)));
  const keepLabel = existing.classificationSource === "user" || existing.classificationSource === "pair";
  await db.transaction.update({
    where: { id: transactionId },
    data: {
      description: tx.description,
      reference: existing.reference ?? tx.reference,
      counterparty: c.counterparty ?? (c.category === "Fees" ? null : existing.counterparty),
      merchantName: c.merchantName ?? existing.merchantName,
      personId: c.personId ?? existing.personId,
      destinationCountry: c.destinationCountry ?? existing.destinationCountry,
      destinationCurrency: c.destinationCurrency ?? existing.destinationCurrency,
      ...(keepLabel ? {} : { category: c.category, subcategory: c.subcategory ?? null, classificationSource: c.source, classificationConfidence: c.confidence }),
    },
  });
}

/**
 * The single entry point into the ledger for every source (email, fixture, demo, and later
 * statements / open banking / SMS). Handles normalization, dedup, categorization and persistence.
 */
export async function ingestTransaction(userId: string, tx: CanonicalTransaction, userRules?: UserRule[], owners?: string[]): Promise<IngestResult> {
  const seen = await db.transactionSource.findUnique({
    where: { userId_source_sourceTransactionId: { userId, source: tx.source, sourceTransactionId: tx.sourceTransactionId } },
  });
  if (seen) return { status: "duplicate", transactionId: seen.transactionId, matchType: "source" };

  const account = await upsertAccount(userId, tx);
  if (tx.accountHolder && !account.holderName) {
    await db.account.update({ where: { id: account.id }, data: { holderName: tx.accountHolder } });
  }
  const fingerprint = computeFingerprint(tx);

  const link = async (transactionId: string, matchType: "exact" | "fuzzy"): Promise<IngestResult> => {
    await db.transactionSource.create({
      data: { userId, transactionId, source: tx.source, sourceTransactionId: tx.sourceTransactionId, matchType },
    });
    await enrich(userId, transactionId, tx, userRules, owners);
    return { status: "duplicate", transactionId, matchType };
  };

  const exact = await db.transaction.findUnique({ where: { userId_fingerprint: { userId, fingerprint } } });
  if (exact) return link(exact.id, "exact");

  // Wide enough for ±1 Lagos day (a statement value date at UTC midnight vs an evening SMS in WAT).
  // Description fuzzy matching still requires 36h; see isFuzzyMatch.
  const window = 3 * 86_400_000;
  const foreign = tx.source === "statement" && tx.currency !== "NGN";
  const candidates = await db.transaction.findMany({
    where: {
      userId,
      accountId: account.id,
      type: tx.type,
      // A wallet re-read can be one cent off, or labelled CAD where the stored row says USD.
      ...(foreign
        ? { amountMinor: { gte: tx.amountMinor > 0n ? tx.amountMinor - 1n : 0n, lte: tx.amountMinor + 1n } }
        : { amountMinor: tx.amountMinor, currency: tx.currency }),
      transactionDate: { gte: new Date(tx.transactionDate.getTime() - window), lte: new Date(tx.transactionDate.getTime() + window) },
    },
    include: { sources: { select: { source: true } } },
  });
  const mapped = candidates.map((c) => ({
    ...c,
    accountKey: accountKey(tx.institution, tx.accountLast4),
    sources: [...new Set([c.source, ...c.sources.map((s) => s.source)])],
  }));
  const fuzzy = findFuzzyMatch(tx, mapped.filter((c) => c.currency === tx.currency && amountsMatch(c.amountMinor, tx.amountMinor, "NGN")));
  if (fuzzy) return link(fuzzy.id, "fuzzy");
  const replay = tx.source === "statement" ? pickStatementReplay(tx, mapped) : undefined;
  if (replay) return link(replay.id, "fuzzy");
  const covered = statementCoversDate(account.statementCoveredFrom, account.statementCoveredTo, tx.transactionDate);
  const byDay = pickStatementAmountMatch(tx, mapped, covered);
  if (byDay) return link(byDay.id, "fuzzy");

  const ownerNames = [...(owners ?? (await loadOwners(userId))), ...(tx.accountHolder ? [tx.accountHolder] : [])];
  const c = categorize({ description: tx.description, type: tx.type }, userRules ?? (await loadUserRules(userId)), ownerNames);

  let fxQuoteCurrency = tx.fxQuoteCurrency;
  let fxQuoteMinor = tx.fxQuoteMinor;
  if ((!fxQuoteMinor || fxQuoteMinor <= 0n) && tx.currency !== "NGN" && tx.type === "DEBIT") {
    const quoted = extractPayoutQuote(tx.description, tx.amountMinor);
    if (quoted) {
      fxQuoteCurrency = "NGN";
      fxQuoteMinor = quoted.ngnMinor;
    }
  }

  try {
    const created = await db.transaction.create({
      data: {
        userId,
        accountId: account.id,
        source: tx.source,
        sourceTransactionId: tx.sourceTransactionId,
        fingerprint,
        transactionDate: tx.transactionDate,
        type: tx.type,
        amountMinor: tx.amountMinor,
        currency: tx.currency,
        balanceAfterMinor: tx.balanceAfterMinor,
        fxQuoteCurrency,
        fxQuoteMinor,
        description: tx.description,
        reference: tx.reference,
        counterparty: c.counterparty,
        merchantName: c.merchantName,
        category: c.category,
        subcategory: c.subcategory,
        classificationSource: c.source,
        classificationConfidence: c.confidence,
        personId: c.personId,
        destinationCountry: c.destinationCountry ?? tx.destinationCountry,
        destinationCurrency: c.destinationCurrency ?? tx.destinationCurrency,
        parseConfidence: tx.confidence,
        sources: {
          create: { userId, source: tx.source, sourceTransactionId: tx.sourceTransactionId, matchType: "created" },
        },
      },
    });

    if (tx.balanceAfterMinor !== undefined && (!account.balanceUpdatedAt || tx.transactionDate >= account.balanceUpdatedAt)) {
      await db.account.update({
        where: { id: account.id },
        data: { balanceMinor: tx.balanceAfterMinor, balanceUpdatedAt: tx.transactionDate },
      });
    }
    if (fxQuoteMinor && fxQuoteCurrency) {
      await storeQuotedRate(userId, { ...tx, fxQuoteCurrency, fxQuoteMinor });
    }
    return { status: "created", transactionId: created.id };
  } catch (e) {
    // Concurrent sync inserted the same fingerprint first
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const again = await db.transaction.findUnique({ where: { userId_fingerprint: { userId, fingerprint } } });
      if (again) return link(again.id, "exact");
    }
    throw e;
  }
}

export interface SyncSummary {
  syncRunId: string;
  emailsScanned: number;
  parsed: number;
  created: number;
  duplicates: number;
  parseFailures: number;
  skipped: number;
}

/** Incremental email sync: fetch new candidate alerts, parse, ingest, record metadata and metrics. */
export async function syncEmailSource(userId: string, connectionId: string, source: EmailSource): Promise<SyncSummary> {
  const conn = await db.financialConnection.findFirstOrThrow({ where: { id: connectionId, userId } });
  const run = await db.syncRun.create({ data: { userId, connectionId, status: "running" } });
  const m = { emailsScanned: 0, parsed: 0, created: 0, duplicates: 0, parseFailures: 0, skipped: 0 };
  const confidences: number[] = [];
  // Re-scan a 2 day overlap; processed message ids make the overlap free.
  const after = conn.lastSyncedAt
    ? new Date(conn.lastSyncedAt.getTime() - 2 * 86400_000)
    : new Date(Date.now() - INITIAL_LOOKBACK_DAYS * 86400_000);

  try {
    const rules = await loadUserRules(userId);
    const owners = await loadOwners(userId);
    let lastId: string | undefined;
    let historyId: string | undefined;
    let historyTried = false;
    let historyCoveredAll = false;
    for (const query of emailSearchQueries(source.source)) {
      if (historyCoveredAll) break;
      let ids: string[] = [];
      if (!historyTried && source.listHistoryMessageIds && conn.gmailHistoryId && conn.lastSyncedAt) {
        historyTried = true;
        const hist = await source.listHistoryMessageIds(conn.gmailHistoryId);
        if (hist.stale) ids = await source.listMessageIds({ query, after, max: MAX_MESSAGES_PER_SYNC });
        else {
          ids = hist.ids.slice(0, MAX_MESSAGES_PER_SYNC);
          historyId = hist.historyId;
          historyCoveredAll = true;
        }
      } else {
        ids = await source.listMessageIds({ query, after, max: MAX_MESSAGES_PER_SYNC });
      }
      const done = new Set(
        (await db.processedEmail.findMany({ where: { userId, messageId: { in: ids } }, select: { messageId: true } })).map((p) => p.messageId),
      );
      for (const id of ids) {
        if (done.has(id)) continue;
        m.emailsScanned++;
        const email = await source.getMessage(id);
        const { importEmailAttachments } = await import("./alerts/import-statements");
        const statements = await importEmailAttachments(userId, {
          source: source.source,
          messageId: id,
          from: email.from,
          subject: email.subject,
          attachments: email.attachments,
          fetchAttachment: source.fetchAttachment ? (attachmentId) => source.fetchAttachment!(id, attachmentId) : undefined,
        }).catch((e: unknown) => {
          log.error("statement.email_failed", { userId, messageId: id, error: e instanceof Error ? e.message : "unknown" });
          return [];
        });
        const outcome = parseEmail(email);
        let status = outcome.status as string;
        let transactionId: string | undefined;
        if (outcome.status === "parsed") {
          m.parsed++;
          confidences.push(outcome.transaction.confidence);
          const r = await ingestTransaction(userId, { ...outcome.transaction, source: source.source, sourceTransactionId: id }, rules, owners);
          transactionId = r.transactionId;
          if (r.status === "created") {
            m.created++;
            const { linkAdjacentFee } = await import("./alerts/fees");
            await linkAdjacentFee(userId, r.transactionId);
          } else {
            m.duplicates++;
            status = "duplicate";
          }
        } else if (outcome.status === "failed") {
          m.parseFailures++;
          const { queueKnownUnparsed } = await import("./alerts/ingest-email");
          await queueKnownUnparsed(userId, email, outcome.parser);
        } else if (statements.length) {
          status = statements.every((file) => file.status === "duplicate") ? "duplicate" : "parsed";
        } else m.skipped++;

        // Metadata only. The body is dropped here and never persisted.
        await db.processedEmail.create({
          data: {
            userId,
            connectionId,
            messageId: id,
            sender: email.from.slice(0, 200),
            subject: email.subject.slice(0, 200),
            receivedAt: email.date,
            status,
            parser: statements.length && outcome.status !== "parsed" ? "statement" : "parser" in outcome ? outcome.parser : null,
            transactionId,
          },
        });
        lastId = id;
      }
    }

    await pairOwnTransfers(userId);
    const accounts = await db.account.findMany({ where: { userId }, select: { id: true } });
    const { scanBalanceGaps } = await import("./alerts/balance");
    for (const a of accounts) await scanBalanceGaps(userId, a.id);
    await db.financialConnection.update({
      where: { id: connectionId },
      data: {
        lastSyncedAt: new Date(),
        lastProcessedMessageId: lastId ?? conn.lastProcessedMessageId,
        status: "active",
        lastError: null,
        ...(historyId ? { gmailHistoryId: historyId } : {}),
      },
    });
    await db.syncRun.update({
      where: { id: run.id },
      data: {
        ...m,
        status: "success",
        finishedAt: new Date(),
        avgConfidence: confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null,
      },
    });
    log.info("sync.success", { userId, connectionId, source: source.source, ...m });
    return { syncRunId: run.id, ...m };
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    await db.syncRun.update({ where: { id: run.id }, data: { ...m, status: "failed", finishedAt: new Date(), error: message.slice(0, 300) } });
    await db.financialConnection.update({ where: { id: connectionId }, data: { lastError: message.slice(0, 300) } });
    log.error("sync.failed", { userId, connectionId, source: source.source, error: message });
    throw e;
  }
}

/**
 * Re-applies the current rules to every transaction the user has not categorized by hand.
 * Used after rules improve, or after the account holder becomes known.
 */
export function reapplyMessage(r: { checked: number; changed: number }): string {
  return `Checked ${r.checked} transactions, updated ${r.changed}. Your manual corrections were left as they are.`;
}

export async function reapplyCategories(userId: string): Promise<{ checked: number; changed: number }> {
  // Giving was a subcategory of Other. Labels the user chose keep their meaning under the new category.
  const legacyGiving = { userId, category: "Other", subcategory: { in: LEGACY_GIVING_SUBCATEGORIES } };
  await db.merchantAlias.updateMany({ where: legacyGiving, data: { category: "Giving" } });
  const moved = await db.transaction.updateMany({ where: legacyGiving, data: { category: "Giving" } });
  const rules = await loadUserRules(userId);
  const debits = await db.transaction.findMany({ where: { userId, type: "DEBIT" }, select: { description: true } });
  const inferred = inferHolderName(debits.map((d) => d.description));
  if (inferred) await db.account.updateMany({ where: { userId, holderName: null }, data: { holderName: inferred } });
  const owners = [...new Set([...(await loadOwners(userId)), ...(inferred ? [inferred] : [])])];
  const rows = await db.transaction.findMany({ where: { userId, classificationSource: { notIn: ["user", "pair"] } } });
  let changed = moved.count;
  for (const t of rows) {
    const c = categorize({ description: t.description, type: t.type as "DEBIT" | "CREDIT" }, rules, owners);
    const next = {
      category: c.category,
      subcategory: c.subcategory ?? null,
      merchantName: c.merchantName ?? null,
      counterparty: c.counterparty ?? null,
      classificationSource: c.source,
      classificationConfidence: c.confidence,
      personId: c.personId ?? null,
      destinationCountry: c.destinationCountry ?? t.destinationCountry,
      destinationCurrency: c.destinationCurrency ?? t.destinationCurrency,
    };
    if (Object.entries(next).some(([k, v]) => (t as Record<string, unknown>)[k] !== v)) {
      await db.transaction.update({ where: { id: t.id }, data: next });
      changed++;
    }
  }
  changed += 2 * (await pairOwnTransfers(userId));
  return { checked: rows.length, changed };
}
