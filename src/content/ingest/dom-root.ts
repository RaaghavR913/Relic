/**
 * DOM root selection for Disclora ingestion.
 *
 * EDGAR renders filings inside <iframe> elements; this module picks the
 * same-origin document whose body has the most text content, which is
 * almost always the actual filing HTML.
 */

export interface FilingRoot {
  document: Document;
  root: Element;
}

const MIN_TEXT_LEN = 200;

export function pickFilingRoot(doc: Document = document): FilingRoot {
  const baseLen = bodyTextLen(doc);
  let best = { document: doc, root: (doc.body ?? doc.documentElement) as Element, len: baseLen };

  for (const iframe of Array.from(doc.querySelectorAll('iframe'))) {
    try {
      const childDoc = (iframe as HTMLIFrameElement).contentDocument;
      if (!childDoc) continue;
      const len = bodyTextLen(childDoc);
      if (len > best.len) {
        best = {
          document: childDoc,
          root: (childDoc.body ?? childDoc.documentElement) as Element,
          len,
        };
      }
    } catch {
      // cross-origin frame — expected, skip
    }
  }

  if (best.len < MIN_TEXT_LEN) {
    return { document: doc, root: (doc.body ?? doc.documentElement) as Element };
  }

  return { document: best.document, root: best.root };
}

function bodyTextLen(doc: Document): number {
  const body = doc.body;
  if (!body) return 0;
  return (body as HTMLElement).innerText?.length ?? body.textContent?.length ?? 0;
}
