/**
 * A value component's `label(value)` says its column's vocabulary as words
 * (server/app/valueLabels.ts): evaluated once over the catalog's values,
 * served as the rule's `values` under the author's own, refused when it throws
 * or answers badly, and advised on where it cannot be used.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveDisplay } from '../packages/mistri/src/shared/app.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { learnValueLabels, valueLabelFindings } from '../packages/mistri/src/server/app/valueLabels.js';
import type { ColumnMeta, DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const ROOT = resolve('.');
const work = mkdtempSync(join(tmpdir(), 'tablewalk-value-label-'));
after(() => rmSync(work, { recursive: true, force: true }));
mkdirSync(join(work, 'node_modules'));
mkdirSync(join(work, 'node_modules', '@mistriwork'), { recursive: true });
symlinkSync(join(ROOT, 'packages', 'mistri'), join(work, 'node_modules', '@mistriwork', 'mistri'), 'dir');

const STATUS = ['CREDIT_STATUS_PENDING', 'CREDIT_STATUS_APPROVED', 'CREDIT_STATUS_DECLINED'];
const column = (name: string, extra: Partial<ColumnMeta> = {}): ColumnMeta => ({
  name,
  type: 'TEXT',
  nullable: true,
  primaryKey: false,
  ...extra,
});
const schema: DatabaseSchema = {
  label: 'Credit',
  dialect: 'postgres',
  readAt: '',
  foreignKeys: [],
  tables: [
    {
      id: 'credit',
      name: 'credit',
      schema: '',
      isView: false,
      columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }, column('status', { allowed: STATUS }), column('note')],
    },
  ],
};

async function app(name: string, module: string, display = '{ component: status }'): Promise<ReturnType<typeof loadApp>> {
  const at = join(work, name);
  mkdirSync(join(at, 'widgets'), { recursive: true });
  writeFileSync(join(at, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(join(at, 'widgets', 'Status.jsx'), module);
  writeFileSync(
    join(at, 'app.mjs'),
    [
      "import { component, defineApp } from '@mistriwork/mistri/app';",
      "const status = component('status', { module: './widgets/Status.jsx', kind: 'value' });",
      `export default defineApp({ id: 'credit', name: 'Credit', resources: { credit: { display: { status: ${display} } } },`,
      "  views: { credits: { kind: 'list', from: 'credit' } }, home: 'credits', nav: ['credits'] });",
    ].join('\n'),
  );
  return loadApp(at);
}

const draw = 'export default function Status({ value }) { return <b>{value}</b>; }\n';
const WORDS = [
  "import { Value } from '@mistriwork/mistri/ui';",
  "const WORDS = { CREDIT_STATUS_PENDING: 'Pending review' };",
  "export function label(value) { return WORDS[value] ?? value.replace(/^CREDIT_STATUS_/, '').toLowerCase(); }",
  draw,
].join('\n');

describe("a value component's label", () => {
  test("says the column's vocabulary as words, which the rule is served with", async () => {
    const loaded = await app('words', WORDS);
    // Before it is learned the stored codes stand, as they did.
    assert.equal(resolveDisplay(loaded.app, schema).display['credit.status'].values?.CREDIT_STATUS_APPROVED, undefined);
    await learnValueLabels(loaded, schema);
    const rule = resolveDisplay(loaded.app, schema).display['credit.status'];
    assert.equal(rule.values?.CREDIT_STATUS_PENDING, 'Pending review');
    assert.equal(rule.values?.CREDIT_STATUS_APPROVED, 'approved');
    assert.deepEqual(valueLabelFindings(loaded.app), {
      problems: [],
      warnings: [],
    });
  });

  test("yields to the author's own values key by key", async () => {
    const loaded = await app('authored', WORDS, "{ component: status, values: { CREDIT_STATUS_PENDING: 'Waiting' } }");
    await learnValueLabels(loaded, schema);
    const rule = resolveDisplay(loaded.app, schema).display['credit.status'];
    assert.equal(rule.values?.CREDIT_STATUS_PENDING, 'Waiting');
    assert.equal(rule.values?.CREDIT_STATUS_DECLINED, 'declined');
  });

  test('a label that throws, is not text, or is too long refuses the check, naming the value', async () => {
    const loaded = await app(
      'bad',
      [
        'export function label(value) {',
        "  if (value.endsWith('PENDING')) throw new Error('no word for this');",
        "  if (value.endsWith('APPROVED')) return 7;",
        "  return 'x'.repeat(81);",
        '}',
        draw,
      ].join('\n'),
    );
    await learnValueLabels(loaded, schema);
    const { problems } = valueLabelFindings(loaded.app);
    assert.equal(problems.length, 3);
    assert.match(problems.join('\n'), /label\("CREDIT_STATUS_PENDING"\) in \.\/widgets\/Status\.jsx threw: no word for this/);
    assert.match(problems.join('\n'), /"CREDIT_STATUS_APPROVED"\) .* something other than text/);
    assert.match(problems.join('\n'), /"CREDIT_STATUS_DECLINED"\) .* 81 characters; a word is at most 80/);
  });

  test('a label that returns a Promise is refused: it is synchronous', async () => {
    const loaded = await app('async', `export async function label(value) { return value; }\n${draw}`);
    await learnValueLabels(loaded, schema);
    assert.match(valueLabelFindings(loaded.app).problems[0], /returned a Promise; label is synchronous/);
  });

  test('a label on a free-text column is not used, and is advised on', async () => {
    const loaded = await app('free', WORDS);
    // The same component, on the column that holds a note.
    const display = loaded.app.resources!.credit.display!;
    display.note = display.status;
    delete display.status;
    await learnValueLabels(loaded, schema);
    assert.match(valueLabelFindings(loaded.app).warnings[0], /\[value-label-open\].*"note" has no vocabulary/);
    assert.deepEqual(loaded.app.valueLabels, {});
  });

  test('a value component with no label and no values on a vocabulary is advised on', async () => {
    const loaded = await app('missing', draw);
    await learnValueLabels(loaded, schema);
    assert.match(valueLabelFindings(loaded.app).warnings[0], /\[value-words-missing\].*"status"/);
    const said = await app('said', draw, "{ component: status, values: { CREDIT_STATUS_PENDING: 'Pending' } }");
    await learnValueLabels(said, schema);
    assert.deepEqual(valueLabelFindings(said.app).warnings, []);
  });

  test('a value is asked once: a second learning runs nothing', async () => {
    const loaded = await app('once', WORDS);
    await learnValueLabels(loaded, schema);
    const first = structuredClone(loaded.app.valueLabels);
    await learnValueLabels(loaded, schema);
    assert.deepEqual(loaded.app.valueLabels, first);
  });
});
