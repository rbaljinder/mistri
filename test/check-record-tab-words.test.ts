/**
 * A record's page tab shares one word with a tab its record's page already has (a related list), and an address
 * names one tab by its word: mistri check refuses the page, naming the way out.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { VALIDATE, validating } from './support/validation.js';

const ROOT = resolve('.');
const ENTRY = join(ROOT, 'packages', 'mistri', 'src', 'server', 'index.ts');

const check = (config: string, dir: string, env: Record<string, string>) =>
  new Promise<{ code: number; text: string }>((done) => {
    const child = validating(['--config', config, '--app', dir, VALIDATE], { ...process.env, ...env });
    execFile(
      process.execPath,
      ['--import', 'tsx', ENTRY, ...child.args],
      { cwd: ROOT, timeout: 120_000, killSignal: 'SIGKILL', env: child.env },
      (error, out, err) => done({ code: (error as { code?: number } | null)?.code ?? 0, text: out + err }),
    );
  });

test('page-tab: a record tab named for a related list is refused; another word is not', { timeout: 300_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-tab-words-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, 'crm.db');
  const raw = new DatabaseSync(db);
  raw.exec(
    'CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT NOT NULL); ' +
      'CREATE TABLE note (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES account(id), body TEXT);',
  );
  raw.close();
  const dir = join(directory, 'crm');
  const page = (file: string) => {
    mkdirSync(dirname(join(dir, 'pages', file)), { recursive: true });
    writeFileSync(
      join(dir, 'pages', file),
      `import { definePage, Empty } from '@mistriwork/mistri/page';\nexport default definePage({ label: 'Tab', reads: ['account'], component: () => <Empty title="x" /> });\n`,
    );
  };
  mkdirSync(dir);
  writeFileSync(
    join(dir, 'app.json'),
    JSON.stringify({
      id: 'crm',
      name: 'Crm',
      connection: 'crm',
      resources: { account: {}, note: {} },
      views: { accounts: { kind: 'list', from: 'account' } },
      home: 'accounts',
    }),
  );
  const config = join(directory, 'mistri.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'crm', url: db }] }));
  const env = { XDG_CONFIG_HOME: join(directory, 'config') };

  page('accounts/[id]/notes.page.tsx');
  const clash = await check(config, dir, env);
  assert.equal(clash.code, 1, clash.text);
  assert.ok(
    clash.text.includes(
      '[page-tab] pages/accounts/[id]/notes.page.tsx: "notes" is already a tab on an accounts record (its related list "Notes"). ' +
        'One word, one tab: rename the file (pages/accounts/[id]/<another word>.page.tsx), or give the related list another title.',
    ),
    clash.text,
  );

  rmSync(join(dir, 'pages'), { recursive: true });
  page('accounts/[id]/map.page.tsx');
  const clean = await check(config, dir, env);
  assert.equal(clean.code, 0, clean.text);
});
