// ============================================================
// Relic — Session 6 tests: EDGAR prior resolver + rate-limit queue
// ============================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolvePriorFiling,
  listPriorComparableFilings,
  resolvePriorFilingByAccession,
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

// A frequent filer pushes its prior 10-Ks out of `filings.recent` and into an
// older-filings continuation file while the current 10-K is still in `recent`.
// Shared by the continuation-paging, enumerate, and by-accession suites.
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

// ── enumerate + resolve-by-accession ─────────────────────────────────────────

/** Quarterly 10-Qs spanning Q2 2022 → Q2 2024 (current = Q2 2024). */
function tenQFixture(): string {
  return JSON.stringify({
    name: 'Quarterly Co.',
    cik: '2000000',
    filings: {
      recent: {
        accessionNumber: [
          '0002000000-24-000040', // 10-Q Q2 2024 (current)
          '0002000000-24-000030', // 10-Q Q1 2024 ← Auto prior
          '0002000000-23-000040', // 10-Q Q2 2023 ← yearsBack:1
          '0002000000-23-000030', // 10-Q Q1 2023
          '0002000000-22-000040', // 10-Q Q2 2022 ← yearsBack:2
        ],
        filingDate: ['2024-08-01', '2024-05-01', '2023-08-01', '2023-05-01', '2022-08-01'],
        reportDate: ['2024-06-30', '2024-03-31', '2023-06-30', '2023-03-31', '2022-06-30'],
        form: ['10-Q', '10-Q', '10-Q', '10-Q', '10-Q'],
        primaryDocument: [
          'q2-2024.htm',
          'q1-2024.htm',
          'q2-2023.htm',
          'q1-2023.htm',
          'q2-2022.htm',
        ],
      },
    },
  });
}

describe('listPriorComparableFilings', () => {
  it('lists earlier same-form filings, most recent first, excluding the current one', async () => {
    const list = await listPriorComparableFilings('2000000', '10-Q', '2024-06-30', {
      fetchText: async () => tenQFixture(),
    });
    // Q2 2024 (the current filing) is excluded; the four earlier 10-Qs remain, desc.
    expect(list.map((f) => f.reportDate)).toEqual([
      '2024-03-31',
      '2023-06-30',
      '2023-03-31',
      '2022-06-30',
    ]);
    expect(list[0]!.accessionNo).toBe('0002000000-24-000030');
    expect(list[0]!.url).toContain('q1-2024.htm');
  });

  it('caps the list to priors within the look-back window', async () => {
    // Current period 2024-06-30; withinYears 1 → cutoff 2023-06-30. Only the two
    // priors on/after the cutoff survive; 2023-03-31 and 2022-06-30 are dropped.
    const list = await listPriorComparableFilings('2000000', '10-Q', '2024-06-30', {
      fetchText: async () => tenQFixture(),
    }, { withinYears: 1 });
    expect(list.map((f) => f.reportDate)).toEqual(['2024-03-31', '2023-06-30']);
  });

  it('excludes amendments (exact-form match only)', async () => {
    const list = await listPriorComparableFilings('320193', '10-K', '2023-09-30', {
      fetchText: async () => fixtureJson(),
    });
    // FY2022 + FY2021 remain; the 10-K/A amendment is never included.
    expect(list.map((f) => f.accessionNo)).toEqual([
      '0000320193-22-000108',
      '0000320193-21-000105',
    ]);
    expect(list.some((f) => f.form === '10-K/A')).toBe(false);
  });

  it('excludes the current filing by accession when no period is available', async () => {
    const list = await listPriorComparableFilings('2000000', '10-Q', undefined, {
      fetchText: async () => tenQFixture(),
    }, { excludeAccessionNo: '0002000000-24-000040' });
    expect(list.some((f) => f.accessionNo === '0002000000-24-000040')).toBe(false);
    expect(list).toHaveLength(4);
  });

  it('pages through continuation files to reach older filings', async () => {
    const urls: string[] = [];
    const fetchText = async (url: string) => {
      urls.push(url);
      return url.includes('submissions-001') ? continuationJson() : recentWithContinuation();
    };
    const list = await listPriorComparableFilings('1000000', '10-K', '2024-09-28', { fetchText });
    // The current FY2024 lives in `recent`; FY2023 + FY2022 come from the continuation.
    expect(list.map((f) => f.reportDate)).toEqual(['2023-09-30', '2022-09-24']);
    expect(urls).toContain('https://data.sec.gov/submissions/CIK0001000000-submissions-001.json');
  });

  it('de-dupes filings that appear in both recent and a continuation', async () => {
    const main = JSON.stringify({
      name: 'Overlap Co.',
      cik: '3000000',
      filings: {
        recent: {
          accessionNumber: ['0003000000-24-000010', '0003000000-23-000010'],
          filingDate: ['2024-11-01', '2023-11-01'],
          reportDate: ['2024-09-30', '2023-09-30'],
          form: ['10-K', '10-K'],
          primaryDocument: ['oc-2024.htm', 'oc-2023.htm'],
        },
        files: [{ name: 'CIK0003000000-submissions-001.json' }],
      },
    });
    const cont = JSON.stringify({
      accessionNumber: ['0003000000-23-000010', '0003000000-22-000010'], // FY2023 repeats
      filingDate: ['2023-11-01', '2022-11-01'],
      reportDate: ['2023-09-30', '2022-09-30'],
      form: ['10-K', '10-K'],
      primaryDocument: ['oc-2023.htm', 'oc-2022.htm'],
    });
    const list = await listPriorComparableFilings('3000000', '10-K', '2024-09-30', {
      fetchText: async (url) => (url.includes('submissions-001') ? cont : main),
    });
    expect(list.map((f) => f.accessionNo)).toEqual([
      '0003000000-23-000010',
      '0003000000-22-000010',
    ]);
  });
});

describe('resolvePriorFilingByAccession', () => {
  it('returns the exact filing picked from recent', async () => {
    const prior = await resolvePriorFilingByAccession('2000000', '10-Q', '0002000000-22-000040', {
      fetchText: async () => tenQFixture(),
    });
    expect(prior).not.toBeNull();
    expect(prior!.reportDate).toBe('2022-06-30');
    expect(prior!.url).toContain('q2-2022.htm');
  });

  it('finds a filing that only exists in a continuation file', async () => {
    const fetchText = async (url: string) =>
      url.includes('submissions-001') ? continuationJson() : recentWithContinuation();
    const prior = await resolvePriorFilingByAccession('1000000', '10-K', '0001000000-22-000030', { fetchText });
    expect(prior!.reportDate).toBe('2022-09-24');
    expect(prior!.url).toContain('ff-20220924.htm');
  });

  it('returns null for an unknown or wrong-form accession', async () => {
    const miss = await resolvePriorFilingByAccession('2000000', '10-Q', 'nope-00-000000', {
      fetchText: async () => tenQFixture(),
    });
    expect(miss).toBeNull();
  });
});

describe('resolvePriorFiling continuation paging', () => {
  it('pages a second continuation file when the first lacks a prior', async () => {
    const main = JSON.stringify({
      name: 'Deep Filer Inc.',
      cik: '4000000',
      filings: {
        recent: {
          accessionNumber: ['0004000000-24-000001'], // only the current 10-K
          filingDate: ['2024-11-01'],
          reportDate: ['2024-09-30'],
          form: ['10-K'],
          primaryDocument: ['df-2024.htm'],
        },
        files: [
          { name: 'CIK0004000000-submissions-001.json' }, // no 10-K
          { name: 'CIK0004000000-submissions-002.json' }, // holds the prior 10-K
        ],
      },
    });
    const cont1 = JSON.stringify({
      accessionNumber: ['0004000000-24-000000'],
      filingDate: ['2024-06-01'],
      reportDate: ['2024-06-30'],
      form: ['8-K'], // wrong form — no prior 10-K here
      primaryDocument: ['df-8k.htm'],
    });
    const cont2 = JSON.stringify({
      accessionNumber: ['0004000000-23-000001'],
      filingDate: ['2023-11-01'],
      reportDate: ['2023-09-30'],
      form: ['10-K'],
      primaryDocument: ['df-2023.htm'],
    });
    const urls: string[] = [];
    const fetchText = async (url: string) => {
      urls.push(url);
      if (url.includes('submissions-002')) return cont2;
      if (url.includes('submissions-001')) return cont1;
      return main;
    };
    const prior = await resolvePriorFiling('4000000', '10-K', '2024-09-30', { fetchText });
    expect(prior!.reportDate).toBe('2023-09-30');
    expect(urls).toContain('https://data.sec.gov/submissions/CIK0004000000-submissions-002.json');
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
