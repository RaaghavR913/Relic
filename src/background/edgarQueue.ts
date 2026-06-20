// ============================================================
// Disclora — EDGAR fetch queue (Session 6)
// ------------------------------------------------------------
// Lives in the service worker. Two responsibilities:
//   1. RateLimitedQueue: serialize all EDGAR requests with ≥125 ms spacing so we
//      never exceed ~8 req/s (SEC's fair-access ceiling is 10/s).
//   2. fetchEdgarText: ride the queue, retry 403/429 with exponential backoff +
//      jitter, and cache successful bodies in-memory for the SW's lifetime.
//
// NOTE: browsers forbid setting the User-Agent header from fetch(), so EDGAR sees
// the normal Chrome UA. That is expected for a user-initiated extension request;
// occasional 403/429 throttling is handled by the backoff below.
// ============================================================

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface QueueOptions {
  /** Requests per second ceiling. Default 8. */
  maxPerSecond?: number;
}

/**
 * Serializes scheduled async functions so that successive runs start at least
 * `interval` ms apart. A single in-flight chain guarantees no burst, regardless
 * of how many callers schedule concurrently.
 */
export class RateLimitedQueue {
  private readonly interval: number;
  private last = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: QueueOptions = {}) {
    const rps = opts.maxPerSecond ?? 8;
    this.interval = Math.ceil(1000 / rps);
  }

  /** Spacing between requests, in ms (exposed for tests/diagnostics). */
  get spacingMs(): number {
    return this.interval;
  }

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const now = Date.now();
      const wait = this.last + this.interval - now;
      if (wait > 0) await delay(wait);
      this.last = Date.now();
      return fn();
    });
    // Keep the chain alive even if this run rejects.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run as Promise<T>;
  }
}

export interface FetchEdgarOptions {
  queue: RateLimitedQueue;
  /** Injectable fetch (defaults to globalThis.fetch) — lets tests stub network. */
  fetchImpl?: typeof fetch;
  /** Max 403/429 retries before giving up. Default 4. */
  maxRetries?: number;
  /** Base backoff in ms (doubles each retry). Default 600. */
  baseBackoffMs?: number;
  /** TTL for the in-memory body cache, ms. Default 30 min. */
  cacheTtlMs?: number;
  signal?: AbortSignal;
}

interface CacheEntry {
  ts: number;
  body: string;
}

const _bodyCache = new Map<string, CacheEntry>();

/** Clear the in-memory EDGAR cache (tests / manual purge). */
export function clearEdgarCache(): void {
  _bodyCache.clear();
}

/**
 * Fetch a text/JSON resource from EDGAR through the rate-limit queue, with
 * exponential backoff on 403/429 and an in-memory cache keyed by URL.
 */
export async function fetchEdgarText(url: string, opts: FetchEdgarOptions): Promise<string> {
  const {
    queue,
    fetchImpl = globalThis.fetch.bind(globalThis),
    maxRetries = 4,
    baseBackoffMs = 600,
    cacheTtlMs = 30 * 60 * 1000,
  } = opts;

  const cached = _bodyCache.get(url);
  if (cached && Date.now() - cached.ts < cacheTtlMs) {
    return cached.body;
  }

  let attempt = 0;
  // Loop until success or retries exhausted.
  for (;;) {
    const res = await queue.schedule(() =>
      fetchImpl(url, {
        headers: { Accept: 'application/json, text/html, */*' },
        ...(opts.signal ? { signal: opts.signal } : {}),
      }),
    );

    if (res.status === 403 || res.status === 429) {
      if (attempt >= maxRetries) {
        throw new Error(`EDGAR ${res.status} for ${url} after ${attempt} retries`);
      }
      // Honor Retry-After when present, else exponential backoff + jitter.
      const retryAfter = Number(res.headers.get('retry-after'));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : baseBackoffMs * 2 ** attempt + Math.random() * 250;
      attempt++;
      await delay(backoff);
      continue;
    }

    if (!res.ok) {
      throw new Error(`EDGAR ${res.status} ${res.statusText} for ${url}`);
    }

    const body = await res.text();
    _bodyCache.set(url, { ts: Date.now(), body });
    return body;
  }
}
