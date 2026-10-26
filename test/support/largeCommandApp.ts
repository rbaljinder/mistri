/**
 * A synthetic tenant App the size of a real one — many resources, hundreds of
 * commands, roles with column rules and `when` conditions — for the startup
 * cost of binding its command authorizers and for the decisions they make.
 * Deterministic: the same arguments always build the same App.
 */
import { parseAppConfig, type AppDef } from '../../packages/mistri/src/shared/app.js';
import type { DatabaseSchema } from '../../packages/engine/src/shared/schema.js';
import { defineCommand, defineCommands, type BusinessCommandRegistry } from '../../packages/mistri/src/server/commands/businessCommands.js';
import type { BusinessCommandAuthorizationOptions } from '../../packages/mistri/src/server/commands/businessCommandAuthorization.js';

export interface LargeCommandApp {
  app: AppDef;
  schema: DatabaseSchema;
  registry: BusinessCommandRegistry;
  roles: string[];
  commands: string[];
  options: BusinessCommandAuthorizationOptions;
}

/* A command whose `when` judges a column some roles are kept from: granted only to the roles that read it. */
export const judgesSecret = (index: number) => index % 33 === 0;
const COLUMNS = ['id', 'tenant_id', 'name', 'status', 'amount', 'secret', 'note', 'parent_id'];

export function largeCommandApp({ resources = 60, commands = 900, roles = 10 } = {}): LargeCommandApp {
  const tables = Array.from({ length: resources }, (_, index) => `r${String(index).padStart(2, '0')}`);
  const schema: DatabaseSchema = {
    label: 'Large',
    dialect: 'postgres',
    readAt: '',
    foreignKeys: [],
    tables: tables.map((id, index) => ({
      id,
      name: id,
      schema: '',
      isView: false,
      columns: COLUMNS.map((name) => ({
        name,
        type: name === 'amount' ? 'INTEGER' : 'TEXT',
        nullable: name === 'note' || name === 'parent_id',
        primaryKey: name === 'id',
        ...(name === 'parent_id' && index ? { references: { table: tables[index - 1], column: 'id' } } : {}),
      })),
    })),
  };
  const ids = Array.from({ length: commands }, (_, index) => `c${String(index).padStart(4, '0')}`);
  const roleNames = Array.from({ length: roles }, (_, index) => `role${index}`);
  const roleGrants = Object.fromEntries(
    roleNames.map((role, k) => {
      /* Every role but one reads everything; some edit a few columns in place; some
         are kept from a column; each is granted a different slice of the
         commands. */
      const hidesSecret = k % 2 === 1;
      // One role reads only half the resources, so a command it is granted can still read past it.
      const reads = k === 7 ? tables.filter((_, index) => index % 2 === 0) : tables;
      const writes = k % 3 === 0 ? tables.filter((_, index) => index % 4 === k % 4) : [];
      const fields = Object.fromEntries(
        tables
          .filter((table) => reads.includes(table) && (hidesSecret || writes.includes(table)))
          .map((table) => [
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
          read: reads === tables ? true : reads,
          ...(writes.length ? { write: writes } : {}),
          commands: ids.filter((_, index) => (index * 7 + k) % roles < Math.max(2, k) && !(hidesSecret && judgesSecret(index))),
          ...(Object.keys(fields).length ? { fields } : {}),
        },
      ];
    }),
  );
  const app = parseAppConfig(
    {
      id: 'large',
      name: 'Large',
      auth: { rows: 'all', roles: roleGrants },
      sources: { business: { connection: 'private' } },
      resources: Object.fromEntries(tables.map((table) => [table, { access: 'write' }])),
      views: { items: { kind: 'list', from: tables[0] } },
      home: 'items',
    },
    'fixture',
  );
  const registry = defineCommands(
    Object.fromEntries(
      ids.map((id, index) => {
        const at = index % resources;
        const target = tables[at];
        const read = [target, ...(at ? [tables[at - 1]] : []), tables[(at + 7) % resources]].filter(
          (table, position, all) => all.indexOf(table) === position,
        );
        return [
          id,
          defineCommand({
            source: 'business',
            target,
            read,
            write: [target],
            ...(index % 3 === 0 ? { when: judgesSecret(index) ? "secret = 'x'" : "status = 'open'" } : {}),
            input: { value: { label: 'Value', type: 'text', optional: true } },
            output: { parse: (value: unknown) => value },
            handle: () => ({ ok: true }),
          }),
        ];
      }),
    ),
  );
  const options: BusinessCommandAuthorizationOptions = {
    app,
    schema,
    registry,
    connectionFor: () => 'private',
    writableConnection: () => true,
    transactionalConnection: () => true,
    managedOwnership: Object.fromEntries(tables.map((table) => [table, 'tenant_id'])),
  };
  return { app, schema, registry, roles: roleNames, commands: ids, options };
}
