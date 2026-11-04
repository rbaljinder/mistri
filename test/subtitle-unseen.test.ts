/**
 * A display rule's `subtitle` is drawn in a list's cell, a block of fields and under a headline figure. Cards, a
 * board's cards, a record's header facts and a card section do not draw it, so `check` says so (`[subtitle-unseen]`)
 * where a column with one is shown there, rather than leaving the second line silently dropped.
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

test('a subtitled column shown in a card, a board, a header or a card section is warned about', () => {
  const list = { kind: 'list', from: 'person' };
  const cards = warnings({ people: { ...list, presentation: { kind: 'cards', primary: 'name' } } });
  assert.equal(cards.length, 1, cards.join('\n'));
  assert.match(cards[0], /view "people".*"person\.name".*subtitle \("email"\).*a card/);
  const board = warnings({ people: { ...list, board: { by: 'status', primary: 'name' } } });
  assert.equal(board.length, 1, board.join('\n'));
  assert.match(board[0], /a board card/);
  const page = warnings({ people: list }, [
    { kind: 'header', facts: ['name'] },
    { kind: 'card', show: ['name'] },
  ]);
  assert.equal(page.length, 2, page.join('\n'));
  assert.match(page.join('\n'), /header facts/);
  assert.match(page.join('\n'), /a card section/);
});

test('where the subtitle is drawn, or the column is not the subtitled one, nothing is said', () => {
  const list = { kind: 'list', from: 'person' };
  assert.deepEqual(warnings({ people: { ...list, presentation: { kind: 'cards', primary: 'email' } } }), []);
  assert.deepEqual(warnings({ people: list }, [{ kind: 'fields', show: ['name'] }]), []);
});
