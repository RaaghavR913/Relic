// ============================================================
// Relic — Session 6 tests: EDGAR prior resolver + rate-limit queue
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolvePriorFiling,
  submissionsUrl,
  buildArchiveUrl,
  padCik,
} from '../src/background/resolvePrior';
import { RateLimitedQueue, fetchEdgarText, clearEdgarCache } from '../src/background/edgarQueue';

// ── URL helpers ─────────────────────────────────────────────────────────────────

describe('URL helpers', () => {
  it('pads CIK to 10 digits', () => {
    expect(padCik('320193')).toBe('0000320193');
    expect(padCik(320193)).toBe('0000320193');
    expect(padCik('CIK0000320193')).toBe('0000320193');
  });

  it('builds the submissions URL', () => {
    expect(submissionsUrl('320193')).toBe('https://data.sec.gov/submissions/CIK0000320193.json');
  });

  it('builds the Archives primary-document URL (dashless accession, unpadded CIK)', () => {
    expect(buildArchiveUrl('320193', '0000320193-22-000108', 'aapl-20220924.htm')).toBe(
      'https://www.sec.gov/Archives/edgar/data/320193/000032019322000108/aapl-20220924.htm',
    );
  });
});

// ── submissions fixture ─────────────────────────────────────────────────────────

function fixtureJson(): string {
  return JSON.stringify({
    name: 'Apple Inc.',
    cik: '320193',
    filings: {
      recent: {
        accessionNumber: [
          '0000320193-23-000106', // 10-K FY2023
          '0000320193-23-000077', // 10-Q (noise)
          '0000320193-22-000108', // 10-K FY2022  ← prior comparable
          '0000320193-21-000105', // 10-K FY2021
          '0000320193-23-000005', // 10-K/A amendment (must be ignored)
        ],
        filingDate: ['2023-11-03', '2023-08-04', '2022-10-28', '2021-10-29', '2023-02-10'],
        reportDate: ['2023-09-30', '2023-07-01', '2022-09-24', '2021-09-25', '2022-09-24'],
        form: ['10-K', '10-Q', '10-K', '10-K', '10-K/A'],
        primaryDocument: [
          'aapl-20230930.htm',
          'aapl-20230701.htm',
          'aapl-20220924.htm',
          'aapl-20210925.htm',
          'aapl-amend.htm',
        ],
      },
    },
  });
}

describe('resolvePriorFiling', () => {
  it('finds the most recent earlier 10-K relative to periodOfReport', async () => {
    const fetchText = async () => fixtureJson();
    const prior = await resolvePriorFiling('320193', '10-K', '2023-09-30', { fetchText });
    expect(prior).not.toBeNull();
    expect(prior!.accessionNo).toBe('0000320193-22-000108');
    expect(prior!.reportDate).toBe('2022-09-24');
    expect(prior!.form).toBe('10-K');
    expect(prior!.url).toContain('000032019322000108/aapl-20220924.htm');
    expect(prior!.companyName).toBe('Apple Inc.');
  });

  it('ignores 10-K/A amendments when matching the form', async () => {
    const fetchText = async () => fixtureJson();
    const prior = await resolvePriorFiling('320193', '10-K', '2023-09-30', { fetchText });
    expect(prior!.accessionNo).not.toBe('0000320193-23-000005');
  });

  it('falls back to the second filing when periodOfReport is unknown', async () => {
    const fetchText = async () => fixtureJson();
    const prior = await resolvePriorFiling('320193', '10-K', undefined, { fetchText });
    // Sorted by reportDate desc: FY2023 (current), then FY2022.
    expect(prior!.reportDate).toBe('2022-09-24');
  });

  it('returns null when no earlier filing of the same form exists', async () => {
    const oneOnly = JSON.stringify({
      name: 'NewCo',
      filings: {
        recent: {
          accessionNumber: ['0001000000-24-000001'],
          filingDate: ['2024-03-01'],
          reportDate: ['2023-12-31'],
          form: ['10-K'],
          primaryDocument: ['newco-2023.htm'],
        },
      },
    });
    const prior = await resolvePriorFiling('1000000', '10-K', '2023-12-31', {
      fetchText: async () => oneOnly,
    });
    expect(prior).toBeNull();
  });

  it('returns null when the company has no matching form at all', async () => {
    const prior = await resolvePriorFiling('320193', 'S-1', '2023-09-30', {
      fetchText: async () => fixtureJson(),
    });
    expect(prior).toBeNull();
  });

  // ── Continuation (filings.files) pagination ─────────────────────────────────
  // A company that files frequently can push its prior 10-K out of
  // `filings.recent` and into an older-filings continuation file while the
  // current 10-K is still in `recent`.

  // recent holds only the CURRENT 10-K (FY2024); the prior comparables live in
  // the continuation file referenced by filings.files[0].
  function recentWithContinuation(): string {
    return JSON.stringify({
      name: 'Frequent Filer Inc.',
      cik: '1000000',
      filings: {
        recent: {
          accessionNumber: ['0001000000-24-000050'],
          filingDate: ['2024-11-01'],
          reportDate: ['2024-09-28'],
          form: ['10-K'],
          primaryDocument: ['ff-20240928.htm'],
        },
        files: [{ name: 'CIK0001000000-submissions-001.json' }],
      },
    });
  }

  function continuationJson(): string {
    return JSON.stringify({
      accessionNumber: ['0001000000-23-000040', '0001000000-22-000030'],
      filingDate: ['2023-10-30', '2022-10-28'],
      reportDate: ['2023-09-30', '2022-09-24'],
      form: ['10-K', '10-K'],
      primaryDocument: ['ff-20230930.htm', 'ff-20220924.htm'],
    });
  }

  it('resolves the prior from filings.files when recent has aged out the prior', async () => {
    const urls: string[] = [];
    const fetchText = async (url: string) => {
      urls.push(url);
      return url.includes('submissions-001') ? continuationJson() : recentWithContinuation();
    };

    const prior = await resolvePriorFiling('1000000', '10-K', '2024-09-28', { fetchText });

    expect(prior).not.toBeNull();
    expect(prior!.accessionNo).toBe('0001000000-23-000040'); // FY2023, most recent earlier
    expect(prior!.reportDate).toBe('2023-09-30');
    // The continuation fetch went through the same injected (rate-limited) fetchText.
    expect(urls).toContain('https://data.sec.gov/submissions/CIK0001000000-submissions-001.json');
    expect(urls).toHaveLength(2);
  });

  it('does not fetch a continuation when recent already yields a prior', async () => {
    const urls: string[] = [];
    const fetchText = async (url: string) => {
      urls.push(url);
      return fixtureJson(); // has both current + prior 10-K in recent
    };
    const prior = await resolvePriorFiling('320193', '10-K', '2023-09-30', { fetchText });
    expect(prior!.accessionNo).toBe('0000320193-22-000108');
    expect(urls).toHaveLength(1); // no continuation fetch
  });

  it('returns null when neither recent nor the continuation has a prior', async () => {
    const mainJson = JSON.stringify({
      name: 'NewCo',
      filings: {
        recent: {
          accessionNumber: ['0001000000-24-000001'],
          filingDate: ['2024-03-01'],
          reportDate: ['2023-12-31'],
          form: ['10-K'],
          primaryDocument: ['newco-2023.htm'],
        },
        files: [{ name: 'CIK0001000000-submissions-001.json' }],
      },
    });
    const emptyContinuation = JSON.stringify({
      accessionNumber: [],
      filingDate: [],
      reportDate: [],
      form: [],
      primaryDocument: [],
    });
    const prior = await resolvePriorFiling('1000000', '10-K', '2023-12-31', {
      fetchText: async (url) =>
        url.includes('submissions-001') ? emptyContinuation : mainJson,
    });
    expect(prior).toBeNull();
  });

  // L4: `filings.recent` entirely ABSENT (not merely no-match). The prior lives
  // only in the continuation file — the resolver must still page into it rather
  // than returning null on the missing `recent`.
  it('falls through to the continuation when filings.recent is absent entirely', async () => {
    const noRecent = JSON.stringify({
      name: 'Paged Filer Inc.',
      cik: '1000000',
      filings: {
        // no `recent` key at all
        files: [{ name: 'CIK0001000000-submissions-001.json' }],
      },
    });
    const urls: string[] = [];
    const fetchText = async (url: string) => {
      urls.push(url);
      return url.includes('submissions-001') ? continuationJson() : noRecent;
    };

    const prior = await resolvePriorFiling('1000000', '10-K', '2024-09-28', { fetchText });

    expect(prior).not.toBeNull();
    expect(prior!.accessionNo).toBe('0001000000-23-000040'); // FY2023 from the continuation
    expect(prior!.reportDate).toBe('2023-09-30');
    // The continuation was fetched through the same injected (rate-limited) fetchText.
    expect(urls).toContain('https://data.sec.gov/submissions/CIK0001000000-submissions-001.json');
  });
});

// ── RateLimitedQueue ─────────────────────────────────────────────────────────────

describe('RateLimitedQueue', () => {
  it('spaces requests at ≥125ms (≤8 req/s)', async () => {
    const queue = new RateLimitedQueue({ maxPerSecond: 8 });
    expect(queue.spacingMs).toBe(125);

    const starts: number[] = [];
    const tasks = Array.from({ length: 5 }, () =>
      queue.schedule(async () => {
        starts.push(Date.now());
        return 0;
      }),
    );
    await Promise.all(tasks);

    expect(starts).toHaveLength(5);
    for (let i = 1; i < starts.length; i++) {
      // Allow a small scheduler slop below the nominal 125ms.
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(110);
    }
  });

  it('keeps running after a task rejects', async () => {
    const queue = new RateLimitedQueue({ maxPerSecond: 50 });
    const bad = queue.schedule(async () => {
      throw new Error('boom');
    });
    await expect(bad).rejects.toThrow('boom');
    const good = await queue.schedule(async () => 42);
    expect(good).toBe(42);
  });
});

// ── fetchEdgarText: backoff + cache ──────────────────────────────────────────────

function makeResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return {
    status,
    statusText: String(status),
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: async () => body,
  } as unknown as Response;
}

describe('fetchEdgarText', () => {
  beforeEach(() => clearEdgarCache());

  it('retries on 403 then succeeds (exponential backoff)', async () => {
    const queue = new RateLimitedQueue({ maxPerSecond: 1000 });
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls < 3) return makeResponse(403, 'denied');
      return makeResponse(200, 'OK-BODY');
    }) as unknown as typeof fetch;

    const body = await fetchEdgarText('https://data.sec.gov/x.json', {
      queue,
      fetchImpl,
      baseBackoffMs: 1, // keep the test fast
      maxRetries: 5,
    });
    expect(body).toBe('OK-BODY');
    expect(calls).toBe(3);
  });

  it('throws after exhausting retries on persistent 429', async () => {
    const queue = new RateLimitedQueue({ maxPerSecond: 1000 });
    const fetchImpl = (async () => makeResponse(429, 'slow down')) as unknown as typeof fetch;
    await expect(
      fetchEdgarText('https://data.sec.gov/y.json', {
        queue,
        fetchImpl,
        baseBackoffMs: 1,
        maxRetries: 2,
      }),
    ).rejects.toThrow(/429/);
  });

  it('serves the second request from cache (one network call)', async () => {
    const queue = new RateLimitedQueue({ maxPerSecond: 1000 });
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return makeResponse(200, 'CACHED');
    }) as unknown as typeof fetch;

    const url = 'https://data.sec.gov/z.json';
    const a = await fetchEdgarText(url, { queue, fetchImpl });
    const b = await fetchEdgarText(url, { queue, fetchImpl });
    expect(a).toBe('CACHED');
    expect(b).toBe('CACHED');
    expect(calls).toBe(1);
  });

  // ── Redline cancellation: the AbortSignal threads SW → fetchEdgarText → fetch ──

  it('aborts an in-flight request when the injected signal fires (redline cancel)', async () => {
    const queue = new RateLimitedQueue({ maxPerSecond: 1000 });
    const ac = new AbortController();

    // Never settles on its own — only when the signal aborts, mirroring how the
    // real fetch() rejects a pending request. Proves the signal is forwarded into
    // fetchImpl's init and that the rejection propagates out through the queue.
    const fetchImpl = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
        signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      })) as unknown as typeof fetch;

    const p = fetchEdgarText('https://data.sec.gov/pending.json', {
      queue,
      fetchImpl,
      signal: ac.signal,
    });
    ac.abort();
    await expect(p).rejects.toThrow(/abort/i);
  });

  it('propagates an already-aborted signal without retrying', async () => {
    const queue = new RateLimitedQueue({ maxPerSecond: 1000 });
    const ac = new AbortController();
    ac.abort();

    let calls = 0;
    const fetchImpl = ((_url: string, init?: { signal?: AbortSignal }) => {
      calls++;
      if (init?.signal?.aborted) {
        return Promise.reject(new DOMException('Aborted', 'AbortError'));
      }
      return Promise.resolve(makeResponse(200, 'OK'));
    }) as unknown as typeof fetch;

    await expect(
      fetchEdgarText('https://data.sec.gov/already.json', {
        queue,
        fetchImpl,
        signal: ac.signal,
        baseBackoffMs: 1,
      }),
    ).rejects.toThrow(/abort/i);
    // An AbortError is not a 403/429, so the retry loop must not spin.
    expect(calls).toBe(1);
  });
});

// ── regression: non-ISO periodOfReport ──────────────────────────────────────
//
// Inline XBRL renders dei:DocumentPeriodEndDate as DISPLAY text — the real Apple
// FY2023 10-K yields "September 30, 2023", not "2023-09-30". selectPrior compared
// periodOfReport.slice(0,10) against ISO reportDates, so the target became
// "September " and EVERY ISO date compared less than it (digits sort before 'S').
// .find() therefore returned index 0 — the NEWEST filing — and when the user was
// viewing the newest filing it returned that same filing, redlining it against
// itself. Observed live against the real EDGAR submissions feed.
describe('resolvePriorFiling — non-ISO periodOfReport (regression)', () => {
  it('normalizes a human-readable period and still picks the earlier filing', async () => {
    const fetchText = async () => fixtureJson();
    const prior = await resolvePriorFiling('320193', '10-K', 'September 30, 2023', { fetchText });
    expect(prior).not.toBeNull();
    // FY2022, not FY2023 (itself) and not some later filing.
    expect(prior!.reportDate).toBe('2022-09-24');
    expect(prior!.accessionNo).toBe('0000320193-22-000108');
  });

  it('never returns the filing being viewed', async () => {
    const fetchText = async () => fixtureJson();
    for (const period of ['September 30, 2023', '2023-09-30']) {
      const prior = await resolvePriorFiling('320193', '10-K', period, { fetchText });
      expect(prior!.reportDate).not.toBe('2023-09-30');
      expect(prior!.accessionNo).not.toBe('0000320193-23-000106');
    }
  });

  it('matches the ISO result exactly for the equivalent human date', async () => {
    const fetchText = async () => fixtureJson();
    const human = await resolvePriorFiling('320193', '10-K', 'September 30, 2023', { fetchText });
    const iso = await resolvePriorFiling('320193', '10-K', '2023-09-30', { fetchText });
    expect(human!.accessionNo).toBe(iso!.accessionNo);
  });

  it('falls back to index 1 when the period is truly unparseable', async () => {
    const fetchText = async () => fixtureJson();
    const prior = await resolvePriorFiling('320193', '10-K', 'not a date', { fetchText });
    // Unknown period → assume index 0 is current, index 1 is prior.
    expect(prior!.reportDate).toBe('2022-09-24');
  });
});
