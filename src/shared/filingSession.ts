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
  const payload: Record<string, unknown> = {
    [`filing:model:${model.rawTextHash}`]: model,
    'filing:current': { url: model.source.url, hash: model.rawTextHash },
  };
  if (flags) payload[`filing:flags:${model.rawTextHash}`] = flags;
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
