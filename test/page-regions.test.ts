import assert from 'node:assert/strict';
import { test } from 'node:test';
import { breakdown, fields, metric, page, related, timeline, stream } from '@mistriwork/mistri/app';
import { pageConfig, parsePagesConfig } from '../packages/engine/src/shared/page.js';
import type { HeaderSection, PageSection } from '../packages/mistri/schema/app.js';

/* Every section that has a place of its own: a record header is drawn in the head. */
const sections: Exclude<PageSection, HeaderSection>[] = [
  fields(['name'], { title: 'Main', region: 'main' }),
  fields(['owner_id', 'priority'], { presentation: 'summary', title: 'Properties', columns: 1 }),
  related('Notes', 'note', 'ticket_id', { show: ['body'], create: 'Add note' }),
  metric('Notes', 'note', { whose: 'ticket_id' }),
  breakdown('Notes by kind', 'note', 'kind', { whose: 'ticket_id' }),
  timeline('History', [stream('note', 'ticket_id', 'created_at', 'body')]),
];

test("region: 'aside' on each section places it beside the main column without changing flat section order", () => {
  // There is no aside() helper: a section says its own region.
  const side = sections.slice(1).map((section) => ({ ...section, region: 'aside' as const }));
  const definition = page('ticket', [sections[0], ...side]);
  const [parsed] = parsePagesConfig({ pages: [definition] }, 'test');
  assert.deepEqual(
    parsed.sections.map((s) => s.kind),
    ['fields', 'fields', 'list', 'metric', 'breakdown', 'timeline'],
  );
  assert.deepEqual(
    parsed.sections.map((s) => s.region),
    ['main', 'aside', 'aside', 'aside', 'aside', 'aside'],
  );
  assert.deepEqual(parsePagesConfig({ pages: [pageConfig(parsed)] }, 'roundtrip')[0], parsed);
});

test('every section preserves explicit regions while legacy placement remains absent', () => {
  for (const section of sections) {
    for (const region of ['main', 'aside', undefined] as const) {
      const definition = page('ticket', [{ ...section, region }]);
      const [parsed] = parsePagesConfig({ pages: [definition] }, 'test');
      assert.equal(parsed.sections[0].region, region);
      const emitted = pageConfig(parsed).sections![0];
      assert.equal((emitted as { region?: string }).region, region);
      if (region === undefined) assert.equal(Object.hasOwn(emitted, 'region'), false);
      assert.deepEqual(parsePagesConfig({ pages: [JSON.parse(JSON.stringify(pageConfig(parsed)))] }, 'roundtrip')[0], parsed);
    }
  }
});

test('page parser refuses invalid region values without coercing them', () => {
  for (const section of sections) {
    for (const region of ['drawer', 'ASIDE', '', ' aside ', null, 1, true, [], {}]) {
      assert.throws(
        () => parsePagesConfig({ pages: [{ label: 'Ticket', base: 'ticket', sections: [{ ...section, region }] }] }, 'test'),
        /region.*main.*aside/,
      );
    }
  }
});
