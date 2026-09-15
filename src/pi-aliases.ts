/**
 * Pi-package-only extension: exposes each report's aliases as slash commands.
 *
 * Pi loads src/skills/*.md natively (see the `pi.skills` entry in package.json),
 * which gives every report its canonical command — /moat, /valuation, and so on.
 * But Pi ignores unknown frontmatter fields, so the `aliases:` line in each skill
 * is dropped. This registers those aliases (/val, /biz, /lt, …) so a Pi user gets
 * the same command surface as the standalone CLI.
 *
 * IMPORTANT: this file is referenced ONLY by the `pi` manifest in package.json —
 * never from cli.ts. The standalone CLI resolves aliases itself, through the
 * lookup table in commands.ts, so loading this module there would register a
 * second, competing handler for every alias.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  REPORT_COMMANDS,
  buildReportMessage,
  MAX_EXTRA_TICKERS,
  type ReportCommand,
} from "./commands.js";

/** Split `/compete NVDA AMD AVGO` into its ticker and any extra companies. */
function parseArgs(cmd: ReportCommand, args: string): { ticker?: string; extra: string[] } {
  const words = args.trim().split(/\s+/).filter(Boolean).map((w) => w.toUpperCase());
  const [first, ...others] = words;
  // Only commands that declare `args` accept companies beyond their own ticker;
  // for every other report the words after the slash are a single ticker.
  return { ticker: first, extra: cmd.args ? others.slice(0, MAX_EXTRA_TICKERS) : [] };
}

export default function stockAnalyzerAliases(pi: ExtensionAPI) {
  for (const cmd of REPORT_COMMANDS) {
    for (const alias of cmd.aliases) {
      pi.registerCommand(alias, {
        description: `${cmd.description} (alias for /${cmd.name})`,
        handler: async (args, ctx) => {
          const { ticker, extra } = parseArgs(cmd, args);
          if (!ticker) {
            const usage = cmd.args ? ` ${cmd.args}` : "";
            ctx.ui.notify(`Usage: /${alias} <TICKER>${usage}`, "warning");
            return;
          }
          if (!cmd.args && args.trim().split(/\s+/).filter(Boolean).length > 1) {
            ctx.ui.notify(`/${alias} takes one ticker.`, "warning");
            return;
          }
          // sendUserMessage always starts a turn, and throws if one is already
          // streaming, so bail out rather than interrupting a running report.
          if (!ctx.isIdle()) {
            ctx.ui.notify("Agent is busy — wait for the current report to finish.", "warning");
            return;
          }
          pi.sendUserMessage(buildReportMessage(cmd, ticker, extra));
        },
      });
    }
  }
}
