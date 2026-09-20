/**
 * Post-build: expand skill includes into dist/skills/, and make the CLI runnable.
 *
 * This replaces a plain `cp -r` because Pi loads dist/skills/*.md natively (the
 * `pi.skills` entry in package.json) and never goes through commands.ts — so an
 * unexpanded include marker would reach the model verbatim in Pi-package mode.
 * Expanding at build time means both consumers see identical prompt text.
 *
 * Runs after tsc so it can import the one implementation of the syntax from dist.
 *
 * It also restores the executable bit on dist/cli.js. tsc writes plain 0644, which
 * `npm link` users feel immediately: the global stock-analyze symlink points at this
 * file, so a rebuild turns the command into "permission denied" until it is chmod'd
 * back. The shebang is already in src/cli.ts and tsc preserves it.
 */

import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { expandIncludes } from "../dist/skills-include.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src", "skills");
const sharedDir = join(root, "src", "skills-shared");
const outDir = join(root, "dist", "skills");

mkdirSync(outDir, { recursive: true });

let count = 0;
for (const file of readdirSync(srcDir).filter((f) => f.endsWith(".md"))) {
  const expanded = expandIncludes(readFileSync(join(srcDir, file), "utf-8"), sharedDir);
  if (expanded.includes("{{include:")) {
    throw new Error(`${file}: include marker survived expansion`);
  }
  writeFileSync(join(outDir, file), expanded);
  count++;
}

const bin = join(root, "dist", "cli.js");
chmodSync(bin, 0o755);

console.log(`skills: wrote ${count} expanded file(s) to dist/skills; chmod +x dist/cli.js`);
