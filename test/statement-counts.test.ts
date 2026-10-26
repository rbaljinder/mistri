/**
 * How many statements the common requests of a real App cost, on the Compass
 * sample's own database — counted, not timed (support/sqlCount.ts).
 *
 * Each number here was once larger for a reason that is easy to bring back:
 * an existence probe before every read, a second introspection on the first
 * view, a `COUNT(*)` beside a single-value metric, a request and two
 * statements per list tab, a count per incoming reference. The assertions
 * are exact so that any added statement is a decision someone makes in this
 * file, not a regression someone finds in a profile.
 *
 * Postgres is the engine these matter most on — every statement is a round
 * trip — so the same suite runs there too when TABLEWALK_TEST_PG names a
 * server, in a database of its own. A pooled connection's two session SETs
 * are the pool's, paid once per physical connection, and are not counted.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Server } from 'node:http';
import { loadApp, type AppHost } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { countStatements, type PgClientClass, type StatementCounter } from './support/sqlCount.js';
import { uuidPostgresDatabase } from './support/tenantDialects.js';

const SESSION = /^SET (default_transaction_read_only|statement_timeout)\b/;
const CATALOG = /sqlite_master|pragma_|PRAGMA|pg_class|pg_namespace|pg_attribute|pg_constraint|information_schema/i;

interface Engine {
  url: string;
  pg?: PgClientClass;
  drop(): Promise<void>;
}

async function sqliteEngine(): Promise<Engine> {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-statement-counts-'));
  const file = join(directory, 'crm.db');
  execFileSync(process.execPath, [resolve('test/fixtures/databases/crm/make-crm-db.mjs'), file], {
    stdio: 'pipe',
    env: { ...process.env, MISTRI_CRM_TODAY: '2026-08-30' },
  });
  return { url: file, drop: async () => rmSync(directory, { recursive: true, force: true }) };
}

async function postgresEngine(): Promise<Engine> {
  const source = await sqliteEngine();
  const owned = await uuidPostgresDatabase('tw_statements');
  try {
    execFileSync(process.execPath, [resolve('test/fixtures/databases/crm/seed-postgres.mjs'), owned.url, source.url], { stdio: 'pipe' });
  } catch (error) {
    await owned.drop();
    throw error;
  } finally {
    await source.drop();
  }
  const specifier = 'pg';
  const pg = (await import(specifier)) as unknown as { default: { Client: PgClientClass } };
  return { url: owned.url, pg: pg.default.Client, drop: owned.drop };
}

function suite(name: string, open: () => Promise<Engine>, skip?: string) {
  describe(`statements per request on the Compass sample (${name})`, { skip }, () => {
    let engine: Engine;
    let server: Server;
    let registry: Registry;
    let counter: StatementCounter;
    let base: string;

    before(async () => {
      engine = await open();
      const loaded = await loadApp(resolve('test/fixtures/apps/crm'));
      registry = new Registry();
      registry.add({ id: 'crm', name: 'crm', url: engine.url, source: 'config' });
      const host: AppHost = { app: loaded, pages: loaded.pages };
      const bound = { host: '127.0.0.1', port: 0 };
      server = createApp({ registry, bound, apps: [host], pages: loaded.pages });
      counter = countStatements(server, engine.pg);
      server.listen(0, bound.host);
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      bound.port = address.port;
      base = `http://${bound.host}:${address.port}`;
    });

    after(async () => {
      counter?.restore();
      if (server) {
        const closed = new Promise<void>((done) => server.close(() => done()));
        server.closeAllConnections();
        await closed;
      }
      await registry?.closeAll();
      await engine?.drop();
    });

    async function post(path: string, body: Record<string, unknown>) {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: 'compass', ...body }),
      });
      const json = (await response.json()) as Record<string, unknown>;
      assert.equal(response.status, 200, JSON.stringify(json));
      return json;
    }

    /** One request's statements, from a clean slate, without the pool's session setup. */
    async function statementsOf(path: string, body: Record<string, unknown>) {
      counter.clear();
      const reply = await post(path, body);
      return { reply, statements: counter.one(path).filter((sql) => !SESSION.test(sql)) };
    }

    test('the first view after start reads the catalog once, at connect, not again', async () => {
      const schema = await fetch(`${base}/api/schema?app=compass`, { signal: AbortSignal.timeout(10_000) });
      assert.equal(schema.status, 200);
      const { statements } = await statementsOf('/api/view/run', {
        text: 'opportunity stage = closed_won show name, account_id.name',
        count: 'none',
      });
      assert.deepEqual(
        statements.filter((sql) => CATALOG.test(sql)),
        [],
        'no catalog statement on the first view',
      );
      assert.equal(statements.length, 1, statements.join('\n'));
    });

    test('a list page is its rows and one bounded count, with no existence probe', async () => {
      const { reply, statements } = await statementsOf('/api/run', { q: 'lead status = new', limit: 20, offset: 0 });
      assert.equal(typeof reply.total, 'number');
      assert.deepEqual(
        statements.filter((sql) => CATALOG.test(sql)),
        [],
        'no existence probe on a read',
      );
      assert.equal(statements.length, 2, statements.join('\n'));
      assert.ok(
        statements.some((sql) => /LIMIT 10001/.test(sql)),
        'a filtered total is bounded',
      );
    });

    test('a list page that says count none reads rows only', async () => {
      const { reply, statements } = await statementsOf('/api/run', { q: 'lead status = new', limit: 20, offset: 20, count: 'none' });
      assert.equal(reply.total, undefined);
      assert.equal(statements.length, 1, statements.join('\n'));
    });

    test('a single-value metric is one statement, with no count of its one row', async () => {
      const { reply, statements } = await statementsOf('/api/breakdown', { text: 'opportunity stage = closed_won sum amount' });
      assert.equal((reply.rows as unknown[]).length, 1);
      assert.equal(statements.length, 1, statements.join('\n'));
    });

    test('a grouped breakdown that fits its page is one statement', async () => {
      const { reply, statements } = await statementsOf('/api/breakdown', { text: 'lead count by source' });
      assert.ok((reply.rows as unknown[]).length > 1);
      assert.equal(reply.total, (reply.rows as unknown[]).length);
      assert.equal(statements.length, 1, statements.join('\n'));
    });

    test("a list's six tab counts are one request and one statement", async () => {
      const items = ['new', 'working', 'qualified', 'converted', 'lost'].map((status) => `lead status = ${status}`).concat('lead');
      const { reply, statements } = await statementsOf('/api/counts', { items });
      const results = reply.results as Array<{ total: number }>;
      assert.equal(results.length, 6);
      assert.equal(
        results.slice(0, 5).reduce((sum, result) => sum + result.total, 0),
        results[5].total,
        'the statuses partition the leads',
      );
      assert.equal(statements.length, 1, statements.join('\n'));
    });

    test("a record's references are counted in one statement", async () => {
      const { reply, statements } = await statementsOf('/api/references', { table: 'account', key: { id: 1 } });
      const references = reply.references as Array<{ count: number }>;
      assert.ok(references.length > 2, 'an account is referenced from several tables');
      assert.ok(references.every((reference) => typeof reference.count === 'number' && reference.count >= 0));
      assert.equal(statements.length, 1, statements.join('\n'));
    });
  });
}

suite('SQLite', sqliteEngine);
suite(
  'PostgreSQL',
  postgresEngine,
  process.env.TABLEWALK_TEST_PG ? undefined : 'Set TABLEWALK_TEST_PG to a server whose role may CREATE DATABASE.',
);
