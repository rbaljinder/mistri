/**
 * Text rules on a column (textRules.ts): what an author may write, what a
 * database's CHECK says in the two shapes a form can judge, how the two merge,
 * what a value breaks, and the server holding the stored row to the rule on
 * every write, whatever door it came through.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { authorizeTransaction } from '../packages/mistri/src/server/app/appAccess.js';
import { compileAppDefinitionValidation } from '../packages/mistri/src/server/app/appValidation.js';
import { AppValidationDenied } from '../packages/mistri/src/server/app/appValidationDenied.js';
import { parseAppConfig, resolveResources } from '../packages/mistri/src/shared/app.js';
import { columnTextRule, parseTextRules, textRuleBreak } from '../packages/engine/src/shared/textRules.js';
import { checkTextRule } from '../packages/engine/src/shared/vocabulary.js';

test('a text rule is checked where it is written', () => {
  assert.deepEqual(parseTextRules({ code: { pattern: '^[A-Z]{3}$', message: ' Three capitals. ' }, name: { min: 2, max: 80 } }, 'r'), {
    code: { pattern: '^[A-Z]{3}$', message: 'Three capitals.' },
    name: { min: 2, max: 80 },
  });
  assert.throws(() => parseTextRules({}, 'r'), /not an object/);
  assert.throws(() => parseTextRules({ 'a.b': { min: 1 } }, 'r'), /never a path/);
  assert.throws(() => parseTextRules({ code: { length: 3 } }, 'r'), /"length"; a text rule takes min, max, pattern and message/);
  assert.throws(() => parseTextRules({ code: { min: 0 } }, 'r'), /whole number of characters/);
  assert.throws(() => parseTextRules({ code: { min: 5, max: 2 } }, 'r'), /"min" is more than "max"/);
  assert.throws(() => parseTextRules({ code: { pattern: '(' } }, 'r'), /not a regular expression JavaScript can read/);
  assert.throws(() => parseTextRules({ code: { message: 'Say it' } }, 'r'), /checks nothing/);
});

test('a CHECK in the two simple shapes is a rule; anything more is none', () => {
  assert.deepEqual(checkTextRule('char_length(name) >= 2', 'name'), { min: 2 });
  assert.deepEqual(checkTextRule('(char_length((name)::text) > 2)', 'name'), { min: 3 });
  assert.deepEqual(checkTextRule("((code)::text ~ '^[A-Z]{3}$'::text)", 'code'), { pattern: '^[A-Z]{3}$' });
  assert.deepEqual(checkTextRule("code ~ 'x'", 'code'), { pattern: '[\\s\\S]*(?:x)[\\s\\S]*' });
  assert.equal(checkTextRule('char_length(name) >= 2', 'other'), undefined);
  assert.equal(checkTextRule("char_length(name) >= 2 AND name <> 'no'", 'name'), undefined);
  assert.equal(checkTextRule("code ~* 'x'", 'code'), undefined);
  assert.equal(checkTextRule('char_length(name) <= 9', 'name'), undefined);
});

test("the App's rule sits on the database's key by key, and a value breaks the first part it fails", () => {
  const rule = columnTextRule({ text: { max: 80, min: 2 } }, { min: 3, pattern: '[a-z ]+' })!;
  assert.deepEqual(rule, { max: 80, min: 3, pattern: '[a-z ]+' });
  assert.equal(columnTextRule({}, undefined), undefined);
  assert.equal(textRuleBreak(rule, ''), undefined, "an empty value is NOT NULL's to judge");
  assert.equal(textRuleBreak(rule, null), undefined);
  assert.equal(textRuleBreak(rule, ' ab '), 'min', 'counted after trimming');
  assert.equal(textRuleBreak(rule, 'a'.repeat(81)), 'max');
  assert.equal(textRuleBreak(rule, 'abc!'), 'pattern', 'the whole value matches, not a part');
  assert.equal(textRuleBreak(rule, 'abc def'), undefined);
  assert.equal(textRuleBreak({ max: 2 }, '😀😀'), undefined, 'characters as a person counts them');
});

test('served text rules: a resource names text columns only, and every write is held to the rule', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-text-rules-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'rules.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE product (id INTEGER PRIMARY KEY, code TEXT NOT NULL, name TEXT, qty INTEGER);
    INSERT INTO product VALUES (1, 'ABC', 'Widget', 1);`);
  db.close();
  const adapter = new SqliteAdapter(file, 'rules');
  t.after(() => adapter.close());
  const schema = await adapter.introspect();
  const app = (text: unknown) =>
    parseAppConfig(
      {
        id: 'rules',
        name: 'Rules',
        resources: { product: { access: 'write', text } },
        views: { products: { kind: 'list', from: 'product' } },
        home: 'products',
        nav: ['products'],
      },
      'rules',
    );

  assert.match(
    resolveResources(app({ qty: { max: 3 } }), schema).problems.join('\n'),
    /text "qty" is INTEGER; a text rule checks a text column/,
  );
  assert.match(resolveResources(app({ nope: { max: 3 } }), schema).problems.join('\n'), /"product" has no column "nope"/);
  const served = app({ code: { pattern: '[A-Z]{3}', message: 'Three capitals.' }, name: { min: 2 } });
  assert.deepEqual(resolveResources(served, schema).resources.product?.text?.code, { pattern: '[A-Z]{3}', message: 'Three capitals.' });

  const validation = compileAppDefinitionValidation(schema, served);
  const access = { readable: new Set(['product']), writable: new Set(['product']), validation };
  const write = (work: (tx: ReturnType<typeof authorizeTransaction>) => Promise<unknown>) =>
    adapter.transaction!((tx) => work(authorizeTransaction(schema, access, tx)));
  await assert.rejects(
    () => write((tx) => tx.update({ table: 'product', key: { id: 1 }, values: { code: 'abcd' } })),
    (error) => error instanceof AppValidationDenied && error.fields.includes('code'),
  );
  await assert.rejects(
    () => write((tx) => tx.insert({ table: 'product', values: { code: 'XYZ', name: 'W' } })),
    (error) => error instanceof AppValidationDenied && error.fields.includes('name'),
  );
  await write((tx) => tx.insert({ table: 'product', values: { code: 'XYZ', name: 'Wing' } }));
  const check = new DatabaseSync(file);
  t.after(() => check.close());
  assert.deepEqual(
    check
      .prepare('SELECT code FROM product ORDER BY id')
      .all()
      .map((row) => row.code),
    ['ABC', 'XYZ'],
  );
});
