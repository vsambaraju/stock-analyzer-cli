/**
 * Single-line activity indicator for the gaps where the CLI has nothing to print.
 *
 * There are two of them: after a prompt is sent, while the model thinks before the
 * first token arrives, and while a tool call is running. Both used to look like the
 * app had hung.
 *
 * It renders to stderr, so piping stdout to a file still yields clean report text,
 * and it disables itself when stderr is not a TTY (no control codes in logs).
 *
 * Anything that writes to the terminal must call `clear()` first, or the spinner's
 * leftover frame is left sitting in the middle of the output. `write()` does that
 * for you; prefer it over touching the streams directly while a spinner may be up.
 */

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;

export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private label = "";
  private rendered = false;
  private readonly enabled: boolean;

  constructor(private readonly stream: NodeJS.WriteStream = process.stderr) {
    this.enabled = Boolean(stream.isTTY) && !process.env.NO_COLOR;
  }

  /** Show (or relabel) the spinner. Safe to call when already running. */
  start(label: string): void {
    if (!this.enabled) return;
    this.label = label;
    if (this.timer) return;
    this.render();
    this.timer = setInterval(() => this.render(), INTERVAL_MS);
    // Never hold the process open just to animate.
    this.timer.unref?.();
  }

  /** Stop and erase the spinner. Safe to call when not running. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clear();
    this.label = "";
  }

  /** Erase the current frame in place, leaving the spinner's state alone. */
  clear(): void {
    if (!this.rendered) return;
    this.stream.write("\r\x1b[K");
    this.rendered = false;
  }

  /** True while a frame is being animated. */
  get active(): boolean {
    return this.timer !== null;
  }

  /**
   * Write to a stream without leaving a stale frame behind. The spinner keeps
   * running afterwards, so a caller that is done waiting should stop() instead.
   */
  write(stream: NodeJS.WriteStream, text: string): void {
    this.clear();
    stream.write(text);
    if (this.timer) this.render();
  }

  private render(): void {
    const frame = FRAMES[this.frame % FRAMES.length];
    this.frame++;
    // \x1b[K clears any longer previous label still on the line.
    this.stream.write(`\r\x1b[2m${frame} ${this.label}\x1b[0m\x1b[K`);
    this.rendered = true;
  }
}
