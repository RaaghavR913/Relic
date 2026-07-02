/**
 * Section segmentation for all supported FilingTypes.
 *
 * LIVE IMPLEMENTATION. src/content/ingest/segment.ts is a thin wrapper that
 * delegates here (attaching table ranges); do not confuse the two or delete this.
 *
 * segmentSections(text, filingType, tableRanges) returns Section[] with:
 *   - id: canonical snake_case ('item_1a_risk_factors', 'item_7_mdna', etc.)
 *   - label: human-readable
 *   - order: stable sort key
 *   - text: the section's normalized text slice
 *   - charRange: [start, end) in positionMap.text (document space)
 *
 * Algorithm:
 *   1. Detect all header positions via per-type regex patterns.
 *   2. De-dupe TOC entries: if many items appear within a short window
 *      (< TOC_WINDOW chars), they are table-of-contents entries — discard the
 *      dense cluster and keep only the subsequent real occurrences.
 *   3. For each kept header, the section content runs from headEnd to the next
 *      headStart (or end of document).
 *   4. Annotate each section with the subset of tableRanges that fall within it.
 */

import type { FilingType, Section } from '../types/index.js';

// ── canonical item registries ─────────────────────────────────────────────────

interface ItemDef {
  id: string;
  label: string;
  order: number;
}

const ITEMS_10K: Record<string, ItemDef> = {
  '1':  { id: 'item_1_business',                   label: 'Business',                                    order: 10 },
  '1a': { id: 'item_1a_risk_factors',               label: 'Risk Factors',                                order: 20 },
  '1b': { id: 'item_1b_unresolved_staff_comments',  label: 'Unresolved Staff Comments',                   order: 30 },
  '1c': { id: 'item_1c_cybersecurity',              label: 'Cybersecurity',                               order: 35 },
  '2':  { id: 'item_2_properties',                  label: 'Properties',                                  order: 40 },
  '3':  { id: 'item_3_legal_proceedings',           label: 'Legal Proceedings',                           order: 50 },
  '4':  { id: 'item_4_mine_safety',                 label: 'Mine Safety Disclosures',                     order: 60 },
  '5':  { id: 'item_5_equity',                      label: "Market for Registrant's Common Equity",       order: 70 },
  '6':  { id: 'item_6_reserved',                    label: 'Selected Financial Data',                     order: 80 },
  '7':  { id: 'item_7_mdna',                        label: "Management's Discussion and Analysis",        order: 90 },
  '7a': { id: 'item_7a_market_risk',                label: 'Quantitative and Qualitative Market Risk',    order: 100 },
  '8':  { id: 'item_8_financial_statements',        label: 'Financial Statements',                        order: 110 },
  '9':  { id: 'item_9_disagreements',               label: 'Changes in and Disagreements with Accountants', order: 120 },
  '9a': { id: 'item_9a_controls',                   label: 'Controls and Procedures',                     order: 130 },
  '9b': { id: 'item_9b_other',                      label: 'Other Information',                           order: 140 },
  '9c': { id: 'item_9c_foreign',                    label: 'Disclosure re Foreign Jurisdictions',         order: 145 },
  '10': { id: 'item_10_directors',                  label: 'Directors, Executive Officers and Corporate Governance', order: 150 },
  '11': { id: 'item_11_compensation',               label: 'Executive Compensation',                      order: 160 },
  '12': { id: 'item_12_security_ownership',         label: 'Security Ownership',                          order: 170 },
  '13': { id: 'item_13_related_transactions',       label: 'Certain Relationships and Related Transactions', order: 180 },
  '14': { id: 'item_14_auditor_fees',               label: 'Principal Accountant Fees and Services',      order: 190 },
  '15': { id: 'item_15_exhibits',                   label: 'Exhibits, Financial Statement Schedules',     order: 200 },
  '16': { id: 'item_16_summary',                    label: 'Form 10-K Summary',                           order: 210 },
};

const ITEMS_10Q: Record<string, ItemDef> = {
  // Part I
  '1':  { id: 'item_1_financial_statements',       label: 'Financial Statements',                         order: 10 },
  '2':  { id: 'item_2_mdna',                       label: "Management's Discussion and Analysis",         order: 20 },
  '3':  { id: 'item_3_market_risk',                label: 'Quantitative and Qualitative Market Risk',     order: 30 },
  '4':  { id: 'item_4_controls',                   label: 'Controls and Procedures',                      order: 40 },
  // Part II
  '1b': { id: 'part_ii_item_1_legal_proceedings',  label: 'Legal Proceedings',                            order: 50 },
  '1a': { id: 'part_ii_item_1a_risk_factors',      label: 'Risk Factors',                                 order: 60 },
  '2b': { id: 'part_ii_item_2_equity',             label: 'Unregistered Sales of Equity Securities',      order: 70 },
  '3b': { id: 'part_ii_item_3_defaults',           label: 'Defaults Upon Senior Securities',              order: 80 },
  '4b': { id: 'part_ii_item_4_mine_safety',        label: 'Mine Safety Disclosures',                      order: 90 },
  '5b': { id: 'part_ii_item_5_other',              label: 'Other Information',                            order: 100 },
  '6b': { id: 'part_ii_item_6_exhibits',           label: 'Exhibits',                                     order: 110 },
};

// 20-F (foreign private issuers) — Part I (items 1–12) / Part II (13–16K) / Part III (17–19).
// Top-level items: pure digits or digits+letter (e.g. "4A", "16A"–"16K").
// Sub-items: dot-then-letter format (e.g. "3.D", "4.B", "5.A") — matched via the extended regex.
const ITEMS_20F: Record<string, ItemDef> = {
  // ── Part I ───────────────────────────────────────────────────────────────────
  '1':    { id: '20f_item_1_directors_advisers',        label: 'Identity of Directors, Senior Management and Advisers', order: 10 },
  '2':    { id: '20f_item_2_offer_statistics',          label: 'Offer Statistics and Expected Timetable',               order: 20 },
  '3':    { id: '20f_item_3_key_information',           label: 'Key Information',                                        order: 30 },
  '3.d':  { id: '20f_item_3d_risk_factors',             label: 'Risk Factors',                                           order: 35 },
  '4':    { id: '20f_item_4_company_information',       label: 'Information on the Company',                             order: 40 },
  '4.a':  { id: '20f_item_4a_history',                  label: 'History and Development of the Company',                 order: 41 },
  '4.b':  { id: '20f_item_4b_business',                 label: 'Business Overview',                                      order: 42 },
  '4.c':  { id: '20f_item_4c_org_structure',            label: 'Organizational Structure',                               order: 43 },
  '4.d':  { id: '20f_item_4d_property',                 label: 'Property, Plants and Equipment',                         order: 44 },
  '4a':   { id: '20f_item_4a_unresolved_staff',         label: 'Unresolved Staff Comments',                              order: 50 },
  '5':    { id: '20f_item_5_operating_review',          label: 'Operating and Financial Review and Prospects',           order: 60 },
  '5.a':  { id: '20f_item_5a_operating_results',        label: 'Operating Results',                                      order: 61 },
  '5.b':  { id: '20f_item_5b_liquidity',                label: 'Liquidity and Capital Resources',                        order: 62 },
  '5.c':  { id: '20f_item_5c_research',                 label: 'Research and Development, Patents and Licenses',         order: 63 },
  '5.d':  { id: '20f_item_5d_trend',                    label: 'Trend Information',                                      order: 64 },
  '5.e':  { id: '20f_item_5e_off_balance',              label: 'Off-Balance Sheet Arrangements',                         order: 65 },
  '5.f':  { id: '20f_item_5f_contractual_obligations',  label: 'Tabular Disclosure of Contractual Obligations',          order: 66 },
  '6':    { id: '20f_item_6_directors_employees',       label: 'Directors, Senior Management and Employees',             order: 70 },
  '6.a':  { id: '20f_item_6a_directors',                label: 'Directors and Senior Management',                        order: 71 },
  '6.b':  { id: '20f_item_6b_compensation',             label: 'Compensation',                                           order: 72 },
  '6.c':  { id: '20f_item_6c_board_practices',          label: 'Board Practices',                                        order: 73 },
  '6.d':  { id: '20f_item_6d_employees',                label: 'Employees',                                              order: 74 },
  '6.e':  { id: '20f_item_6e_share_ownership',          label: 'Share Ownership',                                        order: 75 },
  '7':    { id: '20f_item_7_shareholders',              label: 'Major Shareholders and Related Party Transactions',      order: 80 },
  '7.a':  { id: '20f_item_7a_major_shareholders',       label: 'Major Shareholders',                                     order: 81 },
  '7.b':  { id: '20f_item_7b_related_party',            label: 'Related Party Transactions',                             order: 82 },
  '7.c':  { id: '20f_item_7c_experts',                  label: 'Interests of Experts and Counsel',                       order: 83 },
  '8':    { id: '20f_item_8_financial_info',            label: 'Financial Information',                                  order: 90 },
  '8.a':  { id: '20f_item_8a_consolidated_statements',  label: 'Consolidated Statements and Other Financial Information', order: 91 },
  '8.b':  { id: '20f_item_8b_significant_changes',      label: 'Significant Changes',                                    order: 92 },
  '9':    { id: '20f_item_9_offer_listing',             label: 'The Offer and Listing',                                  order: 100 },
  '9.a':  { id: '20f_item_9a_listing_details',          label: 'Offer and Listing Details',                              order: 101 },
  '10':   { id: '20f_item_10_additional_info',          label: 'Additional Information',                                 order: 110 },
  '10.b': { id: '20f_item_10b_articles',                label: 'Memorandum and Articles of Association',                 order: 112 },
  '10.e': { id: '20f_item_10e_taxation',                label: 'Taxation',                                               order: 115 },
  '11':   { id: '20f_item_11_market_risk',              label: 'Quantitative and Qualitative Disclosures About Market Risk', order: 120 },
  '12':   { id: '20f_item_12_securities',               label: 'Description of Securities Other Than Equity Securities', order: 130 },
  '12.d': { id: '20f_item_12d_ads',                     label: 'American Depositary Shares',                             order: 134 },
  // ── Part II ──────────────────────────────────────────────────────────────────
  '13':   { id: '20f_item_13_defaults',                 label: 'Defaults, Dividend Arrearages and Delinquencies',        order: 140 },
  '14':   { id: '20f_item_14_modifications',            label: 'Material Modifications to the Rights of Security Holders', order: 150 },
  '15':   { id: '20f_item_15_controls',                 label: 'Controls and Procedures',                                order: 160 },
  '16a':  { id: '20f_item_16a_audit_expert',            label: 'Audit Committee Financial Expert',                       order: 170 },
  '16b':  { id: '20f_item_16b_code_ethics',             label: 'Code of Ethics',                                         order: 180 },
  '16c':  { id: '20f_item_16c_accountant_fees',         label: 'Principal Accountant Fees and Services',                 order: 190 },
  '16d':  { id: '20f_item_16d_listing_exemptions',      label: 'Exemptions from Listing Standards for Audit Committees', order: 200 },
  '16e':  { id: '20f_item_16e_equity_purchases',        label: 'Purchases of Equity Securities by the Issuer',           order: 210 },
  '16f':  { id: '20f_item_16f_accountant_change',       label: "Change in Registrant's Certifying Accountant",           order: 220 },
  '16g':  { id: '20f_item_16g_governance',              label: 'Corporate Governance',                                   order: 230 },
  '16h':  { id: '20f_item_16h_mine_safety',             label: 'Mine Safety Disclosure',                                 order: 240 },
  '16i':  { id: '20f_item_16i_foreign_jurisdictions',   label: 'Disclosure Regarding Foreign Jurisdictions',             order: 250 },
  '16j':  { id: '20f_item_16j_insider_trading',         label: 'Insider Trading Policies',                               order: 255 },
  '16k':  { id: '20f_item_16k_cybersecurity',           label: 'Cybersecurity',                                          order: 260 },
  // ── Part III ─────────────────────────────────────────────────────────────────
  '17':   { id: '20f_item_17_financial_statements',     label: 'Financial Statements',                                   order: 270 },
  '18':   { id: '20f_item_18_financial_statements_alt', label: 'Financial Statements (Alternative)',                     order: 280 },
  '19':   { id: '20f_item_19_exhibits',                 label: 'Exhibits',                                               order: 290 },
};

// 8-K uses two-level numbering: "1.01", "2.02", etc.
const ITEMS_8K: Record<string, ItemDef> = {
  '1.01': { id: 'item_1_01_material_agreements',      label: 'Entry into a Material Definitive Agreement',   order: 10 },
  '1.02': { id: 'item_1_02_termination_agreements',   label: 'Termination of a Material Definitive Agreement', order: 20 },
  '1.03': { id: 'item_1_03_bankruptcy',               label: 'Bankruptcy or Receivership',                   order: 30 },
  '1.04': { id: 'item_1_04_mine_safety',              label: 'Mine Safety - Reporting of Shutdowns',         order: 40 },
  '1.05': { id: 'item_1_05_material_cybersecurity',   label: 'Material Cybersecurity Incidents',             order: 45 },
  '2.01': { id: 'item_2_01_acquisition',              label: 'Completion of Acquisition or Disposition',     order: 50 },
  '2.02': { id: 'item_2_02_results_of_operations',    label: 'Results of Operations and Financial Condition', order: 60 },
  '2.03': { id: 'item_2_03_direct_obligations',       label: 'Creation of a Direct Financial Obligation',    order: 70 },
  '2.04': { id: 'item_2_04_triggering_events',        label: 'Triggering Events That Accelerate Obligations', order: 80 },
  '2.05': { id: 'item_2_05_departures',               label: 'Costs Associated with Exit or Disposal',       order: 90 },
  '2.06': { id: 'item_2_06_material_impairment',      label: 'Material Impairments',                         order: 100 },
  '3.01': { id: 'item_3_01_delisting',                label: 'Notice of Delisting or Failure to Satisfy',    order: 110 },
  '3.02': { id: 'item_3_02_unregistered_sales',       label: 'Unregistered Sales of Equity Securities',      order: 120 },
  '3.03': { id: 'item_3_03_material_modification',    label: 'Material Modification to Rights of Securities', order: 130 },
  '4.01': { id: 'item_4_01_changes_registrant_cpa',   label: "Changes in Registrant's Certifying Accountant", order: 140 },
  '4.02': { id: 'item_4_02_non_reliance',             label: 'Non-Reliance on Previously Issued Financials', order: 150 },
  '5.01': { id: 'item_5_01_changes_control',          label: 'Changes in Control of Registrant',             order: 160 },
  '5.02': { id: 'item_5_02_officer_changes',          label: 'Departure or Election of Directors/Officers',  order: 170 },
  '5.03': { id: 'item_5_03_amendments',               label: 'Amendments to Articles of Incorporation',      order: 180 },
  '5.04': { id: 'item_5_04_temporary_suspension',     label: 'Temporary Suspension of Trading',              order: 190 },
  '5.05': { id: 'item_5_05_amendment_code_ethics',    label: 'Amendments to Code of Ethics',                 order: 200 },
  '5.07': { id: 'item_5_07_submission_vote',          label: 'Submission of Matters to a Vote of Security Holders', order: 210 },
  '5.08': { id: 'item_5_08_shareholder_director',     label: 'Shareholder Director Nominations',             order: 220 },
  '6.01': { id: 'item_6_01_aba',                      label: 'ABS Informational and Computational Material', order: 230 },
  '7.01': { id: 'item_7_01_reg_fd',                   label: 'Regulation FD Disclosure',                     order: 240 },
  '8.01': { id: 'item_8_01_other',                    label: 'Other Events',                                 order: 250 },
  '9.01': { id: 'item_9_01_financial_statements',     label: 'Financial Statements and Exhibits',            order: 260 },
};

// S-1 section title patterns (no canonical item numbers)
const SECTIONS_S1: Array<{ pattern: RegExp; def: ItemDef }> = [
  { pattern: /PROSPECTUS SUMMARY/i,             def: { id: 's1_prospectus_summary',     label: 'Prospectus Summary',              order: 10 } },
  { pattern: /RISK FACTORS/i,                   def: { id: 's1_risk_factors',            label: 'Risk Factors',                    order: 20 } },
  { pattern: /SPECIAL NOTE.{0,30}FORWARD.{0,30}LOOKING/i, def: { id: 's1_forward_looking', label: 'Special Note on Forward-Looking Statements', order: 25 } },
  { pattern: /USE OF PROCEEDS/i,                def: { id: 's1_use_of_proceeds',         label: 'Use of Proceeds',                 order: 30 } },
  { pattern: /DIVIDEND POLICY/i,                def: { id: 's1_dividend_policy',         label: 'Dividend Policy',                 order: 40 } },
  { pattern: /CAPITALIZATION/i,                 def: { id: 's1_capitalization',          label: 'Capitalization',                  order: 50 } },
  { pattern: /DILUTION/i,                       def: { id: 's1_dilution',                label: 'Dilution',                        order: 60 } },
  { pattern: /SELECTED (?:FINANCIAL|CONSOLIDATED) DATA/i, def: { id: 's1_selected_data', label: 'Selected Financial Data',        order: 70 } },
  { pattern: /MANAGEMENT.{0,10}S?\s+DISCUSSION AND ANALYSIS/i, def: { id: 's1_mdna',    label: "Management's Discussion and Analysis", order: 80 } },
  { pattern: /BUSINESS/i,                       def: { id: 's1_business',                label: 'Business',                        order: 90 } },
  { pattern: /MANAGEMENT/i,                     def: { id: 's1_management',              label: 'Management',                      order: 100 } },
  { pattern: /EXECUTIVE COMPENSATION/i,         def: { id: 's1_executive_compensation',  label: 'Executive Compensation',          order: 110 } },
  { pattern: /PRINCIPAL (?:AND SELLING )?STOCKHOLDERS/i, def: { id: 's1_stockholders',  label: 'Principal Stockholders',          order: 120 } },
  { pattern: /CERTAIN RELATIONSHIPS/i,          def: { id: 's1_related_transactions',    label: 'Certain Relationships and Related Party Transactions', order: 130 } },
  { pattern: /DESCRIPTION OF (?:OUR )?CAPITAL STOCK/i, def: { id: 's1_capital_stock',   label: 'Description of Capital Stock',    order: 140 } },
  { pattern: /SHARES ELIGIBLE FOR FUTURE SALE/i, def: { id: 's1_future_sales',          label: 'Shares Eligible for Future Sale', order: 150 } },
  { pattern: /UNDERWRITING/i,                   def: { id: 's1_underwriting',            label: 'Underwriting',                    order: 160 } },
  { pattern: /LEGAL MATTERS/i,                  def: { id: 's1_legal_matters',           label: 'Legal Matters',                   order: 170 } },
  { pattern: /EXPERTS/i,                        def: { id: 's1_experts',                 label: 'Experts',                         order: 180 } },
  { pattern: /FINANCIAL STATEMENTS/i,           def: { id: 's1_financial_statements',    label: 'Financial Statements',            order: 190 } },
];

// 6-K (foreign private issuer interim report) — free-form, usually an earnings
// release. No canonical items, so segment by common earnings-release headings. The
// <=1-hit whole-document fallback in segmentByTitlePatterns keeps an unusual 6-K
// (e.g. an AGM notice) from being chopped into a single misleading section.
const SECTIONS_6K: Array<{ pattern: RegExp; def: ItemDef }> = [
  { pattern: /FINANCIAL HIGHLIGHTS/i,           def: { id: '6k_financial_highlights', label: 'Financial Highlights',           order: 10 } },
  { pattern: /RESULTS OF OPERATIONS|OPERATING (?:AND FINANCIAL )?RESULTS|FINANCIAL REVIEW/i, def: { id: '6k_results', label: 'Results of Operations', order: 20 } },
  { pattern: /(?:BUSINESS|OPERATING) REVIEW/i,  def: { id: '6k_business_review',      label: 'Business Review',                order: 30 } },
  { pattern: /LIQUIDITY|CAPITAL RESOURCES/i,    def: { id: '6k_liquidity',            label: 'Liquidity and Capital Resources', order: 40 } },
  { pattern: /OUTLOOK|GUIDANCE|PROSPECTS/i,     def: { id: '6k_outlook',              label: 'Outlook',                        order: 50 } },
  { pattern: /RECENT DEVELOPMENTS/i,            def: { id: '6k_recent_developments',  label: 'Recent Developments',            order: 60 } },
  { pattern: /DIVIDENDS?|CAPITAL RETURN/i,      def: { id: '6k_dividend',             label: 'Dividend',                       order: 70 } },
  { pattern: /RISK FACTORS/i,                   def: { id: '6k_risk_factors',         label: 'Risk Factors',                   order: 80 } },
];

// DEF 14A (proxy statement) section patterns
const SECTIONS_DEF14A: Array<{ pattern: RegExp; def: ItemDef }> = [
  { pattern: /NOTICE OF ANNUAL/i,               def: { id: 'proxy_notice',              label: 'Notice of Annual Meeting',        order: 5  } },
  { pattern: /PROXY SUMMARY/i,                  def: { id: 'proxy_summary',             label: 'Proxy Summary',                   order: 10 } },
  { pattern: /PROPOSAL\s+1[.:]?\s+ELECTION/i,   def: { id: 'proxy_prop1_election',      label: 'Proposal 1: Election of Directors', order: 20 } },
  { pattern: /PROPOSAL\s+2[.:]?\s+RATIF/i,      def: { id: 'proxy_prop2_auditors',      label: 'Proposal 2: Ratification of Auditors', order: 30 } },
  { pattern: /PROPOSAL\s+3[.:]?\s+(?:ADVISORY|SAY.ON.PAY)/i, def: { id: 'proxy_prop3_say_on_pay', label: 'Proposal 3: Say-on-Pay', order: 40 } },
  { pattern: /BOARD OF DIRECTORS/i,             def: { id: 'proxy_board',               label: 'Board of Directors',              order: 50 } },
  { pattern: /CORPORATE GOVERNANCE/i,           def: { id: 'proxy_governance',          label: 'Corporate Governance',            order: 60 } },
  { pattern: /AUDIT COMMITTEE/i,                def: { id: 'proxy_audit_committee',     label: 'Audit Committee',                 order: 70 } },
  { pattern: /EXECUTIVE COMPENSATION/i,         def: { id: 'proxy_exec_compensation',   label: 'Executive Compensation',          order: 80 } },
  { pattern: /COMPENSATION DISCUSSION/i,        def: { id: 'proxy_cd_a',                label: 'Compensation Discussion & Analysis', order: 85 } },
  { pattern: /SECURITY OWNERSHIP/i,             def: { id: 'proxy_security_ownership',  label: 'Security Ownership',              order: 90 } },
  { pattern: /CERTAIN RELATIONSHIPS/i,          def: { id: 'proxy_related_transactions', label: 'Certain Relationships',          order: 100 } },
  { pattern: /ADDITIONAL INFORMATION/i,         def: { id: 'proxy_additional_info',     label: 'Additional Information',          order: 110 } },
  { pattern: /STOCKHOLDER PROPOSAL/i,           def: { id: 'proxy_stockholder_proposals', label: 'Stockholder Proposals',        order: 120 } },
];

// ── generic ITEM header regex ─────────────────────────────────────────────────

/**
 * Matches lines like:
 *   "ITEM 1A. RISK FACTORS"
 *   "Item 1A Risk Factors"
 *   "ITEM 1A: RISK FACTORS"
 *   "ITEM 1A — Risk Factors"
 *   "Item 1.01  Entry into a Material…"  (8-K two-level)
 *
 * Capture group 1 = item number string (e.g. "1A", "1.01")
 * Capture group 2 = item title text
 */
// Capture group 1 also handles 20-F dot-then-letter subitems: "3.D", "4.A", "5.B", etc.
const ITEM_HEADER_RE =
  /(?:^|\n)\s{0,4}ITEM\s+([\d]+(?:[A-Z]|\.\d{2}|\.[A-Z])?)\s*[.:\-–—]?\s+([^\n]{2,100})/gim;

/**
 * Window (chars) used to detect a dense "table of contents" / index block: a
 * header is treated as part of a TOC when at least TOC_MIN_CLUSTER DISTINCT item
 * keys fall within ±TOC_DEDUPE_WINDOW of it. Real body headers sit far apart
 * (sections of prose between them), so they are isolated, not clustered.
 */
const TOC_DEDUPE_WINDOW = 2000;
const TOC_MIN_CLUSTER = 3;

// ── types ─────────────────────────────────────────────────────────────────────

interface HeaderHit {
  itemKey: string;   // normalised lower-case item number, e.g. "1a", "7", "2.02"
  headEnd: number;   // char position right after the header line (content starts here)
  headStart: number; // char position of the line start (for TOC detection)
  title: string;     // raw matched title text
}

// ── main export ───────────────────────────────────────────────────────────────

export function segmentSections(
  text: string,
  filingType: FilingType,
  tableRanges: ReadonlyArray<[number, number]>,
): Section[] {
  const sections = segmentByForm(text, filingType, tableRanges);
  // Flag load-bearing MD&A / operating-review sections that are mere by-reference
  // pointers so downstream UI shows a note instead of analysing the pointer text.
  for (const s of sections) {
    if (isMdnaByReference(s)) s.incorporatedByReference = true;
  }
  return sections;
}

function segmentByForm(
  text: string,
  filingType: FilingType,
  tableRanges: ReadonlyArray<[number, number]>,
): Section[] {
  switch (filingType) {
    case '10-K':  return segmentByItems(text, ITEMS_10K, tableRanges);
    case '10-Q':  return segmentByItems(text, ITEMS_10Q, tableRanges);
    case '8-K':   return segmentByItems(text, ITEMS_8K, tableRanges);
    case '20-F':  return segmentByItems(text, ITEMS_20F, tableRanges);
    case '6-K':   return segmentByTitlePatterns(text, SECTIONS_6K, tableRanges);
    case 'S-1':   return segmentByTitlePatterns(text, SECTIONS_S1, tableRanges);
    case 'DEF 14A': return segmentByTitlePatterns(text, SECTIONS_DEF14A, tableRanges);
    default: return segmentFallback(text, tableRanges);
  }
}

// ── item-number based segmentation (10-K / 10-Q / 8-K) ───────────────────────

function segmentByItems(
  text: string,
  registry: Record<string, ItemDef>,
  tableRanges: ReadonlyArray<[number, number]>,
): Section[] {
  const hits = extractItemHits(text);
  if (hits.length === 0) return segmentFallback(text, tableRanges);

  const deduped = deTocDedupe(hits);
  return buildSections(text, deduped, registry, tableRanges);
}

function extractItemHits(text: string): HeaderHit[] {
  const hits: HeaderHit[] = [];
  ITEM_HEADER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = ITEM_HEADER_RE.exec(text)) !== null) {
    const raw = m[0]!;
    const itemNum = m[1]!;
    const title = (m[2] ?? '').trim();

    // Normalise item key: "1A" → "1a", "1.01" → "1.01"
    const key = itemNum.toLowerCase();
    const matchStart = m.index;
    const lineOffset = raw.search(/ITEM/i);
    hits.push({
      itemKey: key,
      headStart: matchStart + (lineOffset >= 0 ? lineOffset : 0),
      headEnd: matchStart + raw.length,
      title,
    });
  }
  return hits;
}

/**
 * Flag each header that sits inside a dense cluster of DISTINCT item keys — the
 * signature of a table-of-contents / index block. A real body header is isolated
 * (only its own key within the window) and stays unflagged. O(n²) over header
 * hits, which is a small set even on a long filing.
 */
function computeClusterFlags(hits: HeaderHit[]): boolean[] {
  const n = hits.length;
  const inCluster = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    const lo = hits[i]!.headStart - TOC_DEDUPE_WINDOW;
    const hi = hits[i]!.headStart + TOC_DEDUPE_WINDOW;
    const keys = new Set<string>();
    for (let j = 0; j < n; j++) {
      const hs = hits[j]!.headStart;
      if (hs >= lo && hs <= hi) keys.add(hits[j]!.itemKey);
    }
    if (keys.size >= TOC_MIN_CLUSTER) inCluster[i] = true;
  }
  return inCluster;
}

/**
 * Collapse repeated item headers to one header per item, choosing the REAL body
 * header rather than a table-of-contents line or a later cross-reference.
 *
 *   • If a key has any occurrence OUTSIDE a cluster, keep the FIRST such
 *     occurrence — that is the genuine body header. A later isolated repeat
 *     (an MD&A cross-reference like "see Item 1A") is a SECOND non-cluster
 *     occurrence and is ignored. This is the fix for headers that used to be
 *     mis-bound by keeping the last occurrence (which could leave Risk Factors
 *     empty and let a neighbor swallow it).
 *   • If every occurrence is inside a cluster (a key present only in a TOC, or
 *     in a short item-dense block), fall back to the LAST occurrence — for a
 *     front TOC that is the body header following the listing.
 */
function deTocDedupe(hits: HeaderHit[]): HeaderHit[] {
  if (hits.length <= 1) return hits.slice();

  const inCluster = computeClusterFlags(hits);
  const chosen = new Map<string, HeaderHit>();
  const fromPass1 = new Set<string>();

  // Pass 1 — first NON-cluster occurrence of each key (the real body header).
  for (let i = 0; i < hits.length; i++) {
    if (inCluster[i]) continue;
    const h = hits[i]!;
    if (!chosen.has(h.itemKey)) {
      chosen.set(h.itemKey, h);
      fromPass1.add(h.itemKey);
    }
  }
  // Pass 2 — keys seen only inside clusters: keep the LAST occurrence (the body
  // header that follows a front TOC). Overwriting ends on the last occurrence.
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]!;
    if (fromPass1.has(h.itemKey)) continue;
    chosen.set(h.itemKey, h);
  }

  return Array.from(chosen.values()).sort((a, b) => a.headStart - b.headStart);
}

function buildSections(
  text: string,
  hits: HeaderHit[],
  registry: Record<string, ItemDef>,
  tableRanges: ReadonlyArray<[number, number]>,
): Section[] {
  const sections: Section[] = [];

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!;
    const def = registry[hit.itemKey];
    if (!def) continue;  // unknown item number for this form type

    const contentStart = hit.headEnd;
    const contentEnd = hits[i + 1]?.headStart ?? text.length;

    if (contentStart >= contentEnd) continue;

    const sectionText = text.slice(contentStart, contentEnd).trim();
    const trimmedStart = contentStart + (text.slice(contentStart).search(/\S/));

    sections.push(
      makeSection(def, sectionText, [trimmedStart, contentEnd], tableRanges),
    );
  }

  return sections.sort((a, b) => a.order - b.order);
}

// ── title-pattern based segmentation (S-1, DEF 14A) ──────────────────────────

function segmentByTitlePatterns(
  text: string,
  patterns: Array<{ pattern: RegExp; def: ItemDef }>,
  tableRanges: ReadonlyArray<[number, number]>,
): Section[] {
  interface TitleHit { def: ItemDef; headEnd: number; headStart: number }
  const hits: TitleHit[] = [];

  for (const { pattern, def } of patterns) {
    // Look for the pattern preceded by a newline (section header context)
    const re = new RegExp(`(?:^|\\n)([ \\t]{0,4}${pattern.source}[^\\n]{0,120})`, 'gim');
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let lastMatch: TitleHit | null = null;

    while ((m = re.exec(text)) !== null) {
      lastMatch = {
        def,
        headStart: m.index,
        headEnd: m.index + m[0]!.length,
      };
    }
    if (lastMatch) hits.push(lastMatch);
  }

  hits.sort((a, b) => a.headStart - b.headStart);

  // A genuine S-1 / DEF 14A segments into many titled sections. Zero or one hit
  // means the type was misdetected (e.g. a data page whose only match is the word
  // "BUSINESS"); emit a whole-document fallback rather than a misleading lone
  // "Business" section. This is what surfaced as "1 sections" on the BDC page.
  if (hits.length <= 1) return segmentFallback(text, tableRanges);

  const sections: Section[] = [];
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!;
    const contentStart = hit.headEnd;
    const contentEnd = hits[i + 1]?.headStart ?? text.length;
    if (contentStart >= contentEnd) continue;

    const sectionText = text.slice(contentStart, contentEnd).trim();
    const trimmedStart = contentStart + (text.slice(contentStart).search(/\S/));
    sections.push(
      makeSection(hit.def, sectionText, [trimmedStart, contentEnd], tableRanges),
    );
  }

  return sections.sort((a, b) => a.order - b.order);
}

// ── helpers ───────────────────────────────────────────────────────────────────

function makeSection(
  def: ItemDef,
  sectionText: string,
  charRange: [number, number],
  tableRanges: ReadonlyArray<[number, number]>,
): Section {
  const [start, end] = charRange;
  const section: Section = {
    id: def.id,
    label: def.label,
    order: def.order,
    text: sectionText,
    charRange: [start, end],
  };

  // Attach the table regions that overlap this section so later prose analysis can
  // exclude tabular text. (Done here so the segmenter is self-sufficient — no separate
  // post-processing pass required.)
  const sectionTables = tableRanges.filter(([ts, te]) => ts < end && te > start);
  if (sectionTables.length > 0) {
    section.tables = sectionTables.map(([ts, te]) => [ts, te] as [number, number]);
  }

  return section;
}

function segmentFallback(
  text: string,
  tableRanges: ReadonlyArray<[number, number]>,
): Section[] {
  if (text.length === 0) return [];
  return [
    makeSection(
      { id: 'document_body', label: 'Document', order: 1 },
      text.trim(),
      [0, text.length],
      tableRanges,
    ),
  ];
}

// ── segmentation confidence ────────────────────────────────────────────────────

const LOAD_BEARING_MDNA = /mdna|operating_review/;
const LOAD_BEARING_RISK = /risk_factors/;
/** MD&A / operating-review prose is never this short in a real item filing. */
const MIN_MDNA_CHARS = 50;

/**
 * A real inline MD&A / operating-review runs tens of thousands of chars; an
 * "incorporated by reference" pointer is far shorter. Above this bound we never
 * treat a section as a pointer, so genuine narratives are never mis-flagged.
 */
const MAX_BYREF_POINTER_CHARS = 15_000;
/** Explicit incorporation language ("…incorporated (herein) by reference…"). */
const BYREF_INCORP_RE = /incorporat\w*\s+(?:herein\s+)?by reference/i;
/** Cross-reference pointer ("…appears on pages 46–160", "set forth under the heading…"). */
const BYREF_POINTER_RE =
  /\b(?:appears|set forth|included|contained)\b[^.]{0,80}\b(?:on pages?|under the heading|as exhibit|in exhibit|in (?:the|its) annual report)/i;

/**
 * True when a load-bearing MD&A / operating-review section is a short
 * "incorporated by reference" pointer rather than the analysable narrative (the
 * real prose lives in an exhibit or an un-numbered block elsewhere). BOTH signals
 * are required — short AND by-reference phrasing — so a legitimately brief item is
 * not mis-flagged. Detection only: the narrative is not recovered (S2 carry-over).
 */
export function isMdnaByReference(section: Section): boolean {
  if (!LOAD_BEARING_MDNA.test(section.id)) return false;
  if (section.text.length >= MAX_BYREF_POINTER_CHARS) return false;
  return BYREF_INCORP_RE.test(section.text) || BYREF_POINTER_RE.test(section.text);
}

function isItemForm(t: FilingType): boolean {
  return t === '10-K' || t === '10-Q' || t === '8-K' || t === '20-F';
}

/**
 * Heuristic confidence that the sections were correctly bounded. Returns 'low'
 * when the structure looks mis-segmented, so the UI can warn instead of
 * confidently presenting analysis of the wrong spans:
 *   • an item-numbered form collapsed to the whole-document fallback,
 *   • an MD&A / operating-review section located but near-empty (mis-bound), or
 *   • a Risk-Factors section located but completely empty (swallowed by a
 *     neighbouring section — the failure mode this hardening addresses).
 * Title/freeform forms (S-1, DEF 14A, 6-K) and non-item documents are treated as
 * 'high'; their own whole-document fallbacks govern quality. A Risk-Factors
 * emptiness check is intentionally strict (length 0) so a legitimately brief
 * 10-Q "no material changes" Item 1A is not mistaken for a mis-bound section.
 */
export function assessSegmentationConfidence(
  sections: ReadonlyArray<Section>,
  filingType: FilingType,
): 'high' | 'low' {
  if (sections.length === 0) return 'low';
  if (
    isItemForm(filingType) &&
    sections.length === 1 &&
    sections[0]!.id === 'document_body'
  ) {
    return 'low';
  }
  for (const s of sections) {
    const len = s.text.trim().length;
    if (LOAD_BEARING_MDNA.test(s.id) && len < MIN_MDNA_CHARS) return 'low';
    if (LOAD_BEARING_RISK.test(s.id) && len === 0) return 'low';
  }
  return 'high';
}
