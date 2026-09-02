/**
 * Streaming Markdown → ANSI renderer for the terminal.
 *
 * The model is asked for "clean Markdown", and until now that Markdown was
 * written to stdout verbatim: reports arrived with literal `**` around every
 * bold run and backticks around every `[REPORTED]` tag. This turns those into
 * terminal attributes as the text streams.
 *
 * Two constraints shape the design.
 *
 * 1. **Text arrives as token deltas, not lines.** A single `**Data center...**`
 *    run routinely spans three deltas ("**Da", "ta center demand", ":**"), so a
 *    per-delta transform would see half-open markers and mangle them. Rendering
 *    is therefore line-buffered: deltas accumulate, and a line is rendered only
 *    once its newline arrives. Output goes from token-at-a-time to line-at-a-
 *    time, which for a structured report reads better anyway — a heading appears
 *    as a heading rather than assembling itself a character at a time.
 *
 * 2. **Emphasis must not be rendered inside code spans.** `` `**not bold**` ``
 *    is a literal, so the line is split on code spans first and emphasis applied
 *    only to the parts between them. Bold is consumed before italic for the same
 *    reason in reverse: `**` matched as two nested `*` would turn every bold run
 *    into stray asterisks around italic text.
 *
 * Tables are deliberately unsupported — the system prompt forbids them, because
 * pipe-and-dash columns do not survive a terminal once emoji are in the cells.
 */

import { c, styled } from "./ui.js";

/** `# ` … `###### ` — the level decides the colour, not the size. */
const HEADING = /^(#{1,6})\s+(.*)$/;
/** `- `, `* `, `+ ` with any leading indent. */
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
/** `1. `, `2) ` with any leading indent. */
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
/** `---`, `***`, `___` alone on a line. */
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
/** ``` or ~~~ , with an optional language tag. */
const FENCE = /^\s*(?:```|~~~)/;
const QUOTE = /^\s*>\s?(.*)$/;

/**
 * Apply inline emphasis to one run of text that contains no code spans.
 *
 * Order matters: `***` before `**` before `*`, longest marker first, or the
 * shorter pattern eats one half of the longer one and leaves the rest stranded.
 */
function emphasis(s: string): string {
  return (
    s
      .replace(/\*\*\*(\S(?:.*?\S)?)\*\*\*/g, (_, t: string) => c.bold(c.italic(t)))
      .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, (_, t: string) => c.bold(t))
      .replace(/__(\S(?:.*?\S)?)__/g, (_, t: string) => c.bold(t))
      // A single `*`/`_` pair, only when it hugs non-space on both sides — this
      // is what keeps "up 21% * see note" and snake_case_identifiers intact.
      .replace(/(^|[^*\w])\*(\S(?:.*?\S)?)\*(?!\w)/g, (_, pre: string, t: string) => pre + c.italic(t))
      .replace(/(^|[^_\w])_(\S(?:.*?\S)?)_(?!\w)/g, (_, pre: string, t: string) => pre + c.italic(t))
      .replace(/~~(\S(?:.*?\S)?)~~/g, (_, t: string) => c.strike(t))
      // A link renders as its text; the URL is noise in a terminal report.
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, text: string, url: string) =>
        `${text} ${c.dim(c.gray(`(${url})`))}`
      )
  );
}

/**
 * Render inline Markdown: code spans first, emphasis only between them.
 *
 * The split keeps the delimiters in the array (a capturing group), so odd
 * indices are the code spans and even indices the prose around them.
 */
function inline(s: string): string {
  return s
    .split(/(`[^`]*`)/g)
    .map((part, i) =>
      i % 2 === 1 && part.length >= 2 ? c.cyan(part.slice(1, -1)) : emphasis(part)
    )
    .join("");
}

/** Heading colour by level: the deeper the heading, the quieter it gets. */
function heading(level: number, text: string): string {
  const body = inline(text);
  if (level === 1) return c.bold(c.brightCyan(body));
  if (level === 2) return c.bold(c.cyan(body));
  if (level === 3) return c.bold(body);
  return c.bold(c.gray(body));
}

/**
 * Line-buffered Markdown renderer.
 *
 * One instance per session. `write` returns only whole rendered lines and keeps
 * any trailing partial line for the next delta; `flush` emits that remainder at
 * the end of a turn.
 */
export class MarkdownStream {
  private buf = "";
  private inFence = false;

  /** Feed a raw token delta; returns text ready to write to stdout. */
  write(delta: string): string {
    if (!styled) return delta;

    this.buf += delta;
    let out = "";
    for (let nl = this.buf.indexOf("\n"); nl !== -1; nl = this.buf.indexOf("\n")) {
      out += this.renderLine(this.buf.slice(0, nl)) + "\n";
      this.buf = this.buf.slice(nl + 1);
    }
    return out;
  }

  /**
   * Emit whatever is still buffered and reset.
   *
   * Called at the end of a turn: a report that does not end in a newline would
   * otherwise leave its last line unrendered, and a stray unclosed fence would
   * swallow the whole of the next report as code.
   */
  flush(): string {
    if (!styled) return "";
    const rest = this.buf ? this.renderLine(this.buf) : "";
    this.buf = "";
    this.inFence = false;
    return rest;
  }

  private renderLine(line: string): string {
    if (FENCE.test(line)) {
      // The fence marker itself is never shown — the prompt asks for no fences,
      // so one appearing at all is a slip rather than intent.
      this.inFence = !this.inFence;
      return "";
    }
    // Inside a fence nothing is Markdown; dim it and pass it through verbatim.
    if (this.inFence) return c.dim(line);

    if (RULE.test(line)) return c.dim(c.gray("─".repeat(48)));

    const h = line.match(HEADING);
    if (h) return heading(h[1].length, h[2]);

    const q = line.match(QUOTE);
    if (q) return c.dim(c.gray("│ ")) + c.dim(inline(q[1]));

    const b = line.match(BULLET);
    if (b) return `${b[1]}${c.cyan("•")} ${inline(b[2])}`;

    const o = line.match(ORDERED);
    if (o) return `${o[1]}${c.cyan(o[2] + ".")} ${inline(o[3])}`;

    return inline(line);
  }
}
