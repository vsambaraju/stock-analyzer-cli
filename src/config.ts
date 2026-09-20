/**
 * The on-disk config store: ~/.stock-analyzer/config.json.
 *
 * Holds API keys and the SEC contact address. Owner-only (0700 directory, 0600
 * file) and well outside the project directory, so nothing here can be committed
 * to git by accident.
 *
 * This module exists so that both the key manager and the EDGAR client can reach
 * the store without importing each other — they sit on opposite sides of it.
 * It deliberately knows nothing about what the fields mean.
 */

import { homedir } from "os";
import { join } from "path";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";

const CONFIG_DIR = join(homedir(), ".stock-analyzer");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function configPath(): string {
  return CONFIG_FILE;
}

/**
 * Read the whole config object. Returns {} if missing or unreadable.
 *
 * Callers read and write the whole object rather than their own slice of it, so
 * a field one caller doesn't know about survives the other one saving.
 */
export function readConfig(): Record<string, unknown> {
  try {
    const data = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as unknown;
    return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Persist the config securely: 0700 directory, 0600 file. Returns the path. */
export function writeConfig(cfg: Record<string, unknown>): string {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  // Enforce perms even if the file already existed with looser modes.
  chmodSync(CONFIG_FILE, 0o600);
  return CONFIG_FILE;
}
