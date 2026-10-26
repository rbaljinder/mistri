/** Public CLI uses the same listener and reports verification failure on exit. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

test('standalone service responds and exits unsuccessfully after an unexpected call', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'tablewalk-virtual-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'service.mjs');
  await writeFile(
    file,
    `export default {name:'standalone',state:{},routes:[{id:'health',match:{path:'/health'},reply:{body:{ok:true}}}]};`,
  );
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('../packages/mistri/src/server/index.ts', import.meta.url)), 'virtual', file, '--seed', '2'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output += chunk;
    });
  const deadline = Date.now() + 10000;
  while (!/Virtual service listening on (http:\/\/127\.0\.0\.1:\d+)/.test(output) && child.exitCode === null && Date.now() < deadline)
    await delay(20);
  const url = /Virtual service listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
  assert.ok(url, output);
  assert.deepEqual(await (await fetch(`${url}/health`)).json(), { ok: true });
  assert.equal((await fetch(`${url}/unexpected`)).status, 500);
  child.kill('SIGTERM');
  assert.equal((await exited)[0], 1, output);
  assert.match(output, /Unexpected GET \/unexpected/);
});
