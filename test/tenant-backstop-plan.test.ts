/**
 * `mistri migrate backstop`'s plan and SQL, and its refusals, without a server (docs/postgresql.md): what a tenant
 * App's database must hold for the row-security backstop, written as idempotent SQL; which grants each kind of table
 * gets; and the sentences a run that cannot plan one prints. postgres-tenant-backstop.test.ts applies the SQL to a
 * real server and judges it with the catalog check.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runMigrate } from '../packages/engine/src/server/migrate/cli.js';
import { MIGRATE_APPS } from '../packages/mistri/src/server/cli/appTargets.js';
import { backstopPlan, backstopSql } from '../packages/mistri/src/server/tenant/tenantBackstop.js';
import type { TenantOwnershipSnapshot } from '../packages/mistri/src/server/tenant/tenantOwnership.js';

const ownership = {
  resources: { lead: 'public.lead', note: 'crm.Note', kind: 'public.kind', ledger: 'public.ledger' },
  ownership: {
    lead: { kind: 'tenant', column: 'tenant' },
    note: { kind: 'tenant', column: 'Owner "key"' },
    kind: { kind: 'global', access: 'read-only' },
    ledger: { kind: 'platform' },
  },
} as unknown as TenantOwnershipSnapshot;

test('the plan grants what each kind of table needs and fences only the tenant tables', () => {
  const plan = backstopPlan(ownership, 'app_runtime', {
    storeTables: ['mistri.__mistri_journal'],
    sequences: [
      { id: 'public.lead_seq', of: 'public.lead' },
      { id: 'public.ledger_seq', of: 'public.ledger' },
      { id: 'public.kind_seq', of: 'public.kind' },
      { id: 'mistri.__mistri_journal_seq' },
    ],
  });
  assert.deepEqual(plan.schemas, ['crm', 'mistri', 'public']);
  assert.deepEqual(plan.tables, [
    { id: 'crm.Note', write: true },
    { id: 'mistri.__mistri_journal', write: true },
    { id: 'public.kind', write: false },
    { id: 'public.lead', write: true },
  ]);
  assert.deepEqual(plan.tenant, [
    { id: 'crm.Note', column: 'Owner "key"' },
    { id: 'public.lead', column: 'tenant' },
  ]);
  assert.deepEqual(plan.unfenced, ['public.kind', 'public.ledger']);
  assert.deepEqual(
    plan.sequences,
    ['mistri.__mistri_journal_seq', 'public.lead_seq'],
    "a platform or read-only table's sequence is not the runtime's",
  );
});

test('the SQL is idempotent, quotes every name, and never widens, forces or leaves PUBLIC a grant', () => {
  const sql = backstopSql(
    backstopPlan(ownership, 'app_runtime', {
      storeTables: ['mistri.__mistri_journal'],
      sequences: [{ id: 'public.lead_seq', of: 'public.lead' }],
    }),
  );
  assert.match(sql, /CREATE ROLE "app_runtime" NOLOGIN NOBYPASSRLS/);
  assert.match(sql, /IF NOT EXISTS \(SELECT 1 FROM pg_catalog\.pg_roles WHERE rolname = 'app_runtime'\)/);
  assert.match(sql, /GRANT USAGE ON SCHEMA "crm", "mistri", "public" TO "app_runtime";/);
  assert.match(
    sql,
    /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "crm"\."Note", "mistri"\."__mistri_journal", "public"\."lead" TO "app_runtime";/,
  );
  assert.match(sql, /GRANT SELECT ON TABLE "public"\."kind" TO "app_runtime";/);
  assert.match(sql, /GRANT USAGE, SELECT ON SEQUENCE "public"\."lead_seq" TO "app_runtime";/);
  assert.match(sql, /ALTER TABLE "public"\."lead" ENABLE ROW LEVEL SECURITY;\nDROP POLICY IF EXISTS mistri_tenant ON "public"\."lead";/);
  assert.match(
    sql,
    /CREATE POLICY mistri_tenant ON "crm"\."Note" AS PERMISSIVE FOR ALL TO "app_runtime" USING \("Owner ""key""" = NULLIF\(current_setting\('mistri\.tenant', true\), ''\)\) WITH CHECK \("Owner ""key""" = NULLIF\(current_setting\('mistri\.tenant', true\), ''\)\);/,
  );
  assert.equal(sql.match(/CREATE POLICY/g)?.length, 2, 'a policy on each tenant table and no other');
  assert.doesNotMatch(sql, /FORCE|GRANT OPTION|PUBLIC|CREATE ON|LOGIN PASSWORD '(?!<secret>)/);
  assert.doesNotMatch(sql, /ledger/, "a platform table is the owner role's alone");
  assert.match(sql, /ALTER ROLE "app_runtime" LOGIN PASSWORD '<secret>'/, 'the operator step is said, never made');
});

test('a run that cannot plan a backstop says why in a sentence', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-backstop-plan-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = join(directory, 'mistri.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'desk', url: join(directory, 'desk.db'), writable: true }] }));
  const app = join(directory, 'app');
  const write = (file: string, text: string) => writeFileSync(join(app, file), text);
  mkdirSync(app);
  write('package.json', '{ "type": "module" }\n');
  write(
    'app.json',
    JSON.stringify({
      id: 'desk',
      name: 'Desk',
      connection: 'desk',
      resources: { item: { access: 'read' } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
      nav: ['items'],
    }),
  );
  const run = async (...argv: string[]) => {
    const said: string[] = [];
    const error = console.error;
    console.error = (line: string) => void said.push(String(line));
    try {
      const code = await runMigrate(['backstop', ...argv, '--app', app, '--config', config], () => {}, undefined, MIGRATE_APPS);
      return { code, said: said.join('\n') };
    } finally {
      console.error = error;
    }
  };
  const plain = await run('status');
  assert.equal(plain.code, 1);
  assert.match(plain.said, /not a tenant App/);
  const unknown = await run('wipe');
  assert.equal(unknown.code, 1);
  assert.match(unknown.said, /not a backstop command/);
});
