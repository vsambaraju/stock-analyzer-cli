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

import { createAgentSession, ModelRuntime, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { join } from "path";
import { createInterface } from "readline/promises";
import os from "os";
import stockAnalyzerExtension from "./extension.js";
import { validateTicker } from "./tools/market.js";
import { resolveApiKeys, loadSavedKeys } from "./keys.js";
import { c } from "./ui.js";
import { LineReader } from "./io.js";
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
   get_price_history, get_business_phase, get_business_description, get_filing_section,
   get_competitors, get_analyst_sentiment, get_recent_filings.
   (get_competitors and get_analyst_sentiment return no data without a paid key — rely on
   get_business_description for named competitors and get_price_history as a sentiment proxy.)
3. Call tools to gather real data BEFORE writing any analysis.
4. Any claim about a trend, growth rate, phase, or momentum must come from
   get_financial_history or get_price_history — never infer a trend from a single
   TTM figure. Any claim about a company's risks must cite get_filing_section("1A").
   Any lifecycle-phase claim must come from get_business_phase (the single source of
   truth) — never re-derive the phase by hand.
5. If a tool returns an error field or a null value, say so explicitly and mark the
   affected metric "data unavailable" rather than estimating it.
6. When the user invokes a named report protocol, follow it precisely and complete the
   full report in one response — do not stop mid-report. Output clean Markdown (no code fences).
7. For plain follow-up questions, answer concisely, calling tools when useful and drawing on
   the reports already produced in this conversation.
`;

// ── One-time runtime setup (independent of ticker) ─────────────────────────────
const agentDir = join(os.homedir(), ".pi", "agent");
const modelRuntime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath: join(agentDir, "models.json"),
});

// Inject our own saved Anthropic/OpenAI keys so they behave like env vars. Pi's
// ModelRuntime already resolves credentials for every other provider (DeepSeek,
// Gemini, xAI, OpenRouter, Azure, Bedrock, …) from the environment and
// ~/.pi/agent/auth.json, so those need nothing here. The interactive first-run
// wizard is deferred until after model selection — it only fires if NO provider
// is configured at all.
{
  const saved = loadSavedKeys();
  const a = process.env.ANTHROPIC_API_KEY?.trim() || saved.anthropic;
  const o = process.env.OPENAI_API_KEY?.trim() || saved.openai;
  if (a) await modelRuntime.setRuntimeApiKey("anthropic", a);
  if (o) await modelRuntime.setRuntimeApiKey("openai", o);
}

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
      for (const m of modelRuntime.getModels(p)) console.log("  " + m.id);
    }
  }
  process.exit(0);
}

let selectedModel = chooseModel(flagProvider, flagModel);

// Nothing configured anywhere → bootstrap with the interactive Anthropic/OpenAI wizard.
// (Other providers are configured via env vars / auth.json, so we don't prompt for them.)
if (!selectedModel && !flagProvider && !flagModel) {
  const keys = await resolveApiKeys();
  if (keys.anthropic) await modelRuntime.setRuntimeApiKey("anthropic", keys.anthropic);
  if (keys.openai) await modelRuntime.setRuntimeApiKey("openai", keys.openai);
  selectedModel = chooseModel();
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

// ── Session helpers ────────────────────────────────────────────────────────────

/** Create a fresh agent session and stream its output to stdout/stderr. */
async function newSession(): Promise<AgentSession> {
  const { session } = await createAgentSession({
    modelRuntime,
    model: selectedModel,
    resourceLoader: loader,
    noTools: "builtin",
    tools: [
      "get_financials",
      "get_financial_history",
      "get_price_data",
      "get_price_history",
      "get_business_phase",
      "get_business_description",
      "get_filing_section",
      "get_competitors",
      "get_analyst_sentiment",
      "get_recent_filings",
    ],
  });

  session.subscribe((event) => {
    if (event.type === "message_update") {
      const ae = event.assistantMessageEvent;
      if (ae.type === "text_delta") process.stdout.write(ae.delta);
    } else if (event.type === "tool_execution_start") {
      process.stderr.write(c.gray(`\n[tool: ${event.toolName}]\n`));
    } else if (event.type === "agent_end") {
      process.stdout.write("\n");
    }
  });

  return session;
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const reader = new LineReader(rl);

// Exit cleanly on EOF (Ctrl-D) or any other close we didn't initiate ourselves.
let closing = false;
rl.on("close", () => {
  if (!closing) {
    closing = true;
    console.log(c.dim("\nGoodbye."));
    process.exit(0);
  }
});

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

/** Build the user-turn message that runs a report protocol against a ticker. */
function buildReportMessage(cmd: ReportCommand, ticker: string): string {
  const protocol = loadReportPrompt(cmd);
  const hint = cmd.kickoffHint ? `\n${cmd.kickoffHint}` : "";
  return (
    `${protocol}\n\n---\n` +
    `Apply the protocol above to ${ticker} now. The ticker is ${ticker} — do not ask ` +
    `for it. Gather real data with the available tools before writing.${hint}`
  );
}

/** Run a report in the given session, streaming output and handling errors. */
async function runReport(session: AgentSession, cmd: ReportCommand, ticker: string): Promise<void> {
  console.log(
    "\n" + c.brightGreen("▸ ") + c.bold("/" + cmd.name) + " " +
      c.dim(cmd.description + " · " + ticker) + "\n"
  );
  try {
    await session.prompt(buildReportMessage(cmd, ticker));
    printTokenUsage(session, `/${cmd.name} ${ticker}`);
  } catch (e: unknown) {
    console.error(c.red(`\n⚠️  Failed to generate the report: ${(e as Error).message}`));
  }
}

/** Answer a plain follow-up question in the given session. */
async function runFollowup(session: AgentSession, text: string): Promise<void> {
  console.log();
  try {
    await session.prompt(text);
    printTokenUsage(session, "follow-up");
  } catch (e: unknown) {
    console.error(c.red(`\n⚠️  Something went wrong answering that: ${(e as Error).message}`));
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

  let list: PiModel[] = [];
  for (const p of configured) for (const m of modelRuntime.getModels(p)) list.push(m);

  if (query) {
    const q = query.trim().toLowerCase();
    const exact = list.find((m) => modelLabel(m).toLowerCase() === q || m.id.toLowerCase() === q);
    if (exact) {
      selectedModel = exact;
      await session.setModel(exact);
      console.log(c.brightGreen(`  ✓ Switched to ${modelLabel(exact)}`));
      return;
    }
    list = list.filter((m) => modelLabel(m).toLowerCase().includes(q));
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
    console.log("  " + c.brightCyan(("/" + cmd.name).padEnd(pad)) + c.dim(cmd.description));
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

  const { valid, name } = await validateTicker(ticker);
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

      // Optional ticker override, e.g. `/moat TSLA`.
      if (rest) {
        const t = rest.toUpperCase();
        const { valid, name } = await validateTicker(t);
        if (!valid) {
          console.error(c.red(`'${t}' is not a valid stock ticker.`));
          continue;
        }
        activeTicker = t;
        console.log(c.dim(`  (switched to ${name ?? t})`));
      }

      await runReport(session, cmd, activeTicker);
      continue;
    }

    // Otherwise treat it as a follow-up question in the same session.
    await runFollowup(session, input);
  }
}
