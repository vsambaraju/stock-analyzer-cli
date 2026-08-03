/**
 * Line-buffered console reader.
 *
 * A persistent `line` listener captures every line the user enters — including
 * lines typed while a report is still streaming (type-ahead) — so none are lost
 * to readline's flowing mode. `next()` returns a queued line immediately (no
 * prompt reprinted) or prints the prompt and waits for the next line.
 */

import type { Interface as ReadlineInterface } from "readline/promises";

export class LineReader {
  private queue: string[] = [];
  private waiter: ((line: string) => void) | null = null;

  constructor(private readonly rl: ReadlineInterface) {
    rl.on("line", (line: string) => {
      if (this.waiter) {
        const resolve = this.waiter;
        this.waiter = null;
        resolve(line);
      } else {
        this.queue.push(line);
      }
    });
  }

  /** True if there is buffered type-ahead waiting to be consumed. */
  get hasPending(): boolean {
    return this.queue.length > 0;
  }

  /**
   * Return the next line of input. If the user typed ahead, the buffered line is
   * returned immediately without reprinting the prompt; otherwise the prompt is
   * shown and we wait for input.
   */
  async next(prompt: string): Promise<string> {
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;

    this.rl.setPrompt(prompt);
    this.rl.prompt();
    return new Promise<string>((resolve) => {
      this.waiter = resolve;
    });
  }
}
