import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { VALIDATE, validating } from './support/validation.js';

async function fixture(
  options: { unavailableUnrelated?: boolean; unavailableInventory?: boolean },
  run: (config: string, app: string, directory: string) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-multisource-cli-'));
  try {
    for (const [name, columns] of [
      ['ops', 'id INTEGER PRIMARY KEY, name TEXT, severity TEXT'],
      ['stock', 'id INTEGER PRIMARY KEY, name TEXT, asset_tag TEXT'],
      ['unrelated', 'distraction TEXT'],
    ]) {
      if ((name === 'unrelated' && options.unavailableUnrelated) || (name === 'stock' && options.unavailableInventory)) continue;
      const db = new DatabaseSync(join(directory, `${name}.db`));
      try {
        db.exec(`CREATE TABLE ${name === 'unrelated' ? 'unrelated_table' : 'incident'} (${columns})`);
      } finally {
        db.close();
      }
    }
    const config = join(directory, 'mistri.json');
    writeFileSync(
      config,
      JSON.stringify({
        connections: [
          { name: 'unrelated', url: join(directory, 'unrelated.db') },
          { name: 'stock', url: join(directory, 'stock.db') },
          { name: 'ops', url: join(directory, 'ops.db') },
        ],
      }),
    );
    const app = join(directory, 'app.json');
    writeFileSync(
      app,
      JSON.stringify({
        name: 'Multiple sources',
        sources: { operations: { connection: 'ops', default: true }, inventory: { connection: 'stock' } },
        resources: { incident: {}, 'inventory.incident': {} },
        views: {
          incidents: { kind: 'list', from: 'incident', show: ['name', 'severity'] },
          'inventory-incidents': { kind: 'list', from: 'inventory.incident', show: ['name', 'asset_tag'] },
        },
        home: 'incidents',
        nav: ['incidents', 'inventory-incidents'],
      }),
    );
    await run(config, app, directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function cli(config: string, app: string, directory: string, ...args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((done, reject) => {
    const run = validating(args, { ...process.env, DATABASE_URL: '', MISTRI_OPEN: '0', XDG_CONFIG_HOME: join(directory, 'xdg') });
    execFile(
      process.execPath,
      ['--import', 'tsx', resolve('packages/mistri/src/server/index.ts'), '--config', config, '--app', app, ...run.args],
      {
        cwd: resolve('.'),
        timeout: 15_000,
        killSignal: 'SIGKILL',
        env: run.env,
      },
      (error, stdout, stderr) => {
        if (error?.killed) {
          reject(new Error(`CLI did not exit: ${args.join(' ')}\n${stderr}`));
          return;
        }
        done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
      },
    );
  });
}

test('CLI type export uses combined app resources rather than the unrelated active connection', { timeout: 20_000 }, async () => {
  await fixture({}, async (config, app, directory) => {
    const result = await cli(config, app, directory, '--export', 'types');
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /from the "Multiple sources" app resources/);
    assert.match(result.stdout, /incident: "id" \| "name" \| "severity";/);
    assert.match(result.stdout, /"inventory\.incident": "id" \| "name" \| "asset_tag";/);
    assert.doesNotMatch(result.stdout, /unrelated_table|distraction/);
  });
});

test('CLI app checking resolves both source schemas without opening an unrelated unavailable default', { timeout: 20_000 }, async () => {
  await fixture({ unavailableUnrelated: true }, async (config, app, directory) => {
    const result = await cli(config, app, directory, VALIDATE);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Multiple sources: ok/);
    assert.doesNotMatch(result.stdout, /no table|no column|Could not open/);
  });
});

test('CLI app checking reports an unavailable secondary instead of validating against another database', { timeout: 20_000 }, async () => {
  await fixture({ unavailableInventory: true }, async (config, app, directory) => {
    const result = await cli(config, app, directory, VALIDATE);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /Application data source "inventory" is unavailable\./);
    assert.doesNotMatch(result.stdout, /Multiple sources: ok|ENOENT|SQLITE_CANTOPEN/);
  });
});

test('mistri refuses --mcp beside an App, named sources and all, without starting a protocol server', { timeout: 20_000 }, async () => {
  await fixture({}, async (config, app, directory) => {
    const result = await cli(config, app, directory, '--mcp');
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /--mcp is the database browser's, a command of its own: npx tablewalk/);
    assert.doesNotMatch(result.stderr, /speaking MCP|Listening on/);
  });
});
