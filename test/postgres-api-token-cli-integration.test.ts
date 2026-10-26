import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { migratePostgresAuthStore } from '../packages/mistri/src/adapters/auth/postgresAuthStore.js';
import { issuePostgresApiToken } from '../packages/mistri/src/server/auth/postgresApiTokenMaintenance.js';
import { runApiTokenMaintenance } from '../packages/mistri/src/server/cli/apiTokenMaintenance.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { liveSkip } from './live.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
const LIVE = process.env.TABLEWALK_TEST_PG;
interface Client extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}

test(
  'PG CLI locked App routes native maintenance and actual process issuance to isolated stores',
  { skip: liveSkip('postgres', LIVE), timeout: 120000 },
  async (t) => {
    const name = `tw_token_cli_${randomUUID().replaceAll('-', '')}`;
    const businessName = `tw_token_cli_data_${randomUUID().replaceAll('-', '')}`;
    const module = 'pg';
    const pg = (await import(module)) as { default: { Client: new (options: unknown) => Client } };
    const control = new pg.default.Client({ connectionString: LIVE, statement_timeout: 10000 });
    const dir = mkdtempSync(join(tmpdir(), 'tw-pg-token-cli-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let owned = false,
      ownedBusiness = false,
      db: Client | undefined;
    try {
      await control.connect();
      await control.query(`CREATE DATABASE "${name}"`);
      owned = true;
      const url = new URL(LIVE!);
      url.pathname = `/${name}`;
      await migratePostgresAuthStore(url.href);
      db = new pg.default.Client({ connectionString: url.href });
      await db.connect();
      assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name, name);
      await db.query(`INSERT INTO mistri.auth_user (id,name,email,"emailVerified","createdAt","updatedAt",role,banned)
        VALUES ('actor','Actor','actor@example.test',true,now(),now(),'reader',false)`);
      await control.query(`CREATE DATABASE "${businessName}"`);
      ownedBusiness = true;
      const businessUrl = new URL(LIVE!);
      businessUrl.pathname = `/${businessName}`;
      const business = new pg.default.Client({ connectionString: businessUrl.href });
      try {
        await business.connect();
        await business.query('CREATE TABLE item(id INTEGER PRIMARY KEY)');
      } finally {
        await business.end();
      }
      const appPath = join(dir, 'app.json'),
        configPath = join(dir, 'config.json');
      writeFileSync(
        appPath,
        JSON.stringify({
          id: 'app',
          name: 'App',
          connection: 'business',
          resources: { item: {} },
          views: { items: { kind: 'list', from: 'item' } },
          home: 'items',
          auth: { store: url.href, roles: { reader: { read: true } } },
          api: { version: 1, roles: ['reader'], resources: { item: { fields: ['id'] } } },
        }),
      );
      writeFileSync(configPath, JSON.stringify({ connections: [{ name: 'business', url: businessUrl.href }] }));
      const loaded = await loadApp(appPath);
      writeFileSync(join(dir, 'authority.lock'), loaded.authority!.report);
      const storeId = randomUUID(),
        common = ['--app', appPath, '--config', configPath, '--store-id', storeId];
      const provisioned = await runApiTokenMaintenance(['provision', ...common]);
      assert.equal(provisioned.verb, 'provision');
      assert.ok(provisioned.result && 'migrated' in provisioned.result && provisioned.result.migrated);
      const schema: DatabaseSchema = {
        label: 'PG',
        dialect: 'postgres',
        readAt: '',
        foreignKeys: [],
        tables: [
          {
            id: 'item',
            name: 'item',
            schema: '',
            isView: false,
            columns: [{ name: 'id', type: 'integer', primaryKey: true, nullable: false }],
          },
        ],
      };
      const issued = await issuePostgresApiToken(
        url.href,
        loaded.app,
        schema,
        {
          storeId,
          excludeConnections: [],
          subjectId: 'actor',
          actorId: 'actor',
          roles: ['reader'],
          label: 'native',
          expiresAt: Date.now() + 60000,
        },
        Date.now,
      );
      const token = ['--token-id', issued.tokenId];
      const inspected = await runApiTokenMaintenance(['inspect', ...common, ...token]);
      assert.ok(inspected.result && 'record' in inspected.result);
      assert.equal(inspected.result.version, '1');
      const revoked = await runApiTokenMaintenance(['revoke', ...common, ...token, '--expected-version', '1', '--actor', 'actor']);
      assert.deepEqual(revoked, { verb: 'revoke', result: { tokenId: issued.tokenId, version: '2' } });
      for (const result of [inspected, revoked]) {
        assert.ok(!JSON.stringify(result).includes(issued.token));
        assert.ok(!JSON.stringify(result).includes('"digest"'));
      }
      const invoke = (args: string[]) =>
        new Promise<{ out: string; err: string }>((resolve, reject) => {
          execFile(
            process.execPath,
            ['--import', 'tsx', fileURLToPath(new URL('../packages/mistri/src/server/index.ts', import.meta.url)), 'api-token', ...args],
            { timeout: 20000, killSignal: 'SIGKILL' },
            (error, out, err) => {
              if (error) reject(new Error('PG token CLI subprocess failed (output withheld).'));
              else resolve({ out, err });
            },
          );
        });
      const processIssued = await invoke([
        'issue',
        ...common,
        '--subject',
        'actor',
        '--actor',
        'actor',
        '--role',
        'reader',
        '--label',
        'PG CLI',
        '--expires-at',
        new Date(Date.now() + 60000).toISOString(),
        '--deny-all-operations',
      ]);
      const result = JSON.parse(processIssued.out).result;
      assert.equal(typeof result.token, 'string');
      assert.ok(!processIssued.err.includes(result.token));
      const processInspected = await invoke(['inspect', ...common, '--token-id', result.tokenId]);
      assert.deepEqual(JSON.parse(processInspected.out).result.record.operations, []);
      const processRevoked = await invoke([
        'revoke',
        ...common,
        '--token-id',
        result.tokenId,
        '--expected-version',
        '1',
        '--actor',
        'actor',
      ]);
      for (const response of [processInspected, processRevoked]) {
        assert.ok(!response.out.includes(result.token));
        assert.ok(!response.err.includes(result.token));
        assert.ok(!response.out.includes('"digest"'));
        assert.ok(!response.out.includes('"token"'));
      }
      assert.equal((await db.query('SELECT count(*)::integer AS n FROM mistri.auth_api_token')).rows[0].n, 2);
      await assert.rejects(runApiTokenMaintenance(['inspect', ...common.slice(0, -1), randomUUID(), ...token]));
    } finally {
      await db?.end();
      if (owned) await control.query(`DROP DATABASE "${name}"`);
      if (ownedBusiness) await control.query(`DROP DATABASE "${businessName}"`);
      await control.end();
    }
  },
);
