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
  // Dev-preview fixture for the Fundamentals card (src/sidepanel/FundamentalsPanel.tsx).
  xbrl: {
    periodEnd: '2025-12-31',
    priorPeriodEnd: '2024-12-31',
    facts: [
      { concept: 'us-gaap:Revenues', label: 'Revenue', unit: 'USD', currentValue: 383_285_000_000, priorValue: 394_328_000_000, yoyPct: (383285 - 394328) / 394328, range: [0, 60] },
      { concept: 'us-gaap:GrossProfit', label: 'Gross profit', unit: 'USD', currentValue: 169_148_000_000, priorValue: 170_782_000_000, yoyPct: (169148 - 170782) / 170782 },
      { concept: 'us-gaap:NetIncomeLoss', label: 'Net income', unit: 'USD', currentValue: 96_995_000_000, priorValue: 99_803_000_000, yoyPct: (96995 - 99803) / 99803 },
      { concept: 'us-gaap:EarningsPerShareDiluted', label: 'Diluted EPS', unit: 'USD/shares', currentValue: 6.13, priorValue: 6.16, yoyPct: (6.13 - 6.16) / 6.16 },
      { concept: 'us-gaap:NetCashProvidedByUsedInOperatingActivities', label: 'Operating cash flow', unit: 'USD', currentValue: 110_543_000_000, priorValue: 122_151_000_000, yoyPct: (110543 - 122151) / 122151 },
      { concept: 'us-gaap:Assets', label: 'Total assets', unit: 'USD', currentValue: 352_583_000_000, priorValue: 352_755_000_000, yoyPct: (352583 - 352755) / 352755 },
    ],
    metrics: [
      { label: 'Gross margin', current: 169148 / 383285, prior: 170782 / 394328 },
      { label: 'Net margin', current: 96995 / 383285, prior: 99803 / 394328 },
    ],
  },
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
