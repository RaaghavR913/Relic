import { describe, it, expect } from 'vitest';
import { classifyInjectability } from '../src/background/inject';

describe('classifyInjectability', () => {
  it('classifies manifest-matched hosts as auto_host', () => {
    expect(classifyInjectability('https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/aapl-20230930.htm')).toBe('auto_host');
    expect(classifyInjectability('https://efts.sec.gov/LATEST/search-index?q=test')).toBe('auto_host');
    expect(classifyInjectability('https://sec.gov/')).toBe('auto_host');
  });

  it('does not treat lookalike hosts as auto_host', () => {
    expect(classifyInjectability('https://notsec.gov/filing')).toBe('injectable');
    expect(classifyInjectability('https://sec.gov.evil.com/filing')).toBe('injectable');
  });

  it('classifies ordinary http(s) pages as injectable', () => {
    expect(classifyInjectability('https://investor.apple.com/investor-relations/default.aspx')).toBe('injectable');
    expect(classifyInjectability('https://finance.yahoo.com/news/some-article.html')).toBe('injectable');
    expect(classifyInjectability('https://www.fool.com/earnings/call-transcripts/x/')).toBe('injectable');
    expect(classifyInjectability('https://seekingalpha.com/article/123')).toBe('injectable');
    expect(classifyInjectability('http://example.com/annual-report.html')).toBe('injectable');
  });

  it('classifies browser and privileged pages as unsupported', () => {
    expect(classifyInjectability('chrome://extensions')).toBe('unsupported');
    expect(classifyInjectability('chrome://version')).toBe('unsupported');
    expect(classifyInjectability('chrome-extension://abcdef/sidepanel.html')).toBe('unsupported');
    expect(classifyInjectability('about:blank')).toBe('unsupported');
    expect(classifyInjectability('devtools://devtools/bundled/inspector.html')).toBe('unsupported');
  });

  it('classifies local files (including PDFs) as unsupported', () => {
    expect(classifyInjectability('file:///Users/x/annual-report.pdf')).toBe('unsupported');
    expect(classifyInjectability('file:///tmp/report.html')).toBe('unsupported');
  });

  it('classifies the Chrome Web Store as unsupported', () => {
    expect(classifyInjectability('https://chromewebstore.google.com/detail/foo/abc')).toBe('unsupported');
    expect(classifyInjectability('https://chrome.google.com/webstore/detail/foo/abc')).toBe('unsupported');
  });

  it('classifies missing or unparseable URLs as unsupported', () => {
    expect(classifyInjectability(undefined)).toBe('unsupported');
    expect(classifyInjectability('')).toBe('unsupported');
    expect(classifyInjectability('not a url')).toBe('unsupported');
  });
});
