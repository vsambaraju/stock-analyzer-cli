/**
 * Per-segment revenue and operating income, read out of a 10-K's rendered exhibits.
 *
 * This is the one dataset in the CLI that the XBRL companyfacts API cannot supply.
 * Segment figures are *dimensional* facts — revenue tagged along a "Data Center"
 * or "Intelligent Cloud" member axis — and companyfacts publishes only the
 * undimensioned totals. Asking it for segment revenue returns the consolidated
 * number, silently, which is worse than returning nothing.
 *
 * What does carry the breakdown is the financial-report renderer SEC runs over
 * every filing: `FilingSummary.xml` indexes a set of `R*.htm` tables, one of which
 * is the segment note. Those tables are generated from the same XBRL, so the
 * numbers are the filed ones — this is a different door into filed fact, not a
 * scrape of prose.
 *
 * Two things make it awkward, and both are handled by shape rather than by name:
 *
 *   1. Report titles are filer-chosen. The segment table is "Reportable Segments
 *      (Details)" at NVIDIA, "Segment Revenue, Cost of Revenue, Operating Expenses
 *      and Operating Income (Detail)" at Microsoft, and "Information by Reportable
 *      Segment (Details)" at Apple. Titles are therefore *scored*, not matched.
 *   2. Row structure is positional. A row with no numeric cells opens a group (the
 *      segment); rows beneath it carry that segment's metrics until the next such
 *      row. Nothing in the markup labels which is which.
 */

import { EDGAR_HEADERS, getCik } from "./edgar.js";
import { createCache } from "./cache.js";
import { getSubmissions } from "./filings.js";
import { getFinancials } from "./market.js";

const EDGAR_ARCHIVES = "https://www.sec.gov";

const r2 = (n: number | null): number | null => (n == null ? null : Math.round(n * 100) / 100);

export type Unavailable = { available: false; reason: string };

// ── FilingSummary report selection ────────────────────────────────────────────

type ReportRef = { file: string; shortName: string; score: number };

/**
 * Titles that look like a segment table but hold something else. Excluding these
 * matters more than matching well: "Segment Information (Tables)" is the empty
 * template, "(Parenthetical)" is a footnote, and the long-lived-asset and
 * unearned-revenue tables are keyed by segment without being revenue splits.
 */
const TITLE_EXCLUDE =
  /\(tables?\)|parenthetical|policies|narrative|additional information|long-?lived|unearned|deferred|goodwill|impairment|assets? by|reconcil/i;

/** Titles worth fetching, most decisive first. */
const TITLE_SCORES: Array<{ re: RegExp; score: number }> = [
  { re: /reportable segment/i, score: 100 },
  { re: /segment (revenue|information|reporting|results)/i, score: 90 },
  { re: /revenue.*by (market|segment|product|service)/i, score: 80 },
  { re: /disaggregat/i, score: 70 },
  { re: /(significant )?product and service/i, score: 60 },
  { re: /(major )?geographic/i, score: 40 },
  { re: /segment/i, score: 30 },
];

function scoreTitle(shortName: string): number {
  if (TITLE_EXCLUDE.test(shortName)) return 0;
  const base = TITLE_SCORES.find((s) => s.re.test(shortName))?.score ?? 0;
  if (!base) return 0;
  // A "(Details)" report holds the numbers; the bare note is narrative prose.
  return base + (/\(detail/i.test(shortName) ? 10 : 0);
}

function parseFilingSummary(xml: string): ReportRef[] {
  const refs: ReportRef[] = [];
  for (const m of xml.matchAll(/<Report\b[^>]*>([\s\S]*?)<\/Report>/g)) {
    const block = m[1];
    const shortName = block.match(/<ShortName>([\s\S]*?)<\/ShortName>/)?.[1]?.trim();
    const file = block.match(/<HtmlFileName>([\s\S]*?)<\/HtmlFileName>/)?.[1]?.trim();
    if (!shortName || !file) continue;
    const score = scoreTitle(decodeEntities(shortName));
    if (score > 0) refs.push({ file, shortName: decodeEntities(shortName), score });
  }
  return refs.sort((a, b) => b.score - a.score);
}

// ── R-file table parsing ──────────────────────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"');
}

function cellText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Rows of non-empty cell strings. */
function tableRows(html: string): string[][] {
  const rows: string[][] = [];
  for (const m of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)]
      .map((c) => cellText(c[1]))
      .filter((c) => c.length > 0);
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/**
 * A numeric cell, or null. Rendered tables write negatives in parentheses and
 * carry the currency symbol in the same cell as the figure.
 */
function numericCell(s: string): number | null {
  const t = s.replace(/[$,\s]/g, "");
  const negative = /^\(.*\)$/.test(t);
  const body = negative ? t.slice(1, -1) : t;
  if (!/^-?\d+(\.\d+)?$/.test(body)) return null;
  const n = parseFloat(body);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** Scale stated in the table title, e.g. "$ in Millions". */
function unitMultiplier(title: string): { multiplier: number; label: string } {
  if (/in\s+billions/i.test(title)) return { multiplier: 1e9, label: "billions" };
  if (/in\s+millions/i.test(title)) return { multiplier: 1e6, label: "millions" };
  if (/in\s+thousands/i.test(title)) return { multiplier: 1e3, label: "thousands" };
  return { multiplier: 1, label: "units" };
}

/**
 * A period column header. Matched as a substring, not a whole cell: filers append
 * units and stray text to the date — Coca-Cola's columns read "Dec. 31, 2025 USD
 * ($) segement", SEC's own typo included — and an anchored pattern misses them,
 * which leaves the table with no periods and the header row misread as a segment.
 */
const DATE_CELL = /\b[A-Z][a-z]{2}\.?\s+\d{1,2},\s+\d{4}\b/;

/** Column period labels, taken from the header rows above the first data row. */
function periodHeaders(rows: string[][]): string[] {
  for (const row of rows.slice(0, 4)) {
    const dates = row.map((c) => c.match(DATE_CELL)?.[0]).filter((d): d is string => !!d);
    if (dates.length) return dates;
  }
  return [];
}

/**
 * Structural noise: XBRL scaffolding that renders as its own row.
 *
 * These rows are skipped outright and must not disturb the open segment group.
 * The unbracketed spellings matter: AMD and Micron emit a bare "Segment Reporting
 * Information" line beneath each segment header where NVIDIA emits "Segment
 * Reporting Information [Line Items]". Treating the bare form as a group boundary
 * reassigns every segment's revenue to the consolidated total, and the filing then
 * parses as though it had a single segment.
 */
const STRUCTURAL_ROW =
  /\[(line items|abstract|member|domain|axis|table)\]|^segments?\s+reporting\s+information$/i;

/**
 * Axis names that qualify a segment rather than being one.
 *
 * A group header carries every member of every axis the row sits on, so NVIDIA's
 * Compute & Networking arrives as "Compute & Networking | Operating Segments" and
 * Apple's Americas as "Americas | Operating segments". Dropping these leaves the
 * segment's real name; a header made of nothing else is the axis total, which is
 * the consolidated figure under another label.
 */
const GENERIC_MEMBER =
  /^(operating|reportable|business|consolidated)?\s*(segments?|entities|entity)$|^segment reporting information$|^revenue from external customers?$/i;

/**
 * Bridge rows rather than operating units. Coca-Cola's note carries four of them
 * — eliminations, corporate non-segment, and two reconciling subtotals — which
 * reconcile the segments to the consolidated line. They are kept, because the
 * bridge is real, but flagged so a report does not rank "Consolidation,
 * Eliminations" alongside North America as a business.
 */
const RECONCILIATION_MEMBER =
  /reconciling item|consolidation,\s*eliminations?|corporate\s*(non-?segment|and other)|intersegment|elimination/i;

/** Metric rows worth keeping. Everything else in a segment note is cost detail. */
const METRIC_PATTERNS: Array<{ re: RegExp; key: string }> = [
  { re: /^(total\s+)?(net\s+)?(revenue|sales|net sales|revenues)\b/i, key: "revenue" },
  { re: /^(total\s+)?operating income|^segment operating income|^operating (income|loss)/i, key: "operating_income" },
];

function metricKey(label: string): string | null {
  return METRIC_PATTERNS.find((m) => m.re.test(label))?.key ?? null;
}

type SegmentRow = { segment: string; metric: string; values: (number | null)[] };

/**
 * Walk the table positionally: a row carrying no numbers opens a segment group,
 * and the metric rows under it belong to that group. Rows appearing before any
 * group header are the consolidated totals the note reconciles to.
 */
function parseSegmentTable(rows: string[][], multiplier: number): SegmentRow[] {
  const out: SegmentRow[] = [];
  let current = "Consolidated total";

  for (const row of rows.slice(1)) {
    const label = row[0];
    if (!label || STRUCTURAL_ROW.test(label)) continue;

    const values = row.slice(1).map(numericCell);
    const numbers = values.filter((v): v is number => v != null);

    if (numbers.length === 0) {
      // Header rows are dates, not segments; anything else opens a group.
      if (row.every((c) => DATE_CELL.test(c) || /months? ended|year ended/i.test(c))) continue;
      // Multiple axis members reach the row either as separate cells (NVIDIA) or
      // pipe-joined inside one (Apple's "Americas | Operating segments").
      const parts = [
        ...new Set(
          row
            .flatMap((c) => c.split("|"))
            .map((c) => c.trim())
            .filter((c) => c && !STRUCTURAL_ROW.test(c) && !GENERIC_MEMBER.test(c))
        ),
      ];
      // A header naming only the axis ("Operating Segments") opens the axis-total
      // block, which restates the consolidated line — distinct from the scaffolding
      // rows filtered above, which open nothing at all.
      current = parts.length ? parts.join(" · ") : "Consolidated total";
      continue;
    }

    const key = metricKey(label);
    if (!key) continue;
    out.push({
      segment: current,
      metric: key,
      values: values.map((v) => (v == null ? null : v * multiplier)),
    });
  }
  return out;
}

// ── Assembly ──────────────────────────────────────────────────────────────────

/** YoY change per column, given newest-first periods. */
function yoyGrowth(values: (number | null)[]): (number | null)[] {
  return values.map((v, i) => {
    const prior = values[i + 1];
    if (v == null || prior == null || prior === 0) return null;
    return r2(((v - prior) / Math.abs(prior)) * 100);
  });
}

type ParsedTable = {
  table: string;
  source_url: string;
  units: string;
  periods: string[];
  segments: Array<{
    segment: string;
    /** "reconciliation" rows bridge the segments to the consolidated total. */
    kind: "segment" | "reconciliation";
    revenue: (number | null)[];
    revenue_yoy_growth_pct: (number | null)[];
    operating_income?: (number | null)[];
    operating_margin_pct?: (number | null)[];
  }>;
};

function assemble(
  rows: SegmentRow[],
  periods: string[],
  title: string,
  shortName: string,
  sourceUrl: string
): ParsedTable | null {
  const { multiplier, label } = unitMultiplier(title);
  void multiplier; // applied during parse; retained here only for the label

  const bySegment = new Map<string, { revenue?: (number | null)[]; oi?: (number | null)[] }>();
  for (const r of rows) {
    const entry = bySegment.get(r.segment) ?? {};
    // First occurrence wins: notes often restate a metric further down the table.
    if (r.metric === "revenue" && !entry.revenue) entry.revenue = r.values;
    if (r.metric === "operating_income" && !entry.oi) entry.oi = r.values;
    bySegment.set(r.segment, entry);
  }

  const segments = [...bySegment.entries()]
    .filter(([, v]) => v.revenue?.some((x) => x != null))
    .map(([segment, v]) => {
      const revenue = v.revenue as (number | null)[];
      const oi = v.oi;
      const out: ParsedTable["segments"][number] = {
        segment,
        kind: RECONCILIATION_MEMBER.test(segment) ? "reconciliation" : "segment",
        revenue,
        revenue_yoy_growth_pct: yoyGrowth(revenue),
      };
      if (oi?.some((x) => x != null)) {
        out.operating_income = oi;
        out.operating_margin_pct = revenue.map((rev, i) => {
          const o = oi[i];
          return rev == null || o == null || rev === 0 ? null : r2((o / rev) * 100);
        });
      }
      return out;
    });

  // A note's narrative exhibit parses into the same row shape as the data table
  // but holds counts and percentages rather than dollars — Microsoft's "SEGMENT
  // INFORMATION AND GEOGRAPHIC DATA" yields three segments whose revenue is 3.
  // Requiring a plausible dollar magnitude rejects it without hardcoding titles.
  const largest = Math.max(
    0,
    ...segments.flatMap((s) => s.revenue.map((v) => (v == null ? 0 : Math.abs(v))))
  );
  const named = segments.filter(
    (s) => s.segment !== "Consolidated total" && s.kind === "segment"
  );
  if (named.length < 2 || largest < 1e6) return null;

  return { table: shortName, source_url: sourceUrl, units: label, periods, segments };
}

const segmentCache = createCache<Record<string, unknown>>({
  ttlMs: 6 * 60 * 60 * 1000,
  maxEntries: 12,
});

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { ...EDGAR_HEADERS, Accept: "*/*" } });
  if (!res.ok) throw new Error(`EDGAR ${res.status} for ${url}`);
  return res.text();
}

/**
 * Segment revenue (and operating income where the note carries it) for the most
 * recent 10-K, with per-segment year-over-year growth computed here rather than
 * left to the model.
 *
 * Returns `{ available: false, reason }` for a single-segment filer, a filing
 * whose renderer output has no segment table, or an unreachable EDGAR — callers
 * render the reason and fall back to consolidated figures.
 */
export async function getSegmentRevenue(ticker: string): Promise<Record<string, unknown>> {
  const key = ticker.toUpperCase();
  return segmentCache.get(key, async () => {
    try {
      const cik = await getCik(key);
      const submissions = await getSubmissions(cik);
      const { form, accessionNumber, filingDate } = submissions.filings.recent;

      const idx = form.findIndex((f) => f === "10-K");
      if (idx === -1) {
        return { ticker: key, available: false, reason: `No 10-K on file for ${key}` };
      }

      const accession = accessionNumber[idx].replace(/-/g, "");
      const base = `${EDGAR_ARCHIVES}/Archives/edgar/data/${parseInt(cik)}/${accession}`;

      const refs = parseFilingSummary(await fetchText(`${base}/FilingSummary.xml`));
      if (refs.length === 0) {
        return {
          ticker: key,
          available: false,
          reason: `${key}'s 10-K (filed ${filingDate[idx]}) has no segment table in its rendered exhibits — typical of a single-segment filer`,
        };
      }

      // Two tables cover the common case: a reportable-segment split plus a
      // revenue-by-market or geographic split. Stopping there bounds the fetches.
      const tables: ParsedTable[] = [];
      for (const ref of refs.slice(0, 4)) {
        if (tables.length >= 2) break;
        let html: string;
        try {
          html = await fetchText(`${base}/${ref.file}`);
        } catch {
          continue; // one bad exhibit should not sink the whole answer
        }
        const rows = tableRows(html);
        if (rows.length < 2) continue;
        const title = rows[0].join(" ");
        const { multiplier } = unitMultiplier(title);
        const parsed = assemble(
          parseSegmentTable(rows, multiplier),
          periodHeaders(rows),
          title,
          ref.shortName,
          `${base}/${ref.file}`
        );
        if (parsed) tables.push(parsed);
      }

      if (tables.length === 0) {
        return {
          ticker: key,
          available: false,
          reason: `Could not parse a segment breakdown out of ${key}'s 10-K exhibits (filed ${filingDate[idx]}). The filing may report a single segment.`,
        };
      }

      return {
        ticker: key,
        available: true,
        company_name: submissions.name,
        filing_date: filingDate[idx],
        fiscal_periods: tables[0].periods,
        period_order: "newest first — growth is each period against the one to its right",
        tables,
        basis:
          "Segment figures from the SEC's rendered financial-report exhibits (R-files) " +
          "for the latest 10-K. Same filed XBRL as the statements, dimensional facts " +
          "that the companyfacts API does not expose. Annual periods only.",
        source: `SEC EDGAR filing exhibits — ${base}/FilingSummary.xml`,
      };
    } catch (e: unknown) {
      return {
        ticker: key,
        available: false,
        reason: `Could not read segment data for ${key} (${(e as Error).message})`,
      };
    }
  });
}

// ── Peer comparison ───────────────────────────────────────────────────────────

/**
 * Comparing more than this many companies is not a better answer, it is a slower
 * one: each ticker costs a multi-megabyte companyfacts download plus a filing
 * summary and its exhibits.
 */
const MAX_COMPARE = 5;

/**
 * Side-by-side consolidated and per-segment growth for a named set of companies.
 *
 * Peers are supplied by the caller, never guessed. There is no peer-discovery
 * source here that survives contact with reality — SIC codes lump unrelated
 * businesses together and Yahoo's "also watched" list returns whatever else the
 * same retail investors hold, which for a chipmaker is a list of megacap tech.
 * A named set is both cheaper and more honest about where the comparison came from.
 *
 * Every company is fetched independently and a failure is reported per ticker, so
 * one unparseable filing does not collapse the comparison.
 */
export async function comparePeers(tickers: string[]): Promise<Record<string, unknown>> {
  const unique = [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))];
  if (unique.length === 0) {
    return { error: "No tickers given. Pass the companies to compare, e.g. ['NVDA','AMD','AVGO']." };
  }

  const selected = unique.slice(0, MAX_COMPARE);
  const dropped = unique.slice(MAX_COMPARE);

  const companies = await Promise.all(
    selected.map(async (ticker) => {
      const [financials, segments] = await Promise.all([
        getFinancials(ticker).catch((e: Error) => ({ error: e.message })),
        getSegmentRevenue(ticker).catch((e: Error) => ({ available: false, reason: e.message })),
      ]);
      return { ticker, consolidated: financials, segments };
    })
  );

  return {
    compared: selected,
    ...(dropped.length ? { dropped, dropped_reason: `Capped at ${MAX_COMPARE} companies per comparison.` } : {}),
    companies,
    note:
      "Segment names are each company's own — they are not a common taxonomy, and " +
      "two filers' segments rarely line up one-to-one. Compare growth rates within " +
      "a segment's own history, and say so plainly when the segments are not comparable. " +
      "Fiscal years also differ between filers; check each company's period labels " +
      "before reading a growth gap as share shift.",
    source: "SEC EDGAR XBRL companyfacts + rendered 10-K segment exhibits",
  };
}
