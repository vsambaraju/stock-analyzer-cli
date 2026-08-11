/**
 * Forward-looking estimates from Yahoo's quoteSummary endpoint.
 *
 * Everything else in this CLI rests on SEC-filed fact. This module does not: it
 * returns analyst *consensus*, which is opinion, and every value it produces is
 * labelled as such so a report can never present it as filed data.
 *
 * The endpoint is undocumented and defended. A browser User-Agent alone returns
 * `401 Invalid Crumb`; access needs a three-step handshake — fetch a session
 * cookie, exchange it for a crumb, then send both with the request. That has
 * changed before and will change again, so nothing here is allowed to throw into
 * a report: every failure resolves to `{ available: false, reason }` and callers
 * fall back to trailing figures.
 *
 * Degrading on HTTP status alone is not enough. A symbol with no analyst coverage
 * (an ETF, say) returns 200 with `forwardPE: {}` — a successful response carrying
 * no estimate. Extraction therefore keys on field shape, and `{}` reads as absent.
 */

import { createCache } from "./cache.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const MODULES = "defaultKeyStatistics,financialData,earningsTrend,earningsHistory";

/** Cap on how long the whole handshake-plus-fetch may take before we give up and degrade. */
const TIMEOUT_MS = 8000;

/** Yahoo wraps numbers as {raw, fmt}; missing values arrive as {} or are absent entirely. */
type YfNum = { raw?: number } | Record<string, never> | undefined;

function raw(v: YfNum): number | null {
  if (v == null || typeof v !== "object") return null;
  const n = (v as { raw?: unknown }).raw;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

const r2 = (n: number | null): number | null => (n == null ? null : Math.round(n * 100) / 100);

export type Unavailable = { available: false; reason: string };

/** A session cookie plus the crumb minted against it. Only valid as a pair. */
type Session = { cookie: string; crumb: string };

let session: Session | null = null;
let sessionPromise: Promise<Session> | null = null;

async function openSession(): Promise<Session> {
  // fetch() does not manage cookies, so the Set-Cookie header is read off the
  // first hop by hand — redirect:"manual" keeps a 301 from discarding it.
  const cookieRes = await fetch("https://fc.yahoo.com/", {
    headers: { "User-Agent": UA },
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const cookie = (cookieRes.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .join("; ");
  if (!cookie) throw new Error("Yahoo returned no session cookie");

  const crumbRes = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA, Cookie: cookie },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const crumb = (await crumbRes.text()).trim();
  // A rejected handshake yields an HTML error page rather than a short token.
  if (!crumbRes.ok || !crumb || crumb.length > 32 || crumb.includes("<")) {
    throw new Error(`Yahoo crumb handshake failed (HTTP ${crumbRes.status})`);
  }
  return { cookie, crumb };
}

/** Get the live session, opening one if needed. Concurrent callers share one handshake. */
async function getSession(): Promise<Session> {
  if (session) return session;
  if (!sessionPromise) {
    sessionPromise = openSession()
      .then((s) => {
        session = s;
        return s;
      })
      .finally(() => {
        sessionPromise = null;
      });
  }
  return sessionPromise;
}

/** Estimates move slowly; a short TTL is plenty and keeps a report to one fetch. */
const summaryCache = createCache<Record<string, unknown> | Unavailable>({
  ttlMs: 15 * 60 * 1000,
  maxEntries: 24,
});

async function fetchQuoteSummary(ticker: string): Promise<Record<string, unknown> | Unavailable> {
  return summaryCache.get(ticker.toUpperCase(), async () => {
    const attempt = async (): Promise<Response> => {
      const { cookie, crumb } = await getSession();
      const url =
        `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}` +
        `?modules=${MODULES}&crumb=${encodeURIComponent(crumb)}`;
      return fetch(url, {
        headers: { "User-Agent": UA, Cookie: cookie },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    };

    try {
      let res = await attempt();
      if (res.status === 401) {
        // Crumbs expire. Drop the stale session and try once more before degrading.
        session = null;
        res = await attempt();
      }
      if (res.status === 404) {
        return { available: false, reason: `Yahoo has no estimate data for ${ticker.toUpperCase()}` };
      }
      if (!res.ok) {
        return { available: false, reason: `Yahoo estimates endpoint returned HTTP ${res.status}` };
      }
      const json = (await res.json()) as {
        quoteSummary?: { result?: Array<Record<string, unknown>> };
      };
      const result = json.quoteSummary?.result?.[0];
      if (!result) {
        return { available: false, reason: `Yahoo returned no estimate data for ${ticker.toUpperCase()}` };
      }
      return result;
    } catch (e: unknown) {
      const msg = (e as Error).name === "TimeoutError" ? "timed out" : (e as Error).message;
      return { available: false, reason: `Could not reach Yahoo estimates (${msg})` };
    }
  });
}

function isUnavailable(v: unknown): v is Unavailable {
  return typeof v === "object" && v !== null && (v as Unavailable).available === false;
}

/** One forecast period from the earningsTrend module. */
function trendPeriod(
  result: Record<string, unknown>,
  period: string
): Record<string, unknown> | null {
  const trend = (result.earningsTrend as { trend?: Array<Record<string, unknown>> })?.trend ?? [];
  return trend.find((t) => t.period === period) ?? null;
}

function estimateBlock(p: Record<string, unknown> | null) {
  if (!p) return null;
  const eps = p.earningsEstimate as Record<string, YfNum> | undefined;
  const rev = p.revenueEstimate as Record<string, YfNum> | undefined;
  const analysts = raw(eps?.numberOfAnalysts);
  const epsAvg = raw(eps?.avg);
  const revAvg = raw(rev?.avg);
  if (epsAvg == null && revAvg == null) return null;
  return {
    eps_estimate: epsAvg,
    revenue_estimate: revAvg,
    growth_pct: r2(raw(p.growth as YfNum) == null ? null : (raw(p.growth as YfNum) as number) * 100),
    analyst_count: analysts,
    end_date: (p.endDate as { fmt?: string } | undefined)?.fmt ?? null,
  };
}

/**
 * Forward estimates for a ticker: forward EPS and multiples, current- and
 * next-fiscal-year consensus, the analyst target and rating, and the last four
 * quarters of actual-vs-estimate.
 *
 * Returns `{ available: false, reason }` whenever the data cannot be had — a
 * failed handshake, an unknown symbol, or a covered-looking response that in fact
 * carries no estimates. Callers render the reason and fall back to trailing.
 */
export async function getForwardEstimates(ticker: string): Promise<Record<string, unknown>> {
  const result = await fetchQuoteSummary(ticker);
  if (isUnavailable(result)) {
    return { ticker: ticker.toUpperCase(), available: false, reason: result.reason };
  }

  const ks = (result.defaultKeyStatistics ?? {}) as Record<string, YfNum>;
  const fd = (result.financialData ?? {}) as Record<string, YfNum & { recommendationKey?: string }>;

  const forwardEps = raw(ks.forwardEps);
  const forwardPeRaw = raw(ks.forwardPE);
  // Yahoo publishes a negative forward P/E when forward EPS is negative. That is
  // not a multiple — same treatment as a trailing P/E on negative earnings.
  const forwardPe =
    forwardEps != null && forwardEps <= 0
      ? "n/m (forward EPS is negative — a P/E on expected losses is not meaningful)"
      : r2(forwardPeRaw);

  const fyCurrent = estimateBlock(trendPeriod(result, "0y"));
  const fyNext = estimateBlock(trendPeriod(result, "+1y"));

  const history =
    ((result.earningsHistory as { history?: Array<Record<string, YfNum & { quarter?: { fmt?: string } }>> })
      ?.history ?? [])
      .map((q) => ({
        quarter: (q.quarter as { fmt?: string } | undefined)?.fmt ?? null,
        eps_actual: raw(q.epsActual),
        eps_estimate: raw(q.epsEstimate),
        surprise_pct: r2(raw(q.surprisePercent) == null ? null : (raw(q.surprisePercent) as number) * 100),
      }))
      .filter((q) => q.eps_actual != null && q.eps_estimate != null);

  const beats = history.filter((q) => (q.eps_actual as number) > (q.eps_estimate as number)).length;

  const anythingUseful =
    forwardEps != null || fyCurrent != null || fyNext != null || history.length > 0;
  if (!anythingUseful) {
    return {
      ticker: ticker.toUpperCase(),
      available: false,
      reason: `No analyst coverage for ${ticker.toUpperCase()} (Yahoo returned a response with no estimates — typical for ETFs and thinly covered names)`,
    };
  }

  return {
    ticker: ticker.toUpperCase(),
    available: true,
    forward_eps: forwardEps,
    forward_pe: forwardPe,
    peg_ratio: r2(raw(ks.pegRatio)),
    trailing_eps: raw(ks.trailingEps),
    fiscal_year_current: fyCurrent,
    fiscal_year_next: fyNext,
    analyst_target: {
      mean_price: r2(raw(fd.targetMeanPrice)),
      high_price: r2(raw(fd.targetHighPrice)),
      low_price: r2(raw(fd.targetLowPrice)),
      analyst_count: raw(fd.numberOfAnalystOpinions),
      recommendation: typeof fd.recommendationKey === "string" ? fd.recommendationKey : null,
    },
    eps_surprise_history: {
      quarters_available: history.length,
      beats,
      quarters: history,
      note:
        "Yahoo returns at most 4 quarters of actual-vs-estimate, so a beat count " +
        "is out of 4 — an 8-quarter record cannot be sourced here.",
    },
    basis:
      "Analyst consensus from Yahoo Finance — opinion and subject to revision, " +
      "NOT SEC-filed fact like the rest of this tool's data.",
    source: "Yahoo Finance quoteSummary (defaultKeyStatistics, financialData, earningsTrend, earningsHistory)",
  };
}
