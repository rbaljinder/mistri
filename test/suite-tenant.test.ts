import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { provisionSqliteTenantStore, TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { startConfiguredSuite } from '../packages/mistri/src/server/cli/suiteCommand.js';
import { changeSuiteGrant } from '../packages/mistri/src/server/cli/suiteGrant.js';

for (const shared of [false, true])
  test(
    `suite CLI tenant mounts isolate memberships, contexts and equal row ids (${shared ? 'shared' : 'independent'} sign-in)`,
    { timeout: 15_000 },
    async (t) => {
      const directory = mkdtempSync(join(tmpdir(), 'tablewalk-suite-tenant-'));
      let active: Awaited<ReturnType<typeof startConfiguredSuite>> | undefined;
      t.after(async () => {
        await active?.close();
        rmSync(directory, { recursive: true, force: true });
      });
      const reservation = createServer();
      await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
      const port = (reservation.address() as { port: number }).port;
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      const deployments = [],
        fixtures = [];
      const environment: NodeJS.ProcessEnv = { SECRET: 'suite-tenant-test-secret-longer-than-thirty-two-characters' };
      for (const id of ['alpha', 'beta']) {
        const home = join(directory, id);
        mkdirSync(home);
        const database = join(home, 'business.db');
        const db = new DatabaseSync(database);
        db.exec(`CREATE TABLE item(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL);
      INSERT INTO item VALUES('same', 'north', '${id}'), ('hidden', 'south', 'not granted');`);
        db.close();
        provisionSqliteTenantStore(database, { appId: id, source: { id: 'data', connection: 'data' }, storeId: 'store' });
        const seed = new DatabaseSync(database);
        seed.exec(`INSERT INTO "${TENANT_TABLES.tenant}" VALUES('north','active','1','tenant'),('south','active','1','tenant')`);
        seed.close();
        const manifest = {
          id,
          name: id,
          sources: { data: { connection: 'data' } },
          auth: { store: join(home, 'auth.db'), rows: 'tenant', signUp: 'open', roles: { member: { read: true } } },
          resources: { item: { owner: 'tenant', fields: { read: ['id', 'name'] } } },
          views: { items: { kind: 'list', from: 'item' } },
          home: 'items',
        };
        writeFileSync(join(home, 'app.json'), JSON.stringify(manifest));
        writeFileSync(
          join(home, 'policy.mjs'),
          `export default {kind:'tenant',appId:${JSON.stringify(id)},storeId:'store',
      ownership:{item:{kind:'tenant',column:'tenant_id'}},resolveMembershipRows:()=>({item:true}),resolveRows:()=>({item:true})};`,
        );
        writeFileSync(join(home, 'connections.json'), JSON.stringify({ connections: [{ name: 'data', url: '${DATABASE_URL}' }] }));
        environment[id.toUpperCase()] = database;
        deployments.push({
          id,
          directory: `./${id}`,
          mount: `/${id}`,
          config: `./${id}/connections.json`,
          policy: `./${id}/policy.mjs`,
          environment: { BETTER_AUTH_SECRET: 'SECRET', DATABASE_URL: id.toUpperCase() },
        });
        fixtures.push({ id, database, home, manifest });
      }
      const file = join(directory, 'suite.json');
      writeFileSync(
        file,
        JSON.stringify({
          port,
          apps: deployments,
          ...(shared
            ? {
                identity: {
                  id: 'keystone',
                  name: 'Keystone',
                  store: './identity.db',
                  grants: './grants.db',
                  environment: { BETTER_AUTH_SECRET: 'SECRET' },
                },
              }
            : {}),
        }),
      );
      active = await startConfiguredSuite(file, environment);
      const call = async (path: string, headers: Record<string, string> = {}, body?: unknown) => {
        const response = await fetch(active!.publicURL + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { origin: active!.publicURL, 'content-type': 'application/json', ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        return {
          status: response.status,
          body: JSON.parse(text),
          text,
          cookie: response.headers
            .getSetCookie()
            .map((value) => value.split(';')[0])
            .join('; '),
        };
      };
      const contexts: Record<string, Record<string, string>> = {};
      let sharedAccount: Awaited<ReturnType<typeof call>> | undefined;
      for (const fixture of fixtures) {
        const { id, database } = fixture;
        const account =
          sharedAccount ??
          (await call(
            `/${id}/api/auth/sign-up/email`,
            {},
            { name: 'Reader', email: 'reader@example.test', password: 'test-only-tenant-password' },
          ));
        assert.equal(account.status, 200, account.text);
        const headers = { cookie: account.cookie, 'x-mistri-account': account.body.user.id };
        if (shared) {
          sharedAccount = account;
          const refused = await call(`/${id}/api/tenant/context/open?app=${id}&tenant=north`, headers, {});
          assert.ok(refused.status >= 400, 'shared sign-in alone has no App grant');
          await changeSuiteGrant(file, { appId: id, subjectId: account.body.user.id, expectedRevision: 0, roles: ['member'] }, environment);
        }
        const db = new DatabaseSync(database);
        db.prepare(
          `INSERT INTO "${TENANT_TABLES.membership}" VALUES(?, 'north', ?, 'active', '1', '["member"]', ?, 'member', NULL, NULL, NULL)`,
        ).run('membership', account.body.user.id, Date.now() + 120000);
        db.close();
        const open = await call(`/${id}/api/tenant/context/open?app=${id}&tenant=north`, headers, {});
        assert.equal(open.status, 200, open.text);
        contexts[id] = {
          ...headers,
          'x-mistri-tab': open.body.tabId,
          'x-mistri-context': open.body.context,
          'x-mistri-lease-revision': String(open.body.revision),
        };
        const rows = await call(`/${id}/api/query?app=${id}&tenant=north`, contexts[id], { table: 'item' });
        assert.equal(rows.status, 200, rows.text);
        assert.deepEqual(rows.body.rows, [{ id: 'same', name: id }]);
        const hidden = await call(`/${id}/api/tenant/context/open?app=${id}&tenant=south`, headers, {});
        assert.ok(hidden.status >= 400, hidden.text);
      }
      const foreign = await call('/beta/api/query?app=beta&tenant=north', contexts.alpha, { table: 'item' });
      assert.ok(foreign.status >= 400, foreign.text);
      const spoof = await call('/beta/api/query?app=alpha&tenant=north', contexts.beta, { table: 'item' });
      assert.ok(spoof.status >= 400, spoof.text);
      if (shared) {
        const listed = await call('/api/suite/apps', { cookie: sharedAccount!.cookie });
        assert.deepEqual(
          listed.body.apps.map((app: { id: string }) => app.id),
          ['alpha', 'beta'],
        );
        await changeSuiteGrant(
          file,
          { appId: 'beta', subjectId: sharedAccount!.body.user.id, expectedRevision: 1, roles: [] },
          environment,
        );
        assert.ok(
          (await call('/beta/api/query?app=beta&tenant=north', contexts.beta, { table: 'item' })).status >= 400,
          'an existing tenant context cannot outlive its App grant',
        );
        assert.equal((await call('/alpha/api/query?app=alpha&tenant=north', contexts.alpha, { table: 'item' })).status, 200);
        const after = await call('/api/suite/apps', { cookie: sharedAccount!.cookie });
        assert.deepEqual(
          after.body.apps.map((app: { id: string }) => app.id),
          ['alpha'],
        );
        assert.equal(
          (await call('/alpha/api/auth/sign-out', { cookie: sharedAccount!.cookie, 'x-mistri-account': sharedAccount!.body.user.id }, {}))
            .status,
          200,
        );
        assert.ok((await call('/alpha/api/query?app=alpha&tenant=north', contexts.alpha, { table: 'item' })).status >= 400);
        assert.equal((await call('/api/suite/apps', { cookie: sharedAccount!.cookie })).status, 401);
      }
      await active.close();
      // Operator read-only connections still refuse declared writes before listening.
      const first = fixtures[0];
      writeFileSync(
        join(first.home, 'app.json'),
        JSON.stringify({ ...first.manifest, resources: { item: { ...first.manifest.resources.item, access: 'write' } } }),
      );
      await assert.rejects(startConfiguredSuite(file, environment), /writable: true/);
    },
  );
