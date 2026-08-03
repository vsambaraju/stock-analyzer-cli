/**
 * SEC EDGAR filing tools — pure REST, no Python dependency.
 * Uses the public EDGAR submissions API and the filing archives.
 */

import { EDGAR_HEADERS, edgarFetchJson, getCik } from "./edgar.js";

const EDGAR_BASE = "https://data.sec.gov";
const EDGAR_ARCHIVES = "https://www.sec.gov";

type RecentFilings = {
  name?: string;
  filings: {
    recent: {
      form: string[];
      accessionNumber: string[];
      primaryDocument: string[];
      filingDate: string[];
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

async function getSubmissions(cik: string): Promise<RecentFilings> {
  return (await edgarFetchJson(`${EDGAR_BASE}/submissions/CIK${cik}.json`)) as RecentFilings;
}

async function fetchFilingText(cik: string, form: string): Promise<{
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
