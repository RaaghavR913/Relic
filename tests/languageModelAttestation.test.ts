/**
 * Disclora — LanguageModel (Prompt API) language attestation tests.
 *
 * Chrome logs a side-panel error when LanguageModel.availability() or create()
 * is called without expectedOutputs declaring English. These tests pin every
 * Disclora entry point that touches LanguageModel.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  LANGUAGE_MODEL_LANGUAGE,
  hasLanguageModelOutputAttestation,
  getCapabilities,
  clearCapabilitiesCache,
  createPromptSession,
} from '@/runtime/capabilities';
import { createChangeSummarySession, generateChangeSummary } from '@/redline/changeSummary';
import { generateFilingAnalysis } from '@/analyst/pipeline';
import type { DocumentModel, Section } from '@/types';
import type { DiffStats } from '@/redline/diff';
import type { SectionDiff } from '@/types';

function section(id: string, label: string, order: number, text: string, start: number): Section {
  return { id, label, order, text, charRange: [start, start + text.length] };
}

const MINIMAL_DOC: DocumentModel = {
  source: { url: 'https://www.sec.gov/x.htm', host: 'edgar', category: 'edgar_filing' },
  companyName: 'Acme Corp',
  ticker: 'ACME',
  filingType: '10-K',
  filingTypeConfidence: 'high',
  sections: [
    section(
      'item_7_mdna',
      "Management's Discussion and Analysis",
      90,
      'Revenue increased twelve percent year over year driven by strong demand across all product lines and regions.',
      0,
    ),
  ],
  rawTextHash: 'attest-hash',
};

const MINIMAL_DIFF: SectionDiff = {
  sectionId: 'risk_factors',
  magnitude: 0.2,
  summary: 'Template.',
  added: [{ range: [0, 40] as [number, number], text: 'New regulatory risk language was added.' }],
  removed: [],
};

const MINIMAL_STATS: DiffStats = {
  addedSentences: 1,
  removedSentences: 0,
  rewordedSentences: 0,
  cosmeticDropped: 0,
  addedChars: 35,
  removedChars: 0,
  pctChanged: 8,
  longestAdded: 'New regulatory risk language was added.',
};

describe('LANGUAGE_MODEL_LANGUAGE constant', () => {
  it('declares English text expectedOutputs (Chrome Prompt API attestation)', () => {
    expect(hasLanguageModelOutputAttestation(LANGUAGE_MODEL_LANGUAGE)).toBe(true);
    expect(LANGUAGE_MODEL_LANGUAGE.expectedOutputs[0]).toEqual({
      type: 'text',
      languages: ['en'],
    });
    expect(LANGUAGE_MODEL_LANGUAGE.expectedInputs[0]).toEqual({
      type: 'text',
      languages: ['en'],
    });
  });

  it('rejects the legacy Summarizer-only outputLanguage shape', () => {
    expect(hasLanguageModelOutputAttestation({ outputLanguage: 'en' })).toBe(false);
  });
});

describe('LanguageModel entry points pass output attestation', () => {
  const savedGpu = globalThis.navigator?.gpu;

  beforeEach(() => {
    clearCapabilitiesCache();
    Object.defineProperty(globalThis.navigator, 'gpu', {
      configurable: true,
      value: undefined,
    });
  });

  afterEach(() => {
    clearCapabilitiesCache();
    delete (globalThis as Record<string, unknown>)['LanguageModel'];
    if (savedGpu !== undefined) {
      Object.defineProperty(globalThis.navigator, 'gpu', {
        configurable: true,
        value: savedGpu,
      });
    }
  });

  it('getCapabilities() passes attestation to LanguageModel.availability()', async () => {
    const availability = vi.fn().mockResolvedValue('available');
    (globalThis as Record<string, unknown>)['LanguageModel'] = { availability };
    (globalThis as Record<string, unknown>)['Summarizer'] = {
      availability: vi.fn().mockResolvedValue('unavailable'),
    };

    await getCapabilities(true);

    expect(availability).toHaveBeenCalledOnce();
    expect(hasLanguageModelOutputAttestation(availability.mock.calls[0]![0])).toBe(true);
  });

  it('createPromptSession() passes attestation to LanguageModel.create()', async () => {
    const create = vi.fn().mockResolvedValue({ destroy: vi.fn() });
    (globalThis as Record<string, unknown>)['LanguageModel'] = { create };

    await createPromptSession({ systemPrompt: 'test system' });

    expect(create).toHaveBeenCalledOnce();
    expect(hasLanguageModelOutputAttestation(create.mock.calls[0]![0])).toBe(true);
  });

  it('createChangeSummarySession() passes attestation to LanguageModel.create()', async () => {
    const create = vi.fn().mockResolvedValue({
      prompt: vi.fn(),
      destroy: vi.fn(),
    });
    (globalThis as Record<string, unknown>)['LanguageModel'] = { create };

    await createChangeSummarySession();

    expect(create).toHaveBeenCalledOnce();
    expect(hasLanguageModelOutputAttestation(create.mock.calls[0]![0])).toBe(true);
  });

  it('generateChangeSummary() passes attestation when it creates a session', async () => {
    const create = vi.fn().mockResolvedValue({
      prompt: vi.fn().mockResolvedValue('Updated risk language.'),
      destroy: vi.fn(),
    });
    (globalThis as Record<string, unknown>)['LanguageModel'] = { create };

    await generateChangeSummary('Risk Factors', MINIMAL_DIFF, MINIMAL_STATS, { tier: 'builtin' });

    expect(create).toHaveBeenCalledOnce();
    expect(hasLanguageModelOutputAttestation(create.mock.calls[0]![0])).toBe(true);
  });

  it('generateFilingAnalysis() default LM factory passes attestation on create()', async () => {
    const create = vi.fn().mockResolvedValue({
      prompt: vi.fn().mockRejectedValue(new Error('stop after first create')),
      destroy: vi.fn(),
    });
    (globalThis as Record<string, unknown>)['LanguageModel'] = { create };

    await generateFilingAnalysis(MINIMAL_DOC, { tier: 'builtin' });

    expect(create).toHaveBeenCalled();
    for (const call of create.mock.calls) {
      expect(hasLanguageModelOutputAttestation(call[0])).toBe(true);
    }
  });
});
