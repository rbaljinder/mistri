/** Shared by the App API writes-and-events tests (app-api-writes-events*.test.ts):
 * the shop App directory, its commands module and its tables. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './appApiCli.js';

/** The shop App: `item` an operator edits (its name only) and an editor
 * edits whole, through the API's generic writes; `ticket`, which both read
 * and only the auditor's `rename` writes; `vault`, which only the auditor
 * reads, flagged by `flag`. The commands emit `ticket.renamed` and
 * `vault.flagged`, both on the feed. */
export function writeShopApp(
  directory: string,
  options: { business: string; authStore: string; events?: readonly string[]; physical?: boolean },
) {
  const appDir = join(directory, 'app');
  mkdirSync(appDir);
  const config = join(directory, 'mistri.json'),
    commands = join(appDir, 'commands.mjs');
  writeFileSync(
    join(appDir, 'app.json'),
    JSON.stringify({
      id: 'shop',
      name: 'Shop',
      sources: { business: { connection: 'data', default: true } },
      resources: Object.fromEntries(
        Object.entries({ item: { access: 'write', delete: true }, ticket: { access: 'write' }, vault: { access: 'write' } }).map(
          ([name, resource]) => [name, options.physical ? { ...resource, physical: `public.${name}` } : resource],
        ),
      ),
      auth: {
        store: options.authStore,
        roles: {
          operator: {
            read: ['item', 'ticket'],
            write: ['item'],
            fields: { item: { read: ['id', 'revision', 'name', 'note'], write: ['name'] } },
          },
          editor: {
            read: ['item', 'ticket'],
            write: ['item'],
            fields: { item: { read: ['id', 'revision', 'name', 'note'], write: ['id', 'revision', 'name', 'note'] } },
          },
          auditor: { read: true, write: false, commands: ['rename', 'flag'] },
        },
      },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
      api: {
        version: 1,
        roles: ['operator', 'editor', 'auditor'],
        resources: {
          item: { fields: ['id', 'revision', 'name', 'note'], sorts: ['id'], create: true, update: true, delete: true },
          ticket: { fields: ['id', 'revision', 'name'], sorts: ['id'] },
          vault: { fields: ['id', 'label'], sorts: ['id'] },
        },
        commands: ['rename', 'flag'],
        events: options.events ?? ['ticket.renamed', 'vault.flagged'],
      },
    }),
  );
  writeFileSync(config, JSON.stringify({ connections: [{ id: 'data', name: 'data', url: options.business, writable: true }] }));
  const source = (path: string) => pathToFileURL(join(ROOT, path)).href;
  writeFileSync(
    commands,
    `import { defineCommand, defineCommands } from '${source('packages/mistri/src/server/commands/businessCommands.ts')}';
import { defineEvent, defineEventProjection } from '${source('packages/mistri/src/server/commands/businessEvents.ts')}';
import { shape, int, text } from '${source('packages/mistri/src/server/commands/commandShapes.ts')}';
const renamed = defineEvent('ticket.renamed', shape({ id: int(), name: text() }));
const flagged = defineEvent('vault.flagged', shape({ id: int(), label: text() }));
export default defineCommands({
  rename: defineCommand({ source: 'business', target: 'ticket', 
    input: { name: { label: 'Name', type: 'text' } }, output: shape({ id: int(), name: text() }),
    events: { renamed: defineEventProjection(renamed, output => ({ id: output.id, name: output.name })) },
    async handle({ db, record }, input) {
      await db.ticket.update(record, { name: input.name });
      return { id: Number(record.id), name: input.name };
    } }),
  flag: defineCommand({ source: 'business', target: 'vault', 
    input: {}, output: shape({ id: int(), label: text() }),
    events: { flagged: defineEventProjection(flagged, output => ({ id: output.id, label: output.label })) },
    async handle({ db, record }) {
      await db.vault.update(record, { label: 'flagged' });
      return { id: Number(record.id), label: 'flagged' };
    } }),
});
`,
  );
  return { appDir, config, commands };
}

export const SHOP_TABLES =
  'CREATE TABLE item(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL, note TEXT); ' +
  'CREATE TABLE ticket(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL); ' +
  'CREATE TABLE vault(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, label TEXT NOT NULL); ' +
  "INSERT INTO item(id,name,note) VALUES (1,'One','first'); INSERT INTO ticket(id,name) VALUES (1,'Open'); INSERT INTO vault(id,label) VALUES (1,'Secret')";
