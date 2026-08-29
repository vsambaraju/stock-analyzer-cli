/**
 * Earnings-call transcripts from Alpha Vantage.
 *
 * This is the first non-SEC, non-Yahoo source in the CLI, and the only one that
 * carries management speaking about the *future*. A 10-K describes what happened;
 * a transcript carries next-quarter guidance, the market claims management makes
 * unprompted, and — most usefully — what a dozen sell-side analysts chose to press
 * on, which is the closest thing to free competitive intelligence available here.
 *
 * Three constraints shape everything below.
 *
 * 1. A full transcript is ~11k tokens. Handing that to the model would roughly
 *    double the cost of any report that used it, so nothing here returns the raw
 *    text: turns are separated by speaker role and each section is capped, the
 *    same bargain `get_filing_section` makes with filing text.
 *
 * 2. The free tier allows 25 requests per day and 5 per minute. One call covers
 *    one quarter of one company, so a request is genuinely scarce — the quarter is
 *    therefore derived from EDGAR data the CLI already has (free, cached) rather
 *    than discovered by probing Alpha Vantage until something answers.
 *
 * 3. Failure arrives as HTTP 200. An over-quota call returns `{"Information": ...}`
 *    with a success status, and — verified against the live endpoint — an invalid
 *    key can return a complete, real-looking transcript. A successful response
 *    therefore proves nothing about the key, and every response is validated on
 *    shape before any of it is trusted.
 */

import { createCache } from "./cache.js";
import { getCik } from "./edgar.js";
import { getSubmissions } from "./filings.js";

const BASE = "https://www.alphavantage.co/query";

/** Alpha Vantage is slow on transcripts; they are large documents. */
const TIMEOUT_MS = 15000;

/**
 * Default cap per section. Management remarks and analyst questions are capped
 * separately so a long CEO monologue cannot crowd out the Q&A, which is usually
 * the higher-signal half of the call.
 */
const DEFAULT_REMARK_CHARS = 6000;
const DEFAULT_QA_CHARS = 4000;

export type Unavailable = { available: false; reason: string };

type Turn = { speaker?: string; title?: string; content?: string; sentiment?: string };

/** One transcript is immutable once published, so this can be cached hard. */
const transcriptCache = createCache<Record<string, unknown>>({
  ttlMs: 24 * 60 * 60 * 1000,
  maxEntries: 12,
});

function apiKey(): string | null {
  const k = process.env.ALPHAVANTAGE_API_KEY?.trim();
  return k && k.length > 0 ? k : null;
}

/**
 * Alpha Vantage signals every failure — bad key, over quota, unknown symbol,
 * premium-only endpoint — as a 200 carrying one of these fields instead of data.
 */
function refusal(json: Record<string, unknown>): string | null {
  for (const field of ["Information", "Note", "Error Message"]) {
    const v = json[field];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/**
 * The calendar quarter of the company's most recent periodic filing.
 *
 * Alpha Vantage keys transcripts by calendar quarter ("2025Q1") and offers no
 * "latest". Guessing would mean spending scarce requests to find out, so the
 * quarter comes from EDGAR's `reportDate` on the newest 10-Q or 10-K — the period
 * the filing covers, not the day it was filed. Fiscal-year labels are deliberately
 * ignored: NVIDIA's fiscal Q1 ends in April, and Alpha Vantage would call that
 * 2025Q2 regardless of what the cover page says.
 */
async function latestReportedQuarter(ticker: string): Promise<string | null> {
  try {
    const cik = await getCik(ticker);
    const { form, reportDate, filingDate } = (await getSubmissions(cik)).filings.recent;
    const idx = form.findIndex((f) => f === "10-Q" || f === "10-K");
    if (idx === -1) return null;
    const period = reportDate?.[idx] || filingDate[idx];
    if (!period) return null;
    const [y, m] = period.split("-").map(Number);
    if (!y || !m) return null;
    return `${y}Q${Math.floor((m - 1) / 3) + 1}`;
  } catch {
    return null;
  }
}

/** Sentences that carry a forward-looking commitment rather than a recap. */
const GUIDANCE = /\b(we expect|we anticipate|we are guiding|our outlook|guidance for|looking (ahead|forward)|next quarter|full[- ]year|going forward|we believe .{0,40}will)\b/i;

/** Split into sentences well enough for extraction; transcripts are clean prose. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Concatenate turns up to a character budget, flagging when the cap bit.
 *
 * A turn that overruns the remaining budget is cut mid-way rather than dropped.
 * Dropping whole turns loses everything when the first one is already oversized —
 * a CEO's opening remarks routinely run past any sensible cap on their own, which
 * would otherwise return an empty section while reporting success.
 */
function capped(parts: string[], limit: number): { text: string; truncated: boolean } {
  const out: string[] = [];
  let used = 0;
  for (const p of parts) {
    const room = limit - used;
    if (room <= 0) return { text: out.join("\n\n"), truncated: true };
    if (p.length > room) {
      // Only worth a partial turn if enough survives to carry meaning.
      if (room > 200) out.push(p.slice(0, room) + " […truncated]");
      return { text: out.join("\n\n"), truncated: true };
    }
    out.push(p);
    used += p.length;
  }
  return { text: out.join("\n\n"), truncated: false };
}

function averageSentiment(turns: Turn[]): number | null {
  const vals = turns
    .map((t) => Number(t.sentiment))
    .filter((n) => Number.isFinite(n));
  if (vals.length === 0) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
}

/**
 * Extract the useful structure out of a transcript: management's forward-looking
 * statements, their prepared remarks, and the analysts' questions.
 *
 * Answers are deliberately not returned alongside questions. The questions are
 * what carry the signal — they reveal what informed sceptics think the risks are —
 * and pairing each with a full management answer would blow the character budget
 * on exactly the promotional content the rest of this CLI is careful about.
 */
export function extractTranscript(
  turns: Turn[],
  remarkChars: number,
  qaChars: number
): Record<string, unknown> {
  const isMgmt = (t: Turn) => /chief|ceo|cfo|president|officer/i.test(t.title ?? "");
  const isAnalyst = (t: Turn) => /analyst/i.test(t.title ?? "");

  const mgmt = turns.filter(isMgmt);
  const analysts = turns.filter(isAnalyst);

  const guidance = mgmt.flatMap((t) =>
    sentences(t.content ?? "")
      .filter((s) => GUIDANCE.test(s) && s.length < 400)
      .map((s) => ({ speaker: t.speaker ?? null, role: t.title ?? null, statement: s }))
  );

  const remarks = capped(
    mgmt.map((t) => `${t.speaker ?? "?"} (${t.title ?? "?"}): ${t.content ?? ""}`),
    remarkChars
  );
  const qa = capped(
    analysts.map((t) => `${t.speaker ?? "?"}: ${(t.content ?? "").trim()}`),
    qaChars
  );

  return {
    speakers: [...new Set(turns.map((t) => `${t.speaker ?? "?"} (${t.title ?? "?"})`))],
    analyst_count: new Set(analysts.map((t) => t.speaker)).size,
    guidance_statements: guidance,
    management_remarks: remarks.text,
    management_remarks_truncated: remarks.truncated,
    analyst_questions: qa.text,
    analyst_questions_truncated: qa.truncated,
    sentiment: {
      management_avg: averageSentiment(mgmt),
      analyst_avg: averageSentiment(analysts),
      scale: "0.0–1.0, higher is more positive",
      caveat:
        "Alpha Vantage's own score with no published methodology — treat as a weak " +
        "hint, never as evidence, and do not report it as a measurement.",
    },
  };
}

/**
 * The most recent earnings call for a ticker, reduced to guidance, prepared
 * remarks and analyst questions.
 *
 * Returns `{ available: false, reason }` when no API key is configured, when the
 * quota is spent, or when Alpha Vantage has no transcript for the period — callers
 * render the reason and fall back to filing text.
 */
export async function getEarningsTranscript(
  ticker: string,
  quarter?: string,
  maxChars?: number
): Promise<Record<string, unknown>> {
  const key = ticker.toUpperCase();

  const apikey = apiKey();
  if (!apikey) {
    return {
      ticker: key,
      available: false,
      reason:
        "No ALPHAVANTAGE_API_KEY is set, so earnings-call transcripts are unavailable. " +
        "Every other tool in this CLI works without it — use get_filing_section(\"7\") " +
        "for management's written commentary instead.",
    };
  }

  const period = quarter?.trim().toUpperCase() || (await latestReportedQuarter(key));
  if (!period || !/^\d{4}Q[1-4]$/.test(period)) {
    return {
      ticker: key,
      available: false,
      reason: `Could not determine which quarter to request for ${key}. Pass one explicitly, e.g. "2025Q3".`,
    };
  }

  const remarkChars = Math.max(1000, Math.min(maxChars ?? DEFAULT_REMARK_CHARS, 20000));
  const qaChars = Math.max(1000, Math.min(Math.round(remarkChars * 0.7), 20000));

  return transcriptCache.get(`${key}|${period}|${remarkChars}`, async () => {
    const url =
      `${BASE}?function=EARNINGS_CALL_TRANSCRIPT&symbol=${encodeURIComponent(key)}` +
      `&quarter=${encodeURIComponent(period)}&apikey=${encodeURIComponent(apikey)}`;

    let json: Record<string, unknown>;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) {
        return { ticker: key, available: false, reason: `Alpha Vantage returned HTTP ${res.status}` };
      }
      json = (await res.json()) as Record<string, unknown>;
    } catch (e: unknown) {
      const msg = (e as Error).name === "TimeoutError" ? "timed out" : (e as Error).message;
      return { ticker: key, available: false, reason: `Could not reach Alpha Vantage (${msg})` };
    }

    // Checked before the data, because the failure arrives with a 200 status.
    const refused = refusal(json);
    if (refused) {
      const quota = /rate limit|25 requests|premium|higher API call/i.test(refused);
      return {
        ticker: key,
        available: false,
        reason: quota
          ? `Alpha Vantage quota reached (free tier is 25 requests/day, 5/minute). Original message: ${refused}`
          : `Alpha Vantage declined the request: ${refused}`,
      };
    }

    const turns = json.transcript;
    if (!Array.isArray(turns) || turns.length === 0) {
      return {
        ticker: key,
        available: false,
        reason: `Alpha Vantage has no earnings-call transcript for ${key} ${period}.`,
      };
    }

    const rawChars = (turns as Turn[]).reduce((n, t) => n + (t.content?.length ?? 0), 0);

    return {
      ticker: key,
      available: true,
      quarter: (json.quarter as string) ?? period,
      quarter_source: quarter ? "caller-specified" : "derived from the latest 10-Q/10-K period on EDGAR",
      transcript_chars_available: rawChars,
      ...extractTranscript(turns as Turn[], remarkChars, qaChars),
      basis:
        "Earnings-call transcript via Alpha Vantage — management's spoken statements " +
        "and analyst questions. This is NOT SEC-filed fact: prepared remarks are " +
        "promotional by nature and forward-looking statements are not commitments. " +
        "Attribute every quote to its speaker.",
      source: `Alpha Vantage EARNINGS_CALL_TRANSCRIPT (${key} ${period})`,
    };
  });
}
