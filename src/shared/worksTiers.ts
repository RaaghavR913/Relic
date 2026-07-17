export type WorksTierLink = { text: string; href: string };

export type WorksTierPart =
  | { type: 'text'; value: string }
  | { type: 'link'; text: string; href: string };

export type WorksTierItem = {
  /** Bold lead-in before an optional link (e.g. "Most Detailed Analysis: "). */
  prefix: string;
  /** Optional linked phrase in the heading. */
  link?: WorksTierLink;
  /** Optional plain heading text when there is no link. */
  label?: string;
  /** Optional plain text after the link (e.g. closing paren). */
  suffix?: string;
  /** Optional mixed text/links rendered inline after the prefix. */
  parts?: ReadonlyArray<WorksTierPart>;
  /** Optional supporting line under the heading (plain string or mixed parts). */
  detail?: string | ReadonlyArray<WorksTierPart>;
};

export const WORKS_TIERS: ReadonlyArray<WorksTierItem> = [
  {
    prefix: 'Most Detailed Analysis: ',
    link: {
      text: 'SEC EDGAR filings',
      href: 'https://www.sec.gov/search-filings',
    },
  },
  {
    prefix: 'Enhanced Analysis: ',
    parts: [
      { type: 'link', text: 'AnnualReports', href: 'https://www.annualreports.com/' },
      { type: 'text', value: ', ' },
      { type: 'link', text: 'StockAnalysis', href: 'https://stockanalysis.com/' },
      { type: 'text', value: ', ' },
      { type: 'link', text: 'Fool', href: 'https://www.fool.com/' },
      { type: 'text', value: ', ' },
      { type: 'link', text: 'Benzinga', href: 'https://www.benzinga.com/' },
      { type: 'text', value: ', ' },
      { type: 'link', text: 'MarketWatch', href: 'https://www.marketwatch.com/' },
      { type: 'text', value: ', etc.' },
    ],
  },
  {
    prefix: 'Quick Summary: Any website (Ex: ',
    link: {
      text: 'Yahoo Finance',
      href: 'https://finance.yahoo.com/',
    },
    suffix: ')',
  },
];
