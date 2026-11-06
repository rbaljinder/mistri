/**
 * A display rule's `subtitle` is drawn wherever a column has room for a second line: a list's cell, a block of
 * fields, a header's facts, a card section, a headline's figure, a card's title, figure and lines, a board card's
 * title. Where a card gives the column one line (a badge, a description, a summary, a foot; a board card's line, chip
 * or facts) `check` says so (`[subtitle-unseen]`), rather than leaving the second line silently dropped.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appAdvisories, type LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const schema = { label: 'Field', dialect: 'sqlite', readAt: '', foreignKeys: [], tables: [] } as unknown as DatabaseSchema;
const display = { display: { name: { subtitle: 'email' } } };

const warnings = (views: Record<string, unknown>, sections: unknown[] = []) => {
  const app = parseAppConfig(
    { name: 'People', resources: { person: display }, views, home: Object.keys(views)[0], nav: Object.keys(views) },
    'run',
  );
  const pages = parsePagesConfig({ pages: [{ label: 'Person', base: 'person', sections }] }, 'pages');
  return appAdvisories({ path: 'people.ts', app, pages, sources: {} } as unknown as LoadedApp, schema).filter((line) =>
    line.includes('[subtitle-unseen]'),
  );
};

test("a subtitled column on a card's one-line place is warned about", () => {
  const list = { kind: 'list', from: 'person' };
  const cards = warnings({ people: { ...list, presentation: { kind: 'cards', primary: 'email', facts: ['name'] } } });
  assert.equal(cards.length, 1, cards.join('\n'));
  assert.match(cards[0], /view "people".*"person\.name".*subtitle \("email"\).*a card/);
  const board = warnings({ people: { ...list, board: { by: 'status', primary: 'email', lines: ['name'] } } });
  assert.equal(board.length, 1, board.join('\n'));
  assert.match(board[0], /a board card/);
  const page = warnings({ people: list }, [
    { kind: 'list', from: 'person', whose: 'manager_id', presentation: { kind: 'cards', primary: 'email', badge: 'name' } },
  ]);
  assert.equal(page.length, 1, page.join('\n'));
  assert.match(page[0], /page "config-person".*a card/);
});

test('where the subtitle is drawn, or the column is not the subtitled one, nothing is said', () => {
  const list = { kind: 'list', from: 'person' };
  assert.deepEqual(
    warnings({ people: { ...list, presentation: { kind: 'cards', primary: 'name', value: 'name', properties: ['name'] } } }),
    [],
  );
  assert.deepEqual(warnings({ people: { ...list, board: { by: 'status', primary: 'name' } } }), []);
  assert.deepEqual(warnings({ people: { ...list, presentation: { kind: 'cards', primary: 'email' } } }), []);
  assert.deepEqual(
    warnings({ people: list }, [
      { kind: 'header', facts: ['name'] },
      { kind: 'card', show: ['name'] },
      { kind: 'fields', show: ['name'] },
    ]),
    [],
  );
});
