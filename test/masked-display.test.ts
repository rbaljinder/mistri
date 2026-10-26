/**
 * A display rule that masks a column — `masked: true`, or only the
 * values that start with a prefix — and the record's name that reads it.
 * The name is computed in the statement (recordLabel.ts), so the mask is
 * too: judged here on real rows in SQLite and on each engine's statement.
 * Presentation only: the column itself still reads its value.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { MYSQL_STYLE, POSTGRES_STYLE } from '../packages/engine/src/shared/filter.js';
import { parseAppConfig, resolveResources, withLabelTemplates } from '../packages/mistri/src/shared/app.js';
import { MASK } from '../packages/engine/src/shared/model.js';
import { compileView, withViewLabels } from '../packages/engine/src/shared/view.js';
import { textToView } from '../packages/engine/src/shared/viewtext.js';
import { labelPath } from '../packages/engine/src/shared/schema.js';
import { parseLabelTemplate } from '../packages/engine/src/shared/recordLabel.js';

const WHERE = 'test/app.json';

async function vault(t: import('node:test').TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-masked-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'vault.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE api_key (id INTEGER PRIMARY KEY, token TEXT);
    CREATE TABLE secret (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sealed TEXT);
    CREATE TABLE grant_line (id INTEGER PRIMARY KEY, secret_id INTEGER REFERENCES secret(id), key_id INTEGER REFERENCES api_key(id));
    INSERT INTO api_key VALUES (1, 'sk_live_abcdef'), (2, NULL);
    INSERT INTO secret VALUES (1, 'Deploy', 'ENC:QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo='), (2, 'Plain', 'visible');
    INSERT INTO grant_line VALUES (1, 1, 1), (2, 2, 2);
  `);
  db.close();
  const adapter = new SqliteAdapter(file, 'vault');
  t.after(() => adapter.close());
  return { adapter, schema: await adapter.introspect() };
}

const app = (resources: Record<string, unknown>) =>
  parseAppConfig({ name: 'x', resources, views: { keys: { kind: 'list', from: 'api_key' } }, home: 'keys', nav: ['keys'] }, WHERE);

test('a masked rule is a placeholder and nothing else, and its prefix is text a statement can carry', () => {
  const rule = (display: unknown) => () => app({ api_key: { display: { token: display } } });
  assert.doesNotThrow(rule({ masked: true }));
  assert.doesNotThrow(
    rule({ masked: { prefix: 'ENC:' }, tone: { '*': 'neutral' } }),
    'a prefix leaves other values to the rest of the rule',
  );
  assert.throws(rule({ masked: true, tone: { '*': 'good' } }), /"masked: true".*takes no "tone"/);
  // One key for a mask: the old format word is not a format.
  assert.throws(rule({ format: 'masked' }), /a "format" of "masked"/);
  assert.throws(rule({ masked: { prefix: '' } }), /not true \(every value\) or \{ prefix \}/);
  assert.throws(rule({ masked: { prefix: 'a}b' } }), /not true \(every value\) or \{ prefix \}/);
  assert.throws(rule({ masked: { start: 'ENC:' } }), /"masked"/);
});

test("an authored template does not write a mask: that is the column's rule to say", async (t) => {
  const { schema } = await vault(t);
  assert.match(resolveResources(app({ api_key: { recordLabel: 'Key {token|masked}' } }), schema).problems.join('\n'), /writes a mask/);
});

test('a record named by a masked column says the mask, computed in the statement', async (t) => {
  const { adapter, schema } = await vault(t);
  const def = app({
    api_key: { recordLabel: 'token', display: { token: { masked: true } } },
    secret: { display: { sealed: { masked: { prefix: 'ENC:' } } }, recordLabel: '{name}: {sealed}' },
    grant_line: {},
  });
  const served = withLabelTemplates(def, schema);
  const table = (name: string) => served.tables.find((candidate) => candidate.name === name)!;
  // Masked whole, the name would be one placeholder for every key: it is the noun and key instead.
  assert.equal(table('api_key').labelTemplate, 'API key #{id}');
  assert.equal(labelPath(served, table('api_key'), 'token'), '$label', 'the name is read where it is computed, never from the column');
  assert.equal(table('secret').labelTemplate, '{name}: {sealed|masked:ENC:}');
  assert.deepEqual(parseLabelTemplate(table('secret').labelTemplate!), {
    parts: [{ path: 'name' }, { text: ': ' }, { path: 'sealed', mask: { prefix: 'ENC:' } }],
    paths: ['name', 'sealed'],
  });

  const view = withViewLabels(
    served,
    textToView(served, 'grant_line show id, secret_id.$label, key_id.$label, secret_id.sealed sort id').view!,
  );
  const rows = (await adapter.runView(view)).rows;
  assert.deepEqual(
    rows.map((row) => row['secret_id.$label']),
    [`Deploy: ENC:${MASK}`, 'Plain: visible'],
  );
  assert.deepEqual(
    rows.map((row) => row['key_id.$label']),
    ['API key #1', 'API key #2'],
  );
  // Presentation only: the column reads its value, which the browser draws as the mask.
  assert.match(String(rows[0]['secret_id.sealed']), /^ENC:QUJD/);
  // Searching the name searches what it says, not the ciphertext.
  const found = withViewLabels(served, textToView(served, 'secret show id where $label contains QUJD').view!);
  assert.deepEqual((await adapter.runView(found)).rows, []);

  const sql = (style: typeof POSTGRES_STYLE) =>
    compileView(served, { ...view, filter: undefined, orderBy: undefined, columns: [{ path: 'secret_id.$label' }] }, style).text;
  assert.match(
    sql(POSTGRES_STYLE),
    /CASE WHEN SUBSTR\(CAST\("secret_1"\."sealed" AS TEXT\), 1, 4\) = 'ENC:' THEN 'ENC:••••••' ELSE COALESCE\(/,
  );
  assert.match(sql(MYSQL_STYLE), /CASE WHEN SUBSTR\(CAST\(`secret_1`\.`sealed` AS CHAR\), 1, 4\) = 'ENC:'/);
});

test('a template naming a column masked whole keeps its words and says the placeholder where the value was', async (t) => {
  const { adapter, schema } = await vault(t);
  const served = withLabelTemplates(app({ api_key: { recordLabel: 'Key {id} {token}', display: { token: { masked: true } } } }), schema);
  const view = withViewLabels(served, textToView(served, 'api_key show $label sort id').view!);
  assert.deepEqual(
    (await adapter.runView(view)).rows.map((row) => row.$label),
    [`Key 1 ${MASK}`, 'Key 2 '],
  );
});
