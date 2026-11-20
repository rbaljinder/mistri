/**
 * A `when` naming `me` holds a lookup back as any other `when` does (a field report: a vendor was asked about a
 * record that was not the person's, and the command was then refused for it). The person is read before the
 * lookup, through the lookup's own reader and outside the transaction, only for a command whose `when` says `me`;
 * another person's record makes no outside call, and the transaction refuses it in the `when`'s words. A record
 * that becomes the person's between the two reads is refused as stale, since the handler would run without its
 * lookup.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { QueryRequest } from '../packages/engine/src/adapters/adapter.js';
import { draftDescription } from '../packages/engine/src/adapters/http/httpDescription.js';
import { readOpenApi } from '../packages/engine/src/adapters/http/openapi.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { httpConnectionOf } from '../packages/engine/src/server/httpConnection.js';
import { refusalReasons } from '../packages/engine/src/shared/refusal.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { loadAppRuntimeResources, type RuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { AppAccessDenied } from '../packages/mistri/src/server/app/appAccess.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { startFakeRest } from './support/fakeRest.js';

const spec = JSON.parse(readFileSync(new URL('./fixtures/http/openapi.json', import.meta.url), 'utf8'));
const ada = { id: 'account-ada', appId: 'shop', roles: ['staff'], email: 'ada@example.test' };

const app = () =>
  parseAppConfig(
    {
      id: 'shop',
      name: 'Shop',
      sources: { shop: { connection: 'private-db', default: true }, desk: { connection: 'desk-api' } },
      resources: { vehicle: { access: 'write' }, person: {}, 'desk.contacts': {} },
      auth: {
        me: { from: 'person', column: 'email' },
        roles: {
          staff: { read: true, commands: ['chase', 'rush'] },
          // Reads no person, which `chase` needs to say who `me` is.
          blind: { read: ['vehicle'], commands: ['chase'] },
        },
      },
      views: { vehicles: { kind: 'list', from: 'vehicle' } },
      home: 'vehicles',
    },
    'lookup me fixture',
  );

// Each asks the desk about the vehicle's contact: an outside call, seen by the fake API.
const asking = {
  sources: { desk: ['contacts'] },
  async lookup({ sources, record }: { sources: any; record?: Readonly<Record<string, unknown>> }) {
    return { name: (await sources.desk.contacts.get(String(record!.contact_ref))).name as string };
  },
  async handle({ db, record, lookup }: any) {
    await db.vehicle.update(record, { contact_name: lookup.name });
  },
} as const;
const registry = defineCommands({
  // A "my records" verb: the people table is read where `me` is a row of it (binding.people).
  chase: defineCommand({ source: 'shop', target: 'vehicle', input: {}, read: ['person'], when: 'owner_id = me', ...asking }),
  // A `when` that says nothing of `me` costs no read of the person.
  rush: defineCommand({ source: 'shop', target: 'vehicle', input: {}, read: ['person'], when: 'rush = 1', ...asking }),
});

async function fixture(
  run: (f: {
    db: DatabaseSync;
    api: Awaited<ReturnType<typeof startFakeRest>>;
    execute: (command: string, key: number) => Promise<unknown>;
    /** Reads of the people table outside any transaction, and what runs after the next one. */
    people: { reads: number; after?: () => void; fail?: Error };
    /** As the actor `blind`, a role that reads no person. */
    executeBlind: (command: string, key: number) => Promise<unknown>;
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-command-lookup-me-'));
  const path = join(directory, 'shop.db');
  const db = new DatabaseSync(path);
  const api = await startFakeRest();
  const connections = new Registry();
  try {
    db.exec(`CREATE TABLE person (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE);
      INSERT INTO person VALUES (10, 'grace@example.test'), (11, 'ada@example.test');
      CREATE TABLE vehicle (id INTEGER PRIMARY KEY, contact_ref TEXT NOT NULL, owner_id INTEGER REFERENCES person(id),
        rush INTEGER NOT NULL DEFAULT 0, contact_name TEXT, version INTEGER NOT NULL DEFAULT 0);
      INSERT INTO vehicle (id, contact_ref, owner_id, rush) VALUES (1, 'c-01', 11, 1), (2, 'c-02', 10, 1), (3, 'c-03', 10, 0);`);
    migrateSqliteCommandJournal(path);
    connections.add({ id: 'private-db', name: 'Shop', url: path, writable: true, source: 'config' });
    const http = httpConnectionOf(
      { name: 'Desk', kind: 'http', url: `${api.origin}/v1`, insecure: true, description: draftDescription(readOpenApi(spec)) },
      join(directory, 'config.json'),
    )!;
    connections.add({ id: 'desk-api', name: 'Desk', url: `${api.origin}/v1`, writable: false, source: 'config', http });
    const loaded = app();
    const resources = await loadAppRuntimeResources(connections, loaded, 'private-db');
    // The adapter's own reads (a transaction's are its own), so a test can see the person read and act after it.
    const people: { reads: number; after?: () => void; fail?: Error } = { reads: 0 };
    const watched = new Proxy(resources, {
      get(target, name) {
        if (name === 'forConnection')
          return (connection: string) => {
            const adapter = target.forConnection(connection);
            return new Proxy(adapter, {
              get(inner, member) {
                if (member !== 'query') {
                  const value = Reflect.get(inner, member, inner);
                  return typeof value === 'function' ? value.bind(inner) : value;
                }
                return async (request: QueryRequest) => {
                  if (request.table === 'person' && people.fail) {
                    people.reads++;
                    throw people.fail;
                  }
                  const result = await inner.query(request);
                  if (request.table === 'person') {
                    people.reads++;
                    const after = people.after;
                    people.after = undefined;
                    after?.();
                  }
                  return result;
                };
              },
            });
          };
        const value = Reflect.get(target, name, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as RuntimeResources;
    const binding = bindBusinessCommands({ app: loaded, registry, resources: watched, writableConnection: (id) => id === 'private-db' });
    let n = 0;
    const as = (actor: typeof ada) => (command: string, key: number) =>
      executeBusinessCommand(binding, actor, {
        command,
        commandVersion: 1,
        key: { id: key },
        expectedVersion: 0,
        idempotencyKey: `lookup-me-request-${String(++n).padStart(4, '0')}`,
        input: {},
      });
    const execute = as(ada);
    const executeBlind = as({ ...ada, roles: ['blind'] });
    await run({ db, api, execute, executeBlind, people });
  } finally {
    await connections.closeAll();
    await api.close().catch(() => {});
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const outcome = (run: Promise<unknown>) =>
  run.then(
    () => ({ code: 'applied', said: '' }),
    // What the person hears, and the reasons recorded for the owner (shared/refusal.ts).
    (error: { code?: string; message?: string }) => ({ code: error.code, said: [error.message, ...refusalReasons(error)].join(' ') }),
  );
const contact = (db: DatabaseSync, id: number) =>
  (db.prepare('SELECT contact_name FROM vehicle WHERE id = ?').get(id) as { contact_name: unknown }).contact_name;

test("another person's record holds the lookup back, and the transaction refuses it in the when's words", async () => {
  await fixture(async (f) => {
    const refused = await outcome(f.execute('chase', 2));
    assert.equal(refused.code, 'ineligible_state', JSON.stringify(refused));
    assert.match(refused.said, /owner_id is 10; needs to be 11/, JSON.stringify(refused));
    // A length, not deepEqual: deepEqual against [] would narrow `seen` to never[] for the lines below.
    assert.equal(f.api.seen.length, 0, 'no outside call for a record that is not hers');
    assert.equal(f.people.reads, 1, 'the person is read once before the lookup');
    // Her own record still asks once.
    assert.equal((await outcome(f.execute('chase', 1))).code, 'applied');
    assert.deepEqual(
      f.api.seen.map((seen) => seen.path),
      ['/v1/contacts/c-01'],
    );
    assert.equal(contact(f.db, 1), 'Contact 1');
  });
});

test('a when that says nothing of me reads no person before the lookup', async () => {
  await fixture(async (f) => {
    assert.equal((await outcome(f.execute('rush', 3))).code, 'ineligible_state');
    assert.deepEqual(f.api.seen, []);
    assert.equal((await outcome(f.execute('rush', 1))).code, 'applied');
    assert.equal(f.people.reads, 0);
  });
});

test("a record that becomes the person's between the two reads is refused as stale, its lookup never run", async () => {
  await fixture(async (f) => {
    // Handed to Ada once the lookup's read of her has found the record is Grace's.
    f.people.after = () => f.db.exec('UPDATE vehicle SET owner_id = 11 WHERE id = 2');
    const refused = await outcome(f.execute('chase', 2));
    assert.equal(refused.code, 'stale_record', JSON.stringify(refused));
    assert.deepEqual(f.api.seen, []);
    assert.equal(contact(f.db, 2), null);
  });
});

test('a role that reads no person is refused before any outside call, whoever the record belongs to', async () => {
  await fixture(async (f) => {
    for (const key of [2, 1]) {
      const refused = await outcome(f.executeBlind('chase', key));
      assert.equal(refused.code, 'forbidden', JSON.stringify(refused));
    }
    assert.equal(f.api.seen.length, 0, 'no outside call');
    assert.equal(contact(f.db, 1), null);
    // The person a role may read is judged as ever: her own record asks once.
    assert.equal((await outcome(f.execute('chase', 1))).code, 'applied');
    assert.equal(f.api.seen.length, 1);
  });
});

test('a person the lookup is denied reading refuses the command before any outside call; another failure does not run it either', async () => {
  await fixture(async (f) => {
    f.people.fail = new AppAccessDenied();
    const denied = await outcome(f.execute('chase', 1));
    assert.equal(denied.code, 'forbidden', JSON.stringify(denied));
    assert.equal(f.api.seen.length, 0, 'her own record, unread person: no outside call');
    // A database error is not an access answer: it is not swallowed into running the lookup.
    f.people.fail = new Error('connection reset');
    const broken = await outcome(f.execute('chase', 1));
    assert.notEqual(broken.code, 'applied', JSON.stringify(broken));
    assert.equal(f.api.seen.length, 0, 'no outside call');
  });
});
