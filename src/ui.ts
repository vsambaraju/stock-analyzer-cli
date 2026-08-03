/**
 * Terminal color helpers. Colors are disabled automatically when output is not
 * a TTY or when NO_COLOR is set, so redirected/piped output stays clean.
 */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  reset: "\x1b[0m",
  bold: wrap("1"),
  dim: wrap("2"),
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
