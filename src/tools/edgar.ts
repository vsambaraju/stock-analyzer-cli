/**
 * Shared SEC EDGAR access: request headers, JSON fetch, and ticker → CIK lookup.
 *
 * EDGAR's fair-access policy requires a descriptive User-Agent carrying a real
 * contact address and caps traffic at roughly 10 requests/second. Set
 * SEC_USER_AGENT to your own "Name email@example.com" string; the default only
 * identifies the tool.
 *
 * The CIK map (~1MB) is fetched once per process and cached, so every tool that
 * needs a CIK shares a single download.
 */

export const EDGAR_HEADERS = {
  "User-Agent":
    process.env.SEC_USER_AGENT?.trim() ||
    "stock-analyzer-cli (research tool; set SEC_USER_AGENT to your contact email)",
  Accept: "application/json",
};

export async function edgarFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: EDGAR_HEADERS });
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
