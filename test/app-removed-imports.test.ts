import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { importedFromApp } from '../packages/mistri/src/server/app/appImports.js';

test('importedFromApp reads value names, not types or comments', () => {
  const names = importedFromApp(`
    // import { ghost } from '@mistriwork/mistri/app';
    import { defineApp, type AppConfig, money as cash } from '@mistriwork/mistri/app';
    import type { tones } from '@mistriwork/mistri/app';
    import { other } from './other.js';
  `);
  assert.deepEqual(names, ['defineApp', 'money']);
});

test('an App that imports several removed helpers hears all of them at once, with what replaces each', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-removed-imports-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'features'));
  writeFileSync(
    join(dir, 'app.mjs'),
    `import { defineApp, money, number } from '@mistriwork/mistri/app';\nexport default defineApp({ name: 'X' });\n`,
  );
  writeFileSync(
    join(dir, 'features', 'sales.mjs'),
    `import { relative, tones, lisst } from '@mistriwork/mistri/app';\nexport const a = 1;\n`,
  );
  await assert.rejects(loadApp(dir), (error: Error) => {
    for (const name of ['money', 'number', 'relative', 'tones'])
      assert.match(error.message, new RegExp(`"${name}" — write the rule as data`));
    assert.match(error.message, /features\/sales\.mjs/);
    assert.match(error.message, /"lisst" — did you mean "latest"/);
    assert.match(error.message, /5 imports/);
    return true;
  });
});

test("page('Title', 'resource', [...]) says page() no longer takes a title, in the new form", async () => {
  const { page, document } = await import('../packages/mistri/schema/app.mjs');
  assert.throws(() => page('Leads', 'lead', []), /page\(\) no longer takes a title: it is page\('lead', \[sections\]/);
  assert.throws(() => document('Invoice', 'order', []), /document\(\) no longer takes a title/);
  assert.deepEqual(page('lead', [], { aside: false }), { base: 'lead', sections: [], aside: false });
});
