import { beforeEach, describe, expect, it, vi } from 'vitest';

type Styles = typeof import('./styles.js');
let styles: Styles;

beforeEach(async () => {
  vi.resetModules();
  document.adoptedStyleSheets = [];
  styles = await import('./styles.js');
});

const texts = () => document.adoptedStyleSheets.map((sheet) => [...sheet.cssRules].map((rule) => rule.cssText).join(' '));

describe('the shell’s sheets in the host’s document', () => {
  it('are adopted only while an element holds them, after the host’s own, and never touch the host’s', () => {
    const hosts = new CSSStyleSheet();
    hosts.replaceSync('h1 { color: red; }');
    document.adoptedStyleSheets = [hosts];
    styles.adoptCss('.a { color: blue; }');
    expect(document.adoptedStyleSheets).toEqual([hosts]);

    const release = styles.holdStyles();
    expect(document.adoptedStyleSheets[0]).toBe(hosts);
    expect(texts()).toHaveLength(2);
    expect(texts()[1]).toContain('.a');

    // A part's sheet loaded on demand joins at once, after the others.
    styles.adoptCss('.b { color: green; }');
    expect(texts()).toHaveLength(3);
    expect(texts()[2]).toContain('.b');

    // Two holders (StrictMode, or a surface handing over to the App): gone only with the last.
    const second = styles.holdStyles();
    release();
    release();
    expect(texts()).toHaveLength(3);
    second();
    expect(document.adoptedStyleSheets).toEqual([hosts]);
  });
});
