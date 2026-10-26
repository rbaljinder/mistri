/**
 * UX-1: an App served before its schema was applied — the quickstart's, run
 * before `migrate up` — is refused at start, naming the tables it declares and
 * the command that makes them, rather than listening with warnings that
 * scroll past and screens that each answer with an error.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';

const ROOT = resolve('.');
/* An App's starts are mistri's (test/support/bins.ts). */
const ENTRY = join(ROOT, 'packages', 'mistri', 'src', 'server', 'index.ts');
const work = mkdtempSync(join(tmpdir(), 'tablewalk-missing-tables-'));
after(() => rmSync(work, { recursive: true, force: true }));

function serve(cwd: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done, reject) => {
    execFile(
      process.execPath,
      ['--import', join(ROOT, 'node_modules/tsx/dist/loader.mjs'), ENTRY, '--app', '.', '--config', 'mistri.json', '--port', '0'],
      { cwd, timeout: 60_000, killSignal: 'SIGKILL', env: { ...process.env, XDG_CONFIG_HOME: join(work, 'xdg'), MISTRI_OPEN: '' } },
      (error, out, err) => {
        if (error && (error as { killed?: boolean }).killed) {
          reject(new Error(`the server started instead of refusing:\n${out}\n${err}`));
          return;
        }
        done({ code: (error as { code?: number } | null)?.code ?? 0, out, err });
      },
    );
  });
}

test(
  'an App whose declared tables its connection lacks is refused at start, with the command that makes them',
  { timeout: 90_000 },
  async () => {
    const dir = join(work, 'billing');
    mkdirSync(dir);
    const db = join(dir, 'billing.db');
    new DatabaseSync(db).close();
    writeFileSync(join(dir, 'mistri.json'), JSON.stringify({ connections: [{ name: 'billing', url: db }] }));
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({
        id: 'billing',
        name: 'Billing',
        connection: 'billing',
        resources: { customer: {}, invoice: {} },
        views: { invoices: { kind: 'list', from: 'invoice' } },
        home: 'invoices',
      }),
    );
    const ran = await serve(dir);
    assert.notEqual(ran.code, 0, ran.out);
    assert.match(
      ran.err,
      /App error: .*"Billing" declares the tables "customer" and "invoice", which billing does not have\. Apply the schema first: mistri migrate up --app \. /,
    );
    assert.doesNotMatch(ran.out, /Listening on/);
  },
);
