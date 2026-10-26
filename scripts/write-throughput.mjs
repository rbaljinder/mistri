/**
 * How many App writes a second one process makes against PostgreSQL: a
 * business command (the Keystone marketplace's shortlist pair, removing a
 * saved car and saving it again) and a record form's save (a Compass lead's
 * name, with its expected value), each run by several people at once on
 * records of their own, directly and through a proxy that adds a round-trip
 * delay. The measure behind docs/postgresql.md "Writers" (WR4 of 0.8.2).
 *
 * It drives the same functions the HTTP routes call — the command executor
 * with an App's binding, the record write with an App's adapter — in
 * process, so what it counts is the writer, not the browser or the socket.
 * Run it in two checkouts to compare them: a tree without write lanes
 * (packages/engine/src/adapters/writeLanes.ts) writes as the one queue did.
 *
 *   node --import tsx scripts/write-throughput.mjs \
 *     --commands postgres://…/keystone-copy --edits postgres://…/compass-copy \
 *     --saves postgres://…/compass-copy \
 *     [--delay 10] [--users 16] [--seconds 10] [--writers 4]
 *
 * `--delay` is milliseconds each way, so 10 is a 20 ms round trip. The
 * databases are written: give it copies. Compass's comes from
 * test/fixtures/databases/crm/seed-postgres.mjs.
 */
import net from 'node:net';
import { parseArgs } from 'node:util';

const { values: options } = parseArgs({
  options: {
    commands: { type: 'string' },
    edits: { type: 'string' },
    saves: { type: 'string' },
    delay: { type: 'string', default: '0' },
    users: { type: 'string', default: '16' },
    seconds: { type: 'string', default: '10' },
    writers: { type: 'string' },
  },
});
const delay = Number(options.delay),
  users = Number(options.users),
  seconds = Number(options.seconds);

/* The order an App writes in, where this tree has one: set before any adapter is made. */
const lanes = await import('../packages/engine/src/adapters/writeLanes.ts').catch(() => undefined);
lanes?.configureWriteOrder('keyed');
if (lanes && options.writers) lanes.configureWriterPool(Number(options.writers));
const order = lanes ? `keyed, ${options.writers ?? lanes.writerPoolSize()} writers` : 'one queue, one writer';

const { Registry } = await import('../packages/engine/src/server/connections.ts');
const { parseAppConfig } = await import('../packages/mistri/src/shared/app.ts');
const { loadAppRuntimeResources } = await import('../packages/mistri/src/server/app/appRuntimeResources.ts');
const { bindBusinessCommands } = await import('../packages/mistri/src/server/commands/businessCommandAccess.ts');
const { executeBusinessCommand } = await import('../packages/mistri/src/server/commands/businessCommandExecution.ts');
const { defineCommand, defineCommands } = await import('../packages/mistri/src/server/commands/businessCommands.ts');
const { recordedUpdate } = await import('../packages/engine/src/server/recordWriteOperations.ts');
const { refusalReasons } = await import('../packages/engine/src/shared/refusal.ts');
const pg = (await import('pg')).default;

/** A TCP relay that holds every chunk `ms` before passing it on, in order, both ways. */
async function delayed(url, ms) {
  if (!ms) return { url, close: async () => {} };
  const target = new URL(url);
  const sockets = new Set();
  const relay = (from, to) =>
    from.on('data', (chunk) =>
      setTimeout(() => {
        if (!to.destroyed) to.write(chunk);
      }, ms),
    );
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(target.port || 5432), target.hostname);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
    }
    relay(client, upstream);
    relay(upstream, client);
    client.on('close', () => setTimeout(() => upstream.destroy(), ms));
    upstream.on('close', () => setTimeout(() => client.destroy(), ms));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const proxied = new URL(url);
  proxied.hostname = '127.0.0.1';
  proxied.port = String(server.address().port);
  return {
    url: proxied.href,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** `users` loops of `step` for `seconds`: completed steps a second, and each step's time. */
async function drive(step) {
  const times = [];
  let failures = 0,
    firstFailure;
  const started = performance.now();
  const end = started + seconds * 1000;
  await Promise.all(
    Array.from({ length: users }, async (_, user) => {
      for (let turn = 0; performance.now() < end; turn++) {
        const started = performance.now();
        try {
          await step(user, turn);
          times.push(performance.now() - started);
        } catch (error) {
          failures++;
          firstFailure ??= [error.message, ...refusalReasons(error)].join(' — because ');
        }
      }
    }),
  );
  times.sort((a, b) => a - b);
  const at = (q) => Math.round(times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? 0);
  const elapsedSeconds = (performance.now() - started) / 1000;
  return {
    perSecond: Math.round(times.length / elapsedSeconds),
    completed: times.length,
    elapsedSeconds: Math.round(elapsedSeconds * 100) / 100,
    p50: at(0.5),
    p95: at(0.95),
    failures,
    ...(firstFailure ? { firstFailure } : {}),
  };
}

async function commands(url) {
  const setup = new pg.Client({ connectionString: url });
  await setup.connect();
  // One shortlist row per person, on a car of its own: made once, kept for later runs.
  await setup.query(
    `INSERT INTO saved_vehicle (account_id, vehicle_id, status, saved_at)
    SELECT 'throughput-' || n, v.id, 'saved', now() FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM vehicle) v
    WHERE v.n <= $1 ON CONFLICT (account_id, vehicle_id) DO NOTHING`,
    [users],
  );
  const rows = (
    await setup.query(`SELECT id, version FROM saved_vehicle WHERE account_id LIKE 'throughput-%' ORDER BY id LIMIT $1`, [users])
  ).rows;
  await setup.end();
  if (rows.length < users) throw new Error(`The Keystone copy has cars for ${rows.length} people; ${users} need one each.`);
  const proxy = await delayed(url, delay);
  const registry = new Registry();
  registry.add({ id: 'keystone', name: 'keystone', url: proxy.url, writable: true, source: 'config' });
  try {
    const app = parseAppConfig(
      {
        id: 'marketplace',
        name: 'Marketplace',
        sources: { keystone: { connection: 'keystone' } },
        resources: { saved_vehicle: { access: 'write' }, vehicle: {} },
        auth: { roles: { customer: { read: true, commands: ['removeSavedVehicle', 'saveVehicleAgain'] } } },
        views: { shortlist: { kind: 'list', from: 'saved_vehicle' } },
        home: 'shortlist',
      },
      'write-throughput marketplace',
    );
    const toggle = (from, to) => ({
      version: 1,
      source: 'keystone',
      target: 'saved_vehicle',
      read: ['vehicle'],
      when: `status = ${from}`,
      input: {},
      output: { parse: (value) => value },
      async handle({ db, record }) {
        await db.saved_vehicle.update(record, { status: to });
        return {};
      },
    });
    const registered = defineCommands({
      removeSavedVehicle: defineCommand(toggle('saved', 'archived')),
      saveVehicleAgain: defineCommand(toggle('archived', 'saved')),
    });
    const resources = await loadAppRuntimeResources(registry, app, 'keystone');
    const binding = bindBusinessCommands({ app, resources, registry: registered, writableConnection: () => true });
    const actor = { id: 'account-shopper', appId: 'marketplace', roles: ['customer'] };
    const versions = rows.map((row) => Number(row.version));
    let n = 0;
    const step = async (user) => {
      const command = versions[user] % 2 === 0 ? 'removeSavedVehicle' : 'saveVehicleAgain';
      // Written as the rows were set up: even revisions saved, odd archived.
      await executeBusinessCommand(
        binding,
        actor,
        {
          command,
          commandVersion: 1,
          key: { id: rows[user].id },
          expectedVersion: versions[user],
          input: {},
          idempotencyKey: `throughput-${process.pid}-${++n}`,
        },
        { door: 'ui' },
      );
      versions[user]++;
    };
    // Align each row's status with its revision's parity before the clock starts.
    const align = new pg.Client({ connectionString: url });
    await align.connect();
    for (const row of rows)
      await align.query(`UPDATE saved_vehicle SET status = CASE WHEN version % 2 = 0 THEN 'saved' ELSE 'archived' END WHERE id = $1`, [
        row.id,
      ]);
    await align.end();
    await step(0);
    return await drive(step);
  } finally {
    await registry.closeAll();
    await proxy.close();
  }
}

async function edits(url) {
  const proxy = await delayed(url, delay);
  const registry = new Registry();
  registry.add({ id: 'crm', name: 'crm', url: proxy.url, writable: true, source: 'config' });
  try {
    const app = parseAppConfig(
      {
        id: 'compass',
        name: 'Compass',
        connection: 'crm',
        resources: { lead: { access: 'write' } },
        views: { leads: { kind: 'list', from: 'lead' } },
        home: 'leads',
      },
      'write-throughput compass',
    );
    const resources = await loadAppRuntimeResources(registry, app, 'crm');
    const adapter = resources.forConnection('crm');
    const names = new Map();
    const step = async (user, turn) => {
      const id = user + 1;
      const was =
        names.get(id) ??
        (
          await adapter.query({
            table: 'lead',
            columns: ['name'],
            filter: { groups: [[{ column: 'id', op: '=', value: id }]] },
            limit: 1,
            offset: 0,
          })
        ).rows[0].name;
      const name = `Lead ${id} edit ${turn}`;
      // A record form's save: its values and the values it showed (write.js), as an App sends them.
      await recordedUpdate(
        { adapter, connection: 'crm', journal: false },
        { table: 'lead', key: { id }, values: { name }, expected: { name: was } },
      );
      names.set(id, name);
    };
    await step(0, -1);
    return await drive(step);
  } finally {
    await registry.closeAll();
    await proxy.close();
  }
}

/* The writer alone: the adapter's own single-record update with its expected
   value, beneath any App — what the pool and the lanes change, without the
   command runtime's own work around it. */
async function saves(url) {
  const proxy = await delayed(url, delay);
  const registry = new Registry();
  registry.add({ id: 'crm', name: 'crm', url: proxy.url, writable: true, source: 'config' });
  try {
    const { adapter } = await registry.open('crm');
    const names = new Map();
    const step = async (user, turn) => {
      const id = user + 101;
      const was =
        names.get(id) ??
        (
          await adapter.query({
            table: 'lead',
            columns: ['name'],
            filter: { groups: [[{ column: 'id', op: '=', value: id }]] },
            limit: 1,
            offset: 0,
          })
        ).rows[0].name;
      const name = `Lead ${id} save ${turn}`;
      await adapter.update({ table: 'lead', key: { id }, values: { name }, expected: { name: was } });
      names.set(id, name);
    };
    await step(0, -1);
    return await drive(step);
  } finally {
    await registry.closeAll();
    await proxy.close();
  }
}

const result = { order, users, seconds, roundTripMs: delay * 2 };
if (options.commands) result.commands = await commands(options.commands);
if (options.edits) result.edits = await edits(options.edits);
if (options.saves) result.saves = await saves(options.saves);
console.log(JSON.stringify(result));
