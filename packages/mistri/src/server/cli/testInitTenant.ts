/**
 * `mistri test init` on a tenant App: tests/tenants.test.ts, the isolation a tenant App promises, asserted
 * through its doors with the kit's members (testing/tenant.ts):
 *
 * - a member works in its own tenant only: another tenant and the platform realm are refused;
 * - per tenant-owned resource, two tenants each list their own rows and never open the other's records, which
 *   answer not_found exactly as a record that does not exist;
 * - per command a tenant role runs on a tenant-owned record, another tenant's record is refused at prepare and at
 *   execute, before anything is written;
 * - per platform role, the platform realm's reads are answered, and it is no member of a tenant.
 *
 * The tenants are two of the profile table's rows, read from the database the suite copies, or
 * MISTRI_TEST_TENANTS when the run names them. Nothing here grants: the members are made by the test host as an
 * operator makes them, and every assertion is the server's own answer.
 */
import type { LoadedApp } from '../app/apps.js';
import { Registry } from '@mistriwork/engine/server/connections.js';
import { CONFIG_SECTIONS } from '../serviceConnections.js';
import type { Options } from '@mistriwork/engine/server/cli/args.js';
import type { AppCommandField } from '../../shared/command.js';
import { sampleInput } from '../testing/appRequests.js';

interface Grants {
  read: Set<string>;
  commands: Set<string>;
}

const q = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

type Roles = NonNullable<NonNullable<LoadedApp['app']['auth']>['roles']>;
const realmOf = (roles: Roles, role: string) =>
  (roles[role] as { realm?: string } | undefined)?.realm === 'platform' ? 'platform' : 'tenant';

/** The policy module a tenant App is served with, by the names the docs give it, relative to the App. */
export const TENANT_POLICY_NAMES = ['policy', 'tenant-policy', 'server/tenant-policy', 'server/policy'];

/** Two tenants of the database the suite copies: the first two rows of the profile table, by its key. */
export async function tenantsFor(loaded: LoadedApp, configFile: string | undefined): Promise<string[]> {
  if (!configFile || !loaded.app.auth?.tenancy?.profile) return [];
  const registry = new Registry();
  const log = console.log;
  try {
    console.log = () => {};
    const { readStartupConfig } = await import('@mistriwork/engine/server/cli/config.js');
    await readStartupConfig({ config: configFile } as Options, registry, CONFIG_SECTIONS);
    const { profileTenants } = await import('../tenant/tenantLocalAccess.js');
    return await profileTenants(loaded, registry, 2);
  } catch {
    /* Unreadable here: the suite asks for MISTRI_TEST_TENANTS when it runs. */
    return [];
  } finally {
    console.log = log;
    await registry.closeAll().catch(() => {});
  }
}

/** tests/tenants.test.ts for a tenant App, from its roles' grants, its resources' owners and its commands. */
export async function tenantsModule(loaded: LoadedApp, grants: Map<string | null, Grants>, tenants: readonly string[]): Promise<string> {
  const app = loaded.app;
  const roles = (app.auth?.roles ?? {}) as Roles;
  const label = app.auth?.tenancy?.label ?? 'Tenant';
  const one = label.toLowerCase();
  const people = [...grants.entries()].filter((entry): entry is [string, Grants] => entry[0] !== null);
  const tenantRoles = people.filter(([role]) => realmOf(roles, role) === 'tenant');
  const platformRoles = people.filter(([role]) => realmOf(roles, role) === 'platform');
  const owned = Object.entries(app.resources ?? {})
    .filter(([, resource]) => (resource as { owner?: string }).owner === 'tenant')
    .map(([name]) => name)
    .sort();
  const readerOf = (table: string) => tenantRoles.find(([, held]) => held.read.has(table))?.[0];
  const tables = owned.flatMap((table) => {
    const role = readerOf(table);
    return role ? [[table, role] as const] : [];
  });
  /* An answer to each question a command asks, as a journey's: an execute is judged on its input before its record,
     so a check of the record's tenant sends one that passes. None where a question needs the author (a reference). */
  const inputOf = async (table: string, command: string) => {
    const action = (app.resources?.[table]?.actions ?? []).find(
      (each) => typeof each.command === 'object' && each.command?.id === command,
    ) as { command?: { input?: AppCommandField[] } } | undefined;
    const sampled = await sampleInput(action?.command?.input ?? [], async () => undefined);
    return sampled.unanswered ? undefined : sampled.input;
  };
  const commands: Array<readonly [string, number, string, string, string, string]> = [];
  for (const [role, held] of tenantRoles)
    for (const command of [...held.commands].sort()) {
      const declared = loaded.commands?.registry?.[command] as
        | { version?: number; target?: string; targets?: string; realm?: string; public?: boolean }
        | undefined;
      if (!declared?.target || declared.targets === 'none' || declared.public || declared.realm === 'platform') continue;
      const table = Object.entries(app.resources ?? {}).find(([name, resource]) => (resource.physical ?? name) === declared.target)?.[0];
      const reader = table && owned.includes(table) ? readerOf(table) : undefined;
      if (!table || !reader || commands.some(([name]) => name === command)) continue;
      const input = await inputOf(table, command);
      commands.push([command, declared.version ?? 1, table, role, reader, input ? JSON.stringify(input) : '']);
    }
  const member = tenantRoles[0]?.[0];
  const fallback = tenants.length >= 2 ? q(`${tenants[0]},${tenants[1]}`) : undefined;
  const list = (rows: ReadonlyArray<readonly (string | number)[]>) =>
    rows.map((row) => `    [${row.map((value) => (typeof value === 'number' ? String(value) : q(value))).join(', ')}],`).join('\n');
  return `/**
 * ${app.name}'s ${one} isolation, written by \`mistri test init\`: a member works in its own ${one} only; for each
 * resource a ${one} owns, two ${one}s list their own rows and never open each other's records; each command a ${one}'s
 * role runs is refused on another ${one}'s record; and the platform realm's reads are answered. Members are made by
 * the test host as an operator grants them (\`host.tenant\`, \`host.platform\`); every assertion is the server's own
 * answer. Yours to change.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import type { TestTenantClient } from '@mistriwork/mistri/testing';
import { startApp } from './start.ts';

/** The two ${one}s the suite works in: MISTRI_TEST_TENANTS=<id>,<id>${fallback ? `, else two of the database's` : ''}. */
const [A, B] = (process.env.MISTRI_TEST_TENANTS ?? ${fallback ?? "''"}).split(',');

/** Up to five of a member's records of \`table\`, by key. */
async function some(member: TestTenantClient, table: string) {
  const rows = await member.rows(table, { limit: 5 });
  assert.ok(rows.ok, rows.ok ? '' : \`\${table}: \${rows.message}\`);
  return Promise.all(rows.value.map((row) => member.key(table, row)));
}

/** Each of \`owner\`'s records opens for it and is not found to \`other\`: how many there were. */
async function apart(table: string, owner: TestTenantClient, other: TestTenantClient) {
  const keys = await some(owner, table);
  for (const key of keys) {
    assert.ok((await owner.record(table, key)).ok, \`\${table} \${JSON.stringify(key)} opens in its own ${one}\`);
    const theirs = await other.record(table, key);
    assert.equal(theirs.ok ? 'found' : theirs.code, 'not_found', \`\${table} \${JSON.stringify(key)} from another ${one}\`);
  }
  return keys.length;
}

test('${one} isolation', async (t) => {
  if (!A || !B || A === B) throw new Error('Set MISTRI_TEST_TENANTS to two ${one}s of the database, as <id>,<id>.');
  const host = await startApp(t);
${
  member
    ? `
  await t.test('a member works in its own ${one} only', async () => {
    const member = await host.tenant(A, { roles: [${q(member)}] });
    for (const elsewhere of [B, '@platform']) assert.equal((await member.enter(elsewhere)).ok, false, \`entering \${elsewhere}\`);
  });
`
    : ''
}${
    tables.length
      ? `
  /* Each resource a ${one} owns, with a role that reads it. */
  for (const [table, role] of [
${list(tables)}
  ] as const) {
    await t.test(\`\${table}: each ${one} lists its own rows and never opens another's\`, async (s) => {
      const a = await host.tenant(A, { roles: [role] });
      const b = await host.tenant(B, { roles: [role] });
      if (!((await apart(table, a, b)) + (await apart(table, b, a)))) s.skip(\`neither \${A} nor \${B} has a \${table} row: seed some\`);
    });
  }
`
      : ''
  }${
    commands.length
      ? `
  /* Each command a ${one}'s role runs on its records: [command, version, its table, a role that runs it, one that
     reads the table, an input that passes its questions ('' where one needs you)]. */
  for (const [command, version, table, role, reader, input] of [
${list(commands)}
  ] as const) {
    await t.test(\`\${command}: refused on another ${one}'s \${table}\`, async (s) => {
      const a = await host.tenant(A, { roles: [role] });
      const [key] = await some(await host.tenant(B, { roles: [reader] }), table);
      if (!key) return s.skip(\`\${B} has no \${table} row to aim at\`);
      const prepared = await a.prepare(command, key);
      assert.equal(prepared.ok ? 200 : prepared.status, 403);
      if (!input) return s.skip(\`\${command} asks a question the suite cannot answer: give its input to check its execute\`);
      const executed = await a.request('/api/commands/execute', {
        method: 'POST',
        json: { command, commandVersion: version, key, expectedVersion: 0, idempotencyKey: randomBytes(18).toString('base64url'), input: JSON.parse(input) },
      });
      assert.equal(executed.status, 403, await executed.text());
    });
  }
`
      : ''
  }${
    platformRoles.length
      ? `
  /* The platform realm's reads, per platform role: what its policy's resolvePlatformRows answers. */
  for (const [role, tables] of [
${platformRoles.map(([role, held]) => `    [${q(role)}, [${[...held.read].sort().map(q).join(', ')}]],`).join('\n')}
  ] as const) {
    await t.test(\`\${role} reads the platform's tables and is no member of a ${one}\`, async () => {
      const platform = await host.platform({ roles: [role] });
      for (const table of tables) {
        const rows = await platform.rows(table);
        assert.ok(rows.ok, rows.ok ? '' : \`\${table}: \${rows.message}\`);
      }
      assert.equal((await platform.enter(A)).ok, false);
    });
  }
`
      : ''
  }});
`;
}
