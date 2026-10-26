/** Shared by the App API CLI tests: the real CLI, run the way an operator or an
 * MCP client runs it, from this checkout whatever the runner's working
 * directory is. Every spawned process is killed at the end of its test. */
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { validating } from './support/validation.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = ['--import', 'tsx', fileURLToPath(new URL('../packages/mistri/src/server/index.ts', import.meta.url))];
export const SESSION_SECRET = 'synthetic-app-api-cli-secret-at-least-thirty-two-characters';
export const LEDGER_TABLE = 'CREATE TABLE item(id INTEGER PRIMARY KEY, version INTEGER NOT NULL, name TEXT NOT NULL, private_note TEXT)';
export const LEDGER_ROW = "INSERT INTO item VALUES(1,0,'One','never public')";

/** Nothing inherited that could configure the child, plus what it needs. */
export const childEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('TABLEWALK_') && key !== 'MISTRI_TEST_AUTH_LIMITS' && !key.startsWith('BETTER_AUTH_'),
    ),
  ),
  MISTRI_OPEN: '0',
  BETTER_AUTH_SECRET: SESSION_SECRET,
  ...extra,
});

/** An App MCP child's environment: its token, and no session secret — the mode needs none. */
export const mcpEnv = (token: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env = childEnv({ MISTRI_API_TOKEN: token, ...extra });
  delete env.BETTER_AUTH_SECRET;
  return env;
};

export function cliArgs(args: readonly string[]) {
  return [...ENTRY, ...args];
}

/** The real CLI serving an App's API over loopback HTTP; killed at test end.
 * `extra`: more startup flags, such as a tenant App's `--policy`. */
export async function serveApi(
  t: TestContext,
  f: { config: string; appDir: string; commands?: string },
  appId = 'ledger',
  extra: readonly string[] = [],
) {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    cliArgs([
      '--config',
      f.config,
      '--app',
      f.appDir,
      ...extra,
      ...(f.commands ? ['--commands', f.commands] : []),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--api-reads',
      '--api-integers',
      'decimal-string',
      '--api-requests-per-minute',
      '1000',
    ]),
    { cwd: ROOT, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  const closed = new Promise<number | null>((done) => child.once('close', (code) => done(code)));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    try {
      await closed;
    } finally {
      clearTimeout(timer);
    }
  });
  const started = new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`CLI readiness timeout: ${output}`)), 60000);
    const inspect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16000);
      if (output.includes('Listening on http://')) {
        clearTimeout(timer);
        done();
      }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('close', () => {
      clearTimeout(timer);
      fail(new Error(`CLI closed before listening: ${output}`));
    });
  });
  return { child, closed, started, output: () => output, base: `http://127.0.0.1:${port}/api/apps/${appId}/v1` };
}

/** The real CLI serving on its own loopback port until the test ends: its origin. */
export async function serveCli(t: TestContext, args: readonly string[], env: Record<string, string> = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, cliArgs([...args, '--host', '127.0.0.1', '--port', String(port)]), {
    cwd: ROOT,
    env: childEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const closed = new Promise<void>((done) => child.once('close', () => done()));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    await closed;
    clearTimeout(timer);
  });
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`readiness timeout: ${output}`)), 60000);
    const inspect = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16000);
      if (output.includes('Listening on http://')) {
        clearTimeout(timer);
        done();
      }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('close', () => {
      clearTimeout(timer);
      fail(new Error(`closed before listening: ${output}`));
    });
  });
  return `http://127.0.0.1:${port}`;
}

/** A one-shot CLI run; a run that never finishes is a failure, not a hang. */
export function runCli(args: readonly string[], env = childEnv()) {
  return new Promise<{ code: number; out: string; err: string }>((done, fail) => {
    const run = validating(args, env);
    execFile(process.execPath, cliArgs(run.args), { cwd: ROOT, timeout: 60000, killSignal: 'SIGKILL', env: run.env }, (error, out, err) => {
      if (error?.killed) return fail(new Error('A tablewalk run did not finish.'));
      done({ code: Number(error?.code ?? 0), out, err });
    });
  });
}
/** A wait on a child that must end, bounded: a child that never exits fails the
 * test with what it said, rather than holding the runner to its test timeout
 * (a hang there reports nothing but the time). `said` is read when it fires. */
export function within<T>(waited: Promise<T>, ms: number, what: string, said: () => string = () => ''): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error(`${what} did not happen within ${ms / 1000} s. ${said()}`.trim())), ms);
  });
  return Promise.race([waited, late]).finally(() => clearTimeout(timer));
}
/** `mistri api-token …` as an operator runs it; an issued secret is stdout. */
export const tokenCli = (args: readonly string[]) => runCli(['api-token', ...args]);

export async function freePort() {
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done) => reservation.close(() => done()));
  return address.port;
}

/** The ledger App: one table, one targeted command declared in the App file,
 * its registry beside it, and a config naming the business source. */
/** `rank`: expose a nullable INTEGER `rank` (the caller adds the column) as a field and a sort. */
/** `form`: the App also has `log`, a keyless command a signed-in form runs, which the API exposes too. */
/** `notify`: an item's change tells the address in its `owner` column (the caller adds it and the inbox store). */
export function writeLedgerApp(
  directory: string,
  options: { business: string; authStore: string; physical?: string; rank?: boolean; form?: boolean; notify?: boolean },
) {
  const appDir = join(directory, 'app');
  mkdirSync(appDir);
  const config = join(directory, 'mistri.json'),
    commands = join(appDir, 'commands.mjs');
  writeFileSync(
    join(appDir, 'app.json'),
    JSON.stringify({
      id: 'ledger',
      name: 'Ledger',
      sources: { business: { connection: 'data', default: true } },
      resources: {
        item: {
          ...(options.physical ? { physical: options.physical } : {}),
          access: 'write',
          ...(options.notify ? { notify: [{ on: { changes: 'version' }, to: 'owner', title: '{name} changed' }] } : {}),
        },
      },
      auth: { store: options.authStore, roles: { operator: { read: true, commands: ['change', ...(options.form ? ['log'] : [])] } } },
      views: {
        items: { kind: 'list', from: 'item' },
        ...(options.form ? { 'log-item': { kind: 'form', label: 'Log an item', command: 'log' } } : {}),
      },
      home: 'items',
      ...(options.form ? { nav: ['items', 'log-item'] } : {}),
      api: {
        version: 1,
        roles: ['operator'],
        resources: {
          item: {
            fields: ['id', 'version', 'name', ...(options.rank ? ['rank'] : [])],
            sorts: ['id', 'name', ...(options.rank ? ['rank'] : [])],
          },
        },
        commands: ['change', ...(options.form ? ['log'] : [])],
      },
    }),
  );
  // Named as the App binds it: the token CLI reads connections by name, not id.
  writeFileSync(config, JSON.stringify({ connections: [{ id: 'data', name: 'data', url: options.business, writable: true }] }));
  // This checkout's modules, so the registry and the server share one instance
  // of each. .mjs keeps this temporary App ESM and lets loading discover its commands.
  const source = (path: string) => pathToFileURL(join(ROOT, path)).href;
  writeFileSync(
    commands,
    `import { defineCommand, defineCommands } from '${source('packages/mistri/src/server/commands/businessCommands.ts')}';
import { shape, bool } from '${source('packages/mistri/src/server/commands/commandShapes.ts')}';
export default defineCommands({ change: defineCommand({ source: 'business', target: 'item', 
  input: {}, output: shape({ ok: bool() }), async handle(context) {
    await context.tx.update({ table: 'item', key: { id: Number(context.record.id) }, expected: { version: Number(context.record.version) }, values: { version: Number(context.record.version) + 1 } });
    return { ok: true };
  } })${
    options.form
      ? `, log: defineCommand({ source: 'business', target: 'item', targets: 'none',
  input: { name: { type: 'text' } }, output: shape({ ok: bool() }), async handle(context, input) {
    await context.tx.insert({ table: 'item', values: { id: 2, version: 0, name: input.name } });
    return { ok: true };
  } })`
      : ''
  } });
`,
  );
  return { appDir, config, commands };
}

/** Every page of the `item` list, following `next` to its end: the rows in
 * the order the API served them. */
export async function allPages(base: string, headers: Record<string, string>, query: string) {
  const rows: Array<Record<string, unknown>> = [];
  let cursor: string | null = null,
    pages = 0;
  do {
    const response = await fetch(`${base}/item?${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers });
    const body = (await response.json()) as { items: Array<Record<string, unknown>>; next: string | null };
    if (response.status !== 200) throw new Error(`A page answered ${response.status}: ${JSON.stringify(body)}`);
    rows.push(...body.items);
    cursor = body.next;
    if (++pages > 50) throw new Error('A list did not end.');
  } while (cursor);
  return rows;
}

/** Text in byte order: what an API list's text sort promises on every engine. */
export const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** The depot App: a tenant App (auth.rows 'tenant') whose `item` rows belong to
 * a tenant through `tenant_id`, with read exposure of `id` and `name` only, its
 * server-only tenant policy, and a config naming the business source. */
// An opaque text key, unique across tenants: the tenant store's rule for a
// tenant-owned table whose key does not include its tenant column.
export const DEPOT_TABLE = (physical: string) =>
  `CREATE TABLE ${physical}(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, ` +
  'name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0)';
export const DEPOT_ROWS = (physical: string) =>
  `INSERT INTO ${physical}(id, tenant_id, name) VALUES ('north-1','north','North one'),` +
  `('north-2','north','North two'),('south-1','south','South one'),('south-2','south','South two')`;
export const DEPOT_STORE = 'depot-store';
/** `commands`: the App also exposes `touch`, a targeted tenant command that
 * bumps an item's version, and `stock`, a signed-in form's keyless command
 * that adds one, with its registry beside the policy. */
export function writeDepotApp(
  directory: string,
  options: { business: string; authStore: string; physical: string; api?: Record<string, unknown>; commands?: boolean },
) {
  const appDir = join(directory, 'depot');
  mkdirSync(appDir);
  // .mjs: the policy loader takes .ts, .mjs or .js, and a .ts file in a
  // temporary directory with no package.json would load as CommonJS.
  const config = join(directory, 'depot.json'),
    policy = join(directory, 'policy.mjs'),
    commands = join(appDir, 'commands.mjs');
  const running = options.commands === true;
  writeFileSync(
    join(appDir, 'app.json'),
    JSON.stringify({
      id: 'depot',
      name: 'Depot',
      auth: {
        providers: ['email'],
        store: options.authStore,
        rows: 'tenant',
        roles: { member: { read: true, ...(running ? { commands: ['touch', 'stock'] } : {}) } },
      },
      sources: { business: { connection: 'data' } },
      // A command cannot yet run on a resource with field rules, so the command
      // variant has none; the API exposure still names its fields explicitly,
      // and the tenant column is never one (tenantAuthoringSchema).
      resources: {
        item: { physical: options.physical, owner: 'tenant', ...(running ? { access: 'write' } : { fields: { read: ['id', 'name'] } }) },
      },
      views: {
        items: { kind: 'list', from: 'item' },
        ...(running ? { 'stock-item': { kind: 'form', label: 'Stock an item', command: 'stock' } } : {}),
      },
      home: 'items',
      ...(running ? { nav: ['items', 'stock-item'] } : {}),
      api: options.api ?? {
        version: 1,
        roles: ['member'],
        resources: { item: { fields: running ? ['id', 'version', 'name'] : ['id', 'name'], sorts: ['id'] } },
        ...(running ? { commands: ['touch', 'stock'] } : {}),
      },
    }),
  );
  writeFileSync(
    config,
    JSON.stringify({ connections: [{ id: 'data', name: 'data', url: options.business, ...(running ? { writable: true } : {}) }] }),
  );
  const source = (path: string) => pathToFileURL(join(ROOT, path)).href;
  writeFileSync(
    policy,
    `import { defineAppTenantPolicy } from '${source('packages/mistri/src/server/policy/appTenantPolicy.ts')}';
export default defineAppTenantPolicy({ kind: 'tenant', appId: 'depot', storeId: '${DEPOT_STORE}',
  ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
  resolveMembershipRows: () => ({ item: true }), resolveRows: () => ({ item: true })${running ? ',\n  resultReferences: { touch: () => [], stock: () => [] }' : ''} });
`,
  );
  if (running)
    writeFileSync(
      commands,
      `import { defineCommand, defineCommands } from '${source('packages/mistri/src/server/commands/businessCommands.ts')}';
import { shape, bool } from '${source('packages/mistri/src/server/commands/commandShapes.ts')}';
export default defineCommands({ touch: defineCommand({ source: 'business', target: 'item', 
  input: {}, output: shape({ ok: bool() }), async handle(context) {
    await context.tx.update({ table: 'item', key: { id: String(context.record.id) }, values: { version: Number(context.record.version) + 1 } });
    return { ok: true };
  } }), stock: defineCommand({ source: 'business', target: 'item', targets: 'none',
  input: { id: { type: 'text' }, name: { type: 'text' } }, output: shape({ ok: bool() }), async handle(context, input) {
    await context.tx.insert({ table: 'item', values: { id: input.id, name: input.name } });
    return { ok: true };
  } }) });
`,
    );
  return { appDir, config, policy, ...(running ? { commands } : {}) };
}

type Reply = ReturnType<typeof JSON.parse>;
/** `mistri --app-mcp …` as an MCP client runs it: requests written to its
 * stdin, one JSON-RPC answer per stdout line, matched by id. */
export function startAppMcp(t: TestContext, args: readonly string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, cliArgs(args), { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '',
    next = 0;
  const lines: string[] = [],
    waiting = new Map<number, (reply: Reply) => void>();
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-16000);
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    lines.push(line);
    let reply: Reply;
    try {
      reply = JSON.parse(line);
    } catch {
      return;
    }
    waiting.get(reply.id)?.(reply);
    waiting.delete(reply.id);
  });
  const closed = new Promise<number | null>((done) => child.once('close', (code) => done(code)));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    try {
      await closed;
    } finally {
      clearTimeout(timer);
    }
  });
  const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const request = (method: string, params: object = {}) =>
    new Promise<Reply>((done, fail) => {
      const id = ++next;
      const timer = setTimeout(() => fail(new Error(`No answer to ${method}: ${stderr}`)), 90000);
      waiting.set(id, (reply) => {
        clearTimeout(timer);
        done(reply);
      });
      send({ id, method, params });
    });
  return {
    child,
    closed,
    lines,
    request,
    stderr: () => stderr,
    notify: (method: string, params: object = {}) => send({ method, params }),
    end: () => child.stdin.end(),
  };
}

/** Nullable ranks in a scattered order, so a page boundary falls on a value, on a tie and on a null. */
export const RANKS: readonly (number | null)[] = [3, null, 1, null, 2, 3, null, 1, 2];
/** The order the API promises for a nullable sort: nulls last whichever way it runs, then the key ascending. */
export const byRank = (descending: boolean) => (a: { id: number; rank: number | null }, b: { id: number; rank: number | null }) =>
  a.rank === b.rank ? a.id - b.id : a.rank === null ? 1 : b.rank === null ? -1 : descending ? b.rank - a.rank : a.rank - b.rank;
