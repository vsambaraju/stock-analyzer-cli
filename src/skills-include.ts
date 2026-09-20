/**
 * Include expansion for skill bodies: `{{include: moat-rubric.md}}`.
 *
 * Why this exists: `/moat` and `/decide` both score moat size, moat direction and
 * threat level. When each file carried its own copy of the criteria they drifted —
 * `/decide` kept the arithmetic but lost the thresholds, so the two reports scored
 * the same company differently. Partials in skills-shared/ make that impossible:
 * there is one copy of the rubric and both reports get it verbatim.
 *
 * Partials live in src/skills-shared/, deliberately *outside* src/skills/, because
 * Pi loads every .md under the skills directory as a command of its own (see the
 * `pi.skills` entry in package.json). A partial is not a command.
 *
 * Expansion happens twice, in two different places, for two different consumers:
 *   - commands.ts, at load time — serves `npm run dev`, which reads src/skills/.
 *   - scripts/build-skills.mjs, at build time — writes expanded files to dist/skills/,
 *     because Pi reads those .md files natively and never goes through commands.ts.
 * Both call this function, so there is only one implementation of the syntax.
 */

import { readFileSync } from "fs";
import { join } from "path";

/** `{{include: name.md}}` — leading whitespace is preserved as the block's indent. */
const INCLUDE_RE = /^([ \t]*)\{\{\s*include:\s*([A-Za-z0-9._-]+)\s*\}\}[ \t]*$/gm;

/** Maintainer notes at the top of a partial: for whoever edits it, not for the model. */
const HTML_COMMENT_RE = /<!--[\s\S]*?-->\s*/g;

/** How deep one partial may include another before we call it a cycle. */
const MAX_DEPTH = 5;

/**
 * Replace every `{{include: file.md}}` line in `body` with the contents of that
 * partial from `sharedDir`. Throws when a named partial is missing — a silently
 * dropped rubric is exactly the failure this mechanism exists to prevent.
 */
export function expandIncludes(body: string, sharedDir: string, depth = 0): string {
  // The depth check lives inside the replacer rather than guarding the call, so
  // this never has to call INCLUDE_RE.test() — a global regex carries lastIndex
  // between calls, and that state has no business deciding whether we recurse.
  return body.replace(INCLUDE_RE, (_match, indent: string, name: string) => {
    if (depth >= MAX_DEPTH) {
      throw new Error(`skill include nesting exceeded ${MAX_DEPTH} levels (circular include?)`);
    }
    let partial: string;
    try {
      partial = readFileSync(join(sharedDir, name), "utf-8");
    } catch {
      throw new Error(`skill include not found: ${name} (looked in ${sharedDir})`);
    }
    const expanded = expandIncludes(partial, sharedDir, depth + 1)
      .replace(HTML_COMMENT_RE, "")
      .trimEnd();
    return indent ? expanded.replace(/^(?=.)/gm, indent) : expanded;
  });
}
