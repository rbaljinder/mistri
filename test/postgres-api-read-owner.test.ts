/** Genuine isolated PG auth/business composition; no HTTP activation. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { PgClient, PgQuery, PgPool, PgConnectionManager } from '../packages/engine/src/adapters/postgresPool.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { migratePostgresAuthStore } from '../packages/mistri/src/adapters/auth/postgresAuthStore.js';
import { provisionPostgresApiTokenStore } from '../packages/mistri/src/server/auth/provisionPostgresApiTokenStore.js';
import { issuePostgresApiToken, revokePostgresApiToken } from '../packages/mistri/src/server/auth/postgresApiTokenMaintenance.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { createPostgresApiReadOwner } from '../packages/mistri/src/server/api/postgresApiReadOwner.js';
import { liveSkip } from './live.js';
const LIVE = process.env.TABLEWALK_TEST_PG;
interface Client extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}

test(
  'private PG response owner maps, authorizes and sends only inside actual native lifetimes',
  { skip: liveSkip('postgres', LIVE), timeout: 120000 },
  async (t) => {
    const module = 'pg';
    const pg = (await import(module)) as { default: { Client: new (options: unknown) => Client; Pool: { prototype: PgPool } } };
    const control = new pg.default.Client({ connectionString: LIVE, statement_timeout: 10000 });
    const names = ['auth', 'business'].map((kind) => `tw_read_owner_${kind}_${randomUUID().replaceAll('-', '')}`),
      owned: string[] = [];
    const directory = mkdtempSync(join(tmpdir(), 'tw-pg-read-owner-')),
      registry = new Registry();
    let auth: Awaited<ReturnType<typeof createAppAuth>> | undefined, db: Client | undefined, accounts: Client | undefined;
    const owners: Awaited<ReturnType<typeof createPostgresApiReadOwner>>[] = [];
    try {
      await control.connect();
      for (const name of names) {
        await control.query(`CREATE DATABASE "${name}"`);
        owned.push(name);
      }
      const urls = names.map((name) => {
        const url = new URL(LIVE!);
        url.pathname = '/' + name;
        return url.href;
      });
      db = new pg.default.Client({ connectionString: urls[1], statement_timeout: 10000 });
      await db.connect();
      await db.query(`CREATE TABLE physical_team(id INTEGER PRIMARY KEY,name TEXT NOT NULL);
        CREATE TABLE physical_item(id BIGINT PRIMARY KEY,name TEXT NOT NULL,team_id INTEGER REFERENCES physical_team(id),secret TEXT NOT NULL);
        CREATE TABLE physical_pair(a BIGINT NOT NULL,b BIGINT NOT NULL,value TEXT NOT NULL,secret TEXT NOT NULL,PRIMARY KEY(a,b));
        INSERT INTO physical_pair VALUES(1,1,'first','hidden'),(1,2,'second','hidden'),(2,1,'third','hidden'),(9007199254740993,1,'large','hidden');
        INSERT INTO physical_team VALUES(1,'Team'); INSERT INTO physical_item VALUES(1,'One',1,'hidden'),(2,'Two',NULL,'hidden');`);
      await migratePostgresAuthStore(urls[0]);
      accounts = new pg.default.Client({ connectionString: urls[0], statement_timeout: 10000 });
      await accounts.connect();
      await accounts.query(`INSERT INTO mistri.auth_user(id,name,email,"emailVerified","createdAt","updatedAt",role,banned)
        VALUES('account','Account','account@example.test',true,now(),now(),'reader',false),
          ('limited','Limited','limited@example.test',true,now(),now(),'base_limited,field_limited',false)`);
      const app = parseAppConfig(
        {
          id: 'owner',
          name: 'Owner',
          sources: { business: { connection: 'data', default: true } },
          resources: {
            item: { physical: 'public.physical_item' },
            team: { physical: 'public.physical_team' },
            pair: { physical: 'public.physical_pair' },
          },
          views: { items: { kind: 'list', from: 'item' } },
          home: 'items',
          auth: {
            store: urls[0],
            roles: {
              reader: { read: true },
              base_limited: { read: ['item'] },
              field_limited: { read: true, fields: { item: { read: ['id', 'name'] } } },
            },
          },
          api: {
            version: 1,
            roles: ['reader', 'base_limited', 'field_limited'],
            resources: {
              item: { fields: ['id', 'name', 'team_id.name'], sorts: ['id'], filters: ['name'] },
              pair: { fields: ['a', 'b', 'value'], sorts: ['a', 'b'], filters: ['a'] },
            },
          },
        },
        'fixture',
      );
      const loaded = { app, path: join(directory, 'app.ts'), dir: directory, pages: [], sources: {} };
      const envNames = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
      const prior = envNames.map((name) => [name, process.env[name]] as const);
      process.env.BETTER_AUTH_SECRET = 'synthetic-read-owner-secret-at-least-thirty-two-characters';
      delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
      delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
      try {
        auth = await createAppAuth(loaded, { baseURL: 'http://127.0.0.1:1', trustedOrigins: ['http://127.0.0.1:1'] });
      } finally {
        for (const [name, value] of prior) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
      registry.add({ id: 'data', name: 'data', url: urls[1], source: 'config', writable: false });
      const resources = await loadAppRuntimeResources(registry, app, 'data'),
        storeId = randomUUID();
      const excludeConnections = [{ name: 'data', url: urls[1], source: 'session' as const }];
      await provisionPostgresApiTokenStore(urls[0], { appId: app.id, storeId, excludeConnections });
      const token = await issuePostgresApiToken(
        urls[0],
        app,
        resources.schema,
        {
          storeId,
          excludeConnections,
          subjectId: 'account',
          actorId: 'account',
          roles: ['reader'],
          label: 'Read fixture',
          expiresAt: Date.now() + 120000,
        },
        Date.now,
      );
      const host = { app: loaded, auth, pages: [] };
      const acquire = async (integers: 'number' | 'decimal-string' = 'decimal-string') => {
        const owner = await createPostgresApiReadOwner(registry, host, integers);
        owners.push(owner);
        return owner;
      };
      const physical = (await registry.open('data')).adapter as PostgresAdapter;
      t.mock.method(physical, 'runView', async () => {
        throw new Error('ordinary read escaped snapshot');
      });
      t.mock.method(physical, 'countView', async () => {
        throw new Error('ordinary count escaped snapshot');
      });
      const reader = await acquire();
      // Keep the real manager checkout, health guard and native transaction;
      // inject controlled changes only after an actual statement has completed.
      const intercept = (sub: TestContext, effect: (text: string, client: PgQuery) => Promise<void>) => {
        const manager = (physical as unknown as { connections: PgConnectionManager }).connections;
        const original = manager.withObservedReadClient;
        manager.withObservedReadClient = <T>(run: (client: PgQuery, current: () => void) => Promise<T>) =>
          original.call(manager, (client, current) => {
            const wrapped = {
              query: async (input: string | { text: string; values?: unknown[]; rowMode?: string }, values?: unknown[]) => {
                const result = typeof input === 'string' ? await client.query(input, values) : await client.query(input);
                await effect(typeof input === 'string' ? input : input.text, client);
                return result;
              },
            } as PgQuery;
            return run(wrapped, current);
          }) as Promise<T>;
        sub.after(() => {
          manager.withObservedReadClient = original;
        });
      };
      const dataRead = (text: string) => text.startsWith('SELECT') && text.includes('"public"."physical_item"');
      // A controlled pause must surface early refusal, not hide it until the
      // parent timeout. Every caller resumes and drains in finally.
      const pauseRead = (sub: TestContext, owner: Awaited<ReturnType<typeof acquire>>) => {
        let enter!: () => void,
          resume!: () => void,
          paused = false,
          sends = 0,
          settled = false,
          leases = 0;
        const started = new Promise<void>((resolve) => {
          enter = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          resume = resolve;
        });
        const lease = registry.lease.bind(registry);
        sub.mock.method(registry, 'lease', (...args: Parameters<typeof lease>) => {
          const release = lease(...args);
          leases++;
          return () => {
            leases--;
            release();
          };
        });
        intercept(sub, async (text) => {
          if (!paused && dataRead(text)) {
            paused = true;
            enter();
            await gate;
          }
        });
        const work = owner.readItem(token.token, 'item:item', '1', () => {
          sends++;
        });
        // Attach rejection observation immediately, but retain the real error
        // for wait() if the request never reaches the controlled SELECT.
        const drained = work.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        return {
          work,
          drained,
          resume,
          get sends() {
            return sends;
          },
          get settled() {
            return settled;
          },
          get leases() {
            return leases;
          },
          wait: async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                started,
                work.then(() => {
                  throw new Error('Read completed before pause');
                }),
                new Promise<never>((_resolve, reject) => {
                  timer = setTimeout(() => reject(new Error('Read pause deadline exceeded')), 10000);
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          },
        };
      };
      await t.test('renamed resources preserve joined projection, closed output and both integer representations', async () => {
        let body = '',
          calls = 0;
        const outcome = await reader.readItem(token.token, 'item:item', '1', (response) => {
          calls++;
          body = response.body;
          assert.equal(response.status, 200);
        });
        assert.equal(outcome.outcome, 'sent');
        assert.equal(calls, 1);
        assert.deepEqual(JSON.parse(body), { id: '1', name: 'One', 'team_id.name': 'Team' });
        const number = await acquire('number');
        await number.readItem(token.token, 'item:item', '2', (response) => {
          body = response.body;
        });
        assert.deepEqual(JSON.parse(body), { id: 2, name: 'Two', 'team_id.name': null });
      });
      await t.test('bounded count and cursor pages use the same pinned mapping', async () => {
        let first: { items: unknown[]; next: string | null; count: unknown } | undefined;
        await reader.readList(token.token, 'list:item', 'limit=1&count=true&sort=id', (response) => {
          first = JSON.parse(response.body);
        });
        assert.equal(first!.items.length, 1);
        assert.ok(first!.next);
        assert.ok(first!.count);
        let second: { items: { id: string }[]; next: string | null } | undefined;
        await reader.readList(
          token.token,
          'list:item',
          `limit=1&count=true&sort=id&cursor=${encodeURIComponent(first!.next!)}`,
          (response) => {
            second = JSON.parse(response.body);
          },
        );
        assert.equal(second!.items[0].id, '2');
        assert.equal(second!.next, null);
      });
      await t.test('invalid send kinds, unavailable operations and cancelled requests never invoke transport', async () => {
        let calls = 0;
        await assert.rejects(
          reader.readItem(token.token, 'item:item', '1', async () => {
            calls++;
          }),
        );
        await assert.rejects(
          reader.readItem(
            token.token,
            'item:item',
            '1',
            new Proxy(() => {
              calls++;
            }, {}),
          ),
        );
        await assert.rejects(
          reader.readItem(token.token, 'item:team', '1', () => {
            calls++;
          }),
        );
        const signal = new AbortController();
        signal.abort();
        await assert.rejects(
          reader.readItem(
            token.token,
            'item:item',
            '1',
            () => {
              calls++;
            },
            signal.signal,
          ),
        );
        assert.equal(calls, 0);
      });
      await t.test('callback failure is irreversible uncertainty, never a second invocation', async () => {
        let calls = 0;
        const result = await reader.readItem(token.token, 'item:item', '1', () => {
          calls++;
          throw new Error('send failed');
        });
        assert.equal(result.outcome, 'uncertain');
        assert.equal(calls, 1);
      });
      await t.test('native factory capture ignores an instance-supplied snapshot replacement', async (sub) => {
        const fake = sub.mock.method(physical as PostgresAdapter, 'capturePinnedReadSnapshot', async () => {
          throw new Error('fake snapshot');
        });
        const exact = await acquire();
        let sends = 0;
        await exact.readItem(token.token, 'item:item', '1', () => {
          sends++;
        });
        assert.equal(fake.mock.callCount(), 0);
        assert.equal(sends, 1);
      });
      await t.test('release failure after actual send stays uncertain and cannot escape as retryable rejection', async (sub) => {
        const lease = registry.lease.bind(registry);
        sub.mock.method(registry, 'lease', (...args: Parameters<typeof lease>) => {
          const release = lease(...args);
          return () => {
            release();
            throw undefined;
          };
        });
        let sends = 0;
        const result = await reader.readItem(token.token, 'item:item', '1', () => {
          sends++;
        });
        assert.equal(result.outcome, 'uncertain');
        assert.equal(sends, 1);
      });
      await t.test('native demotion after business materialization blocks final token handoff', async (sub) => {
        let changed = false,
          sends = 0;
        intercept(sub, async (text) => {
          if (!changed && dataRead(text)) {
            changed = true;
            await accounts!.query("UPDATE mistri.auth_user SET role='removed' WHERE id='account'");
          }
        });
        try {
          await assert.rejects(
            reader.readItem(token.token, 'item:item', '1', () => {
              sends++;
            }),
          );
        } finally {
          await accounts!.query("UPDATE mistri.auth_user SET role='reader' WHERE id='account'");
        }
        assert.equal(changed, true);
        assert.equal(sends, 0);
      });
      await t.test('expiry during materialization cannot enter send', async (sub) => {
        let changed = false,
          sends = 0;
        const now = Date.now();
        intercept(sub, async (text) => {
          if (!changed && dataRead(text)) {
            changed = true;
            sub.mock.method(Date, 'now', () => now + 240000);
          }
        });
        await assert.rejects(
          reader.readItem(token.token, 'item:item', '1', () => {
            sends++;
          }),
        );
        assert.equal(changed, true);
        assert.equal(sends, 0);
      });
      await t.test('actual business backend loss during handoff preparation refuses without send', async (sub) => {
        let killed = false,
          sends = 0;
        intercept(sub, async (text, client) => {
          if (!killed && dataRead(text)) {
            killed = true;
            const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            const result = await control.query(
              'SELECT pg_terminate_backend(pid) AS stopped FROM pg_stat_activity WHERE pid=$1 AND datname=$2',
              [pid, names[1]],
            );
            assert.equal(result.rows[0]?.stopped, true);
          }
        });
        await assert.rejects(
          reader.readItem(token.token, 'item:item', '1', () => {
            sends++;
          }),
        );
        assert.equal(killed, true);
        assert.equal(sends, 0);
      });
      await t.test('business COMMIT failure after send returns uncertainty exactly once', async (sub) => {
        let sent = false,
          failed = false,
          sends = 0;
        intercept(sub, async (text) => {
          if (sent && text === 'COMMIT') {
            failed = true;
            throw new Error('lost acknowledgement');
          }
        });
        const answer = await reader.readItem(token.token, 'item:item', '1', () => {
          sent = true;
          sends++;
        });
        assert.equal(failed, true);
        assert.equal(answer.outcome, 'uncertain');
        assert.equal(sends, 1);
      });
      await t.test('request cancellation while business callback awaits drains before releasing its lease', async (sub) => {
        const controller = new AbortController();
        let enter!: () => void,
          resume!: () => void,
          paused = false,
          sends = 0,
          settled = false,
          leases = 0;
        const started = new Promise<void>((resolve) => {
            enter = resolve;
          }),
          gate = new Promise<void>((resolve) => {
            resume = resolve;
          });
        const lease = registry.lease.bind(registry);
        sub.mock.method(registry, 'lease', (...args: Parameters<typeof lease>) => {
          const release = lease(...args);
          leases++;
          return () => {
            leases--;
            release();
          };
        });
        intercept(sub, async (text) => {
          if (!paused && dataRead(text)) {
            paused = true;
            enter();
            await gate;
          }
        });
        const work = reader.readItem(
          token.token,
          'item:item',
          '1',
          () => {
            sends++;
          },
          controller.signal,
        );
        const rejected = assert.rejects(work).then(() => {
          settled = true;
        });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Read did not reach the controlled pause')), 10000);
        });
        try {
          await Promise.race([
            started,
            deadline,
            work.then(() => {
              throw new Error('Read completed before pause');
            }),
          ]);
          controller.abort();
          await Promise.resolve();
          assert.equal(settled, false);
          assert.equal(leases, 1);
        } finally {
          clearTimeout(timeout);
          controller.abort();
          resume();
          await rejected;
        }
        assert.equal(leases, 0);
        assert.equal(sends, 0);
        await reader.readItem(token.token, 'item:item', '1', () => {
          sends++;
        });
        assert.equal(sends, 1);
      });
      await t.test('DDL-exclusive lock waits until business snapshot and response handoff finish', async (sub) => {
        let locking: Promise<unknown> | undefined,
          locked = false;
        await db!.query('BEGIN');
        intercept(sub, async (text) => {
          if (!locking && dataRead(text))
            locking = db!.query('LOCK TABLE physical_item IN ACCESS EXCLUSIVE MODE').then(() => {
              locked = true;
            });
        });
        try {
          await reader.readItem(token.token, 'item:item', '1', () => {
            assert.equal(locked, false);
          });
          assert.ok(locking);
          await locking;
          assert.equal(locked, true);
        } finally {
          await db!.query('ROLLBACK');
        }
      });
      await t.test('authentic cursors bind token, owner deployment and exact query before row execution', async (sub) => {
        const other = await issuePostgresApiToken(
          urls[0],
          app,
          resources.schema,
          {
            storeId,
            excludeConnections,
            subjectId: 'account',
            actorId: 'account',
            roles: ['reader'],
            label: 'Second cursor subject token',
            expiresAt: Date.now() + 120000,
          },
          Date.now,
        );
        const freshDeployment = await acquire();
        const query = 'limit=1&sort=id&count=true';
        let cursor = '';
        await reader.readList(token.token, 'list:item', query, (response) => {
          cursor = JSON.parse(response.body).next;
        });
        assert.equal(typeof cursor, 'string');
        assert.ok(cursor.length);
        let rowReads = 0,
          sends = 0;
        intercept(sub, async (sql) => {
          if (dataRead(sql)) rowReads++;
        });
        const continuation = (base: string, value = cursor) => `${base}&cursor=${encodeURIComponent(value)}`;
        assert.ok(cursor.startsWith('twc1.'));
        const payload = Buffer.from(cursor.slice(5), 'base64url'),
          changed = Buffer.from(payload);
        assert.ok(changed.length > 28);
        changed[changed.length - 1] ^= 1;
        const tampered = 'twc1.' + changed.toString('base64url');
        assert.equal(tampered.length, cursor.length);
        assert.ok(tampered.startsWith('twc1.'));
        assert.deepEqual(changed.subarray(0, -1), payload.subarray(0, -1));
        for (const [owner, credential, request] of [
          [reader, other.token, continuation(query)],
          [freshDeployment, token.token, continuation(query)],
          [reader, token.token, continuation(query, tampered)],
          [reader, token.token, continuation('limit=1&sort=id&count=true&name=One')],
          [reader, token.token, continuation('limit=2&sort=id&count=true')],
          [reader, token.token, continuation('limit=1&sort=-id&count=true')],
          [reader, token.token, continuation('limit=1&sort=id&count=false')],
        ] as const) {
          await assert.rejects(
            owner.readList(credential, 'list:item', request, () => {
              sends++;
            }),
          );
          assert.equal(rowReads, 0);
          assert.equal(sends, 0);
        }
        // Catalog/auth observation reads are legitimate; only executable
        // business row SELECTs are counted by the exact physical-table seam.
        await reader.readList(token.token, 'list:item', continuation(query), (response) => {
          sends++;
          assert.deepEqual(
            JSON.parse(response.body).items.map((row: { id: string }) => row.id),
            ['2'],
          );
        });
        assert.equal(sends, 1);
        assert.ok(rowReads > 0);
      });
      await t.test('renamed composite numeric keys preserve precision and paginate tied leading keys', async () => {
        let body = '';
        await reader.readItem(token.token, 'item:pair', 'a=9007199254740993,b=1', (response) => {
          body = response.body;
        });
        assert.deepEqual(JSON.parse(body), { a: '9007199254740993', b: '1', value: 'large' });
        const numeric = await acquire('number');
        let sends = 0;
        await assert.rejects(
          numeric.readItem(token.token, 'item:pair', 'a=9007199254740993,b=1', () => {
            sends++;
          }),
        );
        for (const key of ['a=1', 'a=1,a=1,b=1', 'a=1,b=1,extra=1']) {
          await assert.rejects(
            reader.readItem(token.token, 'item:pair', key, () => {
              sends++;
            }),
          );
        }
        assert.equal(sends, 0);
        await numeric.readItem(token.token, 'item:pair', 'b=2,a=1', (response) => {
          body = response.body;
        });
        assert.deepEqual(JSON.parse(body), { a: 1, b: 2, value: 'second' });
        const query = 'limit=1&sort=a,b&a=1..2',
          keys: string[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 3; page++) {
          await reader.readList(token.token, 'list:pair', query + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), (response) => {
            const result = JSON.parse(response.body);
            assert.equal(result.items.length, 1);
            keys.push(`${result.items[0].a}:${result.items[0].b}`);
            cursor = result.next;
          });
          if (page < 2) assert.equal(typeof cursor, 'string');
          else assert.equal(cursor, null);
        }
        assert.deepEqual(keys, ['1:1', '1:2', '2:1']);
      });
      await t.test('genuine limited native roles cannot compose partial grants into hidden joined exposure', async (sub) => {
        const credentials: string[] = [];
        for (const roles of [['base_limited'], ['field_limited'], ['base_limited', 'field_limited']]) {
          const issued = await issuePostgresApiToken(
            urls[0],
            app,
            resources.schema,
            {
              storeId,
              excludeConnections,
              subjectId: 'limited',
              actorId: 'account',
              roles,
              label: 'Native limited-role fixture',
              expiresAt: Date.now() + 120000,
            },
            Date.now,
          );
          credentials.push(issued.token);
        }
        let rowReads = 0,
          sends = 0;
        intercept(sub, async (sql) => {
          if (dataRead(sql)) rowReads++;
        });
        for (const credential of credentials) {
          await assert.rejects(
            reader.readItem(credential, 'item:item', '1', () => {
              sends++;
            }),
          );
          assert.equal(rowReads, 0);
          assert.equal(sends, 0);
        }
        // Full role remains valid: failure cannot be explained by a broken
        // fixture, globally disabled operation, or unsupported joined mapping.
        await reader.readItem(token.token, 'item:item', '1', (response) => {
          sends++;
          assert.equal(JSON.parse(response.body)['team_id.name'], 'Team');
        });
        assert.equal(sends, 1);
        assert.ok(rowReads > 0);
      });
      await t.test('native spec narrows independent item/list operations and prunes hidden components without row SELECTs', async (sub) => {
        let rowReads = 0;
        intercept(sub, async (sql) => {
          if (dataRead(sql) || (sql.startsWith('SELECT') && sql.includes('"public"."physical_pair"'))) rowReads++;
        });
        for (const [operations, paths] of [
          [[], []],
          [['item:item'], ['/item/{id}']],
          [['list:item'], ['/item']],
          [['item:pair'], ['/pair/{key}']],
        ] as Array<[string[], string[]]>) {
          const issued = await issuePostgresApiToken(
            urls[0],
            app,
            resources.schema,
            {
              storeId,
              excludeConnections,
              subjectId: 'account',
              actorId: 'account',
              roles: ['reader'],
              operations,
              label: 'Spec operation scope',
              expiresAt: Date.now() + 120000,
            },
            Date.now,
          );
          let body = '',
            calls = 0;
          const result = await reader.readSpec(issued.token, (response) => {
            calls++;
            body = response.body;
            assert.equal(response.status, 200);
          });
          const document = JSON.parse(body);
          assert.equal(result.outcome, 'sent');
          assert.equal(calls, 1);
          assert.deepEqual(Object.keys(document.paths), paths);
          assert.equal(document['x-mistri-document'], 'app-api-reads');
          assert.doesNotMatch(body, /eligible-roles|standing-contract/);
          assert.equal(body.includes(issued.token), false);
          assert.equal(body.includes('"secret"'), false);
          if (!operations.length) assert.deepEqual(document.components.schemas, {});
          if (!operations.includes('item:pair'))
            assert.equal(
              Object.keys(document.components.schemas).some((name) => name.includes(Buffer.from('pair').toString('hex'))),
              false,
            );
        }
        assert.equal(rowReads, 0);
      });
      await t.test('native spec cannot restore an operation denied by limited native roles', async () => {
        const issued = await issuePostgresApiToken(
          urls[0],
          app,
          resources.schema,
          {
            storeId,
            excludeConnections,
            subjectId: 'limited',
            actorId: 'account',
            roles: ['base_limited'],
            label: 'Dormant spec native role',
            expiresAt: Date.now() + 120000,
          },
          Date.now,
        );
        let calls = 0;
        await reader.readSpec(issued.token, (response) => {
          calls++;
          const document = JSON.parse(response.body);
          assert.deepEqual(document.paths, {});
          assert.deepEqual(document.components.schemas, {});
        });
        assert.equal(calls, 1);
      });
      await t.test('spec final handoff refuses native demotion during held catalog capture', async (sub) => {
        let changed = false,
          sends = 0;
        intercept(sub, async (sql) => {
          if (!changed && sql.startsWith('SELECT n.nspname AS schema, c.relname AS name')) {
            changed = true;
            await accounts!.query("UPDATE mistri.auth_user SET role='removed' WHERE id='account'");
          }
        });
        try {
          await assert.rejects(
            reader.readSpec(token.token, () => {
              sends++;
            }),
          );
        } finally {
          await accounts!.query("UPDATE mistri.auth_user SET role='reader' WHERE id='account'");
        }
        assert.equal(changed, true);
        assert.equal(sends, 0);
        await reader.readSpec(token.token, () => {
          sends++;
        });
        assert.equal(sends, 1);
      });
      await t.test('spec rejects invalid callbacks and request abort, and preserves after-send uncertainty', async () => {
        let calls = 0;
        await assert.rejects(
          reader.readSpec(token.token, async () => {
            calls++;
          }),
        );
        await assert.rejects(
          reader.readSpec('not-a-native-token', () => {
            calls++;
          }),
        );
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(
          reader.readSpec(
            token.token,
            () => {
              calls++;
            },
            controller.signal,
          ),
        );
        assert.equal(calls, 0);
        const answer = await reader.readSpec(token.token, () => {
          calls++;
          throw new Error('Synthetic spec send failure');
        });
        assert.equal(answer.outcome, 'uncertain');
        assert.equal(calls, 1);
        await reader.readSpec(token.token, () => {
          calls++;
        });
        assert.equal(calls, 2);
      });
      await t.test('held owner retirement drains before release and leaves independent owners usable', async (sub) => {
        const retiringOwner = await acquire();
        const paused = pauseRead(sub, retiringOwner);
        let retired = false,
          retiring: Promise<void> | undefined;
        try {
          await paused.wait();
          retiring = retiringOwner.retire().then(() => {
            retired = true;
          });
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(retired, false);
          assert.equal(paused.settled, false);
          assert.equal(paused.leases, 1);
        } finally {
          paused.resume();
          await paused.drained;
          await (retiring ?? retiringOwner.retire());
        }
        await assert.rejects(paused.work);
        assert.equal(paused.sends, 0);
        assert.equal(paused.leases, 0);
        await assert.rejects(
          retiringOwner.readItem(token.token, 'item:item', '1', () => {
            throw new Error('Retired owner sent');
          }),
        );
        let sibling = 0;
        await reader.readItem(token.token, 'item:item', '1', () => {
          sibling++;
        });
        assert.equal(sibling, 1);
      });
      await t.test('auth COMMIT acknowledgement loss after actual send remains uncertain exactly once', async (sub) => {
        const prototype = pg.default.Pool.prototype,
          connect = prototype.connect;
        let sends = 0,
          injected = 0;
        const releases: Array<boolean | Error | undefined> = [];
        sub.mock.method(prototype, 'connect', async function (this: PgPool) {
          const client = await connect.call(this),
            query = client.query,
            release = client.release;
          let authCheckout = false,
            failedHere = false;
          client.query = (async (input: unknown, values?: unknown[]) => {
            const sql = typeof input === 'string' ? input : ((input as { text?: string })?.text ?? '');
            if (/\bmistri\."?auth_/.test(sql)) authCheckout = true;
            const result = await Reflect.apply(query, client, [input, values]);
            if (authCheckout && sends === 1 && sql === 'COMMIT' && injected === 0) {
              injected++;
              failedHere = true;
              throw new Error('Synthetic auth COMMIT acknowledgement loss');
            }
            return result;
          }) as PgClient['query'];
          client.release = (destroy) => {
            client.query = query;
            client.release = release;
            if (failedHere) releases.push(destroy);
            release.call(client, destroy);
          };
          return client;
        });
        const answer = await reader.readItem(token.token, 'item:item', '1', () => {
          sends++;
        });
        assert.equal(injected, 1);
        assert.equal(sends, 1);
        assert.equal(answer.outcome, 'uncertain');
        assert.deepEqual(releases, [true]);
      });
      await t.test('terminal token revocation after materialization prevents handoff without retiring siblings', async (sub) => {
        const dedicated = await issuePostgresApiToken(
          urls[0],
          app,
          resources.schema,
          {
            storeId,
            excludeConnections,
            subjectId: 'account',
            actorId: 'account',
            roles: ['reader'],
            label: 'Dedicated revocation fixture',
            expiresAt: Date.now() + 120000,
          },
          Date.now,
        );
        let revoked = false,
          sends = 0;
        intercept(sub, async (text) => {
          if (!revoked && dataRead(text)) {
            const result = await revokePostgresApiToken(
              urls[0],
              {
                appId: app.id,
                storeId,
                excludeConnections,
                tokenId: dedicated.tokenId,
                expectedVersion: dedicated.version,
                actorId: 'account',
              },
              Date.now,
            );
            assert.deepEqual(result, { tokenId: dedicated.tokenId, version: '2' });
            revoked = true;
          }
        });
        await assert.rejects(
          reader.readItem(dedicated.token, 'item:item', '1', () => {
            sends++;
          }),
        );
        assert.equal(revoked, true);
        assert.equal(sends, 0);
        await reader.readItem(token.token, 'item:item', '1', () => {
          sends++;
        });
        assert.equal(sends, 1);
      });
      // Last intercepted test: refresh invalidates the original physical
      // instance. The final DDL case below uses a fresh owner, no interceptor.
      await t.test('refresh-start invalidates a held response and waits for lease drain before replacement', async (sub) => {
        const oldOwner = await acquire(),
          paused = pauseRead(sub, oldOwner);
        let refreshed = false,
          refreshing: ReturnType<typeof registry.refresh> | undefined;
        try {
          await paused.wait();
          refreshing = registry.refresh('data');
          void refreshing.then(
            () => {
              refreshed = true;
            },
            () => {},
          );
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(refreshed, false);
          assert.equal(paused.settled, false);
          assert.equal(paused.leases, 1);
        } finally {
          paused.resume();
          await paused.drained;
          if (refreshing) await refreshing;
        }
        await assert.rejects(paused.work);
        assert.equal(paused.sends, 0);
        assert.equal(paused.leases, 0);
        await assert.rejects(
          oldOwner.readItem(token.token, 'item:item', '1', () => {
            throw new Error('Old owner sent');
          }),
        );
        const fresh = await acquire();
        let sends = 0;
        await fresh.readItem(token.token, 'item:item', '1', () => {
          sends++;
        });
        assert.equal(sends, 1);
      });
      await t.test('native demotion and irreversible DDL drift refuse on a fresh owner', async () => {
        const exact = await acquire();
        let calls = 0;
        await exact.readItem(token.token, 'item:item', '1', () => {
          calls++;
        });
        assert.equal(calls, 1);
        await accounts!.query("UPDATE mistri.auth_user SET role='removed' WHERE id='account'");
        try {
          await assert.rejects(
            exact.readItem(token.token, 'item:item', '1', () => {
              calls++;
            }),
          );
        } finally {
          await accounts!.query("UPDATE mistri.auth_user SET role='reader' WHERE id='account'");
        }
        await db!.query('ALTER TABLE physical_item ADD COLUMN changed TEXT');
        await assert.rejects(
          exact.readItem(token.token, 'item:item', '1', () => {
            calls++;
          }),
        );
        await assert.rejects(
          exact.readSpec(token.token, () => {
            calls++;
          }),
        );
        assert.equal(calls, 1);
      });
    } finally {
      await Promise.allSettled(owners.map((owner) => owner.retire()));
      auth?.close();
      await registry.closeAll();
      await db?.end();
      await accounts?.end();
      for (const name of owned.reverse()) {
        await control.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [name]);
        await control.query(`DROP DATABASE "${name}"`);
      }
      await control.end();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
