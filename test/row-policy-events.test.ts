/**
 * Events on a row-policy App's commands (CX2 phase C). A scoped command that
 * declares events records them in its own transaction, under its scope, and
 * what they start runs as its service in the policy's rows: here an inbound
 * delivery closes an item, and the job on that event archives it. The App
 * API's event feed stays refused under a policy ([policy-events-feed]).
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { hostAppCommands } from '../packages/mistri/src/server/cli/commandHost.js';
import { loadBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import { appCommandCatalog } from '../packages/mistri/src/server/commands/commandContracts.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { provisionStores } from '../packages/mistri/src/server/maintenance.js';
import { loadHttpAppPolicy, type HttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const ROOT = resolve('.');
const src = (path: string) => JSON.stringify(pathToFileURL(join(ROOT, path)).href);
const SECRET = 'row-policy-events-secret';

const manifest = {
  id: 'desk',
  name: 'Desk',
  sources: { desk: { connection: 'desk', default: true } },
  resources: { item: { access: 'write' } },
  auth: { rows: 'policy', roles: { user: { read: true }, poster: { read: true, service: true, commands: ['close', 'archive'] } } },
  views: { items: { kind: 'list', from: 'item' } },
  home: 'items',
  nav: ['items'],
};

test('a scoped command records its events, and the job on them runs as its service in the policy rows', { timeout: 120_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-row-policy-events-'));
  const file = join(directory, 'desk.db');
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE item (id INTEGER PRIMARY KEY, desk INTEGER NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
    INSERT INTO item VALUES (1, 1, 'open', 0), (2, 2, 'open', 0);`);
  raw.close();
  migrateSqliteCommandJournal(file);
  writeFileSync(
    join(directory, 'events.mjs'),
    `import { defineEvent, int, shape } from ${src('packages/mistri/src/server/commands.ts')};
export const closed = defineEvent('item.closed', shape({ id: int() }));
`,
  );
  writeFileSync(
    join(directory, 'commands.mjs'),
    `import { defineCommand, defineCommands, defineEventProjection, int, shape } from ${src('packages/mistri/src/server/commands.ts')};
import { closed } from './events.mjs';
export default defineCommands({
  close: defineCommand({ source: 'desk', target: 'item', read: ['item'], write: ['item'], output: shape({ id: int() }),
    events: { closed: defineEventProjection(closed, ({ id }) => ({ id })) },
    async handle({ db, record }) { await db.item.update(record, { status: 'closed' }); return { id: Number(record.id) }; } }),
  archive: defineCommand({ source: 'desk', target: 'item', read: ['item'], write: ['item'],
    async handle({ db, record }) { await db.item.update(record, { status: 'archived' }); } }),
});
`,
  );
  writeFileSync(
    join(directory, 'jobs.mjs'),
    `import { defineInbound, defineJob, defineJobs, hmac } from ${src('packages/mistri/src/server/jobs.ts')};
import { closed } from './events.mjs';
export default defineJobs({
  archiveClosed: defineJob({ on: { event: closed, command: 'close' }, runAs: 'poster', command: 'archive',
    schedule: (event) => ({ key: { id: event.id } }) }),
}, { principals: { poster: { roles: ['poster'] } }, store: { namespace: 'desk' },
  inbound: { closed: defineInbound({ verify: hmac({ secret: 'DESK_SECRET', signature: { header: 'x-signature' },
    timestamp: { header: 'x-timestamp', window: '5 minutes' } }), runAs: 'poster', command: 'close',
    key: body => body.id, input: () => ({}), target: body => ({ id: body.item }) }) } });
`,
  );
  const policyFile = join(directory, 'policy.mjs');
  writeFileSync(
    policyFile,
    `export default { appId: 'desk', services: ['poster'],
  resultReferences: { close: () => [], archive: () => [] },
  resolveRows(principal) {
    if (principal.kind === 'service') return { item: { groups: [[{ column: 'desk', op: '=', value: 1 }]] } };
    return { item: true };
  } };
`,
  );
  const commands = await loadBusinessCommands(join(directory, 'commands.mjs'));
  const jobs = (await import(pathToFileURL(join(directory, 'jobs.mjs')).href)).default;
  await provisionStores({ sqlite: file }, { app: { id: 'desk', commands }, jobs });
  const registry = new Registry();
  registry.add({ id: 'desk', name: 'desk', url: file, source: 'config', writable: true });
  const app = parseAppConfig(manifest, 'desk', { commands: appCommandCatalog(commands, manifest) });
  let policy: HttpAppPolicy | undefined;
  const hosted = await hostAppCommands({
    app,
    commands,
    registry,
    owner: 'desk',
    policy: () => policy,
    jobsFile: join(directory, 'jobs.mjs'),
    environment: { DESK_SECRET: SECRET },
    locate: (id) => registry.configOf(id)?.url,
    current: () => app,
  });
  let server: Server | undefined;
  t.after(async () => {
    if (server) {
      const closed = once(server, 'close');
      server.closeAllConnections();
      server.close();
      await closed;
    }
    await hosted.jobHost?.stop();
    await policy?.retire();
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.ok(hosted.commandHosting?.events, 'the event store is bound under a policy');
  policy = await loadHttpAppPolicy({
    app,
    registry,
    file: policyFile,
    commands,
    verifySession: async () => null,
    services: hosted.jobPrincipals,
    events: hosted.commandHosting.events,
  });
  server = createServer((req, res) => {
    void hosted.inbound!.handle(req, res, new URL(req.url!, 'http://localhost')).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  const deliver = (payload: object) => {
    const body = JSON.stringify(payload),
      timestamp = String(Math.floor(Date.now() / 1000));
    return fetch(`http://127.0.0.1:${port}/api/inbound/closed`, {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-timestamp': timestamp,
        'x-signature': createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex'),
      },
    });
  };
  const read = new DatabaseSync(file, { readOnly: true });
  t.after(() => read.close());
  const items = () =>
    read
      .prepare('SELECT id, status FROM item ORDER BY id')
      .all()
      .map((row) => ({ ...row }));

  assert.equal((await deliver({ id: 'in-1', item: 1 })).status, 204);
  // Item 2 is outside the service's rows: its close is refused, and so no event is recorded for it.
  assert.notEqual((await deliver({ id: 'in-2', item: 2 })).status, 204);
  const deadline = Date.now() + 60_000;
  while (items()[0].status !== 'archived' && Date.now() < deadline) {
    await hosted.jobHost!.tick();
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.deepEqual(items(), [
    { id: 1, status: 'archived' },
    { id: 2, status: 'open' },
  ]);
});
