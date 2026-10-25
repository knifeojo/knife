import { aiConfig, isLocalUrl, type AiConfig } from "./client";

// Minimal Ollama HTTP client: POST /api/chat (JSON-schema structured output, or tool calls), and
// GET /api/tags for status. fetch is injectable so tests never touch the network.

export type Fetch = typeof fetch;

/** A model is not running, not pulled, timed out, or the cloud refused. Callers stop or fall back. */
export class AiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiUnavailableError";
  }
}

const CHAT_TIMEOUT_MS = 180_000;
const STATUS_TIMEOUT_MS = 2_500;

function notRunning(baseUrl: string) {
  return new AiUnavailableError(`Ollama is not reachable at ${baseUrl}. Start it with "ollama serve" (or open the Ollama app), then try again. Ledger keeps working without AI.`);
}

function guard(config: AiConfig): string {
  if (config.provider !== "ollama" || !config.baseUrl) throw new AiUnavailableError("Ollama is not the configured AI provider.");
  if (config.problem) throw new AiUnavailableError(config.problem);
  // Checked again here, right before the request, so no code path can send rows off this machine.
  if (!isLocalUrl(config.baseUrl)) throw new AiUnavailableError("OLLAMA_BASE_URL must be on this machine.");
  return config.baseUrl;
}

export interface OllamaOptions {
  config?: AiConfig;
  fetch?: Fetch;
  timeoutMs?: number;
}

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> | string } }[];
  tool_name?: string;
}

/** One non-streaming /api/chat request. Returns the reply message. */
export async function ollamaPost(body: Record<string, unknown>, opts: OllamaOptions = {}): Promise<OllamaMessage | undefined> {
  const config = opts.config ?? aiConfig();
  const baseUrl = guard(config);
  const f = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model, stream: false, keep_alive: "10m", options: { temperature: 0 }, ...body }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? CHAT_TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new AiUnavailableError(`Ollama did not answer in time. A smaller model (OLLAMA_MODEL) or a smaller --batch may help.`);
    }
    throw notRunning(baseUrl);
  }
  if (res.status === 404) {
    throw new AiUnavailableError(`The model "${config.model}" is not installed. Run: ollama pull ${config.model}`);
  }
  if (!res.ok) throw new AiUnavailableError(`Ollama returned an error (${res.status}).`);
  const json = (await res.json().catch(() => undefined)) as { message?: OllamaMessage } | undefined;
  return json?.message;
}

export interface OllamaChatRequest {
  system: string;
  user: string;
  /** JSON schema the reply must follow (Ollama structured outputs). */
  schema: object;
}

/** One structured chat turn. Returns the parsed JSON reply, or undefined when the model did not return JSON. */
export async function ollamaChat(req: OllamaChatRequest, opts: OllamaOptions = {}): Promise<unknown> {
  const message = await ollamaPost(
    {
      format: req.schema,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    },
    opts,
  );
  const content = message?.content;
  if (typeof content !== "string") return undefined;
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

export interface AiStatus {
  provider: AiConfig["provider"];
  model: string;
  baseUrl?: string;
  cloud: boolean;
  reachable: boolean;
  modelInstalled: boolean;
  message: string;
}

/** Whether Ollama can answer right now. Never throws. Cloud status lives in ./cloud.ts. */
export async function aiStatus(opts: { config?: AiConfig; fetch?: Fetch } = {}): Promise<AiStatus> {
  const config = opts.config ?? aiConfig();
  const base = { provider: config.provider, model: config.model, baseUrl: config.baseUrl, cloud: config.cloud };
  if (config.problem) return { ...base, reachable: false, modelInstalled: false, message: config.problem };
  if (config.provider === "anthropic") {
    return { ...base, reachable: true, modelInstalled: true, message: "Cloud provider (Anthropic). Requests are redacted before they leave this machine." };
  }
  const f = opts.fetch ?? fetch;
  try {
    const res = await f(`${guard(config)}/api/tags`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
    if (!res.ok) return { ...base, reachable: false, modelInstalled: false, message: `Ollama answered with an error (${res.status}).` };
    const body = (await res.json().catch(() => ({}))) as { models?: { name?: string; model?: string }[] };
    const names = (body.models ?? []).flatMap((m) => [m.name, m.model]).filter((n): n is string => !!n);
    const installed = names.some((n) => n === config.model || n === `${config.model}:latest`);
    return {
      ...base,
      reachable: true,
      modelInstalled: installed,
      message: installed ? `Running locally with ${config.model}. Nothing leaves this machine.` : `Ollama is running but ${config.model} is not pulled yet. Run: ollama pull ${config.model}`,
    };
  } catch {
    return { ...base, reachable: false, modelInstalled: false, message: notRunning(config.baseUrl ?? "").message };
  }
}
