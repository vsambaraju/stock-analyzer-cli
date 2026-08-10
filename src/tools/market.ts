/**
 * Market and financial data tools.
 * Price: Yahoo Finance v8 chart API (no auth required).
 * Financials: SEC EDGAR XBRL companyfacts API (no auth required).
 */

import { EDGAR_HEADERS, getCik } from "./edgar.js";
import { createCache } from "./cache.js";

const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  Accept: "application/json",
};

/** Benchmark index used for relative performance comparisons. */
const BENCHMARK = "^GSPC";

// ── Helpers ───────────────────────────────────────────────────────────────────

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const r2 = (n: number | null): number | null => (n == null ? null : Math.round(n * 100) / 100);
const r4 = (n: number | null): number | null => (n == null ? null : Math.round(n * 10000) / 10000);

/** Days between two ISO dates. */
function daysBetween(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 86_400_000;
}

type ChartPoint = { date: string; close: number };

/**
 * Fetch a Yahoo chart response. `range`/`interval` follow Yahoo's vocabulary
 * ("1d", "1mo", "1y", "5y" / "1d", "1wk", "1mo"). Returns the metadata block
 * plus the (possibly empty) close series, with gaps and nulls removed.
 */
/**
 * Short TTL: the same quote is requested several times while one report is being
 * written (validate → price data → history), and collapsing that burst costs
 * nothing. A minute is well inside how long a report takes to read, so a later
 * question in the same session still sees a fresh price.
 */
const chartCache = createCache<{ meta: Record<string, unknown>; points: ChartPoint[] }>({
  ttlMs: 60 * 1000,
  maxEntries: 24,
});

async function yfChart(
  ticker: string,
  range = "1d",
  interval = "1d"
): Promise<{ meta: Record<string, unknown>; points: ChartPoint[] }> {
  // Range and interval change the payload, so both belong in the key.
  return chartCache.get(`${ticker.toUpperCase()}|${range}|${interval}`, () =>
    fetchYfChart(ticker, range, interval)
  );
}

async function fetchYfChart(
  ticker: string,
  range: string,
  interval: string
): Promise<{ meta: Record<string, unknown>; points: ChartPoint[] }> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?interval=${interval}&range=${range}`;
  const res = await fetch(url, { headers: YF_HEADERS });
  if (!res.ok) throw new Error(`Yahoo Finance v8 ${res.status}: ${ticker}`);

  const data = (await res.json()) as {
    chart: {
      result?: Array<{
        meta: Record<string, unknown>;
        timestamp?: number[];
        indicators?: {
          quote?: Array<{ close?: Array<number | null> }>;
          adjclose?: Array<{ adjclose?: Array<number | null> }>;
        };
      }>;
    };
  };

  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No chart data for ${ticker}`);

  const stamps = result.timestamp ?? [];
  const closes =
    result.indicators?.adjclose?.[0]?.adjclose ?? result.indicators?.quote?.[0]?.close ?? [];

  const points: ChartPoint[] = [];
  for (let i = 0; i < stamps.length; i++) {
    const close = num(closes[i]);
    if (close == null) continue; // holidays / halted sessions come back as null
    points.push({ date: new Date(stamps[i] * 1000).toISOString().slice(0, 10), close });
  }

  return { meta: result.meta, points };
}

/** Fetch just the metadata block (price, 52-week range, exchange). */
async function yfMeta(ticker: string): Promise<Record<string, unknown>> {
  return (await yfChart(ticker)).meta;
}

/**
 * Check whether a ticker corresponds to a real, tradeable security.
 * Uses the Yahoo Finance chart endpoint, which covers stocks and ETFs and
 * returns the company/fund name. Returns { valid: false } for unknown tickers.
 */
export async function validateTicker(
  ticker: string
): Promise<{ valid: boolean; name?: string }> {
  try {
    const meta = await yfMeta(ticker);
    const name =
      (meta.longName as string) || (meta.shortName as string) || undefined;
    return { valid: true, name };
  } catch {
    return { valid: false };
  }
}

// ── Price series analytics ────────────────────────────────────────────────────

/** Simple moving average over the final `window` closes; null if too few points. */
function movingAverage(points: ChartPoint[], window: number): number | null {
  if (points.length < window) return null;
  const slice = points.slice(-window);
  return slice.reduce((s, p) => s + p.close, 0) / window;
}

/** Percentage change between the first and last close of a series. */
function totalReturnPct(points: ChartPoint[]): number | null {
  if (points.length < 2) return null;
  const first = points[0].close;
  const last = points[points.length - 1].close;
  return first > 0 ? ((last - first) / first) * 100 : null;
}

/** Largest peak-to-trough decline over the series, as a negative percentage. */
function maxDrawdownPct(points: ChartPoint[]): number | null {
  if (points.length < 2) return null;
  let peak = points[0].close;
  let worst = 0;
  for (const p of points) {
    if (p.close > peak) peak = p.close;
    const dd = ((p.close - peak) / peak) * 100;
    if (dd < worst) worst = dd;
  }
  return worst;
}

/** Annualized volatility from daily log returns (252 trading days). */
function annualizedVolPct(points: ChartPoint[]): number | null {
  if (points.length < 20) return null;
  const returns: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].close;
    if (prev > 0) returns.push(Math.log(points[i].close / prev));
  }
  if (returns.length < 20) return null;
  const mean = returns.reduce((s, x) => s + x, 0) / returns.length;
  const variance = returns.reduce((s, x) => s + (x - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

/** Last close of each calendar month — a compact shape of the trend. */
function monthlyCloses(points: ChartPoint[]): Array<{ month: string; close: number }> {
  const byMonth = new Map<string, number>();
  for (const p of points) byMonth.set(p.date.slice(0, 7), p.close);
  return [...byMonth.entries()].map(([month, close]) => ({ month, close: r2(close)! }));
}

/**
 * One year (or the requested range) of daily closes reduced to the statistics
 * the analysis protocols actually ask for: trend vs. moving averages, drawdown,
 * and performance relative to the S&P 500.
 */
export async function getPriceHistory(ticker: string, range = "1y"): Promise<object> {
  try {
    const { meta, points } = await yfChart(ticker, range, "1d");
    if (points.length < 2) {
      return { error: `No price history returned for ${ticker} over ${range}.` };
    }

    const last = points[points.length - 1].close;
    const ma50 = movingAverage(points, 50);
    const ma200 = movingAverage(points, 200);
    const high52 = num(meta["fiftyTwoWeekHigh"]);
    const low52 = num(meta["fiftyTwoWeekLow"]);
    const changePct = totalReturnPct(points);

    // Benchmark comparison is best-effort — a failed index fetch must not sink
    // the whole tool call.
    let benchmark: object | null = null;
    try {
      const bench = await yfChart(BENCHMARK, range, "1d");
      const benchPct = totalReturnPct(bench.points);
      benchmark = {
        symbol: "S&P 500 (^GSPC)",
        change_pct: r2(benchPct),
        relative_performance_pp:
          changePct != null && benchPct != null ? r2(changePct - benchPct) : null,
        verdict:
          changePct != null && benchPct != null
            ? changePct > benchPct
              ? "outperform"
              : "underperform"
            : null,
      };
    } catch {
      benchmark = { symbol: "S&P 500 (^GSPC)", error: "benchmark fetch failed" };
    }

    return {
      ticker: ticker.toUpperCase(),
      company_name: meta["longName"] ?? meta["shortName"] ?? ticker,
      range,
      period_start: points[0].date,
      period_end: points[points.length - 1].date,
      trading_days: points.length,
      current_price: r2(last),
      change_pct: r2(changePct),
      fifty_two_week_high: high52,
      fifty_two_week_low: low52,
      pct_below_52w_high: high52 ? r2(((last - high52) / high52) * 100) : null,
      pct_above_52w_low: low52 ? r2(((last - low52) / low52) * 100) : null,
      ma_50: r2(ma50),
      ma_200: r2(ma200),
      price_vs_ma50_pct: ma50 ? r2(((last - ma50) / ma50) * 100) : null,
      price_vs_ma200_pct: ma200 ? r2(((last - ma200) / ma200) * 100) : null,
      trend:
        ma50 != null && ma200 != null
          ? ma50 > ma200
            ? "golden cross (50d above 200d)"
            : "death cross (50d below 200d)"
          : null,
      max_drawdown_pct: r2(maxDrawdownPct(points)),
      annualized_volatility_pct: r2(annualizedVolPct(points)),
      monthly_closes: monthlyCloses(points),
      benchmark,
      source: "Yahoo Finance v8 chart (adjusted closes)",
    };
  } catch (e: unknown) {
    return { error: `Failed to fetch price history for ${ticker}: ${(e as Error).message}` };
  }
}

// ── XBRL financial data ───────────────────────────────────────────────────────

type XbrlEntry = { start?: string; end: string; val: number; form: string; frame?: string };

type XbrlFacts = Record<string, { units: Record<string, XbrlEntry[]> }>;

/**
 * Companyfacts is ~3.7 MB per filer and is read by four separate tools, so it is
 * cached for the session. Filings only change when a new one is accepted, which
 * makes a long TTL safe; the entry cap keeps a multi-ticker session (`/new`) from
 * holding every parsed document in memory at once.
 */
const xbrlCache = createCache<{ gaap: XbrlFacts; dei: XbrlFacts }>({
  ttlMs: 6 * 60 * 60 * 1000,
  maxEntries: 8,
});

async function fetchXbrlFacts(cik: string): Promise<{ gaap: XbrlFacts; dei: XbrlFacts }> {
  return xbrlCache.get(cik, async () => {
    const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
    const res = await fetch(url, { headers: EDGAR_HEADERS });
    if (!res.ok) throw new Error(`EDGAR XBRL ${res.status}: CIK ${cik}`);
    const data = (await res.json()) as { facts: { "us-gaap"?: XbrlFacts; dei?: XbrlFacts } };
    return { gaap: data.facts?.["us-gaap"] ?? {}, dei: data.facts?.dei ?? {} };
  });
}

function latestAnnual(entries: XbrlEntry[]): number | null {
  const annual = entries
    .filter((e) => e.form === "10-K" && e.start && !e.frame?.includes("Q"))
    .sort((a, b) => a.end.localeCompare(b.end));
  return annual.length ? annual[annual.length - 1].val : null;
}

function ttmFromQuarterly(entries: XbrlEntry[]): number | null {
  // Find distinct non-overlapping quarters from most recent filing, sum last 4.
  // Relies on SEC's standardized `CYnnnnQn` frames, which are only assigned to
  // periods aligning to calendar quarters — so this returns null (not a wrong sum)
  // for non-calendar fiscal years, and the caller falls back to the annual figure.
  const quarterly = entries
    .filter(
      (e) =>
        (e.form === "10-Q" || e.form === "10-K") &&
        e.start &&
        e.frame?.match(/CY\d{4}Q\d/)
    )
    .sort((a, b) => b.end.localeCompare(a.end)); // newest first

  const seen = new Set<string>();
  const picked: XbrlEntry[] = [];
  for (const e of quarterly) {
    const key = e.frame!;
    if (!seen.has(key)) {
      seen.add(key);
      picked.push(e);
      if (picked.length === 4) break;
    }
  }
  if (picked.length < 4) return null;
  // Only a genuine trailing-twelve-months window is valid: the four picked quarters
  // must be the four most recent, spanning ~9 months end-to-end. A wider span means
  // frames were sparse (non-calendar filer) and we grabbed stale quarters — reject.
  const span = daysBetween(picked[picked.length - 1].end, picked[0].end);
  if (span > 400) return null;
  return picked.reduce((s, e) => s + e.val, 0);
}

/**
 * Resolve a concept from a list of candidate names. When several candidates carry
 * data, prefer the one with the most recent entry — companies migrate between tags
 * (e.g. `Revenues` → `RevenueFromContractWithCustomerExcludingAssessedTax` under
 * ASC 606, or the reverse), and the deprecated tag lingers with stale values. Taking
 * the *first* candidate that merely has any entries would silently read years-old
 * data; taking the freshest tag reads what the company reports today. Ties keep the
 * earlier-listed (more specific) name.
 */
function getConcept(gaap: XbrlFacts, ...names: string[]): XbrlEntry[] {
  let best: XbrlEntry[] = [];
  let bestEnd = "";
  for (const name of names) {
    const entries = gaap[name]?.units?.USD ?? gaap[name]?.units?.shares;
    if (!entries?.length) continue;
    let maxEnd = "";
    for (const e of entries) if (e.end > maxEnd) maxEnd = e.end;
    if (best.length === 0 || maxEnd > bestEnd) {
      best = entries;
      bestEnd = maxEnd;
    }
  }
  return best;
}

function getDeiConcept(dei: XbrlFacts, ...names: string[]): XbrlEntry[] {
  for (const name of names) {
    const entries = dei[name]?.units?.shares ?? dei[name]?.units?.USD;
    if (entries?.length) return entries;
  }
  return [];
}

/** Sum of the concepts that make up total debt (each best-effort). */
function totalDebt(gaap: XbrlFacts): number | null {
  const parts = [
    latestInstant(getConcept(gaap, "LongTermDebtNoncurrent", "LongTermDebt")),
    latestInstant(getConcept(gaap, "LongTermDebtCurrent")),
    latestInstant(getConcept(gaap, "ShortTermBorrowings", "OtherShortTermBorrowings")),
  ].filter((v): v is number => v != null);
  return parts.length ? parts.reduce((s, v) => s + v, 0) : null;
}

// ── Period series extraction ──────────────────────────────────────────────────

/**
 * Duration facts (revenue, income, cash flow) covering ~a quarter or ~a year.
 * Filtering on the measured duration rather than the `frame` label keeps
 * companies with non-calendar fiscal years in scope. Restatements are
 * de-duplicated by period end, preferring the 10-K figure.
 */
function periodSeries(
  entries: XbrlEntry[],
  kind: "annual" | "quarterly",
  limit: number
): Array<{ period_end: string; value: number }> {
  const [lo, hi] = kind === "annual" ? [340, 400] : [75, 105];
  const byEnd = new Map<string, XbrlEntry>();

  for (const e of entries) {
    if (!e.start) continue;
    const days = daysBetween(e.start, e.end);
    if (days < lo || days > hi) continue;
    const prev = byEnd.get(e.end);
    if (!prev || (prev.form !== "10-K" && e.form === "10-K")) byEnd.set(e.end, e);
  }

  return [...byEnd.values()]
    .sort((a, b) => a.end.localeCompare(b.end))
    .slice(-limit)
    .map((e) => ({ period_end: e.end, value: e.val }));
}

/**
 * Discrete quarterly values for a flow concept.
 *
 * Two XBRL facts of life make the naive ~90-day filter insufficient:
 *   - 10-Q cash flow statements are cumulative year-to-date, so only Q1 is ever
 *     tagged as a standalone quarter.
 *   - Fiscal Q4 is never tagged at all; the 10-K reports the full year.
 *
 * Both are recovered the same way: entries sharing a fiscal-year `start` are
 * cumulative snapshots, so differencing consecutive ends yields the discrete
 * quarter — with the full-year 10-K figure supplying Q4. Directly tagged
 * quarters win over derived ones wherever both exist.
 */
function quarterlyFlowSeries(
  entries: XbrlEntry[],
  limit: number
): Array<{ period_end: string; value: number }> {
  const discrete = new Map<string, number>();
  const byStart = new Map<string, XbrlEntry[]>();

  for (const e of entries) {
    if (!e.start) continue;
    const days = daysBetween(e.start, e.end);
    if (days >= 75 && days <= 105 && !discrete.has(e.end)) discrete.set(e.end, e.val);
    if (days < 75 || days > 400) continue;
    const group = byStart.get(e.start) ?? [];
    group.push(e);
    byStart.set(e.start, group);
  }

  const derived = new Map<string, number>();
  for (const group of byStart.values()) {
    // Collapse restatements of the same period end before differencing.
    const uniq = new Map<string, XbrlEntry>();
    for (const e of group) {
      const prev = uniq.get(e.end);
      if (!prev || (prev.form !== "10-K" && e.form === "10-K")) uniq.set(e.end, e);
    }
    const sorted = [...uniq.values()].sort((a, b) => a.end.localeCompare(b.end));

    for (let i = 0; i < sorted.length; i++) {
      if (i === 0) {
        const days = daysBetween(sorted[0].start!, sorted[0].end);
        if (days >= 75 && days <= 105) derived.set(sorted[0].end, sorted[0].val);
        continue;
      }
      const gap = daysBetween(sorted[i - 1].end, sorted[i].end);
      if (gap >= 75 && gap <= 105) {
        derived.set(sorted[i].end, sorted[i].val - sorted[i - 1].val);
      }
    }
  }

  const merged = new Map(derived);
  for (const [end, val] of discrete) merged.set(end, val);

  return [...merged.entries()]
    .map(([period_end, value]) => ({ period_end, value }))
    .sort((a, b) => a.period_end.localeCompare(b.period_end))
    .slice(-limit);
}

/** Instant facts (balance sheet items) — point-in-time, so they carry no `start`. */
function instantSeries(
  entries: XbrlEntry[],
  limit: number
): Array<{ period_end: string; value: number }> {
  const byEnd = new Map<string, XbrlEntry>();
  for (const e of entries) {
    if (e.start) continue;
    const prev = byEnd.get(e.end);
    if (!prev || (prev.form !== "10-K" && e.form === "10-K")) byEnd.set(e.end, e);
  }
  return [...byEnd.values()]
    .sort((a, b) => a.end.localeCompare(b.end))
    .slice(-limit)
    .map((e) => ({ period_end: e.end, value: e.val }));
}

function latestInstant(entries: XbrlEntry[]): number | null {
  const series = instantSeries(entries, 1);
  return series.length ? series[0].value : null;
}

type Row = Record<string, number | string | null>;

/** Merge several concept series into one row per period end. */
function mergeSeries(
  concepts: Record<string, XbrlEntry[]>,
  extract: (entries: XbrlEntry[], limit: number) => Array<{ period_end: string; value: number }>,
  limit: number
): Row[] {
  const rows = new Map<string, Row>();
  // Pull a slightly deeper window per concept so a short series for one metric
  // doesn't punch holes in the final rows.
  for (const [key, entries] of Object.entries(concepts)) {
    for (const p of extract(entries, limit + 4)) {
      let row = rows.get(p.period_end);
      if (!row) {
        row = { period_end: p.period_end };
        rows.set(p.period_end, row);
      }
      row[key] = p.value;
    }
  }
  return [...rows.values()]
    .sort((a, b) => String(a.period_end).localeCompare(String(b.period_end)))
    .slice(-limit);
}

/**
 * Year-over-year comparison against the row ~365 days earlier (±25 days).
 *
 * Percentage growth is only meaningful off a positive base, so a company with a
 * prior-year operating loss gets `pct: null`. The absolute change is always
 * reported — that is what distinguishes a narrowing loss from a widening one,
 * which the phase-classification protocol depends on.
 */
function yoyChange(
  rows: Row[],
  index: number,
  field: string
): { pct: number | null; abs: number | null } {
  const none = { pct: null, abs: null };
  const current = rows[index][field];
  if (typeof current !== "number") return none;
  const end = String(rows[index].period_end);

  for (let i = index - 1; i >= 0; i--) {
    const gap = daysBetween(String(rows[i].period_end), end);
    if (gap > 390) break;
    if (gap >= 340) {
      const prior = rows[i][field];
      if (typeof prior !== "number") return none;
      return {
        pct: prior > 0 ? ((current - prior) / prior) * 100 : null,
        abs: current - prior,
      };
    }
  }
  return none;
}

const REVENUE_CONCEPTS = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "Revenues",
  "SalesRevenueNet",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
];

// Many filers (restaurants, retail, some SaaS) never tag a GrossProfit line — they
// report a cost-of-revenue line instead. Gross profit is then Revenue − Cost of Revenue.
const COST_OF_REVENUE_CONCEPTS = [
  "CostOfGoodsAndServicesSold",
  "CostOfRevenue",
  "CostOfGoodsSold",
  "CostOfServices",
  "CostOfSales",
];

/** Build income-statement / cash-flow rows with derived margins and growth. */
function incomeRows(gaap: XbrlFacts, kind: "annual" | "quarterly", limit: number): Row[] {
  const rows = mergeSeries(
    {
      revenue: getConcept(gaap, ...REVENUE_CONCEPTS),
      gross_profit: getConcept(gaap, "GrossProfit"),
      cost_of_revenue: getConcept(gaap, ...COST_OF_REVENUE_CONCEPTS),
      operating_income: getConcept(gaap, "OperatingIncomeLoss"),
      net_income: getConcept(gaap, "NetIncomeLoss"),
      operating_cashflow: getConcept(gaap, "NetCashProvidedByUsedInOperatingActivities"),
      capex: getConcept(gaap, "PaymentsToAcquirePropertyPlantAndEquipment"),
      rd_expense: getConcept(gaap, "ResearchAndDevelopmentExpense"),
      sm_expense: getConcept(gaap, "SellingAndMarketingExpense", "MarketingExpense"),
    },
    kind === "quarterly"
      ? quarterlyFlowSeries
      : (entries, window) => periodSeries(entries, kind, window),
    limit
  );

  rows.forEach((row, i) => {
    const rev = typeof row.revenue === "number" ? row.revenue : null;
    const ocf = typeof row.operating_cashflow === "number" ? row.operating_cashflow : null;
    const capex = typeof row.capex === "number" ? row.capex : null;
    const fcf = ocf != null ? ocf - (capex ?? 0) : null;

    row.fcf = fcf;
    // Derive gross profit from cost of revenue when the filer tags no GrossProfit line.
    if (typeof row.gross_profit !== "number" && rev && typeof row.cost_of_revenue === "number") {
      row.gross_profit = rev - row.cost_of_revenue;
      row.gross_profit_derived = "Revenue − Cost of Revenue";
    }
    row.gross_margin =
      rev && typeof row.gross_profit === "number" ? r4(row.gross_profit / rev) : null;
    row.operating_margin =
      rev && typeof row.operating_income === "number" ? r4(row.operating_income / rev) : null;
    row.net_margin = rev && typeof row.net_income === "number" ? r4(row.net_income / rev) : null;
    row.fcf_margin = rev && fcf != null ? r4(fcf / rev) : null;
    const revYoy = yoyChange(rows, i, "revenue");
    const oiYoy = yoyChange(rows, i, "operating_income");
    row.revenue_growth_yoy_pct = r2(revYoy.pct);
    row.revenue_change_yoy = revYoy.abs;
    row.operating_income_growth_yoy_pct = r2(oiYoy.pct);
    row.operating_income_change_yoy = oiYoy.abs;
  });

  return rows;
}

/** Build balance-sheet rows from instant facts. */
function balanceRows(gaap: XbrlFacts, dei: XbrlFacts, limit: number): Row[] {
  const sharesGaap = getConcept(gaap, "CommonStockSharesOutstanding");
  const rows = mergeSeries(
    {
      cash_and_equivalents: getConcept(
        gaap,
        "CashAndCashEquivalentsAtCarryingValue",
        "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"
      ),
      short_term_investments: getConcept(
        gaap,
        "ShortTermInvestments",
        "MarketableSecuritiesCurrent",
        "AvailableForSaleSecuritiesDebtSecuritiesCurrent"
      ),
      total_assets: getConcept(gaap, "Assets"),
      total_liabilities: getConcept(gaap, "Liabilities"),
      stockholders_equity: getConcept(
        gaap,
        "StockholdersEquity",
        "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"
      ),
      long_term_debt: getConcept(gaap, "LongTermDebtNoncurrent", "LongTermDebt"),
      shares_outstanding: sharesGaap.length
        ? sharesGaap
        : getDeiConcept(dei, "EntityCommonStockSharesOutstanding"),
    },
    instantSeries,
    limit
  );

  for (const row of rows) {
    const cash = typeof row.cash_and_equivalents === "number" ? row.cash_and_equivalents : 0;
    const sti = typeof row.short_term_investments === "number" ? row.short_term_investments : 0;
    row.cash_and_investments = cash + sti || null;
  }

  return rows;
}

async function xbrlFinancials(cik: string): Promise<Record<string, number | string | null>> {
  const { gaap, dei } = await fetchXbrlFacts(cik);

  const revEntries = getConcept(gaap, ...REVENUE_CONCEPTS);
  const gpEntries = getConcept(gaap, "GrossProfit");
  const corEntries = getConcept(gaap, ...COST_OF_REVENUE_CONCEPTS);
  const oiEntries = getConcept(gaap, "OperatingIncomeLoss");
  const niEntries = getConcept(gaap, "NetIncomeLoss");
  const ocfEntries = getConcept(gaap, "NetCashProvidedByUsedInOperatingActivities");
  const capexEntries = getConcept(gaap, "PaymentsToAcquirePropertyPlantAndEquipment");
  const sharesGaap = getConcept(gaap, "CommonStockSharesOutstanding");
  const sharesEntries = sharesGaap.length ? sharesGaap : getDeiConcept(dei, "EntityCommonStockSharesOutstanding");

  const revTtm = ttmFromQuarterly(revEntries) ?? latestAnnual(revEntries);
  const revPrevTtm = (() => {
    // rough: prior year annual
    const annual = revEntries
      .filter((e) => e.form === "10-K" && !e.frame?.includes("Q"))
      .sort((a, b) => a.end.localeCompare(b.end));
    return annual.length >= 2 ? annual[annual.length - 2].val : null;
  })();

  // Prefer a tagged GrossProfit; otherwise derive it from Revenue − Cost of Revenue.
  const gpTagged = ttmFromQuarterly(gpEntries) ?? latestAnnual(gpEntries);
  const corTtm = ttmFromQuarterly(corEntries) ?? latestAnnual(corEntries);
  const gpDerived = gpTagged == null && revTtm != null && corTtm != null ? revTtm - corTtm : null;
  const gpTtm = gpTagged ?? gpDerived;
  const oiTtm = ttmFromQuarterly(oiEntries) ?? latestAnnual(oiEntries);
  const niTtm = ttmFromQuarterly(niEntries) ?? latestAnnual(niEntries);
  const ocfTtm = ttmFromQuarterly(ocfEntries) ?? latestAnnual(ocfEntries);
  const capexTtm = ttmFromQuarterly(capexEntries) ?? latestAnnual(capexEntries);

  const revenueGrowthYoy =
    revTtm != null && revPrevTtm != null && revPrevTtm > 0
      ? (revTtm - revPrevTtm) / revPrevTtm
      : null;

  const grossMargin = revTtm && gpTtm != null ? gpTtm / revTtm : null;
  const operatingMargin = revTtm && oiTtm != null ? oiTtm / revTtm : null;
  const netMargin = revTtm && niTtm != null ? niTtm / revTtm : null;

  // FCF = OCF - CapEx (capex is reported as positive outflow in EDGAR)
  const fcfTtm = ocfTtm != null && capexTtm != null ? ocfTtm - capexTtm : ocfTtm;
  const fcfMargin = revTtm && fcfTtm != null ? fcfTtm / revTtm : null;

  const ruleOf40 =
    revenueGrowthYoy != null && fcfMargin != null
      ? revenueGrowthYoy * 100 + fcfMargin * 100
      : revenueGrowthYoy != null && operatingMargin != null
      ? revenueGrowthYoy * 100 + operatingMargin * 100
      : null;

  const sharesLatest = (() => {
    const sorted = [...sharesEntries].sort((a, b) => b.end.localeCompare(a.end));
    return sorted.length ? sorted[0].val : null;
  })();

  // ── Balance sheet snapshot and the ratios the scorecards need ───────────────
  const cash = latestInstant(
    getConcept(
      gaap,
      "CashAndCashEquivalentsAtCarryingValue",
      "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"
    )
  );
  const shortTermInvestments = latestInstant(
    getConcept(
      gaap,
      "ShortTermInvestments",
      "MarketableSecuritiesCurrent",
      "AvailableForSaleSecuritiesDebtSecuritiesCurrent"
    )
  );
  const assets = latestInstant(getConcept(gaap, "Assets"));
  const liabilities = latestInstant(getConcept(gaap, "Liabilities"));
  const equity = latestInstant(
    getConcept(
      gaap,
      "StockholdersEquity",
      "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"
    )
  );
  const debt = totalDebt(gaap);

  const liquidity = (cash ?? 0) + (shortTermInvestments ?? 0) || null;

  // Cash runway only means something while free cash flow is negative.
  const cashRunwayYears =
    fcfTtm != null && fcfTtm < 0 && liquidity != null ? liquidity / Math.abs(fcfTtm) : null;

  // ROIC on a 21% statutory tax assumption — EDGAR effective rates are noisy and
  // the scorecards care about level and direction, not a precise NOPAT.
  const investedCapital = (debt ?? 0) + (equity ?? 0) || null;
  const roic =
    oiTtm != null && investedCapital != null && investedCapital > 0
      ? (oiTtm * 0.79) / investedCapital
      : null;

  return {
    revenue_ttm: revTtm,
    revenue_prev_annual: revPrevTtm,
    revenue_growth_yoy: revenueGrowthYoy,
    gross_profit_ttm: gpTtm,
    gross_margin: grossMargin,
    gross_profit_basis:
      gpTagged != null
        ? "reported (GrossProfit)"
        : gpDerived != null
        ? "derived (Revenue − Cost of Revenue)"
        : "unavailable (no GrossProfit or cost-of-revenue line tagged)",
    operating_income_ttm: oiTtm,
    operating_margin: operatingMargin,
    net_income_ttm: niTtm,
    net_margin: netMargin,
    operating_cashflow_ttm: ocfTtm,
    capex_ttm: capexTtm,
    fcf_ttm: fcfTtm,
    fcf_margin: fcfMargin,
    rule_of_40: ruleOf40,
    shares_outstanding: sharesLatest,
    // Balance sheet
    cash_and_equivalents: cash,
    short_term_investments: shortTermInvestments,
    cash_and_investments: liquidity,
    total_assets: assets,
    total_liabilities: liabilities,
    stockholders_equity: equity,
    total_debt: debt,
    net_cash: liquidity != null && debt != null ? liquidity - debt : null,
    debt_to_equity: debt != null && equity ? r4(debt / equity) : null,
    // Derived scorecard inputs
    cash_runway_years: cashRunwayYears != null ? r2(cashRunwayYears) : null,
    cash_runway_note:
      fcfTtm != null && fcfTtm >= 0 ? "FCF positive — runway not applicable" : null,
    roic: roic != null ? r4(roic) : null,
    roic_formula: "operating income x (1 - 21% assumed tax) / (total debt + stockholders equity)",
  };
}

// ── Exported tool functions ───────────────────────────────────────────────────

export async function getFinancials(ticker: string): Promise<object> {
  try {
    const cik = await getCik(ticker);
    const financials = await xbrlFinancials(cik);
    return { ticker: ticker.toUpperCase(), source: "SEC EDGAR XBRL", ...financials };
  } catch (e: unknown) {
    return { error: `Failed to fetch financials for ${ticker}: ${(e as Error).message}` };
  }
}

/**
 * Multi-period income statement, cash flow, and balance sheet history — the
 * trend data the phase/metrics protocols score against. Uses the same
 * companyfacts download as get_financials, so it costs no extra request.
 */
export async function getFinancialHistory(
  ticker: string,
  quarters = 12,
  years = 5
): Promise<object> {
  try {
    const cik = await getCik(ticker);
    const { gaap, dei } = await fetchXbrlFacts(cik);

    const quarterly = incomeRows(gaap, "quarterly", Math.max(1, Math.min(quarters, 20)));
    const annual = incomeRows(gaap, "annual", Math.max(1, Math.min(years, 10)));
    const balanceSheet = balanceRows(gaap, dei, Math.max(1, Math.min(quarters, 20)));

    if (!quarterly.length && !annual.length) {
      return {
        error: `No usable XBRL period data for ${ticker} — the company may file in a non-standard taxonomy.`,
      };
    }

    return {
      ticker: ticker.toUpperCase(),
      source: "SEC EDGAR XBRL companyfacts",
      units: "USD, absolute (margins are ratios, growth is percent)",
      note:
        "Rows are ordered oldest to newest. A missing field means the concept was not tagged for that period. " +
        "*_growth_yoy_pct is null when the prior-year base was zero or negative (a company in a loss) — use " +
        "*_change_yoy, the absolute year-over-year delta, to tell a narrowing loss from a widening one.",
      quarterly,
      annual,
      balance_sheet_quarterly: balanceSheet,
    };
  } catch (e: unknown) {
    return { error: `Failed to fetch financial history for ${ticker}: ${(e as Error).message}` };
  }
}

export async function getPriceData(ticker: string): Promise<object> {
  try {
    const meta = await yfMeta(ticker);
    const price = num(meta["regularMarketPrice"]);
    const prevClose = num(meta["chartPreviousClose"]);
    const priceChangePct =
      price && prevClose
        ? Math.round(((price - prevClose) / prevClose) * 10000) / 100
        : null;

    // Derive market cap and the valuation multiples from EDGAR. The multiples are
    // computed here rather than left to the model: it only ever sees price on one
    // side and earnings on the other (get_financials), so every ratio came back
    // "N/A" even when both inputs were present.
    let marketCap: number | null = null;
    let multiples: Record<string, number | string | null> = {};
    try {
      const cik = await getCik(ticker);
      const { gaap, dei } = await fetchXbrlFacts(cik);
      const sharesGaap = getConcept(gaap, "CommonStockSharesOutstanding");
      const sharesEntries = sharesGaap.length
        ? sharesGaap
        : getDeiConcept(dei, "EntityCommonStockSharesOutstanding");
      const latest = [...sharesEntries].sort((a, b) => b.end.localeCompare(a.end))[0];
      const shares = latest?.val ?? null;
      if (shares && price) marketCap = Math.round(shares * price);

      const ttm = (...names: string[]) => {
        const entries = getConcept(gaap, ...names);
        return ttmFromQuarterly(entries) ?? latestAnnual(entries);
      };
      const revenue = ttm(...REVENUE_CONCEPTS);
      const netIncome = ttm("NetIncomeLoss");
      const grossProfit = (() => {
        const tagged = ttm("GrossProfit");
        if (tagged != null) return tagged;
        const cost = ttm(...COST_OF_REVENUE_CONCEPTS);
        return revenue != null && cost != null ? revenue - cost : null;
      })();
      const ocf = ttm("NetCashProvidedByUsedInOperatingActivities");
      const capex = ttm("PaymentsToAcquirePropertyPlantAndEquipment");
      const fcf = ocf != null && capex != null ? ocf - capex : ocf;
      const equity = latestInstant(
        getConcept(
          gaap,
          "StockholdersEquity",
          "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"
        )
      );
      const cashAndInvestments =
        (latestInstant(
          getConcept(
            gaap,
            "CashAndCashEquivalentsAtCarryingValue",
            "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"
          )
        ) ?? 0) +
          (latestInstant(
            getConcept(
              gaap,
              "ShortTermInvestments",
              "MarketableSecuritiesCurrent",
              "AvailableForSaleSecuritiesDebtSecuritiesCurrent"
            )
          ) ?? 0) || null;
      const debt = totalDebt(gaap);

      // Enterprise value = market cap + debt − cash. Falls back to market cap
      // alone only when neither side of the bridge is tagged.
      const ev =
        marketCap != null && (debt != null || cashAndInvestments != null)
          ? Math.round(marketCap + (debt ?? 0) - (cashAndInvestments ?? 0))
          : marketCap;

      // A multiple against a negative denominator is meaningless, not just absent —
      // say so, so the model reports "not meaningful" instead of inventing a number.
      const over = (cap: number | null, base: number | null): number | string | null => {
        if (cap == null || base == null) return null;
        if (base <= 0) return "n/m (denominator is zero or negative)";
        return r2(cap / base);
      };

      multiples = {
        eps_ttm: netIncome != null && shares ? r2(netIncome / shares) : null,
        pe_ratio: over(marketCap, netIncome),
        ps_ratio: over(marketCap, revenue),
        p_gross_profit_ratio: over(marketCap, grossProfit),
        p_fcf_ratio: over(marketCap, fcf),
        p_book_ratio: over(marketCap, equity),
        enterprise_value: ev,
        ev_to_revenue: over(ev, revenue),
        ev_to_fcf: over(ev, fcf),
        multiples_basis:
          "TTM from SEC EDGAR XBRL (sum of last 4 quarters, else latest annual); " +
          "EV = market cap + total debt − cash & short-term investments",
        revenue_ttm: revenue,
        net_income_ttm: netIncome,
        gross_profit_ttm: grossProfit,
        fcf_ttm: fcf,
        shares_outstanding: shares,
      };
    } catch {
      // Market cap and multiples are best-effort; price data alone is still useful.
    }

    return {
      ticker: ticker.toUpperCase(),
      company_name: meta["longName"] ?? meta["shortName"] ?? ticker,
      current_price: price,
      previous_close: prevClose,
      price_change_pct: priceChangePct,
      market_cap: marketCap,
      ...multiples,
      fifty_two_week_high: num(meta["fiftyTwoWeekHigh"]),
      fifty_two_week_low: num(meta["fiftyTwoWeekLow"]),
      day_high: num(meta["regularMarketDayHigh"]),
      day_low: num(meta["regularMarketDayLow"]),
      volume: num(meta["regularMarketVolume"]),
      currency: meta["currency"] ?? "USD",
      exchange: meta["fullExchangeName"] ?? meta["exchangeName"],
      source: "Yahoo Finance v8 chart (price) + SEC EDGAR XBRL (market cap, multiples)",
    };
  } catch (e: unknown) {
    return { error: `Failed to fetch price data for ${ticker}: ${(e as Error).message}` };
  }
}

export async function getAnalystSentiment(_ticker: string): Promise<object> {
  return {
    note: "Analyst consensus data (target prices, ratings) is not available without a paid API key. Use get_price_history for 1-year performance, moving averages, and performance vs the S&P 500 as a proxy for market sentiment. Use get_recent_filings and get_filing_section to review management commentary.",
  };
}

export async function getCompetitors(ticker: string): Promise<object> {
  try {
    const meta = await yfMeta(ticker);
    return {
      ticker: ticker.toUpperCase(),
      company_name: meta["longName"] ?? ticker,
      note: "Peer discovery requires a market data subscription. Use get_business_description to find named competitors from the 10-K filing (companies typically name their key competitors in Item 1).",
    };
  } catch (e: unknown) {
    return { error: `Failed to fetch competitor context for ${ticker}: ${(e as Error).message}` };
  }
}

// ── Business phase classification ───────────────────────────────────────────────

/**
 * The five business-lifecycle phases. Self-Funding and Operating Leverage are a
 * single merged phase (3): both describe a growing company that funds itself and
 * is not yet returning capital, spanning near-breakeven through fat operating margins.
 */
const PHASES = {
  1: { emoji: "🌱", name: "Startup" },
  2: { emoji: "🚀", name: "Hypergrowth" },
  3: { emoji: "⚖️", name: "Self-Funding / Operating Leverage" },
  4: { emoji: "🎁", name: "Capital Return" },
  5: { emoji: "📉", name: "Decline" },
} as const;

/**
 * Phase-appropriate valuation methods. Phase 3 is conditional on profitability:
 * thin/emerging margins are valued on revenue, durable margins on earnings.
 */
/**
 * The `get_price_data` field holding the trailing stand-in for a recommended metric.
 *
 * Several phases recommend a *forward* multiple, but there is no estimates source
 * here — SEC XBRL is filed historicals and the Yahoo chart endpoint carries no
 * analyst modules. Naming the trailing field explicitly keeps the model from
 * quietly printing a trailing number under a "Forward" label.
 */
function trailingFieldFor(metric: string): string | null {
  const m = metric.toLowerCase();
  if (m.includes("gross-profit") || m.includes("p/gp")) return "p_gross_profit_ratio";
  if (m.includes("free-cash-flow") || m.includes("p/fcf")) return "p_fcf_ratio";
  if (m.includes("earnings") || m.includes("p/e")) return "pe_ratio";
  if (m.includes("sales") || m.includes("p/s")) return "ps_ratio";
  if (m.includes("book")) return "p_book_ratio";
  return null; // "None reliable", "N/A", TAM, DCF — nothing trailing to stand in
}

function valuationFor(
  phase: number,
  opMargin: number | null
): {
  primary: string;
  secondary: string;
  ignore: string[];
  note?: string;
  estimates_available: boolean;
  estimates_note: string;
  trailing_equivalent: { primary: string | null; secondary: string | null };
} {
  const base = valuationMethodsFor(phase, opMargin);
  return {
    ...base,
    // Forward-looking recommendations cannot be filled with a real number here.
    estimates_available: false,
    estimates_note:
      "Analyst estimates are not available from these tools (SEC EDGAR XBRL = filed " +
      "historicals; Yahoo = price only). Where a recommended method is forward-looking, " +
      "report the trailing equivalent from get_price_data, label it explicitly as trailing, " +
      "and say the forward figure is unavailable. Never present a trailing number as forward.",
    trailing_equivalent: {
      primary: trailingFieldFor(base.primary),
      secondary: trailingFieldFor(base.secondary),
    },
  };
}

function valuationMethodsFor(
  phase: number,
  opMargin: number | null
): { primary: string; secondary: string; ignore: string[]; note?: string } {
  switch (phase) {
    case 1:
    case 2:
      return {
        primary: "Forward Price-to-Sales (P/S)",
        secondary: "Price-to-Gross-Profit (P/GP)",
        ignore: ["P/E", "P/FCF", "DCF"],
      };
    case 3:
      return opMargin != null && opMargin >= 0.1
        ? {
            primary: "Forward Price-to-Earnings (P/E)",
            secondary: "Forward Price-to-Free-Cash-Flow (P/FCF)",
            ignore: ["P/S", "P/GP"],
            note: "Durably profitable end of the phase — value on earnings and cash flow.",
          }
        : {
            primary: "Price-to-Sales (P/S)",
            secondary: "Price-to-Gross-Profit (P/GP)",
            ignore: ["Trailing P/E", "DCF"],
            note: "Thin/emerging margins — value on revenue until profitability is durable.",
          };
    case 4:
      return {
        primary: "Trailing Price-to-Earnings (P/E)",
        secondary: "Price-to-Free-Cash-Flow (P/FCF)",
        ignore: ["P/S", "P/GP"],
      };
    case 5:
      return {
        primary: "Price-to-Book / liquidation value",
        secondary: "None reliable",
        ignore: ["Growth multiples", "Forward earnings", "DCF"],
      };
    default:
      return { primary: "N/A", secondary: "N/A", ignore: [] };
  }
}

// Session-scoped: classify each ticker once per process, reuse everywhere.
const phaseCache = new Map<string, object>();

/**
 * Deterministic business-lifecycle phase — the single source of truth shared by
 * the /phase, /valuation, and /metrics reports. A fixed decision tree over SEC
 * XBRL fundamentals; capital returns are the last tiebreak (never an override),
 * so a still-growing dividend-payer stays in its growth phase rather than being
 * classed as mature. Memoized per ticker for the life of the process.
 */
export async function getBusinessPhase(ticker: string): Promise<object> {
  const key = ticker.toUpperCase();
  const cached = phaseCache.get(key);
  if (cached) return cached;

  try {
    const cik = await getCik(ticker);
    const { gaap } = await fetchXbrlFacts(cik);

    // Work from the merged annual rows (revenue and operating income aligned by
    // period end), newest first. This sidesteps the TTM-summation bug that inflates
    // margins for non-calendar fiscal years, and guarantees a matched-period margin.
    const annualDesc = incomeRows(gaap, "annual", 5).reverse() as Row[];
    const num = (r: Row | undefined, f: string): number | null =>
      r && typeof r[f] === "number" ? (r[f] as number) : null;

    const marginRow = annualDesc.find(
      (r) => num(r, "revenue") != null && num(r, "revenue")! > 0 && num(r, "operating_income") != null
    );
    const opMargin = marginRow ? num(marginRow, "operating_income")! / num(marginRow, "revenue")! : null;
    const asOf = marginRow ? String(marginRow.period_end) : (annualDesc[0] ? String(annualDesc[0].period_end) : null);

    const revRows = annualDesc.filter((r) => num(r, "revenue") != null);
    const revGrowthPct =
      revRows.length >= 2 && num(revRows[1], "revenue")! > 0
        ? ((num(revRows[0], "revenue")! - num(revRows[1], "revenue")!) / num(revRows[1], "revenue")!) * 100
        : null;

    const oiRows = annualDesc.filter((r) => num(r, "operating_income") != null);
    const oiLatest = oiRows[0] ? num(oiRows[0], "operating_income") : null;
    const oiPrior = oiRows[1] ? num(oiRows[1], "operating_income") : null;

    const divEntries = getConcept(gaap, "PaymentsOfDividendsCommonStock", "PaymentsOfDividends");
    const buybackEntries = getConcept(gaap, "PaymentsForRepurchaseOfCommonStock", "PaymentsForRepurchaseOfEquity");
    const dividends = latestAnnual(divEntries) ?? ttmFromQuarterly(divEntries);
    const buybacks = latestAnnual(buybackEntries) ?? ttmFromQuarterly(buybackEntries);
    const returningCapital = (dividends != null && dividends > 0) || (buybacks != null && buybacks > 0);

    if (opMargin == null) {
      // Don't cache: a later call may succeed if XBRL coverage improves.
      return {
        ticker: key,
        phase: null,
        error: "Could not compute operating margin from XBRL — unable to classify phase.",
        source: "SEC EDGAR XBRL",
      };
    }

    // ── Unified decision tree (capital returns checked last, as a tiebreak) ──
    let phase: number;
    let reasoning: string;
    if (opMargin < -0.05) {
      if (oiPrior != null && oiLatest != null && oiLatest < oiPrior) {
        phase = 1;
        reasoning = "Operating loss (margin < -5%) widening year-over-year → Startup.";
      } else {
        phase = 2;
        reasoning = "Operating loss (margin < -5%) stable or narrowing → Hypergrowth.";
      }
    } else if (revGrowthPct != null && revGrowthPct < 0) {
      phase = 5;
      reasoning = "Breakeven-or-profitable with declining revenue → Decline.";
    } else if (returningCapital) {
      phase = 4;
      reasoning = "Profitable, growing, and returning capital (dividends/buybacks) → Capital Return.";
    } else {
      phase = 3;
      reasoning = "Breakeven-to-profitable, growing, reinvesting (no capital returns) → Self-Funding / Operating Leverage.";
    }

    const nearMargin = Math.abs(opMargin + 0.05) < 0.02;
    const nearGrowth = revGrowthPct != null && Math.abs(revGrowthPct) < 2;
    let confidence: "High" | "Medium" | "Low" = "High";
    if (revGrowthPct == null || (phase <= 2 && oiPrior == null)) confidence = "Low";
    else if (nearMargin || nearGrowth) confidence = "Medium";

    const meta = PHASES[phase as 1 | 2 | 3 | 4 | 5];
    const result = {
      ticker: key,
      phase,
      phase_name: meta.name,
      phase_emoji: meta.emoji,
      confidence,
      reasoning,
      inputs: {
        operating_margin: r4(opMargin),
        revenue_growth_yoy_pct: revGrowthPct == null ? null : r2(revGrowthPct),
        operating_income_latest: oiLatest,
        operating_income_prior_fy: oiPrior,
        dividends_paid: dividends,
        share_repurchases: buybacks,
        returning_capital: returningCapital,
      },
      valuation: valuationFor(phase, opMargin),
      as_of: asOf,
      source: "SEC EDGAR XBRL companyfacts (deterministic classification)",
      phase_scale:
        "1 Startup · 2 Hypergrowth · 3 Self-Funding/Operating Leverage · 4 Capital Return · 5 Decline",
    };
    phaseCache.set(key, result);
    return result;
  } catch (e: unknown) {
    return { error: `Failed to classify phase for ${ticker}: ${(e as Error).message}` };
  }
}
