/**
 * Readable-page extractor for sec.gov data/research/info pages (and EDGAR
 * search/profile pages) — anything that is a readable document but NOT a company
 * filing. Instead of filing item-regexes, it segments by DOM headings (h1–h3),
 * which is how these pages are actually structured, and names the document by its
 * H1/title rather than a (nonexistent) registrant.
 *
 * Segmentation is anchored through the PositionMap so each section's charRange
 * maps back into the same normalized text every overlay uses.
 */

import type { PositionMap, Section } from '../../types/index.js';

const HEADING_SELECTOR = 'h1, h2, h3';
/** A heading line longer than this is almost certainly body text, not a header. */
const MAX_HEADING_LEN = 160;

/** First descendant Text node with non-whitespace content. */
function firstTextNode(el: Element): Text | null {
  const walker = el.ownerDocument!.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if ((n.textContent ?? '').trim().length > 0) return n as Text;
  }
  return null;
}

/** Map a heading element to its start offset in positionMap.text, or null. */
function headingOffset(el: Element, pm: PositionMap): number | null {
  const tn = firstTextNode(el);
  if (!tn) return null;
  return pm.fromNode(tn, 0);
}

function slug(label: string, idx: number): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return `report_${idx}_${base || 'section'}`;
}

function attachTables(
  section: Section,
  tableRanges: ReadonlyArray<[number, number]>,
): Section {
  const [start, end] = section.charRange;
  const overlapping = tableRanges.filter(([ts, te]) => ts < end && te > start);
  if (overlapping.length > 0) {
    section.tables = overlapping.map(([ts, te]) => [ts, te] as [number, number]);
  }
  return section;
}

/** A single whole-document section (used when no usable headings exist). */
export function wholeDocumentSection(
  text: string,
  tableRanges: ReadonlyArray<[number, number]>,
): Section[] {
  if (text.trim().length === 0) return [];
  return [
    attachTables(
      {
        id: 'document_body',
        label: 'Document',
        order: 1,
        text: text.trim(),
        charRange: [0, text.length],
      },
      tableRanges,
    ),
  ];
}

/**
 * Segment a readable page by its DOM headings. Returns sections in document order;
 * falls back to a single whole-document section when the page has no usable
 * headings (so a readable page is never reduced to a misleading partial section).
 */
export function segmentByHeadings(
  root: Element | Document,
  pm: PositionMap,
  tableRanges: ReadonlyArray<[number, number]>,
): Section[] {
  const text = pm.text;
  const scope: ParentNode = (root as Document).body ?? (root as Element);
  const headings = Array.from(scope.querySelectorAll(HEADING_SELECTOR));

  type Anchor = { label: string; offset: number };
  const anchors: Anchor[] = [];
  for (const h of headings) {
    const label = (h.textContent ?? '').trim().replace(/\s+/g, ' ');
    if (!label || label.length > MAX_HEADING_LEN) continue;
    const offset = headingOffset(h, pm);
    if (offset === null) continue;
    anchors.push({ label, offset });
  }

  anchors.sort((a, b) => a.offset - b.offset);

  // No headings (or none mappable) → don't pretend; emit the whole document.
  if (anchors.length === 0) return wholeDocumentSection(text, tableRanges);

  const sections: Section[] = [];

  // Preamble before the first heading, if substantial.
  const firstStart = anchors[0]!.offset;
  if (firstStart > 0) {
    const pre = text.slice(0, firstStart).trim();
    if (pre.length >= 40) {
      sections.push(
        attachTables(
          { id: 'report_0_overview', label: 'Overview', order: 0, text: pre, charRange: [0, firstStart] },
          tableRanges,
        ),
      );
    }
  }

  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]!;
    const contentEnd = anchors[i + 1]?.offset ?? text.length;
    if (a.offset >= contentEnd) continue;
    const sectionText = text.slice(a.offset, contentEnd).trim();
    if (sectionText.length === 0) continue;
    sections.push(
      attachTables(
        {
          id: slug(a.label, i + 1),
          label: a.label,
          order: i + 1,
          text: sectionText,
          charRange: [a.offset, contentEnd],
        },
        tableRanges,
      ),
    );
  }

  return sections.length > 0 ? sections : wholeDocumentSection(text, tableRanges);
}

/**
 * Pick a human document name for a readable page: prefer the first H1, then a
 * cleaned <title>. Returns undefined when nothing usable exists.
 */
export function readablePageName(doc: Document): string | undefined {
  const h1 = doc.querySelector('h1')?.textContent?.trim().replace(/\s+/g, ' ');
  if (h1 && h1.length >= 3 && h1.length <= 160) return h1;

  const title = doc.title?.trim();
  if (!title) return undefined;
  // Drop a trailing "| SEC.gov"-style site suffix.
  const cleaned = title.split(/\s*[|–—]\s*/)[0]?.trim();
  return cleaned && cleaned.length >= 3 ? cleaned : title;
}
