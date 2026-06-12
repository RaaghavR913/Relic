/**
 * waitForContent — same-origin iframe content timing (inline-XBRL viewer fix).
 *
 * The SEC inline-XBRL viewer renders the real filing into a same-origin child
 * iframe AFTER document_idle. A MutationObserver on the top document never sees
 * those child mutations, so a premature snapshot captured only the shell. These
 * tests pin that waitForContent now observes the child frame and resolves once
 * the filing body streams in — well before the hard cap, not at it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { waitForContent } from '@/content/ingest/ready';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('waitForContent — same-origin iframe content', () => {
  it('resolves once a child iframe streams in enough text (not at the cap)', async () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const cdoc = iframe.contentDocument!;
    expect(cdoc).toBeTruthy();

    const started = Date.now();
    const done = waitForContent({ doc: document, minChars: 300, settleMs: 40, maxWaitMs: 3000 });

    // Stream the filing body into the child frame after a tick (the viewer pattern).
    await new Promise((r) => setTimeout(r, 20));
    cdoc.body.innerHTML =
      '<p>' + 'The registrant reported strong operating results this period. '.repeat(40) + '</p>';

    await done;
    // Resolved via detection (observer/poll), comfortably before the 3s cap.
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('resolves immediately (fast path) when the parent already has enough text', async () => {
    document.body.innerHTML = '<p>' + 'x'.repeat(800) + '</p>';
    const started = Date.now();
    await waitForContent({ doc: document, minChars: 300, settleMs: 40, maxWaitMs: 3000 });
    expect(Date.now() - started).toBeLessThan(60);
  });
});
