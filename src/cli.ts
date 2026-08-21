#!/usr/bin/env node
/**
 * stock-analyze CLI (interactive)
 *
 * Usage: stock-analyze [TICKER] [report]
 *
 * Launches an interactive session: prompts for a stock ticker, runs a report,
 * then accepts slash-commands and follow-up questions. Each analysis prompt is
 * an on-demand "skill" (e.g. /moat, /risk, /valuation TSLA). Type /help for the
 * full list, /new to switch stocks, or /exit to quit. A TICKER (and optional
 * default report) may be passed as arguments to skip the first prompt.
 */

import { createAgentSession, ModelRuntime, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { join } from "path";
import { createInterface } from "readline/promises";
import os from "os";
import stockAnalyzerExtension from "./extension.js";
import { validateTicker } from "./tools/market.js";
import {
  resolveApiKeys,
  loadSavedKeys,
  confirmOrSwitchProviders,
  SETUP_PROVIDERS,
  type Provider,
} from "./keys.js";
import { c } from "./ui.js";
import { LineReader } from "./io.js";
import { Spinner } from "./spinner.js";
import {
  REPORT_COMMANDS,
  findCommand,
  loadReportPrompt,
  type ReportCommand,
} from "./commands.js";

function printUsage() {
  console.error("Usage: stock-analyze [TICKER] [report]\n");
  console.error("Launches an interactive research session. Arguments are optional.");
  console.error("\nReports (invoke in-session as /<name>):");
  for (const cmd of REPORT_COMMANDS) {
    console.error(`  /${cmd.name.padEnd(12)} ${cmd.description}`);
  }
  console.error("\nOptions:");
  console.error("  --provider <id>   Model provider: anthropic, openai, google, xai, deepseek,");
  console.error("                    openrouter, azure-openai-responses, amazon-bedrock, …");
  console.error("  --model <id>      Specific model id (see --list-models)");
  console.error("  --list-models     List configured providers and their models, then exit");
  console.error("\nExamples:");
  console.error("  stock-analyze");
  console.error("  stock-analyze AAPL");
  console.error("  stock-analyze NVDA moat");
  console.error("  stock-analyze --provider google TSLA");
  console.error("  stock-analyze --model grok-4.5 NVDA moat");
  console.error(
    "\nAuth: set an API key for any provider (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY,\n" +
      "  DEEPSEEK_API_KEY, XAI_API_KEY, OPENROUTER_API_KEY, AZURE_OPENAI_API_KEY, or AWS creds).\n" +
      "  With no key set, you'll be prompted to add an Anthropic or OpenAI key on first run."
  );
}

// Args: positional [TICKER] [report], plus flags --provider/--model/--list-models.
const rawArgs = process.argv.slice(2);

if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
  printUsage();
  process.exit(0);
}

/** Read a `--flag value` or `--flag=value` option. */
function flagValue(name: string): string | undefined {
  const i = rawArgs.findIndex((a) => a === name || a.startsWith(name + "="));
  if (i === -1) return undefined;
  const a = rawArgs[i];
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : rawArgs[i + 1];
}

const listModels = rawArgs.includes("--list-models");
const flagProvider = flagValue("--provider");
const flagModel = flagValue("--model");

// Positionals are the leftover non-flag tokens (and not a flag's value).
const consumed = new Set<number>();
rawArgs.forEach((a, i) => {
  if (a === "--list-models") consumed.add(i);
  else if (a === "--provider" || a === "--model") {
    consumed.add(i);
    consumed.add(i + 1);
  } else if (a.startsWith("--provider=") || a.startsWith("--model=")) consumed.add(i);
});
const positionals = rawArgs.filter((a, i) => !consumed.has(i) && !a.startsWith("--"));

const argTicker = positionals[0]?.toUpperCase();
const reportArg = positionals[1] ?? "business";

const defaultCommand = findCommand(reportArg);
if (!defaultCommand) {
  console.error(`Unknown report: ${reportArg}`);
  printUsage();
  process.exit(1);
}

const systemPrompt = `## RUNTIME ENVIRONMENT
You are an expert equity research analyst running as a CLI tool with access to
real financial data tools — not a browser.

Rules:
1. The ticker is always supplied in the user message — NEVER ask for it.
2. No web/browser access — use: get_financials, get_financial_history, get_price_data,
   get_price_history, get_reverse_dcf, get_forward_estimates, get_upcoming_events,
   get_business_phase, get_business_description,
   get_filing_section, get_segment_revenue, compare_peers,
   get_competitors, get_analyst_sentiment, get_recent_filings, get_filing_events.
   (get_competitors returns no data without a paid key — rely on get_business_description
   for named competitors.)
   get_segment_revenue is the ONLY source of revenue by segment, product line or geography;
   get_financial_history returns consolidated totals only, so never present a consolidated
   figure as segment evidence.
   compare_peers is only ever called with companies the USER named. There is no peer-discovery
   tool here by design — never pass competitors you supplied from memory.
   get_forward_estimates, get_upcoming_events and get_analyst_sentiment carry ANALYST CONSENSUS,
   which is opinion, not SEC-filed fact — say so wherever you use it, with the analyst count.
   When any returns available:false, render its reason and fall back to trailing figures; never
   leave a blank and never substitute a trailing number for a forward one without saying so.
3. Call tools to gather real data BEFORE writing any analysis.
   Reuse what you already have: if a tool was called for this ticker earlier in the
   conversation, its result is still valid — read it from the transcript instead of
   calling again. Only re-call when you need a different argument (a new ticker, a
   different range or filing section) or a genuinely fresher quote.
4. Any claim about a trend, growth rate, phase, or momentum must come from
   get_financial_history or get_price_history — never infer a trend from a single
   TTM figure. Any claim about a company's risks must cite get_filing_section("1A").
   Any lifecycle-phase claim must come from get_business_phase (the single source of
   truth) — never re-derive the phase by hand.
5. If a tool returns an error field or a null value, say so explicitly and mark the
   affected metric "data unavailable" rather than estimating it.
6. When the user invokes a named report protocol, follow it precisely and complete the
   full report in one response — do not stop mid-report. Output clean Markdown (no code fences).
7. NEVER use Markdown tables. This output goes straight to a terminal, where pipe-and-dash
   tables do not render and emoji throw the columns out of alignment. Present tabular data as
   one indented line per row, with the label padded so the values line up:
       🟢  Gross Margin              46.2%  ·  target >40%  ·  ↗️
   For two-column data, pad the label and put the value after it on the same line. Long or
   wrapping text belongs on its own indented continuation line, never in a column.
8. For plain follow-up questions, answer concisely, calling tools when useful and drawing on
   the reports already produced in this conversation.
`;

// ── One-time runtime setup (independent of ticker) ─────────────────────────────
const agentDir = join(os.homedir(), ".pi", "agent");
const modelRuntime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath: join(agentDir, "models.json"),
});

// Our own saved provider keys (in ~/.stock-analyzer/config.json) are injected so
// they behave like env vars — see the injection block below, deferred until after
// PROVIDER_ENV is defined. Pi's ModelRuntime already resolves credentials for
// every provider from the environment and ~/.pi/agent/auth.json, so env vars need
// nothing here. The interactive first-run wizard is deferred until after model
// selection — it only fires if NO provider is configured at all.

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir,
  systemPrompt,
  extensionFactories: [stockAnalyzerExtension],
  noContextFiles: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
});
await loader.reload();

// ── Provider & model selection ─────────────────────────────────────────────────

type PiModel = NonNullable<ReturnType<typeof modelRuntime.getModel>>;

// Auto-selection order when no --provider is given: the first configured provider wins.
const PROVIDER_PRIORITY = [
  "anthropic", "openai", "google", "xai", "deepseek",
  "openrouter", "azure-openai-responses", "amazon-bedrock",
];

// Preferred default model per provider — the first id that exists in the catalog is used.
const DEFAULT_MODELS: Record<string, string[]> = {
  anthropic: ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"],
  openai: ["gpt-5", "gpt-4.1", "gpt-4o"],
  google: ["gemini-3-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"],
  xai: ["grok-4.5", "grok-4.3"],
  deepseek: ["deepseek-v4-pro", "deepseek-v4-flash"],
  openrouter: ["anthropic/claude-sonnet-4.5", "openai/gpt-5"],
  "azure-openai-responses": ["gpt-5", "gpt-4.1"],
  "amazon-bedrock": [
    "anthropic.claude-sonnet-4-5-20250929-v1:0",
    "anthropic.claude-opus-4-5-20251101-v1:0",
  ],
};

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic", openai: "OpenAI", google: "Google Gemini", xai: "xAI (Grok)",
  deepseek: "DeepSeek", openrouter: "OpenRouter",
  "azure-openai-responses": "Azure OpenAI", "amazon-bedrock": "Amazon Bedrock",
};

const PROVIDER_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GEMINI_API_KEY",
  xai: "XAI_API_KEY", deepseek: "DEEPSEEK_API_KEY", openrouter: "OPENROUTER_API_KEY",
  "azure-openai-responses": "AZURE_OPENAI_API_KEY", "amazon-bedrock": "AWS_BEARER_TOKEN_BEDROCK",
};

// Registering a key triggers a model-catalog refresh, and with the network
// enabled that refresh also re-checks provider availability over HTTP with no
// timeout — enough to hang the CLI silently right after a key is entered. We
// only ever hand Pi a key we already hold and verified ourselves, so the local
// catalog is all we need. (Pi's own key-injection path does the same.)
const REGISTER_KEY_OPTS = { allowNetwork: false } as const;

// Inject our own saved provider keys so they behave like env vars, for every
// provider we support interactive setup for. Env vars win: if one is set we let
// Pi resolve it and skip our saved copy.
{
  const saved = loadSavedKeys();
  for (const prov of Object.keys(saved) as Provider[]) {
    const key = saved[prov];
    if (!key) continue;
    const envName = PROVIDER_ENV[prov];
    if (envName && process.env[envName]?.trim()) continue;
    await modelRuntime.setRuntimeApiKey(prov, key, REGISTER_KEY_OPTS);
  }
}

const modelLabel = (m: PiModel): string => `${m.provider}/${m.id}`;

const providerConfigured = (id: string): boolean => {
  try {
    return modelRuntime.getProviderAuthStatus(id).configured;
  } catch {
    return false;
  }
};

/** Providers that currently have credentials, priority order first then the rest. */
function configuredProviders(): string[] {
  const all = modelRuntime.getProviders().map((p) => p.id);
  const ordered = [
    ...PROVIDER_PRIORITY.filter((p) => all.includes(p)),
    ...all.filter((p) => !PROVIDER_PRIORITY.includes(p)),
  ];
  return ordered.filter(providerConfigured);
}

/** Default model for a provider: first preferred id that exists, else its first catalog model. */
function defaultModelFor(providerId: string): PiModel | undefined {
  for (const id of DEFAULT_MODELS[providerId] ?? []) {
    const m = modelRuntime.getModel(providerId, id);
    if (m) return m;
  }
  return modelRuntime.getModels(providerId)[0];
}

// Curated "latest" model ids per provider — the browsable menus (/model and
// --list-models) are capped to these so users aren't scrolling hundreds of
// entries (OpenRouter alone exposes hundreds). Ids missing from the live catalog
// are skipped, so stale entries here are harmless. Providers not listed fall back
// to the first MODEL_LIMIT catalog models. Power users can still jump to any
// model by exact id (`/model <provider/id>` or the --model flag).
const MODEL_LIMIT = 5;
const LATEST_MODELS: Record<string, string[]> = {
  anthropic: ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1", "claude-sonnet-4"],
  openai: ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o", "o4-mini"],
  google: ["gemini-3-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-pro"],
  xai: ["grok-4.5", "grok-4.3", "grok-4", "grok-3", "grok-3-mini"],
  deepseek: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-reasoner", "deepseek-chat", "deepseek-coder"],
  openrouter: [
    "anthropic/claude-sonnet-4.5", "openai/gpt-5", "google/gemini-3-pro-preview",
    "x-ai/grok-4.5", "deepseek/deepseek-v4-pro",
  ],
};

/** The (up to MODEL_LIMIT) latest models to browse for a provider — curated ids first, else catalog order. */
function latestModelsFor(providerId: string): PiModel[] {
  const curated = LATEST_MODELS[providerId];
  if (curated) {
    const picked = curated
      .map((id) => modelRuntime.getModel(providerId, id))
      .filter((m): m is PiModel => Boolean(m));
    if (picked.length) return picked.slice(0, MODEL_LIMIT);
  }
  return modelRuntime.getModels(providerId).slice(0, MODEL_LIMIT);
}

/** Resolve --provider/--model flags, else auto-pick the first configured provider's default. */
function chooseModel(providerFlag?: string, modelFlag?: string): PiModel | undefined {
  if (modelFlag) {
    // Prefer a configured provider that has the model; fall back to any provider
    // (which then trips the "no credentials" check with a helpful hint).
    const providers = providerFlag
      ? [providerFlag]
      : [...configuredProviders(), ...modelRuntime.getProviders().map((p) => p.id)];
    for (const p of providers) {
      const m = modelRuntime.getModel(p, modelFlag);
      if (m) return m;
    }
    return undefined;
  }
  if (providerFlag) return defaultModelFor(providerFlag);
  const configured = configuredProviders();
  return configured.length ? defaultModelFor(configured[0]) : undefined;
}

// --list-models: print configured providers and their catalog, then exit.
if (listModels) {
  const configured = configuredProviders();
  if (!configured.length) {
    console.log(
      c.yellow("No providers configured.") +
        c.dim(" Set an API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY, XAI_API_KEY, OPENROUTER_API_KEY, AZURE_OPENAI_API_KEY, or AWS creds) and retry.")
    );
  } else {
    for (const p of configured) {
      console.log(c.bold(`\n${PROVIDER_LABELS[p] ?? p}`) + c.dim(` (${p})`));
      for (const m of latestModelsFor(p)) console.log("  " + m.id);
    }
  }
  process.exit(0);
}

// One readline interface for the whole process. Key setup, the provider confirm
// step and the main loop all share it: creating a second interface on stdin means
// handing the terminal over mid-stream, which loses buffered input (a line typed
// during the handoff would be swallowed by the next prompt instead of printing it).
const rl = createInterface({ input: process.stdin, output: process.stdout });

// Exit cleanly on EOF (Ctrl-D) or any other close we didn't initiate ourselves.
let closing = false;
rl.on("close", () => {
  if (!closing) {
    closing = true;
    console.log(c.dim("\nGoodbye."));
    process.exit(0);
  }
});
rl.on("SIGINT", () => {
  closing = true;
  spinner.stop();
  console.log(c.dim("\nCancelled."));
  process.exit(130);
});

let selectedModel = chooseModel(flagProvider, flagModel);

// Nothing configured anywhere → bootstrap with the interactive first-run wizard.
let justBootstrapped = false;
if (!selectedModel && !flagProvider && !flagModel) {
  const keys = await resolveApiKeys(rl);
  for (const prov of Object.keys(keys) as Provider[]) {
    const key = keys[prov];
    if (key) await modelRuntime.setRuntimeApiKey(prov, key, REGISTER_KEY_OPTS);
  }
  selectedModel = chooseModel();
  justBootstrapped = true;
}

if (!selectedModel) {
  if (flagModel) {
    console.error(
      c.red(`Model "${flagModel}" not found${flagProvider ? ` for provider "${flagProvider}"` : ""}.`) +
        c.dim(" Run with --list-models to see options.")
    );
  } else if (flagProvider) {
    console.error(
      c.red(`Provider "${flagProvider}" isn't configured or has no usable model.`) +
        c.dim(" Set its API key (see README) or try --list-models.")
    );
  } else {
    console.error(c.red("No configured model provider found."));
  }
  process.exit(1);
}

// A model chosen via --provider/--model may belong to a provider without credentials.
// Catch that here with a specific hint rather than letting the first report fail.
if (!providerConfigured(selectedModel.provider)) {
  const envHint = PROVIDER_ENV[selectedModel.provider];
  console.error(
    c.red(`Provider "${selectedModel.provider}" (for ${modelLabel(selectedModel)}) has no credentials.`) +
      c.dim(envHint ? ` Set ${envHint} (see --help).` : " See --help for how to configure it.")
  );
  process.exit(1);
}

// ── Startup provider confirmation ──────────────────────────────────────────────
// When running interactively with no explicit --provider/--model flag, show the
// configured keys + active model and let the user confirm or switch providers.
// Skipped for scripts (non-TTY) and right after the first-run wizard.
if (process.stdin.isTTY && !flagProvider && !flagModel && !justBootstrapped) {
  const configuredSetup = SETUP_PROVIDERS.filter((p) => providerConfigured(p));
  // Providers with creds that we don't offer interactive setup for (Azure, Bedrock)
  // — shown in the summary only, so the user sees the full picture.
  const otherConfiguredLabels = configuredProviders()
    .filter((p) => !SETUP_PROVIDERS.includes(p as Provider))
    .map((p) => PROVIDER_LABELS[p] ?? p);

  const decision = await confirmOrSwitchProviders(rl, {
    configured: configuredSetup,
    activeLabel: modelLabel(selectedModel),
    otherConfiguredLabels,
  });

  if (decision) {
    if (decision.newKey) {
      await modelRuntime.setRuntimeApiKey(decision.provider, decision.newKey, REGISTER_KEY_OPTS);
    }
    const m = defaultModelFor(decision.provider);
    if (m) {
      selectedModel = m;
      console.log(c.brightGreen(`  ✓ Using ${modelLabel(selectedModel)}`));
    } else {
      console.error(
        c.red(`  Could not select a model for ${decision.provider}.`) +
          c.dim(` Continuing with ${modelLabel(selectedModel)}.`)
      );
    }
  }
}

// ── Session helpers ────────────────────────────────────────────────────────────

// Shared activity indicator. Every terminal write while a turn is in flight must
// go through spinner.write()/stop(), or a stale frame is left mid-line.
const spinner = new Spinner();

// Set by the stream subscriber when a turn ends in a provider error. Read (and
// reset) around each prompt so the caller knows the turn failed even though
// prompt() resolved normally. Safe as a single flag: only one prompt runs at a time.
let sawError = false;

/**
 * Condense a provider error into one readable line. They arrive as the raw HTTP
 * status plus the response body, e.g.
 * `401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."}}`.
 */
function formatModelError(raw: string | undefined): string {
  if (!raw?.trim()) return "the provider gave no reason";
  const brace = raw.indexOf("{");
  if (brace === -1) return raw.trim();
  const status = raw.slice(0, brace).trim();
  try {
    const body = JSON.parse(raw.slice(brace)) as { error?: { message?: string }; message?: string };
    const message = body.error?.message ?? body.message;
    if (message) return status ? `${status} — ${message}` : message;
  } catch {
    // Not JSON, or a shape we don't recognise — show the raw text instead.
  }
  return raw.trim();
}

/** Create a fresh agent session and stream its output to stdout/stderr. */
async function newSession(): Promise<AgentSession> {
  const { session } = await createAgentSession({
    modelRuntime,
    model: selectedModel,
    resourceLoader: loader,
    // In-memory session per stock: keeps context within the session (so follow-ups
    // work) but writes nothing to disk and can never resume a prior conversation.
    // The default SessionManager.create() already starts fresh, but it persists
    // every session under ~/.pi/agent/sessions/<cwd>/ (files pile up) and a stray
    // continueRecent()-style path could resume them; in-memory removes both risks.
    sessionManager: SessionManager.inMemory(),
    noTools: "builtin",
    tools: [
      "get_financials",
      "get_financial_history",
      "get_price_data",
      "get_price_history",
      "get_reverse_dcf",
      "get_forward_estimates",
      "get_upcoming_events",
      "get_business_phase",
      "get_business_description",
      "get_filing_section",
      "get_competitors",
      "get_segment_revenue",
      "compare_peers",
      "get_analyst_sentiment",
      "get_recent_filings",
      "get_filing_events",
    ],
  });

  session.subscribe((event) => {
    if (event.type === "message_update") {
      const ae = event.assistantMessageEvent;
      if (ae.type === "text_delta") {
        // First token: the model is answering, so the wait is over.
        spinner.stop();
        process.stdout.write(ae.delta);
      }
    } else if (event.type === "message_end") {
      // A provider error (bad key, rate limit, context overflow, 5xx) comes back
      // as an assistant message with stopReason "error" — the agent loop then ends
      // the turn normally, so prompt() resolves and the catch around it never runs.
      // Report it here or the failure is invisible and the report looks empty.
      const m = event.message;
      if (m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted")) {
        sawError = true;
        spinner.stop();
        process.stderr.write(
          "\n" +
            c.red(
              m.stopReason === "aborted"
                ? `⚠️  Response interrupted: ${formatModelError(m.errorMessage)}`
                : `⚠️  Model error (${selectedModel ? modelLabel(selectedModel) : "model"}): ` +
                  formatModelError(m.errorMessage)
            ) +
            "\n"
        );
      }
    } else if (event.type === "tool_execution_start") {
      spinner.write(process.stderr, c.gray(`\n[tool: ${event.toolName}]\n`));
      // Now waiting on the tool, not the model — name it so a slow fetch is legible.
      spinner.start(`Running ${event.toolName}…`);
    } else if (event.type === "tool_execution_end") {
      // Tool done, model thinking again.
      spinner.start("Thinking…");
    } else if (event.type === "auto_retry_start") {
      // Otherwise a retrying request just looks like a long stall.
      spinner.write(
        process.stderr,
        c.yellow(
          `\n⚠️  ${event.errorMessage} — retrying (${event.attempt}/${event.maxAttempts}) ` +
            `in ${Math.max(1, Math.round(event.delayMs / 1000))}s…\n`
        )
      );
      spinner.start("Retrying…");
    } else if (event.type === "agent_end") {
      spinner.stop();
      process.stdout.write("\n");
    }
  });

  return session;
}

// Attached only once the setup prompts are done, so nothing typed during them is
// captured as type-ahead for the ticker prompt.
const reader = new LineReader(rl);

async function askTicker(): Promise<string> {
  const answer = await reader.next(
    `\n${c.brightCyan("Enter a stock ticker to research")} ${c.dim("(or 'exit' to quit):")} `
  );
  return answer.trim();
}

function isQuit(s: string): boolean {
  const c = s.trim().toLowerCase();
  return c === "exit" || c === "quit" || c === "q";
}

function quit(): never {
  closing = true;
  console.log(c.dim("\nGoodbye."));
  rl.close();
  process.exit(0);
}

// ── Token accounting ───────────────────────────────────────────────────────────

type UsageSnap = {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  total: number; cost: number; toolCalls: number;
};
const ZERO_USAGE: UsageSnap = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, toolCalls: 0,
};

// Last cumulative usage seen for each session, so we can show a per-prompt delta.
const lastUsage = new WeakMap<AgentSession, UsageSnap>();

/** Cumulative billed usage for a session (best-effort — 0s if stats are unavailable). */
function snapUsage(session: AgentSession): UsageSnap {
  try {
    const s = session.getSessionStats();
    return { ...s.tokens, cost: s.cost, toolCalls: s.toolCalls };
  } catch {
    return { ...ZERO_USAGE };
  }
}

const nfmt = (n: number): string => Math.round(n).toLocaleString("en-US");
const costFmt = (n: number): string => (n > 0 ? ` · $${n.toFixed(4)}` : "");

/**
 * Report what a prompt cost, splitting *new* tokens (fresh input + output — what
 * you're actually billed near-full price for) from *cached* tokens (prefix re-read
 * across the agent's tool-use loop, billed at a steep discount). Also shows the
 * tool-call count, which is what makes the cached figure grow. See the "Token &
 * cost accounting" section of the README.
 */
function printTokenUsage(session: AgentSession, label: string): void {
  const cur = snapUsage(session);
  const prev = lastUsage.get(session) ?? ZERO_USAGE;
  lastUsage.set(session, cur);
  if (cur.total <= 0) return; // stats unavailable for this model/runtime

  const dIn = cur.input - prev.input;
  const dOut = cur.output - prev.output;
  const dCached = cur.cacheRead - prev.cacheRead + (cur.cacheWrite - prev.cacheWrite);
  const dTools = cur.toolCalls - prev.toolCalls;
  const dNew = dIn + dOut;

  console.log(
    c.dim(
      `  ⛁ ${label}: ${nfmt(dNew)} new (${nfmt(dIn)} in · ${nfmt(dOut)} out) + ` +
        `${nfmt(dCached)} cached · ${dTools} tool call${dTools === 1 ? "" : "s"}` +
        costFmt(cur.cost - prev.cost) +
        `   ·   session ${nfmt(cur.total)} total${costFmt(cur.cost)}`
    )
  );
}

/** Print the session's cumulative usage (shown when a session ends). */
function printSessionTotal(session: AgentSession): void {
  const s = snapUsage(session);
  if (s.total <= 0) return;
  const cached = s.cacheRead + s.cacheWrite;
  console.log(
    c.dim(
      `  ⛁ session total: ${nfmt(s.input + s.output)} new (${nfmt(s.input)} in · ${nfmt(s.output)} out) + ` +
        `${nfmt(cached)} cached · ${s.toolCalls} tool call${s.toolCalls === 1 ? "" : "s"}` +
        costFmt(s.cost)
    )
  );
}

/**
 * Cap on companies a report may be pointed at beyond its own ticker. Each one
 * costs a full data fetch — a multi-megabyte companyfacts download plus filing
 * exhibits — so this bounds a single command's runtime and token bill.
 */
const MAX_EXTRA_TICKERS = 4;

/** Build the user-turn message that runs a report protocol against a ticker. */
function buildReportMessage(cmd: ReportCommand, ticker: string, extra: string[] = []): string {
  const protocol = loadReportPrompt(cmd);
  const hint = cmd.kickoffHint ? `\n${cmd.kickoffHint}` : "";
  // Naming the absent case matters as much as the present one: without it the
  // model fills an empty peer list with companies it remembers.
  const args = cmd.args
    ? extra.length
      ? `\nThe user named these companies to compare against ${ticker}: ${extra.join(", ")}. ` +
        `Use exactly these — do not add or substitute any.`
      : `\nThe user named no other companies. Do not invent a peer list from memory; ` +
        `analyze ${ticker} alone and say which comparison would need naming.`
    : "";
  return (
    `${protocol}\n\n---\n` +
    `Apply the protocol above to ${ticker} now. The ticker is ${ticker} — do not ask ` +
    `for it. Gather real data with the available tools before writing.${args}${hint}`
  );
}

/** Run a report in the given session, streaming output and handling errors. */
async function runReport(
  session: AgentSession,
  cmd: ReportCommand,
  ticker: string,
  extra: string[] = []
): Promise<void> {
  console.log(
    "\n" + c.brightGreen("▸ ") + c.bold("/" + cmd.name) + " " +
      c.dim(cmd.description + " · " + ticker + (extra.length ? ` vs ${extra.join(", ")}` : "")) + "\n"
  );
  sawError = false;
  try {
    spinner.start("Thinking…");
    await session.prompt(buildReportMessage(cmd, ticker, extra));
    spinner.stop();
    printTokenUsage(session, `/${cmd.name} ${ticker}`);
    if (sawError) {
      console.error(
        c.red(`⚠️  /${cmd.name} did not complete.`) +
          c.dim(` Retry it, or use ${c.brightCyan("/model")} to switch provider.`)
      );
    }
  } catch (e: unknown) {
    console.error(c.red(`\n⚠️  Failed to generate the report: ${(e as Error).message}`));
  } finally {
    spinner.stop();
  }
}

/** Answer a plain follow-up question in the given session. */
async function runFollowup(session: AgentSession, text: string): Promise<void> {
  console.log();
  sawError = false;
  try {
    spinner.start("Thinking…");
    await session.prompt(text);
    spinner.stop();
    printTokenUsage(session, "follow-up");
    if (sawError) {
      console.error(
        c.red("⚠️  That answer did not complete.") +
          c.dim(` Ask again, or use ${c.brightCyan("/model")} to switch provider.`)
      );
    }
  } catch (e: unknown) {
    console.error(c.red(`\n⚠️  Something went wrong answering that: ${(e as Error).message}`));
  } finally {
    spinner.stop();
  }
}

/**
 * Interactive `/model` switcher. With no argument, lists models across configured
 * providers and prompts for a number. With an argument, matches a model id/label
 * directly, or filters the list — important because some providers (OpenRouter)
 * expose hundreds of models. Applies the switch to the live session and to the
 * default used for future /new sessions.
 */
async function switchModel(session: AgentSession, query?: string): Promise<void> {
  const configured = configuredProviders();
  if (!configured.length) {
    console.log(c.yellow("  No configured providers."));
    return;
  }

  // `all` is the full catalog (for exact-id matching — power users can reach any
  // model); `list` is the curated "latest" set that the menu browses.
  const all: PiModel[] = [];
  for (const p of configured) for (const m of modelRuntime.getModels(p)) all.push(m);
  let list: PiModel[] = [];
  for (const p of configured) for (const m of latestModelsFor(p)) list.push(m);

  if (query) {
    const q = query.trim().toLowerCase();
    const exact = all.find((m) => modelLabel(m).toLowerCase() === q || m.id.toLowerCase() === q);
    if (exact) {
      selectedModel = exact;
      await session.setModel(exact);
      console.log(c.brightGreen(`  ✓ Switched to ${modelLabel(exact)}`));
      return;
    }
    // Filter the latest set first; if nothing matches there, widen to the full catalog.
    const narrowed = list.filter((m) => modelLabel(m).toLowerCase().includes(q));
    list = narrowed.length ? narrowed : all.filter((m) => modelLabel(m).toLowerCase().includes(q));
    if (!list.length) {
      console.log(c.red(`  No model matches "${query}".`) + c.dim(" Try /model or --list-models."));
      return;
    }
  }

  if (list.length > 60) {
    console.log(
      c.yellow(`  ${list.length} models available.`) +
        c.dim(" Narrow it: e.g. /model gemini, /model claude, or /model <provider/id>.")
    );
    return;
  }

  const current = selectedModel ? modelLabel(selectedModel) : "none";
  console.log(c.bold("\n  Models") + c.dim(`  (current: ${current})`));
  list.forEach((m, i) => {
    const here =
      selectedModel && m.provider === selectedModel.provider && m.id === selectedModel.id
        ? c.brightGreen("  ← current")
        : "";
    console.log("  " + c.brightCyan(String(i + 1).padStart(3)) + "  " + modelLabel(m) + here);
  });

  const ans = (await reader.next("\n  Number to switch (blank to cancel): ")).trim();
  if (!ans) {
    console.log(c.dim("  (unchanged)"));
    return;
  }
  const idx = Number(ans) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) {
    console.log(c.red("  Invalid selection."));
    return;
  }
  selectedModel = list[idx];
  await session.setModel(selectedModel);
  console.log(c.brightGreen(`  ✓ Switched to ${modelLabel(selectedModel)}`));
}

/** Print the list of available commands. */
function printHelp(): void {
  const pad = 15;
  console.log(c.bold("\n  Reports") + c.dim("  (run on the current stock; append a ticker to switch):"));
  for (const cmd of REPORT_COMMANDS) {
    const usage = cmd.args ? ` ${cmd.args}` : "";
    console.log(
      "  " + c.brightCyan(("/" + cmd.name).padEnd(pad)) + c.dim(cmd.description) +
        (usage ? c.dim(c.gray(`  —  /${cmd.name}${usage}`)) : "")
    );
  }
  console.log(c.bold("\n  Controls:"));
  console.log("  " + c.brightCyan("/new [TICKER]".padEnd(pad)) + c.dim("Research a different stock"));
  console.log("  " + c.brightCyan("/model [query]".padEnd(pad)) + c.dim("Switch the AI model" + (selectedModel ? ` (now: ${modelLabel(selectedModel)})` : "")));
  console.log("  " + c.brightCyan("/help".padEnd(pad)) + c.dim("Show this help"));
  console.log("  " + c.brightCyan("/exit".padEnd(pad)) + c.dim("Quit"));
  console.log(
    c.dim("\n  Examples: ") + c.brightCyan("/moat") + c.dim("  ·  ") +
      c.brightCyan("/valuation TSLA") + c.dim("  ·  plain text = a follow-up question")
  );
}

// ── Interactive loop ───────────────────────────────────────────────────────────

const WORDMARK = String.raw`
   ____  _             _        _                _
  / ___|| |_ ___   ___| | __   / \   _ __   __ _| |_   _ _______ _ __
  \___ \| __/ _ \ / __| |/ /  / _ \ | '_ \ / _' | | | | |_  / _ \ '__|
   ___) | || (_) | (__|   <  / ___ \| | | | (_| | | |_| |/ /  __/ |
  |____/ \__\___/ \___|_|\_\/_/   \_\_| |_|\__,_|_|\__, /___\___|_|
                                                   |___/`;

const CHART = [
  "        .  ___                                        ___",
  "       /|\\/   \\        AI-powered stock research     /   \\",
  "      / | \\    \\___                             ___/     \\",
  "     /  |  \\       \\___                     ___/          \\__",
  "    /   |   \\          \\___             ___/                 \\",
].join("\n");

console.log(c.brightGreen(c.bold(WORDMARK)));
console.log(c.cyan(CHART));
console.log(`\n  ${c.bold("📈 stock-analyze")} ${c.dim("— interactive stock research")}`);
console.log(
  "  " + c.dim("Default report:") + " " + c.yellow("/" + defaultCommand.name) +
    c.dim("   ·   Type ") + c.brightCyan("/help") + c.dim(" for all commands")
);
console.log(
  "  " + c.dim("Model:") + " " + c.yellow(selectedModel ? modelLabel(selectedModel) : "none") +
    c.dim("   ·   ") + c.brightCyan("/model") + c.dim(" to switch")
);

// Seed the first ticker from the argument, if provided.
let pendingTicker: string | null = argTicker ?? null;

while (true) {
  // Prompt for a ticker until we get a valid one.
  if (!pendingTicker) {
    const input = await askTicker();
    if (isQuit(input)) quit();
    if (!input) continue;
    pendingTicker = input.toUpperCase();
  }

  const ticker: string = pendingTicker;
  pendingTicker = null;

  spinner.start(`Looking up ${ticker}…`);
  const { valid, name } = await validateTicker(ticker);
  spinner.stop();
  if (!valid) {
    console.error(
      c.red(`\n❌ Error: '${ticker}' is not a valid stock ticker.`) +
        c.dim(" Please try again.")
    );
    continue;
  }

  console.log(
    "\n" +
      c.brightGreen("🔎 Researching") +
      " " +
      c.bold(name ?? ticker) +
      " " +
      c.dim("(" + ticker + ")...") +
      "\n"
  );

  const session = await newSession();
  let activeTicker = ticker;

  // Run the default report to kick things off.
  await runReport(session, defaultCommand, activeTicker);

  // Command / follow-up loop for the current stock.
  while (true) {
    const input: string = (
      await reader.next(
        "\n" + c.brightCyan(`[${activeTicker}]`) +
          c.dim(" follow-up, /command, or /help: ")
      )
    ).trim();

    if (!input) continue;
    // Bare quit words remain convenient shortcuts.
    if (isQuit(input)) {
      printSessionTotal(session);
      session.dispose();
      quit();
    }

    // Slash commands (plus bare `new` for back-compat).
    if (input.startsWith("/") || /^new(\s|$)/i.test(input)) {
      const body = input.startsWith("/") ? input.slice(1) : input;
      const [word, ...restParts] = body.split(/\s+/);
      const key = word.toLowerCase();
      const rest = restParts.join(" ").trim();

      if (["help", "h", "?", "commands", "reports"].includes(key)) {
        printHelp();
        continue;
      }
      if (["exit", "quit", "q"].includes(key)) {
        printSessionTotal(session);
        session.dispose();
        quit();
      }
      if (key === "new") {
        pendingTicker = rest ? rest.toUpperCase() : null;
        printSessionTotal(session);
        session.dispose();
        break; // back to the outer loop to validate & research the next stock
      }
      if (key === "model" || key === "models") {
        await switchModel(session, rest || undefined);
        continue;
      }

      const cmd = findCommand(key);
      if (!cmd) {
        console.error(
          c.red(`Unknown command: /${key}.`) + c.dim(" Type /help for the list.")
        );
        continue;
      }

      // `/moat TSLA` overrides the ticker. A command declaring `args` takes more:
      // `/compete NVDA AMD AVGO` runs on NVDA against the rest.
      const words = rest ? rest.split(/\s+/).filter(Boolean) : [];
      const [first, ...others] = words;
      const extraWords = cmd.args ? others : [];

      if (!cmd.args && words.length > 1) {
        console.error(
          c.red(`/${cmd.name} takes one ticker.`) +
            c.dim(` Got ${words.length}: ${words.join(", ")}.`)
        );
        continue;
      }

      if (first) {
        const t = first.toUpperCase();
        spinner.start(`Looking up ${t}…`);
        const { valid, name } = await validateTicker(t);
        spinner.stop();
        if (!valid) {
          console.error(c.red(`'${t}' is not a valid stock ticker.`));
          continue;
        }
        activeTicker = t;
        console.log(c.dim(`  (switched to ${name ?? t})`));
      }

      // Peers are validated too — a typo here would otherwise surface as an
      // unexplained gap in the comparison rather than as an error.
      const extra: string[] = [];
      for (const word of extraWords.slice(0, MAX_EXTRA_TICKERS)) {
        const t = word.toUpperCase();
        if (t === activeTicker || extra.includes(t)) continue;
        spinner.start(`Looking up ${t}…`);
        const { valid } = await validateTicker(t);
        spinner.stop();
        if (!valid) {
          console.error(c.red(`'${t}' is not a valid stock ticker — skipping it.`));
          continue;
        }
        extra.push(t);
      }
      if (extraWords.length > MAX_EXTRA_TICKERS) {
        console.log(
          c.dim(`  (comparing the first ${MAX_EXTRA_TICKERS}; each company adds a full data fetch)`)
        );
      }

      await runReport(session, cmd, activeTicker, extra);
      continue;
    }

    // Otherwise treat it as a follow-up question in the same session.
    await runFollowup(session, input);
  }
}
