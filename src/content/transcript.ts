/**
 * Transcript detection and segmentation.
 *
 * Earnings call transcripts follow a well-known structure:
 *   Prepared remarks section (executives present):
 *     [Operator intro]  [Presenter names + blocks of text]
 *   Q&A section:
 *     [Operator: "We will now take questions"]
 *     [Q - Analyst Name, Firm Name] [question text]
 *     [A - Executive Name, Title]   [answer text]
 *
 * segmentTranscript() produces Section[] with canonical IDs:
 *   'transcript_prepared_remarks'          — everything before Q&A
 *   'transcript_qa_start'                  — the Q&A intro paragraph
 *   'transcript_qa_{n}_{analyst_slug}'     — each question block
 *   'transcript_qa_{n}_{exec_slug}_answer' — each answer block
 *
 * isTranscript() provides a quick heuristic to detect transcripts before
 * full segmentation.
 */

import type { Section } from '../types/index.js';

// ── detection ─────────────────────────────────────────────────────────────────

/**
 * Quick heuristic: is this document most likely an earnings call transcript?
 * Checks the first 6 000 chars of the normalized text.
 */
export function isTranscript(text: string): boolean {
  const head = text.slice(0, 6000);
  let score = 0;

  // Strong signals
  if (/\bOPERATOR\b/m.test(head)) score += 3;
  if (/\bEARNINGS CALL\b|\bEARNINGS CONFERENCE CALL\b/im.test(head)) score += 3;
  if (/\bQ\s*[-–&]\s+[A-Z][a-zA-Z'-]+,/m.test(head)) score += 2;  // "Q - Analyst Name,"
  if (/\bA\s*[-–&]\s+[A-Z][a-zA-Z'-]+,/m.test(head)) score += 2;  // "A - Exec Name,"

  // Moderate signals
  if (/PREPARED REMARKS/i.test(head)) score += 2;
  if (/QUESTION.AND.ANSWER/i.test(head)) score += 2;
  if (/\bThank you\b.*\boperator\b/im.test(head)) score += 1;
  if (/\bgood (?:morning|afternoon|evening),?\s*(?:ladies and gentlemen|everyone)/im.test(head)) score += 1;

  return score >= 4;
}

// ── segmentation ──────────────────────────────────────────────────────────────

interface TranscriptBlock {
  speaker: string;      // e.g. "Operator", "Q - Jane Doe, Goldman Sachs", "A - John Smith"
  role: 'operator' | 'question' | 'answer' | 'prepared';
  analystName?: string;
  execName?: string;
  start: number;        // char position in full text
  end: number;
}

/**
 * The main Q pattern: "Q - Jane Doe, Goldman Sachs" or "Q: Jane Doe"
 * Also handles: "[Q]: Jane Doe" and "QUESTION: Jane Doe"
 */
const Q_LINE =
  /(?:^|\n)\s{0,4}(?:Q\s*[-–:]\s*|QUESTION:\s*)([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,4})[,\s]/gm;

/** The main A pattern: "A - John Smith, CEO" */
const A_LINE =
  /(?:^|\n)\s{0,4}(?:A\s*[-–:]\s*|ANSWER:\s*)([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,4})[,\s]/gm;

/** Operator line: "Operator:" or "[Operator]" */
const OPERATOR_LINE = /(?:^|\n)\s{0,4}(?:Operator\s*:|OPERATOR\s*:|\[Operator\])/gim;

/** Q&A section start: "Questions and Answers", "Q&A SESSION", etc. */
const QA_SECTION_RE =
  /(?:^|\n)\s{0,4}(?:QUESTION(?:S)?(?:\s+AND\s+ANSWER(?:S)?)?|Q(?:\s*[&\+]\s*A)|OPEN(?:ING)?\s+THE\s+FLOOR\s+(?:FOR\s+)?QUESTIONS)/im;

export function segmentTranscript(
  text: string,
  tableRanges: ReadonlyArray<[number, number]>,
): Section[] {
  const sections: Section[] = [];

  // Find the Q&A section start
  QA_SECTION_RE.lastIndex = 0;
  const qaMatch = QA_SECTION_RE.exec(text);
  const qaStart = qaMatch ? qaMatch.index : text.length;

  // --- Prepared remarks section (everything before Q&A) ---
  const preparedText = text.slice(0, qaStart).trim();
  if (preparedText.length > 20) {
    sections.push({
      id: 'transcript_prepared_remarks',
      label: 'Prepared Remarks',
      order: 0,
      text: preparedText,
      charRange: [0, qaStart],
    });
  }

  if (qaStart >= text.length) return sections;

  // Q&A intro paragraph (Operator announcement)
  const qaIntroEnd = findQAIntroEnd(text, qaStart);
  sections.push({
    id: 'transcript_qa_start',
    label: 'Q&A Session',
    order: 100,
    text: text.slice(qaStart, qaIntroEnd).trim(),
    charRange: [qaStart, qaIntroEnd],
  });

  // --- Q&A blocks ---
  const blocks = extractQABlocks(text, qaIntroEnd);
  let order = 110;

  for (const block of blocks) {
    const id = block.role === 'question'
      ? `transcript_qa_q_${slugify(block.analystName ?? block.speaker)}`
      : `transcript_qa_a_${slugify(block.execName ?? block.speaker)}`;

    const blockText = text.slice(block.start, block.end).trim();
    if (blockText.length < 10) continue;

    sections.push({
      id,
      label: block.role === 'question'
        ? `Q: ${block.analystName ?? block.speaker}`
        : `A: ${block.execName ?? block.speaker}`,
      order: order++,
      text: blockText,
      charRange: [block.start, block.end],
    });
  }

  return sections;
}

function findQAIntroEnd(text: string, qaStart: number): number {
  // The Q&A intro is typically 1-3 lines from the Q&A section header to the first speaker
  Q_LINE.lastIndex = qaStart;
  A_LINE.lastIndex = qaStart;
  const qm = Q_LINE.exec(text);
  const am = A_LINE.exec(text);
  const firstSpeaker = Math.min(
    qm ? qm.index : Infinity,
    am ? am.index : Infinity,
  );
  return Number.isFinite(firstSpeaker) ? firstSpeaker : Math.min(qaStart + 500, text.length);
}

function extractQABlocks(text: string, from: number): TranscriptBlock[] {
  // Collect all speaker-line positions
  interface SpeakerHit {
    pos: number;
    matchEnd: number;
    role: 'question' | 'answer' | 'operator';
    name: string;
  }
  const hits: SpeakerHit[] = [];

  const re = new RegExp(
    `(?:^|\\n)\\s{0,4}(?:(Q)\\s*[-–:]\\s*|QUESTION:\\s*|(A)\\s*[-–:]\\s*|ANSWER:\\s*|Operator\\s*:|OPERATOR\\s*:|\\[Operator\\])([A-Z][a-zA-Z' -]*)`,
    'gim',
  );
  re.lastIndex = from;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    const raw = m[0]!;
    const role: SpeakerHit['role'] =
      /^(?:\n?\s{0,4})?Q\s*[-–:]|QUESTION:/im.test(raw) ? 'question'
      : /^(?:\n?\s{0,4})?A\s*[-–:]|ANSWER:/im.test(raw) ? 'answer'
      : 'operator';
    hits.push({ pos: m.index, matchEnd: m.index + raw.length, role, name: (m[3] ?? '').trim() });
  }

  const blocks: TranscriptBlock[] = [];
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!;
    const nextStart = hits[i + 1]?.pos ?? text.length;

    if (hit.role === 'operator') continue; // skip operator interjections

    const block: TranscriptBlock = {
      speaker: hit.name,
      role: hit.role,
      start: hit.matchEnd,
      end: nextStart,
    };
    if (hit.role === 'question') block.analystName = hit.name;
    else if (hit.role === 'answer') block.execName = hit.name;
    blocks.push(block);
  }

  return blocks;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
}
