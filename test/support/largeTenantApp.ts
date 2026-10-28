/**
 * A tenant App the size of a field report's — a few hundred tables, a hundred
 * and fifty commands, ten roles — on a SQLite file, for the CPU a deployment
 * spends checking itself before its port opens (tenant-startup-scale.test.ts).
 *
 * Its shape: every table but the last few is a tenant's and refers to the one
 * before it; those few are the platform's. Each resource carries what a real
 * one does beyond its grants — tabs, rollups over its children, a derived
 * column, here and there a hidden column or a state machine. Each command is
 * an action on its target, reads a few dozen tables around it and takes a
 * reference input that picks a row of one of them; one in ten is the
 * platform's. Every role says which columns it reads, some edit a few
 * columns of a slice of the tables, some are kept from a column, two are the
 * platform's, and each is granted a different share of its realm's commands.
 * Deterministic: the same arguments always build the same App.
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { AppDef } from '../../packages/mistri/src/shared/app.js';
import { defineCommand, defineCommands, type BusinessCommandRegistry } from '../../packages/mistri/src/server/commands/businessCommands.js';
import { defineAppTenantPolicy, type AppTenantPolicy } from '../../packages/mistri/src/server/policy/appTenantPolicy.js';
import { provisionSqliteTenantStore } from '../../packages/mistri/src/server/tenant/tenantStore.js';
import { migrateSqliteCommandJournal } from '../../packages/mistri/src/adapters/commands/commandJournal.js';
import type { TenantEnrollmentOptions } from '../../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { parseTestApp } from './commandCatalog.js';

export interface LargeTenantApp {
  app: AppDef;
  registry: BusinessCommandRegistry;
  policy: AppTenantPolicy;
  roles: string[];
  tables: string[];
  commands: string[];
  /** What createTenantEnrollment takes. */
  options: TenantEnrollmentOptions<unknown>;
}

/* A business table's other columns: a real one carries a few dozen. */
const EXTRA = Array.from({ length: 16 }, (_, index) => `field_${String(index).padStart(2, '0')}`);
/* What a role reads of a table when it says: everything but the tenant's own column. */
const COLUMNS = ['id', 'version', 'name', 'status', 'amount', 'secret', 'note', 'parent_id', ...EXTRA];
/* How far back each of a table's first few `field_` columns refers. */
const REFERENCES = [2, 3, 5];
const PLATFORM_TABLES = 10;
const PLATFORM_ROLES = 2;

export interface LargeTenantShape {
  tables?: number;
  commands?: number;
  roles?: number;
  /** How many tables each command reads. */
  reads?: number;
  /** A command's `when`, by its index, in place of the default (every third asks `status = 'open'`). */
  whenOf?: (index: number) => string | undefined;
}

export function largeTenantApp(
  directory: string,
  {
    tables: count = 250,
    commands = 150,
    roles = 10,
    reads = 30,
    whenOf = (index) => (index % 3 === 0 ? "status = 'open'" : undefined),
  }: LargeTenantShape = {},
): LargeTenantApp {
  const tables = Array.from({ length: count }, (_, index) => `t${String(index).padStart(3, '0')}`);
  const tenantTables = tables.slice(0, count - PLATFORM_TABLES),
    platformTables = tables.slice(count - PLATFORM_TABLES);
  /* The table before and after one in its own realm's list: a parent refers within its realm. */
  const realmOf = (table: string) => (platformTables.includes(table) ? platformTables : tenantTables);
  const neighbour = (table: string, step: number) => {
    const list = realmOf(table);
    return list[list.indexOf(table) + step];
  };
  const path = join(directory, 'business.db');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    for (const table of tables) {
      const parent = neighbour(table, -1);
      /* A tenant's row points at its parent through the tenant's composite key too, as a tenant App's do, and a
         few of its other columns refer further back: a real catalog has several references per table. */
      const further = REFERENCES.map((step) => neighbour(table, -step));
      db.exec(`CREATE TABLE ${table} (
        id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', amount INTEGER, secret TEXT, note TEXT,
        parent_id TEXT${parent ? ` REFERENCES ${parent}(id)` : ''},
        ${EXTRA.map((column, index) => `${column} TEXT${further[index] ? ` REFERENCES ${further[index]}(id)` : ''}`).join(', ')},
        UNIQUE (tenant_id, id)${parent ? `, FOREIGN KEY (tenant_id, parent_id) REFERENCES ${parent}(tenant_id, id)` : ''})`);
    }
  } finally {
    db.close();
  }
  const binding = { appId: 'large', source: { id: 'business', connection: 'large-db' }, storeId: 'large-store' };
  provisionSqliteTenantStore(path, binding);
  migrateSqliteCommandJournal(path);

  const ids = Array.from({ length: commands }, (_, index) => `c${String(index).padStart(3, '0')}`);
  const platformCommand = (index: number) => index % 10 === 9;
  /* Commands are spread over their realm's tables, a few on each targeted one, so a resource carries several actions. */
  const footprintOf = (index: number) => {
    const list = platformCommand(index) ? platformTables : tenantTables;
    const at = (index * 2) % list.length;
    // A real command reads around its target: the rows it checks and the ones it links, a few dozen in a large App.
    const read = Array.from({ length: Math.min(reads, list.length) }, (_, step) => list[(at + step) % list.length]);
    return { target: read[0], picked: read[1 % read.length], read };
  };
  const inputOf = (index: number) =>
    ({
      pick: { label: 'Pick', type: 'reference', from: footprintOf(index).picked, by: 'id', labelColumn: 'name', query: 'status = open' },
      note: { label: 'Note', type: 'text', optional: true },
    }) as const;
  const roleNames = Array.from({ length: roles }, (_, index) => `role${index}`);
  const platformRole = (k: number) => k >= roles - PLATFORM_ROLES;
  const roleGrants = Object.fromEntries(
    roleNames.map((role, k) => {
      const realm = platformRole(k) ? 'platform' : 'tenant';
      const own = platformRole(k) ? platformTables : tenantTables;
      const hidesSecret = k % 2 === 1;
      const writes = k % 3 === 0 ? own.filter((_, index) => index % 4 === k % 4) : [];
      const fields = Object.fromEntries(
        own.map((table) => [
          table,
          {
            read: COLUMNS.filter((column) => !(hidesSecret && column === 'secret')),
            ...(writes.includes(table) ? { write: ['name', 'note'] } : {}),
          },
        ]),
      );
      return [
        role,
        {
          realm,
          read: true,
          write: writes.length ? writes : false,
          commands: ids.filter((_, index) => platformCommand(index) === platformRole(k) && (index * 7 + k) % roles < Math.max(2, k)),
          fields,
        },
      ];
    }),
  );
  const actionsOn = new Map<string, Record<string, unknown>>();
  for (const [index, id] of ids.entries()) {
    const { target } = footprintOf(index);
    const actions = actionsOn.get(target) ?? {};
    actions[id] = {
      label: `Do ${id}`,
      command: { id, version: 1, target, input: inputOf(index), ...(platformCommand(index) ? { realm: 'platform' } : {}) },
    };
    actionsOn.set(target, actions);
  }
  const app = parseTestApp(
    {
      id: binding.appId,
      name: 'Large tenant',
      sources: { business: { connection: binding.source.connection } },
      resources: Object.fromEntries(
        tables.map((table, index) => {
          const child = neighbour(table, 1);
          return [
            table,
            {
              owner: platformTables.includes(table) ? 'platform' : 'tenant',
              access: 'write',
              recordLabel: 'name',
              segments: { open_items: { query: 'status = open', label: 'Open' }, big_items: { query: 'amount > 100', label: 'Big' } },
              ...(child
                ? {
                    rollups: {
                      children: { fn: 'count', from: child, whose: 'parent_id' },
                      spent: { fn: 'sum', from: child, column: 'amount', whose: 'parent_id' },
                    },
                  }
                : {}),
              computed: { is_big: { type: 'boolean', value: 'amount > 100' } },
              ...(index % 5 === 4 ? { hidden: ['secret'] } : {}),
              ...(index % 3 === 1
                ? { machine: { column: 'status', states: { open: { on: { close: 'closed' } }, closed: { final: true } } } }
                : {}),
              ...(actionsOn.has(table) ? { actions: actionsOn.get(table) } : {}),
            },
          ];
        }),
      ),
      auth: { rows: 'tenant', tenancy: { platform: { label: 'Operator' } }, roles: roleGrants },
      views: Object.fromEntries([
        ...tenantTables.slice(0, 40).map((table) => [`${table}-list`, { kind: 'list', from: table }]),
        ...platformTables.slice(0, 5).map((table) => [`${table}-list`, { kind: 'list', from: table, realm: 'platform' }]),
      ]),
      home: `${tables[0]}-list`,
    },
    'large tenant fixture',
  );
  const registry = defineCommands(
    Object.fromEntries(
      ids.map((id, index) => {
        const { target, read } = footprintOf(index);
        return [
          id,
          defineCommand({
            source: 'business',
            target,
            read,
            write: [target],
            ...(platformCommand(index) ? { realm: 'platform' as const } : {}),
            ...(whenOf(index) === undefined ? {} : { when: whenOf(index) }),
            input: inputOf(index),
            output: { parse: (value: unknown) => value },
            handle: () => ({ ok: true }),
          }),
        ];
      }),
    ),
  );
  const rows = Object.freeze(Object.fromEntries(tables.map((table) => [table, true])));
  const policy = defineAppTenantPolicy({
    kind: 'tenant',
    appId: binding.appId,
    storeId: binding.storeId,
    ownership: Object.fromEntries(
      tables.map((table) => [table, platformTables.includes(table) ? { kind: 'platform' } : { kind: 'tenant', column: 'tenant_id' }]),
    ),
    resolveMembershipRows: () => rows,
    resolveRows: () => rows,
    resolvePlatformRows: () => rows,
    resultReferences: Object.fromEntries(ids.map((id) => [id, () => []])),
  });
  return {
    app,
    registry,
    policy,
    roles: roleNames,
    tables,
    commands: ids,
    options: {
      app,
      pages: [],
      policy,
      source: { ...binding.source, existingPath: path },
      deployment: 'large-deployment',
      roles: roleNames,
      maxLifetimeMs: 300_000,
      verifySession: () => ({ id: 'ada', who: 'ada@example.test' }),
      commands: { registry },
    },
  };
}
