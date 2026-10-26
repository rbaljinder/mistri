import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePagesConfig, sectionConfig } from '../packages/engine/src/shared/page.js';

/**
 * A record's sections as tabs: any section may name the tab it is drawn in,
 * the name is spelled back as written, and a region names two tabs or none.
 */
const pageOf = (sections: unknown[]) => parsePagesConfig({ pages: [{ id: 'deal', label: 'Deal', base: 'deal', sections }] }, 'pages')[0];

test('any section may name its tab, trimmed, and the page export spells it back', () => {
  const page = pageOf([
    { kind: 'fields', show: ['name'], tab: ' Details ' },
    { kind: 'list', from: 'task', whose: 'deal_id', tab: 'Work' },
    { kind: 'metric', from: 'task', whose: 'deal_id', tab: 'Work' },
    { kind: 'breakdown', from: 'task', whose: 'deal_id', by: 'status', tab: 'Work' },
    { kind: 'timeline', streams: [{ from: 'note', whose: 'deal_id', at: 'noted_at', show: 'body' }], tab: 'Details' },
    { kind: 'fields', show: ['stage'] },
  ]);
  assert.deepEqual(
    page.sections.map((section) => section.tab),
    ['Details', 'Work', 'Work', 'Work', 'Details', undefined],
  );
  assert.equal((sectionConfig(page.sections[0]) as { tab?: string }).tab, 'Details');
  assert.equal('tab' in sectionConfig(page.sections[5]), false);
  assert.deepEqual(pageOf(page.sections.map(sectionConfig)).sections, page.sections);
});

test('a region naming one tab is refused, and the side panel counts on its own', () => {
  assert.throws(
    () =>
      pageOf([
        { kind: 'fields', show: ['name'], tab: 'Details' },
        { kind: 'fields', show: ['stage'] },
      ]),
    /names one tab, "Details". A tab strip needs two tabs or more: name another, or leave "tab" out/,
  );
  assert.throws(
    () =>
      pageOf([
        { kind: 'fields', show: ['name'], tab: 'A' },
        { kind: 'fields', show: ['stage'], tab: 'B' },
        { kind: 'fields', show: ['owner_id'], region: 'aside', tab: 'C' },
      ]),
    /names one tab, "C" in its side panel/,
  );
  assert.doesNotThrow(() =>
    pageOf([
      { kind: 'fields', show: ['name'], tab: 'A' },
      { kind: 'fields', show: ['stage'], tab: 'B' },
    ]),
  );
});

test('a tab is a short name, never blank', () => {
  for (const tab of ['', '   ', 7]) {
    assert.throws(
      () =>
        pageOf([
          { kind: 'fields', show: ['name'], tab },
          { kind: 'fields', show: ['stage'], tab: 'B' },
        ]),
      /Invalid caption at .*\.tab/,
    );
  }
  assert.throws(
    () =>
      pageOf([
        { kind: 'fields', show: ['name'], tab: 'x'.repeat(41) },
        { kind: 'fields', show: ['stage'], tab: 'B' },
      ]),
    /has a "tab" that is not a name of at most 40 characters/,
  );
});
