import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readyBrowserChild } from './support/ownedBrowserChild.mjs';

const launch = (source: string) => spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
const options = { startupMs: 2000, stopMs: 50 };

test('browser child owner drains normal and repeated stops', async () => {
  const child = launch("console.log('Listening on fixture'); setInterval(() => {}, 1000)");
  const owner = await readyBrowserChild(child, 'fixture', options);
  await Promise.all([owner.stop(), owner.stop()]);
  assert.notEqual(child.signalCode, null);
});

test('browser child owner kills a child ignoring graceful shutdown', async () => {
  const child = launch("process.on('SIGTERM', () => {}); console.log('Listening on fixture'); setInterval(() => {}, 1000)");
  const owner = await readyBrowserChild(child, 'fixture', options);
  await owner.stop();
  assert.equal(child.signalCode, 'SIGKILL');
});

test('browser child startup timeout drains the otherwise unregistered child', async () => {
  const child = launch("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");
  await assert.rejects(readyBrowserChild(child, 'fixture', { ...options, startupMs: 300 }), /did not start/);
  assert.notEqual(child.signalCode, null);
});

test('browser child startup exit and spawn failure reject without leaking ownership', async () => {
  await assert.rejects(readyBrowserChild(launch('process.exit(7)'), 'fixture', options), /exited during startup/);
  const missing = spawn('/nonexistent-tablewalk-browser-fixture-executable', [], { stdio: ['ignore', 'pipe', 'pipe'] });
  await assert.rejects(readyBrowserChild(missing, 'missing', options), { code: 'ENOENT' });
});
