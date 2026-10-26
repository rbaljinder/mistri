/**
 * How a table or column name is said to a reader: the words of the name alone, never the schema it lives in, and
 * never its snake_case.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { humanName } from '../packages/engine/src/shared/model.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { appAdvisories, type LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

describe('humanName', () => {
  test('a schema-prefixed table is said by its own name', () => {
    assert.equal(humanName('billing.order_line'), 'Order line');
    assert.equal(humanName('public.invoice'), 'Invoice');
    assert.equal(humanName('a.b.event_enum'), 'Event enum');
  });

  test('snake_case, camelCase and known acronyms read as words, and spoken text is left as it is', () => {
    assert.equal(humanName('work_order_id'), 'Work order ID');
    assert.equal(humanName('workOrder'), 'Work order');
    assert.equal(humanName('Open items'), 'Open items');
    assert.equal(humanName(''), '');
  });
});

test('a page over a schema-prefixed table is headed by the table alone', () => {
  const [page] = parsePagesConfig({ pages: [{ id: 'order', base: 'billing.order_line', sections: [{ kind: 'fields' }] }] }, 'pages');
  assert.equal(page.name, 'Order line');
});

describe('[raw-id]', () => {
  const schema = { label: 'Sales', dialect: 'sqlite', readAt: '', foreignKeys: [], tables: [] } as unknown as DatabaseSchema;
  const advice = (label: string, page = 'Deal') =>
    appAdvisories(
      {
        path: 'sales.ts',
        app: parseAppConfig(
          {
            name: 'Sales',
            resources: { deal: {} },
            views: { deals: { kind: 'list', from: 'deal', label } },
            home: 'deals',
            nav: ['deals'],
          },
          'raw',
        ),
        pages: parsePagesConfig({ pages: [{ id: 'deal', label: page, base: 'deal', sections: [{ kind: 'fields' }] }] }, 'pages'),
        sources: {},
      } as unknown as LoadedApp,
      schema,
    ).filter((line) => /raw-id/.test(line));

  test('a label written as an identifier is advised, and words are not', () => {
    assert.equal(advice('billing.order_line').length, 1);
    assert.equal(advice('EVENT_ENUM').length, 1);
    assert.equal(advice('Deals', 'order_line').length, 1);
    assert.equal(advice('Open deals').length, 0);
    assert.equal(advice('Deals').length, 0);
  });
});
