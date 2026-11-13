/* checkPatterns on plain markup: each rule it reads, with a page that breaks it and one that keeps it. */
import { afterEach, describe, expect, it } from 'vitest';
import { checkPatterns } from './conformancePatterns.js';

function page(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host;
}
afterEach(() => document.body.replaceChildren());

describe('a tab list', () => {
  const tabs = (first: string) => `
    <div role="tablist" aria-label="Sections">
      ${first}
      <button role="tab" aria-selected="false" tabindex="-1" id="b">B</button>
      <button role="tab" aria-selected="true" tabindex="0" id="c">C</button>
    </div>`;

  it('walks back to the chosen tab past a disabled one, leaving it chosen', async () => {
    const host = page(tabs('<button role="tab" aria-selected="false" tabindex="-1" disabled>A</button>'));
    const chosen = host.querySelector<HTMLElement>('#c')!;
    chosen.focus();
    // Roving by hand, as a tab list does: an arrow moves the focus to the next live tab, and wraps past the last.
    host.addEventListener('keydown', (event) => {
      const live = [...host.querySelectorAll<HTMLElement>('[role="tab"]:not([disabled])')];
      const at = live.indexOf(document.activeElement as HTMLElement);
      const to =
        event.key === 'Home' ? 0 : event.key === 'End' ? live.length - 1 : event.key === 'ArrowRight' ? (at + 1) % live.length : at;
      for (const tab of live) tab.tabIndex = tab === live[to] ? 0 : -1;
      live[to]!.focus();
    });
    expect(await checkPatterns(host)).toEqual([]);
    expect(document.activeElement).toBe(chosen);
  });
});

describe('a name from content', () => {
  it('ignores what is under aria-hidden: an item that is only an icon has no name', async () => {
    const host = page(`
      <div role="listbox" tabindex="0" aria-label="Pick">
        <div role="option" id="o1"><svg aria-hidden="true"><title>star</title></svg><span aria-hidden="true">Star</span></div>
        <div role="option" id="o2">Plain</div>
      </div>`);
    const problems = await checkPatterns(host, { keys: false });
    expect(problems.filter((p) => p.includes('has no name'))).toHaveLength(1);
  });

  it("counts a descendant's own aria-label", async () => {
    const host = page(
      `<div role="listbox" tabindex="0" aria-label="Pick"><div role="option"><span role="img" aria-label="Star"></span></div></div>`,
    );
    expect(await checkPatterns(host, { keys: false })).toEqual([]);
  });
});

describe('what a composite owns', () => {
  it('sees a bare button among a listbox options by its implicit role', async () => {
    const host = page(`<div role="listbox" tabindex="0" aria-label="Pick"><div role="option">One</div><button>Clear</button></div>`);
    expect(await checkPatterns(host, { keys: false })).toContain('listbox "Pick": owns a button, which a listbox may not hold');
  });

  it('is not troubled by a bare element with no role of its own', async () => {
    const host = page(`<div role="listbox" tabindex="0" aria-label="Pick"><div><span role="option">One</span></div></div>`);
    expect(await checkPatterns(host, { keys: false })).toEqual([]);
  });

  it('flags a status inside a listbox', async () => {
    const host = page(`<div role="listbox" tabindex="0" aria-label="Pick"><div role="status">Nothing</div></div>`);
    const problems = await checkPatterns(host, { keys: false });
    expect(problems).toContain('listbox "Pick": owns a status, which a listbox may not hold');
    expect(problems).toContain('listbox "Pick": owns no option');
  });
});

describe('the topmost modal dialog', () => {
  const modal = (name: string, style = '') =>
    `<div role="dialog" aria-modal="true" aria-label="${name}" style="${style}"><button>${name} button</button></div>`;

  it('is the one stacked highest, not the last in the document', async () => {
    const host = page(modal('Above', 'position:fixed;z-index:50') + modal('Below', 'position:fixed;z-index:10'));
    host.querySelector<HTMLElement>('[aria-label="Above"] button')!.focus();
    expect(await checkPatterns(host, { keys: false })).toEqual([]);
    host.querySelector<HTMLElement>('[aria-label="Below"] button')!.focus();
    expect(await checkPatterns(host, { keys: false })).toEqual(['dialog "Above": an open modal dialog does not hold the focus']);
  });

  it('is the later one in the document where nothing is stacked', async () => {
    const host = page(modal('First') + modal('Second'));
    host.querySelector<HTMLElement>('[aria-label="Second"] button')!.focus();
    expect(await checkPatterns(host, { keys: false })).toEqual([]);
  });
});
