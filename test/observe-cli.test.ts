/*
 * The observer as a person meets it: `--dev` starts it and says where it is,
 * `mistri observe` finds it, `mistri observe --mcp` hands its telemetry
 * to an agent — and a start without `--dev` has none of it: the address is a
 * 404 and no discovery file is written.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../packages/mistri/src/server/index.ts', import.meta.url));

function start(args: string[], env: NodeJS.ProcessEnv): Promise<{ child: ChildProcess; base: string; output: () => string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no listening line:\n${output}`)), 60_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      const listening = /Listening on (http:\/\/localhost:\d+)/.exec(output);
      if (listening && (!args.includes('--dev') || /dev observer at/.test(output))) {
        clearTimeout(timer);
        resolve({ child, base: listening[1], output: () => output });
      }
    };
    child.stdout!.on('data', read);
    child.stderr!.on('data', read);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`exited ${code}:\n${output}`));
    });
  });
}
const stop = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });

test('a start without --dev has no observer; with --dev it is found, and speaks MCP', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-observe-cli-'));
  const db = join(dir, 'shop.db');
  const sqlite = new DatabaseSync(db);
  sqlite.exec("CREATE TABLE product(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO product VALUES (1, 'Lamp');");
  sqlite.close();
  /* The observer is the App framework's (`--dev`), so the start serves a small App over the database. */
  const app = join(dir, 'shop');
  mkdirSync(app);
  writeFileSync(
    join(app, 'app.json'),
    JSON.stringify({
      id: 'shop',
      name: 'Shop',
      connection: 'shop',
      resources: { product: {} },
      views: { product: { kind: 'list', from: 'product' } },
      home: 'product',
    }),
  );
  const config = join(dir, 'mistri.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'shop', url: db }] }));
  const serve = ['--config', config, '--app', app, '--port', '0'];
  const env = { ...process.env, XDG_CONFIG_HOME: join(dir, 'xdg'), MISTRI_OPEN: '0' };
  const observers = join(dir, 'xdg', 'mistri', 'observers');
  try {
    const plain = await start(serve, env);
    try {
      assert.equal((await fetch(`${plain.base}/_mistri/observe/`)).status, 404);
      assert.equal((await fetch(`${plain.base}/healthz`)).status, 200);
      assert.equal((await fetch(`${plain.base}/readyz`)).status, 200);
      assert.doesNotMatch(plain.output(), /observer/);
      assert.ok(!existsSync(observers) || !readdirSync(observers).length, 'a production start wrote a discovery file');
    } finally {
      await stop(plain.child);
    }

    const dev = await start([...serve, '--dev'], env);
    try {
      assert.match(dev.output(), /dev observer at http:\/\/localhost:\d+\/_mistri\/observe\//);
      await fetch(`${dev.base}/api/schema`);
      const found = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'observe'], { env, encoding: 'utf8', timeout: 60_000 });
      assert.equal(found.status, 0, found.stderr);
      assert.equal(found.stdout.trim(), `${dev.base}/_mistri/observe/`);

      const messages = [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
        },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_traces', arguments: { route: '/api/schema' } } },
      ]
        .map((message) => JSON.stringify(message))
        .join('\n');
      const mcp = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'observe', '--mcp', '--url', dev.base], {
        env,
        input: `${messages}\n`,
        encoding: 'utf8',
        timeout: 60_000,
      });
      const answers = mcp.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(answers[0].result.serverInfo.name, 'mistri-observe');
      assert.deepEqual(
        answers[1].result.tools.map((tool: { name: string }) => tool.name),
        [
          'check',
          'recent_errors',
          'list_traces',
          'get_trace',
          'search_logs',
          'slow_queries',
          'n_plus_one',
          'explain_statement',
          'explain_access',
          'page_vitals',
          'tail',
        ],
      );
      // The telemetry only reads; `check` writes the App's generated schema types, as the command does.
      assert.ok(
        answers[1].result.tools.every(
          (tool: { name: string; annotations: { readOnlyHint: boolean } }) => tool.annotations.readOnlyHint === (tool.name !== 'check'),
        ),
      );
      const listed = answers[2].result.structuredContent;
      assert.ok(
        listed.traces.some((trace: { route: string }) => trace.route === '/api/schema'),
        JSON.stringify(listed),
      );
    } finally {
      await stop(dev.child);
    }
    // The discovery file goes with the process.
    assert.ok(!readdirSync(observers).length, 'the discovery file outlived its server');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
