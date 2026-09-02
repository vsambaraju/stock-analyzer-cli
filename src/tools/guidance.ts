/**
 * Company-issued forward guidance, read out of the earnings press release.
 *
 * An 8-K carrying item 2.02 ("Results of operations and financial condition") is
 * the earnings release, and its EX-99.1 exhibit is the press release itself. For
 * filers that guide in writing, that exhibit holds the single most valuable thing
 * in this CLI that no other source carries: management's own numeric outlook for
 * the coming quarter, with ranges.
 *
 *   NVIDIA, Q1 FY2027: "Revenue is expected to be $91.0 billion, plus or minus 2%.
 *   GAAP and non-GAAP gross margins are expected to be 74.9% and 75.0% …"
 *
 * That is strictly better than the same figure recovered from an earnings-call
 * transcript: it is written, exact, free, and needs no API key or daily quota.
 *
 * Four facts about item 2.02 shape everything below.
 *
 * 1. The exhibit is *furnished*, not filed, and is exempt from inline XBRL. There
 *    are no tagged facts here — only HTML laid out however the filer pleased. So
 *    this tool deliberately does NOT parse the financial tables: those same
 *    numbers arrive properly tagged in the 10-Q a few days later, and
 *    `get_financial_history` already reads them. This reads the outlook prose,
 *    which XBRL never carries.
 *
 * 2. Not every filer guides. Measured against live filings, NVDA, AMD, DDOG,
 *    PLTR, SNOW and CRM publish a numeric outlook in the release; Apple, Microsoft
 *    and Costco do not — Microsoft's release references guidance it gave on the
 *    prior call, and issues the new one verbally. A missing outlook is therefore a
 *    normal outcome to report, not a failure to retry.
 *
 * 3. `index.json` for an accession cannot be trusted to list the documents. For
 *    NVIDIA's Q1 FY2027 8-K it returned only the wrapper files and omitted
 *    `q1fy27pr.htm` — the press release — entirely. The `-index.html` page lists
 *    them reliably, so that is what gets parsed.
 *
 * 4. "Outlook" appears in the forward-looking-statements boilerplate of nearly
 *    every release, so the heading cannot simply be matched. Candidates are
 *    *scored* by how much numeric forward-looking content follows them, the same
 *    bargain `get_segment_revenue` strikes with filer-chosen table titles.
 */

import { EDGAR_HEADERS, getCik } from "./edgar.js";
import { createCache } from "./cache.js";
import { getSubmissions } from "./filings.js";

const EDGAR_ARCHIVES = "https://www.sec.gov";

/** Press releases are small; a filing that is slow is a filing that is wrong. */
const TIMEOUT_MS = 15000;

/** Cap on the outlook text handed back to the model. */
const DEFAULT_MAX_CHARS = 4000;

/** A published exhibit never changes, so this can be cached hard. */
const guidanceCache = createCache<Record<string, unknown>>({
  ttlMs: 24 * 60 * 60 * 1000,
  maxEntries: 12,
});

// ── HTML → text ───────────────────────────────────────────────────────────────

/**
 * Flatten markup to text, keeping the line structure.
 *
 * Unlike the 10-K reader, which wants one long searchable string, guidance lives
 * in bullets — "• Revenue is expected to be $91.0 billion, plus or minus 2%".
 * Collapsing those into a paragraph welds three separate guidance items into one
 * unsplittable run, so block-level tags become newlines before markup is dropped.
 */
function htmlToLines(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*[^>]*>/gi, "\n")
    .replace(/<\s*li\b[^>]*>/gi, "\n• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// ── Section location ──────────────────────────────────────────────────────────

/**
 * Match a phrase tolerating whitespace between any two characters.
 *
 * Inline-XBRL tagging splits words in the rendered text: Datadog's release reads
 * "Co nference Call Details" and "W hat:". A contiguous pattern misses the
 * boundary and the outlook section runs on into the dial-in instructions.
 */
function loose(phrase: string): string {
  return phrase
    .split("")
    .map((ch) => (/\s/.test(ch) ? "\\s+" : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("\\s*");
}

/** Headings that open an outlook block, however the filer words it. */
const OUTLOOK_START =
  /\b(?:(?:business|financial|updated|revised)\s+outlook|outlook|guidance)\b/gi;

/**
 * Headings that open a highlights block.
 *
 * Worth reading because this is where quarterly *segment* figures live — "Data
 * Center: first-quarter revenue was a record $75.2 billion, up 21% from the
 * previous quarter" at NVIDIA. Nothing else in this CLI carries a segment split
 * at quarterly frequency: `get_segment_revenue` parses 10-K exhibits and is
 * annual only.
 */
const HIGHLIGHTS_START =
  /\b(?:(?:financial|business|operational|operating|quarterly|recent|other|company|segment)\s+highlights|highlights|segment\s+(?:summary|results)|quarterly\s+(?:financial\s+)?results)\b/gi;

/**
 * Boilerplate that closes any section. An earnings release puts its legal and
 * logistical matter after the substance, so the first of these following a
 * heading is the boundary.
 */
const COMMON_STOP: RegExp[] = [
  new RegExp(loose("conference call"), "gi"),
  new RegExp(loose("webcast"), "gi"),
  new RegExp(loose("forward-looking statement"), "gi"),
  new RegExp(loose("safe harbor"), "gi"),
  new RegExp(loose("non-GAAP financial measures"), "gi"),
  new RegExp(loose("non-GAAP measures"), "gi"),
  new RegExp(loose("investor relations"), "gi"),
  new RegExp(loose("condensed consolidated"), "gi"),
  new RegExp(loose("consolidated statements"), "gi"),
  new RegExp(loose("consolidated balance sheet"), "gi"),
  /\bAbout\s+[A-Z]/g,
];

/**
 * The two sections bound each other, in whichever order the filer puts them.
 * NVIDIA runs Outlook then Highlights; most others run Highlights then Outlook.
 * Without the mutual boundary each swallows the other and the guidance figures
 * end up mixed in with the reported ones — the exact confusion this tool exists
 * to prevent.
 */
const OUTLOOK_STOP: RegExp[] = [...COMMON_STOP, HIGHLIGHTS_START];
const HIGHLIGHTS_STOP: RegExp[] = [...COMMON_STOP, OUTLOOK_START];

/** A figure. Guidance without a number is a sentiment, not a guide. */
const NUMERIC = /(?:\$\s?[\d,]+(?:\.\d+)?\s*(?:billion|million|thousand|B\b|M\b)?|\d+(?:\.\d+)?\s*%|\bbasis\s+points\b)/i;

/** Wording that states a figure is a forecast rather than a result. */
const FORWARD =
  /\b(?:expects?|expected|anticipat\w*|guidance|guiding|outlook|forecast\w*|project(?:s|ed|ing)?|will\s+be|plus\s+or\s+minus|raising|lowering|reiterat\w*|initiates?|maintains?|updates?)\b/i;

/** Wording that compares a figure to a prior period — the mark of a result. */
const COMPARISON =
  /\b(?:up|down|increased?|decreased?|grew|growth|declined?|rose|fell|compared\s+to|year[-\s]over[-\s]year|YoY|Y\/Y|sequential\w*|quarter[-\s]over[-\s]quarter|from\s+the\s+(?:previous|prior)|record)\b/i;

/**
 * How strongly a candidate block looks like real guidance.
 *
 * Counting numeric lines alone is not enough. NVIDIA's release carries the prose
 * outlook — "Revenue is expected to be $91.0 billion, plus or minus 2%" — and,
 * further down, a reconciliation table also headed "OUTLOOK" whose rows are bare
 * fragments ("GAAP gross margin 74.9 %"). The table has *more* numeric rows and
 * wins on count, while omitting the revenue guide entirely. Weighting lines that
 * actually say a number is expected restores the prose block, which is the one a
 * reader wants.
 */
function scoreGuidance(lines: string[]): number {
  return lines.length + 2 * lines.filter((l) => FORWARD.test(l)).length;
}

/**
 * The same idea inverted for highlights: what makes a highlights block valuable
 * is figures set against a prior period, not figures set against a forecast.
 */
function scoreHighlights(lines: string[]): number {
  return lines.length + 2 * lines.filter((l) => COMPARISON.test(l)).length;
}

/** Split a block into candidate lines, however the filer bulleted it. */
function splitLines(section: string): string[] {
  return section
    .split(/\n|[•◦▪]|(?<=[.!?])\s+(?=[A-Z])/)
    .map((l) => l.replace(/^[•◦▪\-–—\s]+/, "").trim());
}

/**
 * The numeric lines of a block.
 *
 * Deliberately does NOT require forward-looking wording per line. Datadog's
 * guidance bullets read "Revenue between $1.135 billion and $1.145 billion" —
 * the forwardness is carried by the "Third Quarter 2026 Outlook:" heading above
 * them, not repeated in each bullet, and demanding it per line drops every one.
 * The section boundary is what establishes what these figures are; requiring a
 * figure is what keeps legal boilerplate out.
 */
function numericLines(section: string): string[] {
  return splitLines(section).filter(
    (l) => l.length > 20 && l.length < 400 && NUMERIC.test(l)
  );
}

/**
 * First heading-position stop at or after `from`, or -1.
 *
 * The heading-position test matters as much here as it does for the opening
 * match. Snowflake's outlook begins "Financial Outlook: Our guidance includes
 * GAAP and non-GAAP financial measures." — the phrase "non-GAAP financial
 * measures" occurs in the very first sentence, and treating that inline mention
 * as the section boundary truncates the outlook to fifty characters, before a
 * single figure. A boundary is a heading, not a phrase.
 */
function firstStop(text: string, from: number, stops: RegExp[]): number {
  let best = -1;
  for (const re of stops) {
    const scan = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    scan.lastIndex = from;
    for (let m = scan.exec(text); m !== null; m = scan.exec(text)) {
      if (!isHeadingPosition(text, m.index, m.index + m[0].length)) continue;
      if (best === -1 || m.index < best) best = m.index;
      break;
    }
  }
  return best;
}

/**
 * True when a match sits where a heading sits rather than inside a sentence.
 *
 * This is the rule that separates a real outlook section from a passing mention.
 * Microsoft's release says "…compared to guidance provided on April 29, 2026,
 * resulting in a benefit of $0.27 on diluted earnings per share" — the word
 * "guidance" mid-clause, followed by figures that are *results*, not forecasts.
 * Scoring alone would happily return that as Microsoft's outlook. A heading, by
 * contrast, either starts its own line (NVIDIA's "Outlook") or is punctuated as
 * a label (Datadog's "Outlook:").
 */
function isHeadingPosition(text: string, start: number, end: number): boolean {
  if (/^\s*:/.test(text.slice(end, end + 3))) return true;

  const prefix = text.slice(text.lastIndexOf("\n", start) + 1, start);
  // A qualifier may sit between the line break and the word — "Current Outlook"
  // at AMD, "Third Quarter 2026 Outlook" at Datadog, "3 Financial Outlook" where
  // a page number leads. A whole clause may not: that is prose, and the word is
  // being used in a sentence rather than naming a section.
  if (prefix.length > 40) return false;
  if (/[.!?;,]\s*$/.test(prefix)) return false;
  // A trailing function word means the match is the object of a phrase
  // ("compared to guidance", "up from previous guidance"), never a heading.
  return !/\b(?:the|our|its|to|of|and|or|in|on|with|from|than|for|prior|previous|initial|original|full[-\s]year)\s+$/i.test(
    prefix
  );
}

export type Section = {
  text: string;
  lines: string[];
  heading: string;
  truncated: boolean;
  score: number;
};

/**
 * A section, chosen by scoring rather than by matching the first heading.
 *
 * "Outlook" occurs in the forward-looking-statements paragraph of essentially
 * every release ("statements regarding our outlook…"), and that paragraph is
 * longer than the real outlook section. Matching the first, or the longest, hit
 * therefore returns boilerplate. Counting how many numeric lines follow each
 * candidate separates them cleanly: a real block is dense with figures and the
 * boilerplate has none.
 */
function extractSection(
  text: string,
  start: RegExp,
  stops: RegExp[],
  maxChars: number,
  cap: number,
  score: (lines: string[]) => number
): Section | null {
  const scan = new RegExp(start.source, start.flags);
  let best: { body: string; lines: string[]; heading: string; score: number } | null = null;

  for (let m = scan.exec(text); m !== null; m = scan.exec(text)) {
    const at = m.index;
    if (!isHeadingPosition(text, at, at + m[0].length)) continue;
    const stop = firstStop(text, at + m[0].length, stops);
    // A hard cap bounds the block when a release carries none of the usual
    // trailing headings; a section longer than this is not the section.
    const end = stop === -1 ? Math.min(text.length, at + cap) : Math.min(stop, at + cap);
    const body = text.slice(at, end).trim();
    if (body.length < 40) continue;

    const lines = numericLines(body);
    if (lines.length === 0) continue;
    const s = score(lines);
    // Strictly greater, so that on a tie the earlier block wins — prose outlooks
    // precede the reconciliation tables that restate them.
    if (!best || s > best.score) best = { body, lines, heading: m[0].trim(), score: s };
  }

  if (!best) return null;
  return {
    text: best.body.slice(0, maxChars).trim(),
    lines: best.lines,
    heading: best.heading,
    truncated: best.body.length > maxChars,
    score: best.score,
  };
}

/** The forward-looking outlook block. */
export function extractOutlook(text: string, maxChars: number): Section | null {
  return extractSection(text, OUTLOOK_START, OUTLOOK_STOP, maxChars, 6000, scoreGuidance);
}

/**
 * The reported-results highlights block.
 *
 * Capped wider than the outlook because a highlights section legitimately runs
 * long — NVIDIA lists four segments, each with several bullets — where an
 * outlook that long would be a sign the boundary was missed.
 */
export function extractHighlights(text: string, maxChars: number): Section | null {
  return extractSection(text, HIGHLIGHTS_START, HIGHLIGHTS_STOP, maxChars, 9000, scoreHighlights);
}

/**
 * Group highlight lines under the sub-headings they sit beneath.
 *
 * This is what turns a highlights block into segment evidence. NVIDIA's reads
 * "Data Center" / "• First-quarter revenue was a record $75.2 billion, up 21%
 * from the previous quarter" / "Gaming" / "• …". The sub-headings carry no
 * numbers and the figures beneath them do, which is the same positional rule
 * `get_segment_revenue` applies to rendered filing tables: a row with no numeric
 * cells opens a group, and the rows beneath belong to it until the next such row.
 *
 * Lines appearing before any sub-heading are returned under a null segment
 * rather than dropped — most filers put consolidated figures there.
 */
export function groupHighlights(
  body: string
): Array<{ segment: string | null; lines: string[] }> {
  const MAX_GROUPS = 12;
  const MAX_LINES = 8;

  const groups: Array<{ segment: string | null; lines: string[] }> = [];
  let current: { segment: string | null; lines: string[] } = { segment: null, lines: [] };

  for (const line of splitLines(body)) {
    if (!line) continue;
    const isHeading =
      line.length <= 60 &&
      !NUMERIC.test(line) &&
      /^[A-Za-z]/.test(line) && // "813 Forbes Global 2000 customers" is a statistic, not a heading
      !/[.!?]$/.test(line);
    if (isHeading) {
      if (current.lines.length) groups.push(current);
      if (groups.length >= MAX_GROUPS) return groups;
      current = { segment: line.replace(/:$/, "").trim(), lines: [] };
      continue;
    }
    if (line.length > 20 && line.length < 400 && NUMERIC.test(line) && current.lines.length < MAX_LINES) {
      current.lines.push(line);
    }
  }
  if (current.lines.length) groups.push(current);
  return groups.slice(0, MAX_GROUPS);
}

/**
 * Mentions of guidance the company gave previously.
 *
 * Worth surfacing separately because it answers "did the guide move?" without a
 * second filing, and because it survives in releases that carry no outlook block
 * at all — Microsoft's release quantifies its beat against "guidance provided on
 * April 29, 2026" while issuing the new guide only on the call.
 */
function priorGuidanceMentions(text: string): string[] {
  const out: string[] = [];
  const re = /[^\n.]*\b(?:previous|prior|initial|original)\s+guidance\b[^\n.]*\.?|[^\n.]*\bguidance\s+(?:provided|issued|given)\s+on\b[^\n.]*\.?/gi;
  for (const m of text.matchAll(re)) {
    const line = m[0].trim();
    if (line.length > 20 && line.length < 400) out.push(line);
    if (out.length >= 6) break;
  }
  return out;
}

// ── Exhibit lookup ────────────────────────────────────────────────────────────

type ExhibitRef = { type: string; url: string; name: string };

/**
 * The EX-99 exhibits of a filing, read from its `-index.html`.
 *
 * `index.json` is the obvious route and is not reliable — see the file header.
 * The index page renders one table row per document, so a row carrying an EX-99
 * type and an `.htm` link is an exhibit. The primary 8-K document is skipped: it
 * is the cover page, and the substance is always in the exhibit.
 */
function parseExhibitIndex(html: string, dir: string): ExhibitRef[] {
  const refs: ExhibitRef[] = [];
  const seen = new Set<string>();

  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const block = row[1];
    const type = block.match(/<td[^>]*>\s*(EX-99[.\d]*)\s*<\/td>/i)?.[1];
    if (!type) continue;
    const href = block.match(/href="([^"]+?\.htm)"/i)?.[1];
    if (!href) continue;

    const clean = href.replace(/^\/ix\?doc=/, "");
    const url = clean.startsWith("http") ? clean : `${EDGAR_ARCHIVES}${clean}`;
    if (seen.has(url)) continue;
    seen.add(url);
    refs.push({ type: type.toUpperCase(), url, name: url.split("/").pop() ?? url });
  }

  // EX-99.1 is the press release by convention; EX-99.2, where present, is
  // usually CFO commentary and can carry the outlook instead.
  refs.sort((a, b) => a.type.localeCompare(b.type));
  return refs.length ? refs : fallbackExhibits(html, dir);
}

/** Last resort: any .htm in the row table that is not the inline-XBRL primary doc. */
function fallbackExhibits(html: string, dir: string): ExhibitRef[] {
  const refs: ExhibitRef[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/href="([^"]+?\.htm)"/gi)) {
    if (/^\/ix\?doc=/.test(m[1])) continue; // the 8-K cover page itself
    const url = m[1].startsWith("http") ? m[1] : `${EDGAR_ARCHIVES}${m[1]}`;
    if (!url.startsWith(dir) || seen.has(url)) continue;
    seen.add(url);
    refs.push({ type: "UNKNOWN", url, name: url.split("/").pop() ?? url });
  }
  return refs;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: EDGAR_HEADERS,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`EDGAR ${res.status} for ${url}`);
  return res.text();
}

// ── Tool ──────────────────────────────────────────────────────────────────────

/**
 * Forward guidance from the most recent earnings release (8-K item 2.02).
 *
 * Returns `{ available: false, reason }` when there is no item-2.02 8-K or its
 * exhibit cannot be read. When the release is found but carries no outlook,
 * `available` stays true and `guidance_found` is false — the distinction matters,
 * because "this filer does not guide in writing" is an answer and "EDGAR was
 * unreachable" is not.
 */
export async function getEarningsGuidance(
  ticker: string,
  maxChars?: number
): Promise<Record<string, unknown>> {
  const key = ticker.toUpperCase();
  const cap = Math.max(1000, Math.min(maxChars ?? DEFAULT_MAX_CHARS, 12000));

  return guidanceCache.get(`${key}|${cap}`, async () => {
    let cik: string;
    try {
      cik = await getCik(key);
    } catch (e: unknown) {
      return { ticker: key, available: false, reason: (e as Error).message };
    }

    let submissions;
    try {
      submissions = await getSubmissions(cik);
    } catch (e: unknown) {
      return { ticker: key, available: false, reason: `Could not reach EDGAR: ${(e as Error).message}` };
    }

    const { form, items, accessionNumber, filingDate } = submissions.filings.recent;
    if (!items) {
      return {
        ticker: key,
        available: false,
        reason: "EDGAR returned no 8-K item codes for this filer, so the earnings release cannot be located.",
      };
    }

    const idx = form.findIndex(
      (f, i) => f.startsWith("8-K") && (items[i] ?? "").includes("2.02")
    );
    if (idx === -1) {
      return {
        ticker: key,
        available: false,
        reason:
          `No 8-K carrying item 2.02 (earnings release) on file for ${key}. Foreign private ` +
          `issuers file 6-K instead, and some filers report only in the 10-Q.`,
      };
    }

    const accession = accessionNumber[idx];
    const releaseDate = filingDate[idx];
    const dir = `${EDGAR_ARCHIVES}/Archives/edgar/data/${parseInt(cik)}/${accession.replace(/-/g, "")}`;

    let exhibits: ExhibitRef[];
    try {
      exhibits = parseExhibitIndex(await fetchText(`${dir}/${accession}-index.html`), dir);
    } catch (e: unknown) {
      return {
        ticker: key,
        available: false,
        reason: `Could not read the filing index for ${key}'s ${releaseDate} earnings 8-K: ${(e as Error).message}`,
      };
    }

    if (exhibits.length === 0) {
      return {
        ticker: key,
        available: false,
        reason: `${key}'s ${releaseDate} earnings 8-K has no readable EX-99 exhibit — the release may have been furnished as a graphic or plain text.`,
      };
    }

    // Read at most three exhibits: the press release and any CFO commentary. The
    // outlook lives in one of them, and scanning further costs requests to no end.
    let bestOutlook: Section | null = null;
    let bestFrom: ExhibitRef | null = null;
    let bestHighlights: Section | null = null;
    let highlightsFrom: ExhibitRef | null = null;
    let priorGuidance: string[] = [];
    const read: string[] = [];

    for (const ex of exhibits.slice(0, 3)) {
      let text: string;
      try {
        text = htmlToLines(await fetchText(ex.url));
      } catch {
        continue; // a missing exhibit is not a failed lookup
      }
      read.push(`${ex.type} (${ex.name})`);

      if (priorGuidance.length === 0) priorGuidance = priorGuidanceMentions(text);

      const outlook = extractOutlook(text, cap);
      if (outlook && (!bestOutlook || outlook.score > bestOutlook.score)) {
        bestOutlook = outlook;
        bestFrom = ex;
      }

      const highlights = extractHighlights(text, Math.round(cap * 1.5));
      if (highlights && (!bestHighlights || highlights.score > bestHighlights.score)) {
        bestHighlights = highlights;
        highlightsFrom = ex;
      }
    }

    if (read.length === 0) {
      return {
        ticker: key,
        available: false,
        reason: `Could not fetch any exhibit from ${key}'s ${releaseDate} earnings 8-K.`,
      };
    }

    // How fresh this is relative to the tagged financials, which the model needs
    // to know before it reconciles the two: the release lands first.
    const periodicIdx = form.findIndex((f) => f === "10-Q" || f === "10-K");
    const periodic =
      periodicIdx === -1
        ? null
        : { form: form[periodicIdx], filed: filingDate[periodicIdx] };
    const releaseIsNewer = periodic ? releaseDate > periodic.filed : true;

    const base = {
      ticker: key,
      available: true,
      earnings_release: {
        filed: releaseDate,
        accession,
        filing_url: `${dir}/`,
        exhibits_read: read,
      },
      freshness: {
        latest_periodic_filing: periodic,
        release_is_newer_than_periodic: releaseIsNewer,
        note: releaseIsNewer
          ? "This earnings release is more recent than the latest 10-Q/10-K, so " +
            "get_financial_history (which reads XBRL from periodic filings) does NOT " +
            "yet include this quarter. Say so rather than presenting stale figures as current."
          : "The latest 10-Q/10-K is at least as recent as this release, so the tagged " +
            "financials in get_financial_history cover this quarter.",
      },
      prior_guidance_mentions: priorGuidance,
      highlights: bestHighlights
        ? {
            found: true,
            heading: bestHighlights.heading,
            from: highlightsFrom ? `${highlightsFrom.type} (${highlightsFrom.name})` : null,
            by_segment: groupHighlights(bestHighlights.text),
            text: bestHighlights.text,
            text_truncated: bestHighlights.truncated,
            basis:
              "REPORTED results for the quarter just ended, in the company's own words — " +
              "not guidance. This is the only quarterly segment split available in this " +
              "CLI (get_segment_revenue reads 10-K exhibits and is annual only), so it is " +
              "the right source for 'which segment drove the quarter'. Two caveats: the " +
              "company chooses what to highlight, so treat the selection as promotional " +
              "even though the figures are its own; and these are untagged press-release " +
              "numbers that may be non-GAAP, so prefer get_financial_history for " +
              "consolidated GAAP figures wherever it covers the quarter.",
          }
        : {
            found: false,
            note:
              `No highlights section with figures was found in ${key}'s ${releaseDate} ` +
              `release. Quarterly segment figures are therefore unavailable — do not ` +
              `substitute the annual split from get_segment_revenue and call it the quarter.`,
          },
      basis:
        "Furnished exhibit to an 8-K item 2.02 — the company's own earnings press " +
        "release. Guidance is a forward-looking statement, not a commitment or a " +
        "filed fact, and item 2.02 exhibits are furnished rather than filed. " +
        "Attribute it to the company and to the release date.",
      source: `SEC EDGAR 8-K item 2.02, ${releaseDate} (${key})`,
    };

    if (!bestOutlook) {
      return {
        ...base,
        guidance_found: false,
        note:
          `${key}'s ${releaseDate} earnings release contains no outlook or guidance section ` +
          `with figures in it. Many large filers guide only verbally on the earnings call — ` +
          `Apple, Microsoft and Costco all do. Try get_earnings_transcript for spoken ` +
          `guidance, or get_upcoming_events for where analyst consensus has moved instead. ` +
          `Do not infer that the company withdrew guidance. Any highlights block above is ` +
          `reported results for the quarter just ended, never a forecast.`,
      };
    }

    return {
      ...base,
      guidance_found: true,
      outlook_heading: bestOutlook.heading,
      outlook_from: bestFrom ? `${bestFrom.type} (${bestFrom.name})` : null,
      guidance_items: bestOutlook.lines,
      outlook_text: bestOutlook.text,
      outlook_text_truncated: bestOutlook.truncated,
    };
  });
}
