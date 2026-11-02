/**
 * `shot --as <role>:<email>` (a field report): an account of the role made with that address, through the
 * accounts door (so verified), signed in, so a row policy that finds a household by email has one to show. Before,
 * `--as` took a bare role (a fresh `shot-<role>@example.invalid`, which owns nothing) or an account already made.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { splitRoleEmail } from '../packages/mistri/src/server/build/shotAccount.js';

test('--as splits a role from the address it is made with, and nothing else', () => {
  assert.deepEqual(splitRoleEmail('agent:Ann@Example.test'), { role: 'agent', email: 'ann@example.test' });
  for (const other of ['agent', 'ann@example.test', 'agent:', ':ann@example.test', 'a:b:c@d.test', 'all'])
    assert.equal(splitRoleEmail(other), undefined, other);
});

function shot(args: string[], env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', resolve('packages/mistri/src/server/index.ts'), 'shot', ...args],
      { timeout: 150_000, killSignal: 'SIGKILL', env: { ...process.env, ...env } },
      (error, out, err) => done({ code: (error as { code?: number } | null)?.code ?? 0, out, err }),
    );
  });
}

test('a household found by email is shown to the account made with that email', { timeout: 200_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tw-shot-as-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const business = join(directory, 'business.db');
  const db = new DatabaseSync(business);
  try {
    db.exec(
      'CREATE TABLE ticket(id INTEGER PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL); ' +
        "INSERT INTO ticket VALUES (1, 'ann@example.test', 'Printer jam'), (2, 'bob@example.test', 'Laptop fan')",
    );
  } finally {
    db.close();
  }
  const app = join(directory, 'app');
  mkdirSync(app);
  writeFileSync(
    join(app, 'app.json'),
    JSON.stringify({
      id: 'desk',
      name: 'Desk',
      connection: 'data',
      resources: { ticket: {} },
      auth: { signUp: 'open', rows: 'policy', roles: { agent: { read: ['ticket'] } } },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
    }),
  );
  const config = join(directory, 'mistri.json');
  writeFileSync(config, JSON.stringify({ connections: [{ id: 'data', name: 'data', url: business }] }));
  const policy = join(directory, 'policy.mjs');
  writeFileSync(
    policy,
    `export default { appId: 'desk', resolveRows(principal) { return { ticket: { groups: [[{ column: 'owner', op: '=', value: principal.email ?? '' }]] } }; } };\n`,
  );
  const env = { XDG_CONFIG_HOME: join(directory, 'xdg') };
  const common = ['--app', app, '--config', config, '--policy', policy, 'tickets', '--text', '--out', join(directory, 'never')];

  const ann = await shot([...common, '--as', 'agent:ann@example.test'], env);
  assert.equal(ann.code, 0, ann.err);
  assert.match(ann.err, /signed in as ann@example\.test, a new "agent" account made with that address, verified/);
  // The page text counts rows rather than quoting them: of two tickets, the one this address owns.
  assert.match(ann.out, /table: .* — 1 row\n/);

  // A bare role is still a fresh account that owns nothing.
  const bare = await shot([...common, '--as', 'agent'], env);
  assert.equal(bare.code, 0, bare.err);
  assert.doesNotMatch(bare.out, /— [12] rows?\n/);

  const admin = await shot([...common, '--as', 'admin:ann@example.test'], env);
  assert.notEqual(admin.code, 0);
  assert.match(admin.err, /has its own address/);
});
