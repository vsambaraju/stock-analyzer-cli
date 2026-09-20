/**
 * Shared SEC EDGAR access: identity, rate limiting, JSON fetch, and ticker → CIK
 * lookup.
 *
 * EDGAR's fair-access policy requires every request to declare a real contact
 * address in its User-Agent, and caps traffic at roughly 10 requests/second.
 * Both are enforced here rather than left to callers:
 *
 *   - Identity: resolved from SEC_USER_AGENT, else the address saved by the
 *     CLI's first-run prompt. There is deliberately no placeholder default —
 *     shipping one would put every user's traffic on SEC under the same
 *     non-compliant string.
 *   - Rate: every request passes through one process-wide gate spaced to stay
 *     under the ceiling, so a fan-out like `/compete NVDA AMD AVGO` cannot burst.
 *
 * Nothing here should call fetch() directly — use edgarFetch() so both apply.
 *
 * The CIK map (~1MB) is fetched once per process and cached, so every tool that
 * needs a CIK shares a single download.
 */

import { readConfig } from "../config.js";

/** SEC's published ceiling is ~10 req/s; stay under it with a little headroom. */
const MIN_INTERVAL_MS = 125;

let lastRequestAt = 0;
let gate: Promise<void> = Promise.resolve();

/**
 * Space requests at least MIN_INTERVAL_MS apart, process-wide.
 *
 * The chained promise serialises only the *gate*, not the requests themselves —
 * callers still run concurrently once past it, they just start staggered.
 */
function pace(): Promise<void> {
  gate = gate.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
  });
  return gate;
}

let cachedUserAgent: string | null = null;

/** A usable contact string has to carry an address SEC can actually reach. */
export function isValidSecUserAgent(value: string): boolean {
  return /[^@\s]+@[^@\s]+\.[^@\s]+/.test(value.trim());
}

/** Record the address resolved at startup, so later requests skip the file read. */
export function setSecUserAgent(value: string): void {
  cachedUserAgent = value.trim();
}

/**
 * Resolve the declared identity. Throws rather than falling back to a generic
 * string: an unidentified request is one SEC asks us not to send.
 */
export function secUserAgent(): string {
  if (cachedUserAgent) return cachedUserAgent;

  const fromEnv = process.env.SEC_USER_AGENT?.trim();
  if (fromEnv) return (cachedUserAgent = fromEnv);

  const saved = readConfig().secUserAgent;
  if (typeof saved === "string" && saved.trim()) return (cachedUserAgent = saved.trim());

  throw new Error(
    "SEC EDGAR requires a contact address in the User-Agent (fair-access policy). " +
      'Set SEC_USER_AGENT to "Your Name your@email.com", or run the stock-analyze ' +
      "CLI once and enter it when prompted."
  );
}

/** The only way to reach EDGAR: declares identity and holds the rate ceiling. */
export async function edgarFetch(
  url: string,
  opts: { accept?: string; timeoutMs?: number } = {}
): Promise<Response> {
  const headers = {
    "User-Agent": secUserAgent(),
    Accept: opts.accept ?? "application/json",
  };
  await pace();
  return fetch(url, {
    headers,
    ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
  });
}

export async function edgarFetchJson(url: string): Promise<unknown> {
  const res = await edgarFetch(url);
  if (!res.ok) throw new Error(`EDGAR API ${res.status}: ${url}`);
  return res.json();
}

const _cikCache = new Map<string, string>();
let _tickerMap: Promise<Record<string, { cik_str: number; ticker: string; title: string }>> | null =
  null;

/** Resolve a ticker to its zero-padded 10-digit CIK. Cached for the process. */
export async function getCik(ticker: string): Promise<string> {
  const t = ticker.toUpperCase();
  const cached = _cikCache.get(t);
  if (cached) return cached;

  _tickerMap ??= edgarFetchJson("https://www.sec.gov/files/company_tickers.json") as Promise<
    Record<string, { cik_str: number; ticker: string; title: string }>
  >;

  let map: Record<string, { cik_str: number; ticker: string; title: string }>;
  try {
    map = await _tickerMap;
  } catch (e) {
    _tickerMap = null; // don't cache a failed download
    throw e;
  }

  const match = Object.values(map).find((c) => c.ticker.toUpperCase() === t);
  if (!match) throw new Error(`CIK not found for ticker: ${ticker}`);
  const cik = String(match.cik_str).padStart(10, "0");
  _cikCache.set(t, cik);
  return cik;
}
