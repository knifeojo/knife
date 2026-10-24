import { db } from "@/lib/db";
import { aiConfig, type AiConfig } from "./client";
import { aiStatus, type Fetch } from "./ollama";
import { ollamaCategorizeLLM, suggestCategories, type CategorizeLLM } from "./categorizer";

// `npm run ai:suggest`: works through the backlog of rows the rules could not label, in small
// batches, storing AI suggestions for Review. Stoppable and re-runnable at any point.

export interface SuggestArgs {
  limit: number;
  dryRun: boolean;
  email?: string;
  batch?: number;
  retryFailed: boolean;
  enable: boolean;
  help: boolean;
}

export const USAGE = `Usage: npm run ai:suggest -- [--limit 50] [--dry-run] [--email you@example.com] [--batch 8] [--retry-failed] [--enable]
  --limit N        look at up to N uncertain transactions this run (default 50)
  --dry-run        ask the model and print what it would suggest; store nothing
  --email          which account (needed when the database has more than one)
  --batch N        transactions per model request (default 8 locally)
  --retry-failed   ask again about rows the model could not answer last time
  --enable         switch AI on for the account (same as the Settings toggle)`;

export function parseSuggestArgs(argv: string[]): SuggestArgs {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    const v = i >= 0 ? argv[i + 1] : undefined;
    return v && !v.startsWith("--") ? v : undefined;
  };
  const int = (flag: string) => {
    const v = value(flag);
    const n = v === undefined ? Number.NaN : Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  return {
    limit: int("--limit") ?? 50,
    dryRun: argv.includes("--dry-run"),
    email: value("--email"),
    batch: int("--batch"),
    retryFailed: argv.includes("--retry-failed"),
    enable: argv.includes("--enable"),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  config?: AiConfig;
  fetch?: Fetch;
  llm?: CategorizeLLM;
}

/** Returns the process exit code. 0 done, 1 usage or setup problem, 2 model unreachable. Never throws for a missing model. */
export async function runSuggestCli(args: SuggestArgs, io: CliIo): Promise<number> {
  if (args.help) {
    io.out(USAGE);
    return 0;
  }
  const config = io.config ?? aiConfig();
  if (config.provider === "off" || config.problem) {
    io.err(config.problem ?? "AI is off on this server.");
    return 1;
  }
  io.out(config.cloud ? `Provider: Anthropic (cloud, set by AI_PROVIDER) · model ${config.model}` : `Provider: Ollama at ${config.baseUrl} · model ${config.model}`);

  const status = await aiStatus({ config, fetch: io.fetch });
  if (!status.reachable || !status.modelInstalled) {
    io.err(status.message);
    io.err("No changes were made. The Ledger server keeps working without AI.");
    return 2;
  }

  const users = args.email
    ? await db.user.findMany({ where: { email: args.email } })
    : await db.user.findMany({ where: { isDemo: false }, take: 2 });
  if (!users.length) {
    io.err(args.email ? `No account with email ${args.email}.` : "No accounts yet. Sign up in the web app first.");
    return 1;
  }
  if (users.length > 1) {
    io.err("More than one account in this database. Pick one with --email you@example.com");
    return 1;
  }
  const user = users[0];
  if (!user.aiConsent) {
    if (!args.enable) {
      io.err(`AI is switched off for ${user.email}. Turn it on in Settings, or re-run with --enable.`);
      return 1;
    }
    await db.user.update({ where: { id: user.id }, data: { aiConsent: true } });
    io.out(`AI switched on for ${user.email}.`);
  }

  const llm = io.llm ?? (config.provider === "ollama" ? ollamaCategorizeLLM({ config, fetch: io.fetch }) : undefined);
  const started = Date.now();
  const r = await suggestCategories(user.id, {
    llm,
    config,
    limit: args.limit,
    batchSize: args.batch,
    dryRun: args.dryRun,
    retryFailed: args.retryFailed,
    onBatch: (p) => {
      const secs = Math.round((Date.now() - started) / 1000);
      io.out(`[${String(p.done).padStart(String(p.total).length)}/${p.total}] ${p.suggested} suggested, ${p.rejected} rejected · ${secs}s`);
    },
  });

  if (!r.backlog) {
    io.out("Nothing to do: every uncertain transaction has already been looked at.");
    return 0;
  }
  if (args.dryRun) {
    for (const p of r.preview) {
      const label = p.suggestion ? `${p.suggestion.category}${p.suggestion.subcategory ? ` / ${p.suggestion.subcategory}` : ""} (${Math.round(p.suggestion.confidence * 100)}%) ${p.suggestion.reason}` : `no suggestion: ${p.rejected}`;
      io.out(`${p.amount.padStart(14)}  ${p.narration.slice(0, 60).padEnd(60)}  ${p.current} -> ${label}`);
    }
    io.out(`Dry run: ${r.suggested} suggestions, ${r.rejected} rejected out of ${r.asked}. Nothing was stored.`);
  } else {
    io.out(`Done: ${r.suggested} suggestions stored, ${r.rejected} rejected, ${r.remaining} uncertain transactions left.`);
    if (r.suggested) io.out("Open Review (web or phone) to confirm them. Nothing changes until you do.");
    if (r.remaining && !r.stopped) io.out(`Run again to continue: npm run ai:suggest -- --limit ${args.limit}`);
  }
  if (r.stopped) {
    io.err(`Stopped early: ${r.stopped}`);
    io.err("Progress so far is saved; run the same command again to resume.");
    return 2;
  }
  return 0;
}
