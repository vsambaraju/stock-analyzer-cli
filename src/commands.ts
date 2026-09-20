/**
 * Report commands ("skills"), loaded from the skills/ directory.
 *
 * Each *.md file in skills/ is a self-contained analysis protocol with a small
 * YAML-ish frontmatter block describing how it is exposed as a slash command:
 *
 *   ---
 *   name: moat
 *   order: 2
 *   aliases: moat_analysis
 *   description: Competitive moat assessment
 *   kickoffHint: <optional extra instruction appended when invoked>
 *   ---
 *   <prompt body>
 *
 * Drop a new .md file in skills/ (with frontmatter) and it becomes a /command
 * automatically — no code changes required.
 */

import { readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { expandIncludes } from "./skills-include.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, "skills");
// Partials shared between skills, e.g. the moat rubric both /moat and /decide score
// against. Present in src/ (what `npm run dev` reads); absent from dist/, where the
// build has already expanded every include — so a missing directory here is normal
// and only an error if some skill still names a partial.
const SHARED_DIR = join(__dirname, "skills-shared");

export type ReportCommand = {
  /** Canonical slash name, e.g. "moat" → /moat */
  name: string;
  /** Alternate names (incl. the original prompt file name for back-compat). */
  aliases: string[];
  /** One-line description shown in /help. */
  description: string;
  /** Sort order in /help (lower first); defaults after all numbered ones. */
  order: number;
  /** Optional extra instruction appended when the report is invoked. */
  kickoffHint?: string;
  /**
   * Set when the report accepts tickers beyond the one it runs on, e.g. the peer
   * list in `/compete NVDA AMD AVGO`. The value is the usage shown in /help. Only
   * commands declaring this get extra words parsed as arguments; for every other
   * command the words after the slash remain a single ticker override.
   */
  args?: string;
  /** The prompt body (frontmatter stripped). */
  body: string;
};

/** Split a skill file into its frontmatter map and body. */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };

  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    // Values may be quoted so the frontmatter stays valid YAML — pi parses these
    // files with a real YAML parser and silently drops a skill whose frontmatter
    // fails to parse, so e.g. `args: [TICKER] [PEER ...]` must be quoted. Strip
    // the quotes here to keep the value identical to the unquoted form.
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
  }
  return { meta, body: match[2] };
}

function loadSkills(): ReportCommand[] {
  let files: string[];
  try {
    files = readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }

  const commands: ReportCommand[] = [];
  for (const file of files) {
    const raw = readFileSync(join(SKILLS_DIR, file), "utf-8");
    const { meta, body } = parseFrontmatter(raw);
    const name = (meta.name || file.replace(/\.md$/, "")).toLowerCase();
    if (!name) continue;

    const aliases = (meta.aliases ?? "")
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter((a) => a && a !== name);

    commands.push({
      name,
      aliases,
      description: meta.description || name,
      order: Number.isFinite(Number(meta.order)) ? Number(meta.order) : 999,
      kickoffHint: meta.kickoffHint || undefined,
      args: meta.args || undefined,
      body: expandIncludes(body, SHARED_DIR),
    });
  }

  commands.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return commands;
}

export const REPORT_COMMANDS: ReportCommand[] = loadSkills();

const byKey = new Map<string, ReportCommand>();
for (const cmd of REPORT_COMMANDS) {
  byKey.set(cmd.name, cmd);
  for (const alias of cmd.aliases) byKey.set(alias, cmd);
}

/** Look up a command by its name or any alias (case-insensitive). */
export function findCommand(key: string): ReportCommand | undefined {
  return byKey.get(key.trim().toLowerCase());
}

/** The prompt body for a report (frontmatter already stripped). */
export function loadReportPrompt(cmd: ReportCommand): string {
  return cmd.body;
}

/**
 * Cap on companies a report may be pointed at beyond its own ticker. Each one
 * costs a full data fetch — a multi-megabyte companyfacts download plus filing
 * exhibits — so this bounds a single command's runtime and token bill.
 */
export const MAX_EXTRA_TICKERS = 4;

/**
 * Build the user-turn message that runs a report protocol against a ticker.
 *
 * Shared by both entry points — the standalone CLI (cli.ts) and the Pi-package
 * alias commands (pi-aliases.ts) — so a report reads identically either way.
 */
export function buildReportMessage(
  cmd: ReportCommand,
  ticker: string,
  extra: string[] = []
): string {
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
