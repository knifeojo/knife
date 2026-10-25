import { db } from "@/lib/db";
import { aiRouting, configFor, routingFor, type AiConfig, type AiRouting } from "./client";
import { aiStatus, type Fetch } from "./ollama";
import { categorizersFor, cloudCategorizeLLM, ollamaCategorizeLLM, suggestCategories, type CategorizeLLM, type Categorizer } from "./categorizer";
import { redactorFor } from "./redact";

// `npm run ai:suggest`: works through the backlog of rows the rules could not label, in small
// batches, storing AI suggestions for Review. Stoppable and re-runnable at any point.
// In hybrid mode the local model goes first and unsure rows get a cloud second opinion (--escalate).

export interface SuggestArgs {
  limit: number;
  dryRun: boolean;
  email?: string;
  batch?: number;
  retryFailed: boolean;
  enable: boolean;
  /** Second opinions for unsure rows. Undefined follows the routing (on in hybrid). */
  escalate?: boolean;
  help: boolean;
}

export const USAGE = `Usage: npm run ai:suggest -- [--limit 50] [--dry-run] [--email you@example.com] [--batch 8] [--retry-failed] [--enable] [--escalate | --no-escalate]
  --limit N        look at up to N uncertain transactions this run (default 50)
  --dry-run        ask the model and print what it would suggest; store nothing
  --email          which account (needed when the database has more than one)
  --batch N        transactions per model request (default 8 locally)
  --retry-failed   ask again about rows the model could not answer last time
  --enable         switch AI on for the account (same as the Settings toggle)
  --escalate       second opinion for rows the local model is unsure about, answers badly or cannot
                   answer (default on in hybrid; the cloud model, through redaction)
  --no-escalate    local model only for this run`;

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
    escalate: argv.includes("--no-escalate") ? false : argv.includes("--escalate") ? true : undefined,
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** First-pass provider instead of the routing's. */
  config?: AiConfig;
  routing?: AiRouting;
  fetch?: Fetch;
  llm?: CategorizeLLM;
  /** Second-opinion model instead of the routing's. */
  escalate?: Categorizer;
}

const describe = (c: { provider: string; model: string }) => (c.provider === "anthropic" ? `Anthropic (cloud, redacted) · model ${c.model}` : `Ollama (local) · model ${c.model}`);

/** Returns the process exit code. 0 done, 1 usage or setup problem, 2 model unreachable. Never throws for a missing model. */
export async function runSuggestCli(args: SuggestArgs, io: CliIo): Promise<number> {
  if (args.help) {
    io.out(USAGE);
    return 0;
  }
  const server = io.routing ?? aiRouting();
  if (server.problem) {
    io.err(server.problem);
    return 1;
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

  const routing = io.routing ?? (await routingFor(user.id));
  const cat = routing.features.categorize;
  const config = io.config ?? configFor(routing, cat.route);
  if (config.provider === "off" || config.problem) {
    io.err(config.problem ?? cat.note ?? "AI categorization is off.");
    return 1;
  }
  if (!user.aiConsent) {
    if (!args.enable) {
      io.err(`AI is switched off for ${user.email}. Turn it on in Settings, or re-run with --enable.`);
      return 1;
    }
    await db.user.update({ where: { id: user.id }, data: { aiConsent: true } });
    io.out(`AI switched on for ${user.email}.`);
  }

  const wantEscalation = args.escalate !== false;
  const resolved = await categorizersFor(user.id, routing, { fetch: io.fetch, escalate: wantEscalation });
  const first: Categorizer = io.llm
    ? { llm: io.llm, provider: config.provider === "anthropic" ? "anthropic" : "ollama", model: config.model }
    : config.provider === "anthropic"
      ? { llm: cloudCategorizeLLM({ redactor: await redactorFor(user.id) }), provider: "anthropic", model: config.model, batchSize: resolved.first?.batchSize }
      : { llm: ollamaCategorizeLLM({ config, fetch: io.fetch }), provider: "ollama", model: config.model };
  const second = wantEscalation ? (io.escalate ?? resolved.second) : undefined;

  io.out(`Categorize: ${describe(first)}${config.baseUrl ? ` at ${config.baseUrl}` : ""}`);
  if (second) io.out(`Escalation: ${describe(second)}. Unsure, invalid or unanswered rows get a second opinion.`);
  else io.out(`Escalation: off${!wantEscalation ? " (--no-escalate)" : routing.features.escalation.note ? ` (${routing.features.escalation.note})` : ""}`);
  if (args.escalate === true && !second) io.err(`--escalate has nothing to escalate to: ${routing.features.escalation.note ?? "escalation is off for this account."}`);

  if (first.provider === "ollama") {
    const status = await aiStatus({ config, fetch: io.fetch });
    if (!status.reachable || !status.modelInstalled) {
      if (second?.provider === "anthropic") {
        io.out(`${status.message}`);
        io.out("Sending uncertain rows to the cloud model instead (redacted).");
      } else {
        io.err(status.message);
        io.err("No changes were made. The Ledger server keeps working without AI.");
        return 2;
      }
    }
  }

  const started = Date.now();
  const r = await suggestCategories(user.id, {
    categorizer: first,
    escalate: second ?? false,
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
      const who = p.provider === "anthropic" ? "cloud" : "local";
      const label = p.suggestion ? `${p.suggestion.category}${p.suggestion.subcategory ? ` / ${p.suggestion.subcategory}` : ""} (${Math.round(p.suggestion.confidence * 100)}%) ${p.suggestion.reason}` : `no suggestion: ${p.rejected}`;
      io.out(`${p.amount.padStart(14)}  ${p.narration.slice(0, 60).padEnd(60)}  ${p.current} -> [${who}] ${label}`);
    }
    io.out(`Dry run: ${r.suggested} suggestions, ${r.rejected} rejected out of ${r.asked}. Nothing was stored.`);
  } else {
    io.out(`Done: ${r.suggested} suggestions stored, ${r.rejected} rejected, ${r.remaining} uncertain transactions left.`);
  }
  io.out(`Local: ${r.local.rows} rows sent, ${r.local.suggested} suggestions · Cloud: ${r.cloud.rows} rows sent${r.escalated ? ` (${r.escalated} escalated)` : ""}, ${r.cloud.suggested} suggestions`);
  if (!args.dryRun) {
    if (r.suggested) io.out("Open Review (web or phone) to confirm them. Nothing changes until you do.");
    if (r.remaining && !r.stopped) io.out(`Run again to continue: npm run ai:suggest -- --limit ${args.limit}`);
  }
  if (r.escalationStopped) io.err(`Second opinions stopped: ${r.escalationStopped} Local answers were kept.`);
  if (r.stopped) {
    io.err(`Stopped early: ${r.stopped}`);
    io.err("Progress so far is saved; run the same command again to resume.");
    return 2;
  }
  return 0;
}
