/**
 * TTL cache with in-flight de-duplication, for the network payloads behind the tools.
 *
 * Several tools need the same upstream data — SEC companyfacts is read by
 * get_financials, get_financial_history, get_price_data and get_business_phase —
 * and the model calls those repeatedly across a session's reports. Uncached, one
 * pass over a single ticker downloaded the same 3.7 MB companyfacts document four
 * times. Keying on the payload rather than the tool means every caller shares one
 * fetch, whatever order the model asks for things in.
 *
 * De-duplicating in-flight requests matters as much as the TTL: tool calls can
 * overlap, and without it two concurrent callers each start their own download
 * before either has a result to cache.
 */

type Entry<T> = { value: T; expires: number };

export interface AsyncCache<T> {
  /** Return the cached value for `key`, else run `load` and cache what it resolves to. */
  get(key: string, load: () => Promise<T>): Promise<T>;
  /** Drop everything. Exposed for tests. */
  clear(): void;
  /** Current entry count, excluding in-flight loads. Exposed for tests. */
  readonly size: number;
}

export function createCache<T>(options: {
  /** How long a value stays fresh. */
  ttlMs: number;
  /** Cap on stored entries; the oldest insertion is evicted past this. */
  maxEntries: number;
}): AsyncCache<T> {
  const { ttlMs, maxEntries } = options;
  // Insertion-ordered, so the first key is the oldest — enough for a cache this size.
  const entries = new Map<string, Entry<T>>();
  const inFlight = new Map<string, Promise<T>>();

  return {
    get(key: string, load: () => Promise<T>): Promise<T> {
      const hit = entries.get(key);
      if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
      if (hit) entries.delete(key); // expired

      const pending = inFlight.get(key);
      if (pending) return pending;

      const promise = load()
        .then((value) => {
          entries.set(key, { value, expires: Date.now() + ttlMs });
          if (entries.size > maxEntries) {
            const oldest = entries.keys().next();
            if (!oldest.done) entries.delete(oldest.value);
          }
          return value;
        })
        .finally(() => {
          // Always clear the in-flight slot: a rejection must not be cached, and a
          // later call should be free to retry.
          inFlight.delete(key);
        });

      inFlight.set(key, promise);
      return promise;
    },

    clear(): void {
      entries.clear();
      inFlight.clear();
    },

    get size(): number {
      return entries.size;
    },
  };
}
