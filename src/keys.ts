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
import type { Interface as ReadlineInterface } from "node:readline/promises";
import { c } from "./ui.js";

/** Providers we support interactive key setup for. Others (Azure, Bedrock) are
 *  configured via environment variables / ~/.pi/agent/auth.json, so we don't
 *  prompt for them. Ids match Pi's provider ids so a saved key can be injected
 *  with modelRuntime.setRuntimeApiKey(provider, key). */
export type Provider = "anthropic" | "openai" | "google" | "xai" | "deepseek" | "openrouter";
export const SETUP_PROVIDERS: readonly Provider[] = [
  "anthropic", "openai", "google", "xai", "deepseek", "openrouter",
];
export type ApiKeys = Partial<Record<Provider, string>>;

export const PROVIDER_LABEL: Record<Provider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google Gemini",
  xai: "xAI (Grok)",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
};

/** Environment variable that supplies each provider's key, when set. */
const PROVIDER_ENV: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  xai: "XAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/** Typical key prefix per provider, used only for a soft "double-check it" warning. */
const PROVIDER_PREFIX: Partial<Record<Provider, string>> = {
  anthropic: "sk-ant-",
  openai: "sk-",
  openrouter: "sk-or-",
  xai: "xai-",
  google: "AIza",
  deepseek: "sk-",
};

const CONFIG_DIR = join(homedir(), ".stock-analyzer");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function configPath(): string {
  return CONFIG_FILE;
}

/** Read saved keys from the config file. Returns {} if missing or unreadable. */
export function loadSavedKeys(): ApiKeys {
  try {
    const data = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Record<string, unknown>;
    const out: ApiKeys = {};
    for (const p of SETUP_PROVIDERS) {
      const v = data[p];
      if (typeof v === "string" && v.trim()) out[p] = v.trim();
    }
    return out;
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

async function ask(rl: ReadlineInterface, query: string): Promise<string> {
  return (await rl.question(query)).trim();
}

/**
 * Ask a question, masking typed characters so the key is not echoed to the screen.
 *
 * In terminal mode stdin is raw, so nothing is echoed by the tty itself — every
 * visible character comes from readline writing to the output stream. Muting that
 * stream for the duration of the question therefore hides the key. (Don't mute
 * readline's `_writeToOutput` instead: `readline/promises` interfaces don't define
 * it, so that mask silently does nothing and the key is echoed in cleartext.)
 */
async function askHidden(rl: ReadlineInterface, query: string): Promise<string> {
  const out = (rl as unknown as { output?: NodeJS.WritableStream }).output ?? process.stdout;
  const realWrite = out.write;
  const hadOwn = Object.hasOwn(out, "write");

  // The prompt is written synchronously by question() before we mute, so it stays visible.
  const answer = rl.question(query);
  out.write = () => true;

  try {
    return (await answer).trim();
  } finally {
    // Restore exactly what was there rather than leaving a bound copy shadowing
    // the stream's prototype for the rest of the process.
    if (hadOwn) out.write = realWrite;
    else delete (out as Partial<NodeJS.WritableStream>).write;
    out.write("\n");
  }
}

/** Best-effort key check. true = valid, false = rejected (auth error), null = unknown. */
async function verifyKey(provider: Provider, key: string): Promise<boolean | null> {
  try {
    let res: Response;
    switch (provider) {
      case "anthropic":
        res = await fetch("https://api.anthropic.com/v1/models", {
          headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
        });
        break;
      case "openai":
        res = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${key}` },
        });
        break;
      case "google":
        // Gemini takes the key as a query param; a bad key returns 400/403.
        res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`
        );
        if (res.status === 400) return false;
        break;
      case "xai":
        res = await fetch("https://api.x.ai/v1/models", {
          headers: { Authorization: `Bearer ${key}` },
        });
        break;
      case "deepseek":
        res = await fetch("https://api.deepseek.com/models", {
          headers: { Authorization: `Bearer ${key}` },
        });
        break;
      case "openrouter":
        // /models is public; /key echoes the calling key's data and 401s if invalid.
        res = await fetch("https://openrouter.ai/api/v1/key", {
          headers: { Authorization: `Bearer ${key}` },
        });
        break;
    }
    if (res.status === 401 || res.status === 403) return false;
    return res.ok ? true : null;
  } catch {
    return null; // network error — can't tell, don't block the user
  }
}

/**
 * Prompt for a provider key, verify it, and save it. Returns the key on success,
 * or null if the user backs out (empty input then Enter again is not treated as
 * a cancel — Ctrl-C/Ctrl-D on the shared readline handles that).
 */
async function readAndVerifyKey(rl: ReadlineInterface, provider: Provider): Promise<string> {
  const label = PROVIDER_LABEL[provider];
  const expectedPrefix = PROVIDER_PREFIX[provider];

  while (true) {
    const key = await askHidden(
      rl,
      `${c.brightCyan(`Paste your ${label} API key`)} ${c.dim("(input hidden):")} `
    );
    if (!key) {
      console.error(c.red("No key entered. Try again, or press Ctrl-C to quit."));
      continue;
    }
    if (expectedPrefix && !key.startsWith(expectedPrefix)) {
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
    return key;
  }
}

/** Interactive first-run setup: choose a provider, paste a key, verify, and save. */
async function runSetupWizard(rl: ReadlineInterface): Promise<ApiKeys> {
  console.log(c.yellow("\nNo API key found — let's set one up."));
  console.log(
    c.dim(`It will be saved to ${CONFIG_FILE} (owner-only, 0600) and never committed to git.\n`)
  );

  const provider = await chooseProvider(rl, "Which provider?");
  const key = await readAndVerifyKey(rl, provider);
  return { [provider]: key } as ApiKeys;
}

/** Numbered provider picker over SETUP_PROVIDERS. `configured` marks which already have creds. */
async function chooseProvider(
  rl: ReadlineInterface,
  heading: string,
  configured: readonly Provider[] = []
): Promise<Provider> {
  console.log(c.brightCyan(`\n${heading}`));
  SETUP_PROVIDERS.forEach((p, i) => {
    const mark = configured.includes(p) ? c.green("  ✓ configured") : c.dim("  (not set)");
    console.log("  " + c.brightCyan(String(i + 1).padStart(2)) + "  " + PROVIDER_LABEL[p] + mark);
  });
  while (true) {
    const choice = await ask(rl, c.dim(`Enter a number 1-${SETUP_PROVIDERS.length} (default 1): `));
    if (choice === "") return SETUP_PROVIDERS[0];
    const byName = SETUP_PROVIDERS.find((p) => p === choice.toLowerCase());
    if (byName) return byName;
    const n = Number(choice);
    if (Number.isInteger(n) && n >= 1 && n <= SETUP_PROVIDERS.length) return SETUP_PROVIDERS[n - 1];
    console.error(c.red(`Please enter 1-${SETUP_PROVIDERS.length}.`));
  }
}

/** Result of the startup confirm/switch step. */
export type ProviderSwitch = { provider: Provider; newKey?: string };

/**
 * Startup confirmation: show the configured providers and the active model, let
 * the user press Enter to proceed or switch to another provider. Switching to an
 * unconfigured provider prompts for its key (verified and saved). Returns the
 * chosen switch, or null to proceed unchanged.
 */
export async function confirmOrSwitchProviders(
  rl: ReadlineInterface,
  opts: {
    configured: readonly Provider[];
    activeLabel: string;
    otherConfiguredLabels?: readonly string[];
  }
): Promise<ProviderSwitch | null> {
  const configuredLabels = [
    ...opts.configured.map((p) => PROVIDER_LABEL[p]),
    ...(opts.otherConfiguredLabels ?? []),
  ];

  console.log(
    c.dim("\n  Configured keys: ") +
      (configuredLabels.length ? c.green(configuredLabels.join(", ")) : c.yellow("none"))
  );
  console.log(c.dim("  Active model:    ") + c.yellow(opts.activeLabel));

  const answer = (
    await ask(rl, "\n  " + c.dim("Press Enter to continue, or type ") + c.brightCyan("switch") + c.dim(" to change provider: "))
  ).toLowerCase();

  if (answer !== "switch" && answer !== "s") return null;

  const provider = await chooseProvider(rl, "Switch to which provider?", opts.configured);
  if (opts.configured.includes(provider)) {
    // Already has creds — just switch the active provider/model, no key needed.
    return { provider };
  }
  console.log(
    c.dim(
      `\nNo ${PROVIDER_LABEL[provider]} key is configured yet — it will be saved to ` +
        `${CONFIG_FILE} (owner-only, 0600).\n`
    )
  );
  const newKey = await readAndVerifyKey(rl, provider);
  return { provider, newKey };
}

/**
 * Resolve API keys, running the interactive setup wizard if none are available.
 * Environment variables take precedence over saved keys.
 */
export async function resolveApiKeys(rl: ReadlineInterface): Promise<ApiKeys> {
  const saved = loadSavedKeys();
  const keys: ApiKeys = {};
  for (const p of SETUP_PROVIDERS) {
    const key = process.env[PROVIDER_ENV[p]]?.trim() || saved[p];
    if (key) keys[p] = key;
  }

  if (Object.keys(keys).length) return keys;

  return runSetupWizard(rl);
}
