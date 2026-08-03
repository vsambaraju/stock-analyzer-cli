/**
 * API key management.
 *
 * Resolution order: process environment → saved config file → interactive setup.
 *
 * Keys are persisted to ~/.stock-analyzer/config.json with 0600 permissions
 * (owner read/write only), well outside the project directory, so they are
 * never at risk of being committed to git. Interactive entry is masked so the
 * key is not echoed to the terminal.
 */

import { homedir } from "os";
import { join } from "path";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { c } from "./ui.js";

export type Provider = "anthropic" | "openai";
export type ApiKeys = { anthropic?: string; openai?: string };

const CONFIG_DIR = join(homedir(), ".stock-analyzer");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function configPath(): string {
  return CONFIG_FILE;
}

/** Read saved keys from the config file. Returns {} if missing or unreadable. */
export function loadSavedKeys(): ApiKeys {
  try {
    const data = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Record<string, unknown>;
    const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    return { anthropic: pick(data.anthropic), openai: pick(data.openai) };
  } catch {
    return {};
  }
}

/** Persist a key securely (0600) to the config file, merging with any existing keys. */
export function saveKey(provider: Provider, key: string): string {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const existing = loadSavedKeys();
  existing[provider] = key;
  writeFileSync(CONFIG_FILE, JSON.stringify(existing, null, 2) + "\n", { mode: 0o600 });
  // Enforce perms even if the file already existed with looser modes.
  chmodSync(CONFIG_FILE, 0o600);
  return CONFIG_FILE;
}

/** Promisified readline question. */
function ask(rl: ReadlineInterface, query: string): Promise<string> {
  return new Promise((resolve) => rl.question(query, (answer) => resolve(answer.trim())));
}

/** Ask a question, masking typed characters so the key is not echoed to the screen. */
function askHidden(rl: ReadlineInterface, query: string): Promise<string> {
  const iface = rl as unknown as { _writeToOutput?: (s: string) => void; output?: NodeJS.WritableStream };
  return new Promise((resolve) => {
    const original = iface._writeToOutput?.bind(iface);
    // The prompt is printed synchronously by question() below (before we mute).
    rl.question(query, (answer) => {
      if (original) iface._writeToOutput = original;
      iface.output?.write("\n");
      resolve(answer.trim());
    });
    // Mute all subsequent echo (typed characters, line refreshes) until Enter.
    if (original) iface._writeToOutput = () => {};
  });
}

/** Best-effort key check. true = valid, false = rejected (401/403), null = unknown. */
async function verifyKey(provider: Provider, key: string): Promise<boolean | null> {
  try {
    const res =
      provider === "anthropic"
        ? await fetch("https://api.anthropic.com/v1/models", {
            headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
          })
        : await fetch("https://api.openai.com/v1/models", {
            headers: { Authorization: `Bearer ${key}` },
          });
    if (res.status === 401 || res.status === 403) return false;
    return res.ok ? true : null;
  } catch {
    return null; // network error — can't tell, don't block the user
  }
}

const PROVIDER_LABEL: Record<Provider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

/** Interactive first-run setup: choose a provider, paste a key, verify, and save. */
async function runSetupWizard(): Promise<ApiKeys> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Exit cleanly if the user cancels setup (Ctrl-C) or sends EOF (Ctrl-D).
  let finished = false;
  const cancel = (code: number) => {
    if (finished) return;
    finished = true;
    console.log(c.dim("\nSetup cancelled."));
    rl.close();
    process.exit(code);
  };
  rl.on("SIGINT", () => cancel(130));
  rl.on("close", () => cancel(0));

  try {
    console.log(c.yellow("\nNo API key found — let's set one up."));
    console.log(
      c.dim(`It will be saved to ${CONFIG_FILE} (owner-only, 0600) and never committed to git.\n`)
    );

    // 1. Choose provider.
    let provider: Provider | null = null;
    while (!provider) {
      const choice = await ask(
        rl,
        `${c.brightCyan("Which provider?")} ${c.dim("[1] Anthropic  [2] OpenAI  (default 1):")} `
      );
      if (choice === "" || choice === "1" || /^anthropic$/i.test(choice)) provider = "anthropic";
      else if (choice === "2" || /^openai$/i.test(choice)) provider = "openai";
      else console.error(c.red("Please enter 1 or 2."));
    }

    const label = PROVIDER_LABEL[provider];
    const expectedPrefix = provider === "anthropic" ? "sk-ant-" : "sk-";

    // 2. Read and verify the key.
    while (true) {
      const key = await askHidden(
        rl,
        `${c.brightCyan(`Paste your ${label} API key`)} ${c.dim("(input hidden):")} `
      );
      if (!key) {
        console.error(c.red("No key entered. Try again, or press Ctrl-C to quit."));
        continue;
      }
      if (!key.startsWith(expectedPrefix)) {
        console.error(
          c.yellow(`Warning: ${label} keys usually start with "${expectedPrefix}". Double-check it.`)
        );
      }

      process.stdout.write(c.dim("Verifying key... "));
      const ok = await verifyKey(provider, key);
      if (ok === false) {
        console.error(c.red("rejected. That key was not accepted — please try again."));
        continue;
      }
      console.log(ok ? c.green("ok.") : c.yellow("could not verify (network), saving anyway."));

      const path = saveKey(provider, key);
      console.log(c.green(`✓ Saved ${label} key to ${path}\n`));
      finished = true; // prevent the close handler from exiting the process
      return { [provider]: key } as ApiKeys;
    }
  } finally {
    rl.close();
  }
}

/**
 * Resolve API keys, running the interactive setup wizard if none are available.
 * Environment variables take precedence over saved keys.
 */
export async function resolveApiKeys(): Promise<ApiKeys> {
  const saved = loadSavedKeys();
  const keys: ApiKeys = {
    anthropic: process.env.ANTHROPIC_API_KEY?.trim() || saved.anthropic,
    openai: process.env.OPENAI_API_KEY?.trim() || saved.openai,
  };

  if (keys.anthropic || keys.openai) return keys;

  return runSetupWizard();
}
