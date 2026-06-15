import type { DocumentModel, LanguageFlag } from '@/types';

export const MOCK_DOC: DocumentModel = {
  source: {
    url: 'https://www.sec.gov/Archives/edgar/data/1/x-10k.htm',
    host: 'edgar',
    category: 'edgar_filing',
  },
  companyName: 'Acme Industries, Inc.',
  ticker: 'ACME',
  filingType: '10-K',
  filingTypeConfidence: 'high',
  periodOfReport: '2025-12-31',
  sections: [
    {
      id: 'item_7_mdna',
      label: "Management's Discussion and Analysis",
      order: 90,
      text: 'Revenue increased 12% year over year driven by strong demand in our core markets. Gross margin expanded 180 basis points as supply chain costs normalized.',
      charRange: [0, 140],
    },
    {
      id: 'item_1a_risk_factors',
      label: 'Risk Factors',
      order: 20,
      text: 'We may be unable to compete effectively if we fail to innovate. Litigation and regulatory actions could materially harm our business.',
      charRange: [140, 260],
    },
  ],
  rawTextHash: 'hash-rich',
};

export const MOCK_FLAGS: LanguageFlag[] = [
  {
    type: 'litigious',
    range: [180, 190],
    sectionId: 'item_1a_risk_factors',
    term: 'litigation',
    note: 'Litigious language',
  },
  {
    type: 'uncertainty',
    range: [150, 160],
    sectionId: 'item_1a_risk_factors',
    term: 'may',
    note: 'Uncertainty modal',
  },
];

export type PreviewScenario = 'onboarding' | 'empty' | 'filing';

export function scenarioFromSearch(search: string): PreviewScenario {
  const raw = new URLSearchParams(search).get('scenario');
  if (raw === 'onboarding' || raw === 'empty' || raw === 'filing') return raw;
  return 'filing';
}
