/**
 * Tests for the on-demand content-readiness gate (src/content/ingest/ready.ts).
 *
 * jsdom doesn't implement innerText, so currentTextLength falls back to
 * textContent — which is what these tests drive. Real timers + tiny durations
 * keep the suite fast and avoid fake-timer/MutationObserver interaction quirks.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { waitForContent, currentTextLength } from '../src/content/ingest/ready';

afterEach(() => {
  document.body.innerHTML = '';
});

function fill(chars: number): void {
  document.body.innerHTML = `<p>${'x'.repeat(chars)}</p>`;
}

describe('waitForContent', () => {
  it('resolves immediately when enough text is already present', async () => {
    fill(400);
    const start = Date.now();
    await waitForContent({ minChars: 100, settleMs: 30, maxWaitMs: 3000 });
    expect(Date.now() - start).toBeLessThan(50); // fast path, no waiting
  });

  it('waits, then resolves once content is injected after load (SPA case)', async () => {
    fill(20); // below threshold at "injection" time
    const start = Date.now();
    const p = waitForContent({ minChars: 100, settleMs: 30, maxWaitMs: 3000 });

    // Simulate the SPA streaming its article body in after a tick.
    setTimeout(() => fill(400), 40);

    await p;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40); // it actually waited for content
    expect(elapsed).toBeLessThan(3000); // resolved on content, not the cap
    expect(currentTextLength()).toBeGreaterThanOrEqual(100);
  });

  it('resolves at the cap when content never appears (never hangs)', async () => {
    fill(20);
    const start = Date.now();
    await waitForContent({ minChars: 1_000_000, settleMs: 30, maxWaitMs: 120 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(100); // waited ~the cap
    expect(elapsed).toBeLessThan(1500); // but still resolved promptly after it
  });
});
