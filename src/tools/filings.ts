/**
 * SEC EDGAR filing tools — pure REST, no Python dependency.
 * Uses the public EDGAR submissions API and the filing archives.
 */

import { EDGAR_HEADERS, edgarFetchJson, getCik } from "./edgar.js";
import { createCache } from "./cache.js";

const EDGAR_BASE = "https://data.sec.gov";
const EDGAR_ARCHIVES = "https://www.sec.gov";

export type RecentFilings = {
  name?: string;
  filings: {
    recent: {
      form: string[];
      accessionNumber: string[];
      primaryDocument: string[];
      filingDate: string[];
      /** Comma-separated 8-K item codes, e.g. "1.01,2.03,7.01". Empty for other forms. */
      items?: string[];
    };
  };
};

// ── Section extraction ────────────────────────────────────────────────────────

/**
 * Match a phrase tolerating whitespace between any two characters.
 *
 * Inline-XBRL filings wrap fragments of words in their own tags, so once markup
 * is stripped Microsoft's 10-K reads "ITEM 1A. RIS K FACTORS" and "UNRESOLVE D
 * STAFF COMMENTS". A contiguous-word pattern silently misses the real section
 * and matches only the table of contents.
 */
function spaced(phrase: string): string {
  return phrase
    .split("")
    .map((ch) => (/\s/.test(ch) ? "\\s*" : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("\\s*");
}

const ITEM = (n: string) => `Item\\s*${n}\\s*[.:\\-–—]?\\s*`;

/** "Management's Discussion", also tolerating a missing or detached apostrophe. */
const MDNA = `${spaced("Management")}\\s*'?\\s*s\\s*${spaced("Discussion")}`;

/**
 * The 10-K / 10-Q sections worth pulling, each keyed by the item number as the
 * caller writes it. `header` locates the section and `next` locates whichever
 * item follows it, so the slice ends at a real boundary rather than a fixed
 * character count. Titles are part of the pattern because "Item 1" alone would
 * also match inside "Item 1A".
 */
const SECTION_SPECS: Record<
  string,
  { label: string; header: RegExp; next: RegExp[]; defaultChars: number }
> = {
  "1": {
    label: "Item 1 — Business",
    header: new RegExp(ITEM("1") + spaced("Business"), "gi"),
    next: [new RegExp(ITEM("1A") + spaced("Risk Factors"), "gi")],
    defaultChars: 8000,
  },
  "1A": {
    label: "Item 1A — Risk Factors",
    header: new RegExp(ITEM("1A") + spaced("Risk Factors"), "gi"),
    next: [
      new RegExp(ITEM("1B") + spaced("Unresolved"), "gi"),
      new RegExp(ITEM("2") + spaced("Propert"), "gi"),
    ],
    defaultChars: 14000,
  },
  // Item 7 in a 10-K; the same content is Item 2 in a 10-Q.
  "7": {
    label: "Item 7 — Management's Discussion and Analysis",
    header: new RegExp(`Item\\s*[27]\\s*[.:\\-–—]?\\s*${MDNA}`, "gi"),
    next: [
      new RegExp(ITEM("7A") + spaced("Quantitative"), "gi"),
      new RegExp(ITEM("8") + spaced("Financial Statements"), "gi"),
      new RegExp(ITEM("3") + spaced("Quantitative"), "gi"),
    ],
    defaultChars: 12000,
  },
  "7A": {
    label: "Item 7A — Quantitative and Qualitative Disclosures About Market Risk",
    header: new RegExp(ITEM("7A") + spaced("Quantitative"), "gi"),
    next: [new RegExp(ITEM("8") + spaced("Financial Statements"), "gi")],
    defaultChars: 6000,
  },
};

/** Strip markup and normalize entities/whitespace into flat searchable text. */
function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/[‘’]/g, "'") // curly apostrophes defeat "Management's"
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ");
}

/**
 * True when a match is a quoted citation rather than a section heading.
 *
 * Filings cite other items in quotes — `refer to "Item 8. Financial Statements
 * and Supplementary Data" of this report`. These outnumber the real headings
 * and, treated as section boundaries, truncate a section to nothing: Coca-Cola's
 * MD&A cites Item 8 within 500 characters of its own heading.
 */
function isQuotedCitation(text: string, start: number): boolean {
  return text.slice(Math.max(0, start - 2), start).includes('"');
}

/** Every index just past a match of `re` in `text`, ignoring quoted citations. */
function allMatchEnds(text: string, re: RegExp): number[] {
  const scan = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  const ends: number[] = [];
  for (let m = scan.exec(text); m !== null; m = scan.exec(text)) {
    if (!isQuotedCitation(text, m.index)) ends.push(m.index + m[0].length);
  }
  return ends;
}

/** Index of the first non-citation match of `re` at or after `from`, or -1. */
function firstMatchFrom(text: string, re: RegExp, from: number): number {
  const scan = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  scan.lastIndex = from;
  for (let m = scan.exec(text); m !== null; m = scan.exec(text)) {
    if (!isQuotedCitation(text, m.index)) return m.index;
  }
  return -1;
}

/**
 * Slice one item out of a filing.
 *
 * An item header appears several times in a filing: in the table of contents,
 * as the real section, and as in-text cross-references ("see Item 1A. Risk
 * Factors"). Selection applies three rules, each earning its keep against a
 * real filing:
 *
 *   1. Bound each candidate by the nearest following item header. Table-of-
 *      contents entries collapse to a page number plus the next line, so a
 *      minimum body length discards them (all filers).
 *   2. Require that a following header was actually found. Cross-references
 *      appearing *after* the section — NVDA has four, in MD&A — otherwise run
 *      to end-of-document and look like enormous sections.
 *   3. The longest surviving span identifies the real section's END boundary,
 *      since every cross-reference preceding the body shares that boundary.
 *      Among the candidates sharing it, the body is the LAST one — the earlier
 *      members are references pointing forward at it (RIVN has two inside Item
 *      1, NVDA two). Taking the longest span alone would pick those.
 */
function extractSection(
  text: string,
  section: string,
  maxChars: number
): { text: string; truncated: boolean; located: boolean } {
  const spec = SECTION_SPECS[section];
  const MIN_BODY = 500;

  const bounded: Array<{ start: number; end: number }> = [];
  let fallback: { start: number; end: number } | null = null;

  for (const start of allMatchEnds(text, spec.header)) {
    let end = text.length;
    let hasBoundary = false;
    for (const nextRe of spec.next) {
      const idx = firstMatchFrom(text, nextRe, start);
      if (idx > start && idx < end) {
        end = idx;
        hasBoundary = true;
      }
    }
    if (end - start < MIN_BODY) continue;
    if (hasBoundary) bounded.push({ start, end });
    else fallback ??= { start, end };
  }

  let best: { start: number; end: number } | null = null;
  if (bounded.length) {
    const longest = bounded.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
    const sharingBoundary = bounded.filter((c) => c.end === longest.end);
    best = sharingBoundary[sharingBoundary.length - 1];
  } else {
    // No candidate had a following item header — trust an unbounded one only here.
    best = fallback;
  }

  if (!best) return { text: "", truncated: false, located: false };

  const body = text.slice(best.start, best.end).trim();
  return {
    text: body.slice(0, maxChars).trim(),
    truncated: body.length > maxChars,
    located: true,
  };
}

// ── Filing lookup ─────────────────────────────────────────────────────────────

/**
 * A filing is fetched once per session, not once per section.
 *
 * `get_filing_section` extracts one item out of the whole document, so asking for
 * Items 1, 1A and 7 used to download and re-parse the same multi-megabyte 10-K
 * three times — and `get_business_description` is itself Item 1, so a single
 * /business run pulled it three times over. Caching the parsed text keeps the
 * HTML-to-text pass out of the repeat path too.
 *
 * Filings are immutable once accepted, so the only staleness risk is missing a
 * newly filed 10-Q partway through a session, which the TTL bounds.
 */
const submissionsCache = createCache<RecentFilings>({
  ttlMs: 6 * 60 * 60 * 1000,
  maxEntries: 16,
});

const filingTextCache = createCache<{ text: string; filingDate: string; docUrl: string }>({
  ttlMs: 6 * 60 * 60 * 1000,
  // Parsed filing text is large; keep only a few tickers' worth resident.
  maxEntries: 6,
});

/** Shared with the segment reader, so both go through one cached download. */
export async function getSubmissions(cik: string): Promise<RecentFilings> {
  return submissionsCache.get(
    cik,
    async () => (await edgarFetchJson(`${EDGAR_BASE}/submissions/CIK${cik}.json`)) as RecentFilings
  );
}

async function fetchFilingText(
  cik: string,
  form: string
): Promise<{ text: string; filingDate: string; docUrl: string }> {
  return filingTextCache.get(`${cik}|${form}`, () => downloadFilingText(cik, form));
}

async function downloadFilingText(cik: string, form: string): Promise<{
  text: string;
  filingDate: string;
  docUrl: string;
}> {
  const submissions = await getSubmissions(cik);
  const { form: forms, accessionNumber, primaryDocument, filingDate } = submissions.filings.recent;

  const idx = forms.findIndex((f) => f === form);
  if (idx === -1) throw new Error(`No ${form} found in recent filings`);

  const accession = accessionNumber[idx].replace(/-/g, "");
  const docUrl = `${EDGAR_ARCHIVES}/Archives/edgar/data/${parseInt(cik)}/${accession}/${primaryDocument[idx]}`;

  const res = await fetch(docUrl, { headers: EDGAR_HEADERS });
  if (!res.ok) throw new Error(`Failed to fetch filing document: ${res.status}`);

  return { text: htmlToText(await res.text()), filingDate: filingDate[idx], docUrl };
}

// ── Exported tool functions ───────────────────────────────────────────────────

/**
 * Pull a named section (Item 1, 1A, 7, 7A) out of the most recent 10-K or 10-Q.
 * This is what the risk protocol needs — Item 1A carries the company's own
 * enumeration of its risks, and Item 7 carries management's explanation of the
 * numbers.
 */
export async function getFilingSection(
  ticker: string,
  section = "1A",
  form = "10-K",
  maxChars?: number
): Promise<object> {
  const key = section.trim().toUpperCase().replace(/^ITEM\s*/i, "");
  const spec = SECTION_SPECS[key];
  if (!spec) {
    return {
      error: `Unknown section "${section}". Supported: ${Object.keys(SECTION_SPECS).join(", ")}.`,
    };
  }

  const wantedForm = form.trim().toUpperCase();
  if (wantedForm !== "10-K" && wantedForm !== "10-Q") {
    return { error: `Unsupported form "${form}". Use 10-K or 10-Q.` };
  }

  try {
    const cik = await getCik(ticker);
    const { text, filingDate, docUrl } = await fetchFilingText(cik, wantedForm);
    const limit = Math.max(1000, Math.min(maxChars ?? spec.defaultChars, 40000));
    const extracted = extractSection(text, key, limit);

    // Returning the head of the filing on a miss would feed the model raw iXBRL
    // metadata; an explicit failure is more useful than plausible garbage.
    if (!extracted.located) {
      return {
        error: `Could not locate "${spec.label}" in ${ticker.toUpperCase()}'s ${wantedForm} dated ${filingDate}. The filing may use a non-standard section layout.`,
        source_url: docUrl,
      };
    }

    return {
      ticker: ticker.toUpperCase(),
      section: spec.label,
      filing_type: wantedForm,
      filing_date: filingDate,
      source_url: docUrl,
      truncated: extracted.truncated,
      note: extracted.truncated
        ? "Section truncated — SEC filings order items by materiality, so the most significant appear first."
        : undefined,
      content: extracted.text,
    };
  } catch (e: unknown) {
    return { error: `Failed to fetch ${spec.label} for ${ticker}: ${(e as Error).message}` };
  }
}

export async function getBusinessDescription(ticker: string): Promise<object> {
  const result = (await getFilingSection(ticker, "1", "10-K")) as Record<string, unknown>;
  if (result.error) return result;
  // Preserve the original field name so existing prompts keep working.
  const { content, section, ...rest } = result;
  return { ...rest, business_description: content };
}

export async function getRecentFilings(ticker: string): Promise<object> {
  try {
    const cik = await getCik(ticker);
    const submissions = await getSubmissions(cik);

    const { form, accessionNumber, filingDate } = submissions.filings.recent;
    const relevantForms = ["10-K", "10-Q", "8-K", "DEF 14A"];

    const filings = form
      .map((f, i) => ({ form: f, accession: accessionNumber[i], date: filingDate[i] }))
      .filter((f) => relevantForms.includes(f.form))
      .slice(0, 10);

    return {
      ticker: ticker.toUpperCase(),
      company_name: submissions.name,
      cik: parseInt(cik).toString(),
      recent_filings: filings,
    };
  } catch (e: unknown) {
    return { error: `Failed to fetch recent filings for ${ticker}: ${(e as Error).message}` };
  }
}

// ── 8-K event stream ──────────────────────────────────────────────────────────

/**
 * Form 8-K item codes.
 *
 * An 8-K is the only filing a company makes *because something happened*, and the
 * item code says what — so the codes turn an undifferentiated filing list into a
 * dated event log. The submissions API already carries them in the payload
 * `get_recent_filings` downloads, so decoding costs nothing extra.
 */
const EIGHT_K_ITEMS: Record<string, string> = {
  "1.01": "Entry into a material definitive agreement",
  "1.02": "Termination of a material definitive agreement",
  "1.03": "Bankruptcy or receivership",
  "1.04": "Mine safety — reporting of shutdowns",
  "1.05": "Material cybersecurity incident",
  "2.01": "Completion of an acquisition or disposition of assets",
  "2.02": "Results of operations and financial condition (earnings release)",
  "2.03": "Creation of a direct financial obligation (debt raised)",
  "2.04": "Triggering event accelerating a financial obligation",
  "2.05": "Costs associated with exit or disposal activities (restructuring)",
  "2.06": "Material impairment",
  "3.01": "Notice of delisting or failure to satisfy a listing rule",
  "3.02": "Unregistered sale of equity securities",
  "3.03": "Material modification to rights of security holders",
  "4.01": "Change in certifying accountant (auditor change)",
  "4.02": "Non-reliance on previously issued financial statements (restatement)",
  "5.01": "Change in control of registrant",
  "5.02": "Departure or election of directors or principal officers",
  "5.03": "Amendment to articles or bylaws; change in fiscal year",
  "5.04": "Temporary suspension of trading under employee benefit plans",
  "5.05": "Amendment to the code of ethics",
  "5.07": "Submission of matters to a vote of security holders (annual meeting)",
  "5.08": "Shareholder director nominations",
  "7.01": "Regulation FD disclosure",
  "8.01": "Other events (company's own catch-all)",
  "9.01": "Financial statements and exhibits",
};

/**
 * Codes that accompany an event rather than being one. 9.01 just says exhibits
 * are attached and 7.01 is the wrapper for a press release; an 8-K carrying only
 * these is not itself news, so they are reported but not counted as substantive.
 */
const ROUTINE_ITEMS = new Set(["9.01", "7.01"]);

/**
 * The 8-K event log: what the company has told the market it did, with dates.
 *
 * Distinct from `get_recent_filings`, which answers "what has been filed" — this
 * answers "what happened". Use it for near-term catalysts: new material
 * agreements, closed acquisitions, debt raises, restructurings, executive
 * changes, and the cadence of earnings releases.
 */
export async function getFilingEvents(ticker: string, limit = 20): Promise<object> {
  try {
    const cik = await getCik(ticker);
    const submissions = await getSubmissions(cik);
    const { form, accessionNumber, filingDate, items } = submissions.filings.recent;

    if (!items) {
      return {
        ticker: ticker.toUpperCase(),
        available: false,
        reason: "EDGAR returned no item codes for this filer's submissions.",
      };
    }

    const capped = Math.max(1, Math.min(limit, 40));
    const events = form
      .map((f, i) => ({ form: f, date: filingDate[i], raw: items[i] ?? "", accession: accessionNumber[i] }))
      .filter((f) => f.form.startsWith("8-K") && f.raw)
      .slice(0, capped)
      .map((f) => {
        const codes = f.raw.split(",").map((c) => c.trim()).filter(Boolean);
        const substantive = codes.filter((c) => !ROUTINE_ITEMS.has(c));
        return {
          date: f.date,
          form: f.form,
          items: codes.map((c) => ({ code: c, meaning: EIGHT_K_ITEMS[c] ?? "Unrecognized item code" })),
          // An 8-K whose only codes are 7.01/9.01 is a press-release wrapper —
          // the substance, if any, is in the exhibit rather than the item code.
          substantive: substantive.length > 0,
          filing_url: `${EDGAR_ARCHIVES}/Archives/edgar/data/${parseInt(cik)}/${f.accession.replace(/-/g, "")}/`,
        };
      });

    if (events.length === 0) {
      return {
        ticker: ticker.toUpperCase(),
        available: false,
        reason: `No 8-K filings with item codes found for ${ticker.toUpperCase()}.`,
      };
    }

    return {
      ticker: ticker.toUpperCase(),
      available: true,
      company_name: submissions.name,
      events_returned: events.length,
      oldest_event: events[events.length - 1].date,
      newest_event: events[0].date,
      events,
      note:
        "8-K item codes are the company's own classification of what it reported. " +
        "An item code says what happened, not whether it was good — read the filing " +
        "for direction. Items 7.01 and 9.01 alone mean a press release with exhibits.",
      source: "SEC EDGAR submissions API (form 8-K item codes)",
    };
  } catch (e: unknown) {
    return { error: `Failed to fetch filing events for ${ticker}: ${(e as Error).message}` };
  }
}
