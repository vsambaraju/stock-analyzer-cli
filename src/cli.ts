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
import { resolveApiKeys } from "./keys.js";
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
  console.error("\nExamples:");
  console.error("  stock-analyze");
  console.error("  stock-analyze AAPL");
  console.error("  stock-analyze NVDA moat");
  console.error("\nAuth: set ANTHROPIC_API_KEY or OPENAI_API_KEY, or you'll be prompted on first run.");
}

const _rawArg = process.argv[2];

if (_rawArg === "--help" || _rawArg === "-h") {
  printUsage();
  process.exit(0);
}

const argTicker = _rawArg?.toUpperCase();
const reportArg = process.argv[3] ?? "business";

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

// Resolve API keys: environment → securely-saved config → interactive setup.
// Keys are injected at runtime only (not persisted to Pi's on-disk auth store).
const { anthropic: anthropicKey, openai: openaiKey } = await resolveApiKeys();
if (anthropicKey) modelRuntime.setRuntimeApiKey("anthropic", anthropicKey);
if (openaiKey) modelRuntime.setRuntimeApiKey("openai", openaiKey);

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

// Select model based on available API keys
let selectedModel: ReturnType<typeof modelRuntime.getModel>;
if (anthropicKey) {
  selectedModel = modelRuntime.getModel("anthropic", "claude-sonnet-4-6")
    ?? modelRuntime.getModel("anthropic", "claude-opus-4-1")
    ?? modelRuntime.getModels("anthropic")[0];
} else if (openaiKey) {
  selectedModel = modelRuntime.getModel("openai", "gpt-4.1")
    ?? modelRuntime.getModel("openai", "gpt-4o")
    ?? modelRuntime.getModels("openai")[0];
}

if (!selectedModel) {
  console.error(
    c.red("No usable model found for the configured API key. Check your Pi model configuration.")
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
  } catch (e: unknown) {
    console.error(c.red(`\n⚠️  Failed to generate the report: ${(e as Error).message}`));
  }
}

/** Answer a plain follow-up question in the given session. */
async function runFollowup(session: AgentSession, text: string): Promise<void> {
  console.log();
  try {
    await session.prompt(text);
  } catch (e: unknown) {
    console.error(c.red(`\n⚠️  Something went wrong answering that: ${(e as Error).message}`));
  }
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
        session.dispose();
        quit();
      }
      if (key === "new") {
        pendingTicker = rest ? rest.toUpperCase() : null;
        session.dispose();
        break; // back to the outer loop to validate & research the next stock
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
