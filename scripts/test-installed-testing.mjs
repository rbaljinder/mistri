/** Fresh tarball consumer: public declarations, real App process and virtual CLI.
 * Usage: node scripts/test-installed-testing.mjs <tarball>…
 * Every workspace package's tarball (`npm pack --workspaces`): `tablewalk` needs mistri, @mistriwork/kit and
 * @mistriwork/engine at its own version, which the registry may not have yet, so every one is installed from the files. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const tarballs = process.argv.slice(2);
assert.ok(tarballs.length, "Pass the built packages' tarballs.");
const directory = await mkdtemp(join(tmpdir(), 'tablewalk-installed-testing-'));
const run = promisify(execFile),
  require = createRequire(import.meta.url);
const environment = { ...process.env };
for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'TSX_TSCONFIG_PATH']) delete environment[key];
const options = { cwd: directory, env: environment, timeout: 120000, maxBuffer: 1024 * 1024 };
try {
  await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const typescript = JSON.parse(await readFile(require.resolve('typescript/package.json'), 'utf8')).version;
  const nodeTypes = JSON.parse(await readFile(require.resolve('@types/node/package.json'), 'utf8')).version;
  /* TypeScript 7's compiler is a native binary in an optional package per platform, which --omit=optional
     drops with the database drivers it is here to leave out; name this platform's one so tsc can run. */
  const compiler = `@typescript/typescript-${process.platform}-${process.arch}@${typescript}`;
  await run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--omit=optional',
      '--omit=peer',
      '--no-audit',
      '--no-fund',
      ...tarballs.map((tarball) => resolve(tarball)),
      `typescript@${typescript}`,
      compiler,
      `@types/node@${nodeTypes}`,
    ],
    options,
  );
  await writeFile(
    join(directory, 'consumer.ts'),
    `
import { createTestWorkspace, startTestApp, startTestSuite, createTestClock, validateTestApp, assertAuthorizationMatrix, defineService, startService, type TestHost, type TestClient } from '@mistriwork/mistri/testing';
const clock: number = createTestClock(0).now();
const service = defineService({ name: 'typed', state: { count: 0 }, routes: [{ id: 'read', match: { method: 'GET', path: '/ready' }, reply: context => ({ body: { count: ++context.state.count, now: context.clock.now() } }) }] });
async function check(): Promise<void> {
  await using workspace = await createTestWorkspace();
  const host: TestHost = await startTestApp({ workspace, directory: workspace.path('app') });
  const client: TestClient = host.client();
  await assertAuthorizationMatrix([{ name: 'ready', client, path: '/readyz', status: 200 }]);
  const suite = await startTestSuite({ workspace, configuration: { apps: [] } });
  const account: string = await suite.account({ email: 'user@example.test', name: 'User', password: 'test-password' });
  await suite.grant({ appId: 'app', subjectId: account, roles: ['reader'], expectedRevision: 0 });
  await startService(service); await validateTestApp(workspace.path('app')); void clock;
}
void check;
`,
  );
  await writeFile(
    join(directory, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2023',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        skipLibCheck: false,
        noEmit: true,
        types: ['node'],
      },
      include: ['consumer.ts'],
    }),
  );
  await run(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.json'], options);
  await writeFile(
    join(directory, 'service.mjs'),
    `import { defineService } from '@mistriwork/mistri/testing'; export default defineService({ name: 'installed-cli', routes: [{ id: 'ping', match: { method: 'GET', path: '/ping' }, reply: { body: { pong: true } } }] });\n`,
  );
  await writeFile(
    join(directory, 'smoke.mjs'),
    `
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createTestWorkspace, startTestApp, validateTestApp, defineService, startService } from '@mistriwork/mistri/testing';
assert.ok(import.meta.resolve('@mistriwork/mistri/testing').endsWith('/node_modules/@mistriwork/mistri/testing.js'));
assert.ok(import.meta.resolve('@mistriwork/mistri/testing').includes('/node_modules/@mistriwork/mistri/dist/'));
await assert.rejects(import('tablewalk/src/server/testing/host.js'), error => error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
await using workspace = await createTestWorkspace();
const database = await workspace.database('business.db', db => db.exec('CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT)'));
await workspace.write('app/app.json', { id: 'installed-notes', name: 'Installed notes', resources: { note: {} }, views: { notes: { kind: 'list', from: 'note' } }, home: 'notes', nav: ['notes'] });
assert.equal((await validateTestApp(workspace.path('app'))).id, 'installed-notes');
const host = await startTestApp({ workspace, directory: workspace.path('app'), database });
assert.equal((await host.client().request('/readyz')).status, 200);
await using service = await startService(defineService({ name: 'installed', state: { count: 0 }, routes: [{ id: 'ping', match: { method: 'POST', path: '/ping' }, reply: ({ state }) => ({ body: { count: ++state.count } }) }] }));
assert.deepEqual(await (await fetch(service.url + '/ping', { method: 'POST' })).json(), { count: 1 });
service.verify({ method: 'POST', path: '/ping' }, { times: 1 });
const child = spawn(process.execPath, ['node_modules/@mistriwork/mistri/dist/server/index.js', 'virtual', 'service.mjs', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; child.stdout.on('data', value => { logs += value; }); child.stderr.on('data', value => { logs += value; });
const exited = once(child, 'exit');
try {
  const deadline = Date.now() + 15000;
  while (!logs.includes('Virtual service listening on ') && Date.now() < deadline && child.exitCode === null) await delay(20);
  const url = /Virtual service listening on (http:\\/\\/127\\.0\\.0\\.1:\\d+)/.exec(logs)?.[1];
  assert.ok(url, logs);
  assert.deepEqual(await (await fetch(url + '/ping')).json(), { pong: true });
} finally { child.kill('SIGTERM'); }
const [code] = await exited; assert.equal(code, 0, logs);
console.log('Installed testing declarations, App host, embedded service and virtual CLI passed.');
`,
  );
  const result = await run(process.execPath, ['smoke.mjs'], options);
  process.stdout.write(result.stdout);
  await rm(directory, { recursive: true, force: true });
} catch (error) {
  console.error(`Consumer artifacts preserved at ${directory}`);
  if (error.stdout) console.error(error.stdout);
  if (error.stderr) console.error(error.stderr);
  throw error;
}
