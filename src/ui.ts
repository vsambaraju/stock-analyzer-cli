/**
 * Terminal color helpers. Colors are disabled automatically when output is not
 * a TTY or when NO_COLOR is set, so redirected/piped output stays clean.
 */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

/**
 * Whether styled output is on at all.
 *
 * The Markdown renderer keys off this rather than testing the TTY itself: with
 * colour disabled it has no way to *show* emphasis, so stripping the `**` markers
 * would lose information instead of rendering it. Piped output stays raw
 * Markdown, which is what a redirect into a .md file wants anyway.
 */
export const styled = useColor;

export const c = {
  reset: "\x1b[0m",
  bold: wrap("1"),
  dim: wrap("2"),
  italic: wrap("3"),
  strike: wrap("9"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
  gray: wrap("90"),
  brightGreen: wrap("92"),
  brightCyan: wrap("96"),
};
