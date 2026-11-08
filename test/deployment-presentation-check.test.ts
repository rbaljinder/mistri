/* `mistri check` and `mistri shot` read the config's "presentation" as a start does: the same refusals in the same
   words, and the name check reports is the one the deployment serves. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ENTRY = join(resolve('.'), 'packages', 'mistri', 'src', 'server', 'index.ts');
const work = mkdtempSync(join(tmpdir(), 'mistri-presentation-check-'));
after(() => rmSync(work, { recursive: true, force: true }));

const db = join(work, 'bank.db');
const source = new DatabaseSync(db);
source.exec('CREATE TABLE account (id INTEGER PRIMARY KEY, holder TEXT NOT NULL);');
source.close();
const appDir = join(work, 'app');
mkdirSync(appDir);
writeFileSync(
  join(appDir, 'app.json'),
  JSON.stringify({
    id: 'bank',
    name: 'Retail Banking',
    connection: 'ledger',
    resources: { account: {} },
    views: { accounts: { kind: 'list', from: 'account', label: 'Accounts', show: ['holder'] } },
    home: 'accounts',
    nav: ['accounts'],
  }),
);
const configOf = (file: string, presentation: unknown) => {
  const path = join(work, file);
  writeFileSync(path, JSON.stringify({ connections: [{ name: 'ledger', url: db }], presentation }));
  return path;
};

function run(args: string[]): Promise<{ code: number; text: string }> {
  return new Promise((done) =>
    execFile(process.execPath, ['--import', 'tsx', ENTRY, ...args], { cwd: resolve('.'), timeout: 120_000 }, (error, out, err) =>
      done({ code: (error as { code?: number } | null)?.code ?? 0, text: out + err }),
    ),
  );
}

test('check refuses a theme the App cannot wear, in the words a start uses', async () => {
  const config = configOf('theme.json', { bank: { theme: 'nope' } });
  const { code, text } = await run(['check', '--app', appDir, '--config', config]);
  assert.notEqual(code, 0);
  assert.match(text, /"presentation\.bank"\.theme "nope" is not a built-in theme or one this App registers in ui\.customThemes/);
});

test('check refuses a presentation keyed by an App the server does not serve', async () => {
  const config = configOf('stray.json', { ghost: { name: 'Ghost' } });
  const { code, text } = await run(['check', '--app', appDir, '--config', config]);
  assert.notEqual(code, 0);
  assert.match(text, /"presentation\.ghost" names no App this server serves \("bank"\)\. Key each presentation by the App's id\./);
});

test('check judges the overlaid App and says that a presentation applied', async () => {
  const config = configOf('ok.json', { bank: { name: 'Northside Bank', theme: 'mono' } });
  const { code, text } = await run(['check', '--app', appDir, '--config', config]);
  assert.equal(code, 0, text);
  assert.match(text, /Checking "Northside Bank" in /);
  assert.match(text, /presentation: name, theme from .*ok\.json/);
  assert.doesNotMatch(text, /Retail Banking/);
});

test('shot reads the presentation as a start does, before it serves anything', async (t) => {
  const bad = await run(['shot', '--app', appDir, '--config', configOf('shot-theme.json', { bank: { theme: 'nope' } }), '/']);
  if (/npx playwright install/.test(bad.text)) return t.skip('no Chromium to shoot with');
  assert.notEqual(bad.code, 0);
  assert.match(bad.text, /"presentation\.bank"\.theme "nope" is not a built-in theme/);
  const stray = await run(['shot', '--app', appDir, '--config', configOf('shot-stray.json', { ghost: { name: 'x' } }), '/']);
  assert.notEqual(stray.code, 0);
  assert.match(stray.text, /"presentation\.ghost" names no App this server serves/);
});
