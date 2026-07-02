import type { DocumentModel, LanguageFlag } from '@/types';

/** Normalize URLs so session recovery can match the active tab. */
export function normalizePageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href.replace(/\/$/, '');
  } catch {
    return url;
  }
}

export async function persistFilingToSession(
  model: DocumentModel,
  flags?: LanguageFlag[],
): Promise<void> {
  const hash = model.rawTextHash;

  // Evict prior filings before writing. A full DocumentModel for a large 10-K can
  // be several MB, and chrome.storage.session has a hard ~10 MB quota — without
  // eviction, a handful of filings in one browser session exhausts it and the
  // set() below (plus its retry path) fails identically. We only keep the filing
  // being written, so remove every filing:model:* / filing:flags:* key whose hash
  // differs. filing:current is left untouched (its semantics are unchanged).
  const keep = new Set([`filing:model:${hash}`, `filing:flags:${hash}`]);
  const existing = await chrome.storage.session.get(null);
  const stale = Object.keys(existing).filter(
    (k) =>
      (k.startsWith('filing:model:') || k.startsWith('filing:flags:')) && !keep.has(k),
  );
  if (stale.length > 0) await chrome.storage.session.remove(stale);

  const payload: Record<string, unknown> = {
    [`filing:model:${hash}`]: model,
    'filing:current': { url: model.source.url, hash },
  };
  if (flags) payload[`filing:flags:${hash}`] = flags;
  await chrome.storage.session.set(payload);
}

export async function loadFilingFromSession(): Promise<{
  model: DocumentModel | null;
  flags: LanguageFlag[] | null;
}> {
  const data = await chrome.storage.session.get('filing:current');
  const current = data['filing:current'] as { hash: string } | undefined;
  if (!current?.hash) return { model: null, flags: null };

  const hash = current.hash;
  const [modelData, flagData] = await Promise.all([
    chrome.storage.session.get(`filing:model:${hash}`),
    chrome.storage.session.get(`filing:flags:${hash}`),
  ]);

  return {
    model: (modelData[`filing:model:${hash}`] as DocumentModel | undefined) ?? null,
    flags: (flagData[`filing:flags:${hash}`] as LanguageFlag[] | undefined) ?? null,
  };
}
