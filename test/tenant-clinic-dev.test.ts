/**
 * `mistri dev` on a tenant App (the clinic fixture): it serves, and once it answers it prints a sign-in per role,
 * each a member where its role works — a clinic role in every clinic, the operator in the platform realm —
 * and a restart signs the same people in again, even when dev.json names accounts the sign-in store does not hold.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { tenantTestClient } from '../packages/mistri/src/server/testing/tenant.ts';
import { seedSqlite } from './fixtures/databases/clinic/seed.mjs';

const ROOT = resolve('.');
/* An App's starts are mistri's (test/support/bins.ts). */
const ENTRY = join(ROOT, 'packages', 'mistri', 'src', 'server', 'index.ts');

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

test('mistri dev serves a tenant App and prints a sign-in per role, each a member where it works', { timeout: 240000 }, async (t) => {
  const work = mkdtempSync(join(ROOT, 'test', '.clinic-dev-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const dir = join(work, 'apps', 'clinic');
  cpSync(join(ROOT, 'test', 'fixtures', 'apps', 'clinic'), dir, { recursive: true });
  seedSqlite(join(dir, 'clinic.db'));
  writeFileSync(join(dir, 'mistri.json'), JSON.stringify({ connections: [{ name: 'clinic-db', url: './clinic.db', writable: true }] }));
  const policy = join(dir, 'server', 'tenant-policy.ts');
  const env = {
    PATH: process.env.PATH,
    HOME: work,
    MISTRI_AUDIT_KEY: 'k'.repeat(40),
    MISTRI_TEST_AUTH_LIMITS: 'off',
    NODE_ENV: 'test',
    TSX_TSCONFIG_PATH: join(ROOT, 'tsconfig.json'),
  };
  const up = spawnSync(
    process.execPath,
    ['--import', 'tsx', ENTRY, 'migrate', 'stores', 'up', '--app', dir, '--policy', policy, '--config', join(dir, 'mistri.json')],
    { encoding: 'utf8', cwd: dir, env },
  );
  assert.equal(up.status, 0, up.stdout + up.stderr);

  /** One `mistri dev` start, until it has printed its sign-ins: the output and how to stop it. */
  async function start() {
    const port = await freePort();
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', ENTRY, 'dev', '--app', dir, '--policy', policy, '--commands', join(dir, 'commands.ts'), '--port', String(port)],
      { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => (output += String(chunk)));
    const ended = once(child, 'exit');
    const stop = async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await ended;
    };
    t.after(stop);
    for (let tries = 0; tries < 1200 && !/Kept in|could not make/.test(output) && child.exitCode === null; tries++) await delay(50);
    assert.match(output, /Kept in/, output);
    return { output, origin: `http://127.0.0.1:${port}`, stop };
  }

  const first = await start();
  assert.doesNotMatch(first.output, /could not make the dev accounts/, first.output);
  const signIns = new Map<string, { email: string; password: string }>();
  for (const [, role, email, password] of first.output.matchAll(/^ {2}(\w+) +(\S+@example\.test) +(\S+)$/gm))
    signIns.set(role, { email, password });
  assert.deepEqual([...signIns.keys()].sort(), ['operator', 'owner', 'reception']);
  // Every clinic of the profile table, by key, as many as a seed has (a field report found two too few to switch
  // between); the operator works in the platform realm.
  assert.match(first.output, /a member of east, north and south/);
  assert.match(first.output, /a member of Operator/);

  const accountOf = async (role: string) => {
    const { email, password } = signIns.get(role)!;
    // The account id is the session's: signed in once to read it, as the browser's chooser does.
    const session = await fetch(`${first.origin}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: first.origin },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(session.status, 200, await session.clone().text());
    const { user } = (await session.json()) as { user: { id: string } };
    return { accountId: user.id, email, password };
  };
  const reception = await tenantTestClient(first.origin, 'clinic', await accountOf('reception'), 'north');
  const rows = await reception.rows('appointment');
  assert.ok(rows.ok, rows.ok ? '' : rows.message);
  assert.deepEqual(rows.value.map((row) => row.id).sort(), ['ap-north-1', 'ap-north-2']);
  // A clinic role is a member of each clinic it was made in, and of no other.
  assert.equal((await reception.enter('east')).ok, true);
  assert.equal((await reception.enter('south')).ok, true);
  assert.equal((await reception.enter('west')).ok, false);
  const operator = await tenantTestClient(first.origin, 'clinic', await accountOf('operator'), '@platform');
  assert.ok((await operator.rows('clinic')).ok);
  await first.stop();

  // A restart signs the same people in: the passwords and memberships are kept.
  const again = await start();
  assert.doesNotMatch(again.output, /could not make the dev accounts/, again.output);
  assert.match(
    again.output,
    new RegExp(`reception +reception@example\\.test +${signIns.get('reception')!.password.replace(/[-]/g, '\\-')}`),
  );
  await again.stop();

  // A held address dev.json names another id for is that account: the one the store holds is used, and it is given the
  // password dev.json keeps, so the sign-in printed is the one that works.
  const devFile = join(dir, '.mistri', 'dev.json');
  const dev = JSON.parse(readFileSync(devFile, 'utf8')) as { accounts: Record<string, string>; passwords: Record<string, string> };
  const kept = 'kept-in-dev-json-4821';
  dev.accounts.reception = 'another-tree';
  dev.passwords.reception = kept;
  writeFileSync(devFile, JSON.stringify(dev));
  const adopted = await start();
  assert.doesNotMatch(adopted.output, /could not make the dev accounts/, adopted.output);
  assert.match(adopted.output, /reception@example\.test in the sign-in store is not the reception account .* named; that account is used/);
  assert.match(adopted.output, new RegExp(`reception +reception@example\\.test +${kept}`));
  const signInAs = (origin: string, password: string) =>
    fetch(`${origin}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email: 'reception@example.test', password }),
    });
  assert.equal((await signInAs(adopted.origin, kept)).status, 200, 'the printed password signs the adopted account in');
  assert.notEqual((await signInAs(adopted.origin, signIns.get('reception')!.password)).status, 200, 'the password it had is no longer one');
  await adopted.stop();

  // dev.json naming accounts the sign-in store does not hold (the store deleted, or another tree's) makes them again
  // with the kept passwords, where it once refused every role (a field report).
  rmSync(join(dir, '.mistri', 'config'), { recursive: true, force: true });
  const remade = await start();
  assert.doesNotMatch(remade.output, /could not make the dev accounts/, remade.output);
  assert.match(remade.output, /the sign-in store does not hold the reception account .* named; it is made again/);
  const session = await fetch(`${remade.origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: remade.origin },
    body: JSON.stringify({ email: 'reception@example.test', password: kept }),
  });
  assert.equal(session.status, 200, await session.clone().text());
  const { user } = (await session.json()) as { user: { id: string } };
  const member = await tenantTestClient(
    remade.origin,
    'clinic',
    { accountId: user.id, email: 'reception@example.test', password: kept },
    'north',
  );
  assert.equal((await member.enter('east')).ok, true);
  assert.equal(
    (JSON.parse(readFileSync(devFile, 'utf8')) as typeof dev).accounts.reception,
    user.id,
    'dev.json names the account made again',
  );
});
