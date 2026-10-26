/**
 * `check --design --fix` (checkFix.ts): it deletes exactly what the restated
 * warnings name, as written, and nothing it cannot find once per restatement.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixRestated } from '../packages/mistri/src/server/build/checkFix.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { restatedDefaults } from '../packages/engine/src/shared/displayDefaults.js';
import type { ColumnMeta, DatabaseSchema, TableMeta } from '../packages/engine/src/shared/schema.js';

const col = (name: string, type: string, more: Partial<ColumnMeta> = {}): ColumnMeta =>
  ({ name, type, primaryKey: false, nullable: true, ...more }) as ColumnMeta;
const table = (name: string, columns: ColumnMeta[]): TableMeta => ({ id: name, name, schema: '', isView: false, columns }) as TableMeta;
const schema = {
  tables: [
    table('customer', [col('id', 'INTEGER', { primaryKey: true, nullable: false }), col('name', 'TEXT', { nullable: false })]),
    table('bike', [col('id', 'INTEGER', { primaryKey: true, nullable: false }), col('name', 'TEXT', { nullable: false })]),
    table('work_order', [
      col('id', 'INTEGER', { primaryKey: true, nullable: false }),
      col('summary', 'TEXT', { nullable: false }),
      col('status', 'TEXT', { nullable: false, default: "'booked'", allowed: ['booked', 'in_progress', 'on_hold', 'done'] }),
      col('labor_charge', 'INTEGER'),
      col('parts_cost', 'INTEGER'),
    ]),
  ],
  foreignKeys: [],
} as unknown as DatabaseSchema;

/* The source as a person wrote it, and the same App as the loader would read it. */
const SOURCE = `import { defineApp } from '@mistriwork/mistri/app';

export default defineApp({
  id: 'shop',
  name: 'Shop',
  connection: 'shop',
  resources: {
    customer: { access: 'write', recordLabel: 'name' },
    bike: { recordLabel: 'name', access: 'write' },
    work_order: {
      access: 'write',
      display: {
        labor_charge: { format: 'money' },
        status: { tone: { booked: 'neutral', in_progress: 'info', on_hold: 'warn', done: 'good' }, icons: { done: 'check-circle' } },
      },
    },
  },
  views: { orders: { kind: 'list', from: 'work_order' } },
  home: 'orders',
});
`;
const APP = {
  id: 'shop',
  name: 'Shop',
  connection: 'shop',
  resources: {
    customer: { access: 'write', recordLabel: 'name' },
    bike: { recordLabel: 'name', access: 'write' },
    work_order: {
      access: 'write',
      display: {
        labor_charge: { format: 'money' },
        status: { tone: { booked: 'neutral', in_progress: 'info', on_hold: 'warn', done: 'good' }, icons: { done: 'check-circle' } },
      },
    },
  },
  views: { orders: { kind: 'list', from: 'work_order' } },
  home: 'orders',
};

const inDir = (files: Record<string, string>, run: (dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-fix-'));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('a whole restated rule goes with its key, a partial one keeps what the App adds, and an emptied anchor goes too', () => {
  inDir({ 'app.ts': SOURCE }, (dir) => {
    const app = parseAppConfig(APP, 'shop');
    assert.equal(restatedDefaults(app, schema).length, 4);
    const result = fixRestated(app, schema, dir);
    assert.deepEqual(result.left, []);
    assert.equal(result.fixed.length, 4, result.fixed.join('\n'));
    const text = readFileSync(join(dir, 'app.ts'), 'utf8');
    assert.match(text, /customer: \{ access: 'write' \},/);
    assert.match(text, /bike: \{ access: 'write' \},/);
    assert.doesNotMatch(text, /labor_charge|recordLabel|tone:/);
    assert.match(text, /status: \{ icons: \{ done: 'check-circle' \} \},/);
    // What is left still parses as the App with nothing restated.
    const fixed = parseAppConfig(
      {
        ...APP,
        resources: {
          customer: { access: 'write' },
          bike: { access: 'write' },
          work_order: { access: 'write', display: { status: { icons: { done: 'check-circle' } } } },
        },
      },
      'shop',
    );
    assert.deepEqual(restatedDefaults(fixed, schema), []);
    // Run twice, nothing more to do.
    assert.deepEqual(fixRestated(fixed, schema, dir), { fixed: [], left: [] });
  });
});

test('a display emptied of every rule goes whole', () => {
  const source = SOURCE.replace(/, icons: \{ done: 'check-circle' \}/, '');
  inDir({ 'app.ts': source }, (dir) => {
    const app = parseAppConfig(
      {
        ...APP,
        resources: {
          ...APP.resources,
          work_order: {
            access: 'write',
            display: { labor_charge: { format: 'money' }, status: { tone: APP.resources.work_order.display.status.tone } },
          },
        },
      },
      'shop',
    );
    fixRestated(app, schema, dir);
    const text = readFileSync(join(dir, 'app.ts'), 'utf8');
    assert.doesNotMatch(text, /display/);
    assert.match(text, /work_order: \{\s*access: 'write',?\s*\},/);
  });
});

test('a declaration written once and shared, or not found as written, is left for the person', () => {
  const shared = SOURCE.replace("customer: { access: 'write', recordLabel: 'name' },", 'customer: named,')
    .replace("bike: { recordLabel: 'name', access: 'write' },", 'bike: named,')
    .replace('export default', "const named = { access: 'write', recordLabel: 'name' } as const;\n\nexport default");
  inDir({ 'app.ts': shared }, (dir) => {
    const result = fixRestated(parseAppConfig(APP, 'shop'), schema, dir);
    assert.equal(result.left.length, 2, result.left.join('\n'));
    for (const line of result.left) assert.match(line, /recordLabel "name".*written in 1 places?; delete it by hand/);
    const text = readFileSync(join(dir, 'app.ts'), 'utf8');
    assert.match(text, /recordLabel: 'name'/);
    assert.doesNotMatch(text, /labor_charge/);
  });
});

test('two neighbours ending a one-line object go with the comma before them', () => {
  const campaignSchema = {
    tables: [
      table('campaign', [
        col('id', 'INTEGER', { primaryKey: true, nullable: false }),
        col('name', 'TEXT', { nullable: false }),
        col('starts_on', 'DATE'),
        col('ends_on', 'DATE'),
      ]),
    ],
    foreignKeys: [],
  } as unknown as DatabaseSchema;
  const source = `import { defineApp } from '@mistriwork/mistri/app';

export default defineApp({
  id: 'shop',
  name: 'Shop',
  connection: 'shop',
  resources: {
    campaign: {
      labels: { name: 'Campaign', starts_on: 'Starts', ends_on: 'Ends' },
    },
  },
  views: { campaigns: { kind: 'list', from: 'campaign' } },
  home: 'campaigns',
});
`;
  inDir({ 'app.ts': source }, (dir) => {
    const app = parseAppConfig(
      {
        id: 'shop',
        name: 'Shop',
        connection: 'shop',
        resources: { campaign: { labels: { name: 'Campaign', starts_on: 'Starts', ends_on: 'Ends' } } },
        views: { campaigns: { kind: 'list', from: 'campaign' } },
        home: 'campaigns',
      },
      'shop',
    );
    // A label the warnings leave out (one said through a message, a translation) is no deletion either.
    const kept = fixRestated(app, campaignSchema, dir, (warning) => warning.includes('"ends_on"'));
    assert.equal(kept.fixed.length, 1, [...kept.fixed, ...kept.left].join('\n'));
    assert.match(readFileSync(join(dir, 'app.ts'), 'utf8'), /labels: \{ name: 'Campaign', ends_on: 'Ends' \},/);
    writeFileSync(join(dir, 'app.ts'), source);
    const result = fixRestated(app, campaignSchema, dir);
    assert.equal(result.fixed.length, 2, [...result.fixed, ...result.left].join('\n'));
    const text = readFileSync(join(dir, 'app.ts'), 'utf8');
    assert.match(text, /labels: \{ name: 'Campaign' \},/);
  });
});

test("a test or a seed beside the App that writes the same rule is not the App's, and the rule still goes", () => {
  inDir({ 'app.ts': SOURCE }, (dir) => {
    // The same declarations, as a permissions test and a seed script keep them: neither module authors the App.
    const copy =
      "export const work_order = { display: { labor_charge: { format: 'money' } } };\nexport const bike = { recordLabel: 'name', access: 'write' };\n";
    mkdirSync(join(dir, 'tests'));
    mkdirSync(join(dir, 'db'));
    writeFileSync(join(dir, 'tests', 'authorization.test.mjs'), copy);
    writeFileSync(join(dir, 'db', 'seed.mjs'), copy);
    const result = fixRestated(parseAppConfig(APP, 'shop'), schema, dir);
    assert.deepEqual(result.left, []);
    assert.equal(result.fixed.length, 4, result.fixed.join('\n'));
    assert.doesNotMatch(readFileSync(join(dir, 'app.ts'), 'utf8'), /labor_charge|recordLabel/);
    for (const kept of ['tests/authorization.test.mjs', 'db/seed.mjs']) assert.equal(readFileSync(join(dir, kept), 'utf8'), copy);
  });
});

/* A payment as a field report wrote it: a column the conventions dress, a vocabulary said as its own words, and
   a note beside them; the fix once left `method: {}` and `display: {}` behind and broke a display whose first
   rule carried a comment. */
const paymentSchema = {
  tables: [
    table('payment', [
      col('id', 'INTEGER', { primaryKey: true, nullable: false }),
      col('amount', 'INTEGER'),
      col('note', 'TEXT'),
      col('status', 'TEXT', { allowed: ['pending', 'paid', 'refunded'] }),
      col('method', 'TEXT', { allowed: ['card', 'bank_transfer'] }),
    ]),
  ],
  foreignKeys: [],
} as unknown as DatabaseSchema;
const paymentApp = (display: string) => {
  const source = `import { defineApp } from '@mistriwork/mistri/app';

export default defineApp({
  id: 'shop',
  name: 'Shop',
  connection: 'shop',
  resources: {
    payment: {
      access: 'write',
      ${display}
    },
  },
  views: { payments: { kind: 'list', from: 'payment' } },
  home: 'payments',
});
`;
  return {
    source,
    read: (text: string) => new Function(text.replace(/^import .*$/m, '').replace('export default defineApp(', 'return ('))(),
  };
};

test('a display whose every rule is restated goes whole, nested values and all, and what is left parses', () => {
  const { source, read } = paymentApp(`display: {
        status: { tone: { pending: 'warn', paid: 'good', refunded: 'neutral' } },
        amount: { format: 'money' },
        method: {
          values: { card: 'Card', bank_transfer: 'Bank transfer' },
        },
      },`);
  inDir({ 'app.ts': source }, (dir) => {
    const app = parseAppConfig(read(source), 'shop');
    const result = fixRestated(app, paymentSchema, dir);
    assert.deepEqual(result.left, []);
    assert.equal(result.fixed.length, 4, result.fixed.join('\n'));
    const text = readFileSync(join(dir, 'app.ts'), 'utf8');
    assert.doesNotMatch(text, /display|method|\{\s*\}/);
    assert.match(text, /payment: \{\n\s*access: 'write',\n\s*\},/);
    assert.deepEqual(restatedDefaults(parseAppConfig(read(text), 'shop'), paymentSchema), []);
  });
});

test('a display of restated and kept rules keeps only what the App adds, and an emptied rule goes with its key', () => {
  const { source, read } = paymentApp(`display: { amount: { format: 'money' } /* cents */, note: { subtitle: 'status' },
        status: { tone: { pending: 'warn', paid: 'good', refunded: 'neutral' }, icons: { paid: 'check-circle' } },
        method: { values: { card: 'Card', bank_transfer: 'Bank transfer' } } },`);
  inDir({ 'app.ts': source }, (dir) => {
    const app = parseAppConfig(read(source), 'shop');
    const result = fixRestated(app, paymentSchema, dir);
    assert.deepEqual(result.left, []);
    assert.equal(result.fixed.length, 4, result.fixed.join('\n'));
    const text = readFileSync(join(dir, 'app.ts'), 'utf8');
    assert.match(text, /display: \{ note: \{ subtitle: 'status' \},\n\s*status: \{ icons: \{ paid: 'check-circle' \} \} \},/);
    assert.doesNotMatch(text, /amount|cents|method|\{\s*\}/);
    const fixed = parseAppConfig(read(text), 'shop');
    assert.deepEqual(restatedDefaults(fixed, paymentSchema), []);
    assert.deepEqual(fixRestated(fixed, paymentSchema, dir), { fixed: [], left: [] });
  });
});
