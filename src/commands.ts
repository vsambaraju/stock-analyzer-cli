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

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, "skills");

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
    if (kv) meta[kv[1]] = kv[2].trim();
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
      body,
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
