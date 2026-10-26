/**
 * Sign-in state across the instances of one deployment (auth/signInState.ts):
 * two processes serving the same App over the same database, with the cache
 * the config names. A receipt locked by failures counted on one is locked on
 * the other — the guesses came from many addresses, so no per-address budget
 * is what stopped them — and a status step-up proved on one opens the details
 * on the other, for that browser only.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { startFakeValkey } from './support/fakeValkey.js';

const CHILD = fileURLToPath(new URL('./support/signInStateChild.ts', import.meta.url));

async function instance(t: TestContext, directory: string, cache: string): Promise<string> {
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', CHILD, directory, cache], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => {
    child.kill();
  });
  let errors = '';
  child.stderr!.on('data', (chunk) => {
    errors += String(chunk);
  });
  const port = await new Promise<string>((resolve, reject) => {
    let out = '';
    child.stdout!.on('data', (chunk) => {
      out += String(chunk);
      const line = /^(\d+)\n/.exec(out);
      if (line) resolve(line[1]);
    });
    child.once('exit', (code) => reject(new Error(`instance exited ${code}: ${errors.slice(-2000)}`)));
  });
  return `http://127.0.0.1:${port}`;
}

let visitor = 0;
/** One request from a fresh address, with this browser's cookies. */
async function post(base: string, path: string, body: unknown, jar = new Map<string, string>()) {
  const cookies = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
    headers: {
      'content-type': 'application/json',
      origin: base,
      'x-forwarded-for': `203.0.113.${(++visitor % 250) + 1}`,
      ...(cookies ? { cookie: cookies } : {}),
    },
  });
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(';')[0];
    const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
    if (!value || /Max-Age=0/.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
  const raw = await response.text();
  return { status: response.status, body: JSON.parse(raw) as Record<string, any>, raw };
}

async function apply(base: string, tag: string): Promise<string> {
  const jar = new Map<string, string>();
  const started = await post(
    base,
    '/api/forms/apply/steps/about-you',
    { input: { last_name: 'Lovelace', email: `${tag}@example.test` }, submission: `${tag}-submission-000001` },
    jar,
  );
  assert.equal(started.status, 200, started.raw);
  const done = await post(base, '/api/forms/apply', { input: { consent: true }, submission: `${tag}-submission-000002` }, jar);
  assert.equal(done.status, 200, done.raw);
  return String(done.body.reference);
}

test('a lockout and a status step-up made on one instance are honoured on another', { timeout: 90_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-sign-in-state-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'apply.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE application(id INTEGER PRIMARY KEY, status TEXT NOT NULL, reference TEXT UNIQUE, last_name TEXT, email TEXT,
    resume_token_hash TEXT, resume_expires_at TEXT, resume_progress TEXT)`);
  db.close();
  migrateSqliteCommandJournal(file);
  const valkey = await startFakeValkey();
  t.after(() => valkey.close());
  const [one, two] = await Promise.all([instance(t, directory, valkey.url), instance(t, directory, valkey.url)]);

  // Lockout: five failures through one instance lock the receipt on the other, right details and all.
  const locked = await apply(one, 'ada');
  assert.equal((await post(two, '/api/forms/apply/status', { receipt: locked, confirm: { last_name: 'Lovelace' } })).status, 200);
  for (let i = 0; i < 5; i++) {
    assert.equal((await post(one, '/api/forms/apply/status', { receipt: locked, confirm: { last_name: 'Byron' } })).status, 404);
  }
  const after = await post(two, '/api/forms/apply/status', { receipt: locked, confirm: { last_name: 'Lovelace' } });
  assert.equal(after.status, 404, 'locked on the other instance too');
  // An application nobody guessed at is untouched.
  const other = await apply(two, 'grace');
  assert.equal((await post(one, '/api/forms/apply/status', { receipt: other, confirm: { last_name: 'Lovelace' } })).status, 200);
  assert.ok(
    valkey.commands.some((command) => command.some((part) => part.startsWith('tw:lending:signin:fail:'))),
    'counted in the named cache',
  );

  // Step-up: the code is asked for and spent on one instance; the session it opens is read on the other.
  const browser = new Map<string, string>();
  assert.deepEqual((await post(one, '/api/forms/apply/stepup', { receipt: other, confirm: { last_name: 'Lovelace' } }, browser)).body, {
    sent: true,
  });
  const log = join(directory, 'mail.log');
  let code: string | undefined;
  for (let i = 0; i < 100 && !code; i++) {
    code = existsSync(log) ? /\b(\d{6})\b/.exec(readFileSync(log, 'utf8'))?.[1] : undefined;
    if (!code) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(code, 'the code was sent');
  const opened = await post(one, '/api/forms/apply/stepup', { receipt: other, confirm: { last_name: 'Lovelace' }, code }, browser);
  assert.equal(opened.status, 200, opened.raw);
  assert.deepEqual((await post(two, '/api/forms/apply/details', {}, browser)).body, {
    status: { status: 'Received' },
    details: { last_name: 'Lovelace' },
  });
  assert.equal((await post(two, '/api/forms/apply/details', {}, new Map())).status, 404, 'that browser only');
  assert.ok(valkey.commands.some((command) => command.some((part) => part.startsWith('tw:lending:signin:stepup:'))));
});
