/** Shared by the App API writes-and-events tests (app-api-writes-events*.test.ts):
 * the shop App directory, its commands module and its tables. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { ROOT, mcpEnv, startAppMcp } from './appApiCli.js';

/** The shop App: `item` an operator edits (its name only) and an editor
 * edits whole, through the API's generic writes; `ticket`, which both read
 * and only the auditor's `rename` writes; `vault`, which only the auditor
 * reads, flagged by `flag`. The commands emit `ticket.renamed` and
 * `vault.flagged`, both on the feed. */
export function writeShopApp(
  directory: string,
  options: {
    business: string;
    authStore: string;
    events?: readonly string[];
    physical?: boolean;
    narrowed?: boolean;
    /** A `clerk` that creates items and does not write them: append-only (`create` without `write`). */
    appendOnly?: boolean;
    /** Resources that audit their reads (`audit: { reads: true }`). */
    audited?: readonly string[];
  },
) {
  /* `shelf`: the items whose note is "shelf", a narrowed resource the editor writes through the API's generic writes
     (narrowed-writes.test.ts holds the rules; this is their door on the API and App MCP). */
  const shelf = options.narrowed
    ? { shelf: { physical: options.physical ? 'public.item' : 'item', query: 'note = shelf', access: 'write', delete: true } }
    : {};
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
      resources: {
        ...Object.fromEntries(
          Object.entries({ item: { access: 'write', delete: true }, ticket: { access: 'write' }, vault: { access: 'write' } }).map(
            ([name, resource]) => [
              name,
              {
                ...resource,
                ...(options.physical ? { physical: `public.${name}` } : {}),
                ...(options.audited?.includes(name) ? { audit: { reads: true } } : {}),
              },
            ],
          ),
        ),
        ...shelf,
      },
      auth: {
        store: options.authStore,
        roles: {
          operator: {
            read: ['item', 'ticket'],
            write: ['item'],
            fields: { item: { read: ['id', 'revision', 'name', 'note'], write: ['name'] } },
          },
          editor: {
            read: ['item', 'ticket', ...(options.narrowed ? ['shelf'] : [])],
            write: ['item', ...(options.narrowed ? ['shelf'] : [])],
            fields: { item: { read: ['id', 'revision', 'name', 'note'], write: ['id', 'revision', 'name', 'note'] } },
          },
          auditor: { read: true, write: false, commands: ['rename', 'flag'] },
          ...(options.appendOnly ? { clerk: { read: ['ticket'], write: false, create: ['item'] } } : {}),
        },
      },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
      api: {
        version: 1,
        roles: ['operator', 'editor', 'auditor', ...(options.appendOnly ? ['clerk'] : [])],
        resources: {
          item: { fields: ['id', 'revision', 'name', 'note'], sorts: ['id'], create: true, update: true, delete: true },
          ticket: { fields: ['id', 'revision', 'name'], sorts: ['id'] },
          vault: { fields: ['id', 'label'], sorts: ['id'] },
          ...(options.narrowed
            ? { shelf: { fields: ['id', 'revision', 'name', 'note'], sorts: ['id'], create: true, update: true, delete: true } }
            : {}),
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

type Read = (sql: string) => Promise<Record<string, unknown> | undefined>;

/**
 * The shop's narrowed `shelf` (items whose note is "shelf", item 2 the one seeded) written through the App API and
 * App MCP with `token`, an editor's: a create takes the query's value and refuses another, an update may not move
 * its row out and is rolled back when it would, and a row outside the query (item 1) answers as an id nothing holds.
 * App MCP is asked the same: its create tool (a form's command, no record named) takes the query's value and refuses
 * another, and its update and delete stay inside the query.
 */
export async function shelfThroughApi(
  t: TestContext,
  f: { config: string; appDir: string; commands: string },
  base: string,
  token: string,
  read: Read,
) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const said = async (response: Response) => ({ status: response.status, body: (await response.json()) as Record<string, any> });
  const create = (key: string, values: object) =>
    fetch(`${base}/shelf/commands/create-shelf/v1`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': key },
      body: JSON.stringify(values),
    });
  const count = async () => Number((await read('SELECT COUNT(*) AS n FROM item'))!.n);

  // A create takes the query's value: no note given, note = shelf stored.
  const created = await said(await create('shelf-create-000000001', { name: 'Box' }));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = Number(created.body.result.key.id);
  assert.deepEqual({ ...(await read(`SELECT name, note FROM item WHERE id = ${id}`)) }, { name: 'Box', note: 'shelf' });
  /* A value the query contradicts is refused, and nothing is added. The API says a refusal in its fixed vocabulary
     (ineligible_state, not_applied), as it says every refuse(); the sentence is the record routes' and the form's. */
  const before = await count();
  const contradicted = await said(await create('shelf-create-000000002', { name: 'Bag', note: 'attic' }));
  assert.deepEqual([contradicted.status, contradicted.body.code, contradicted.body.outcome], [409, 'ineligible_state', 'not_applied']);
  assert.equal(await count(), before);

  const prepare = async (key: string | number, command: string) =>
    fetch(`${base}/shelf/${key}/commands/${command}/v1/prepare`, { headers: { authorization: headers.authorization } });
  const run = (key: string | number, command: string, version: string, attempt: string, values: object) =>
    fetch(`${base}/shelf/${key}/commands/${command}/v1`, {
      method: 'POST',
      headers: { ...headers, 'if-match': version, 'idempotency-key': attempt },
      body: JSON.stringify(values),
    });
  // An update that would move the row out of the query is refused, and the row is as it was.
  const etag = (await prepare(2, 'update-shelf')).headers.get('etag')!;
  assert.ok(etag);
  const moved = await said(await run(2, 'update-shelf', etag, 'shelf-update-000000001', { note: 'attic' }));
  assert.deepEqual([moved.status, moved.body.code, moved.body.outcome], [409, 'ineligible_state', 'not_applied']);
  assert.deepEqual({ ...(await read('SELECT name, note FROM item WHERE id = 2')) }, { name: 'Crate', note: 'shelf' });
  // Inside, it is made.
  const renamed = await run(2, 'update-shelf', etag, 'shelf-update-000000002', { name: 'Big crate' });
  assert.equal(renamed.status, 200, await renamed.clone().text());
  // A row outside the query, prepared, updated or deleted, answers as an id nothing holds.
  for (const command of ['update-shelf', 'delete-shelf']) {
    const outside = await prepare(1, command),
      nothing = await prepare(999, command);
    assert.equal(outside.status, nothing.status, `${command}: ${await outside.clone().text()} / ${await nothing.clone().text()}`);
    assert.deepEqual(await outside.json(), await nothing.json());
    const ran = [
      await said(await run(1, command, '"0"', `shelf-${command}-outside1`, command === 'update-shelf' ? { name: 'Taken' } : {})),
      await said(await run(999, command, '"0"', `shelf-${command}-nothing1`, command === 'update-shelf' ? { name: 'Taken' } : {})),
    ];
    assert.equal(ran[0].status, ran[1].status, JSON.stringify(ran));
    assert.ok(ran[0].status >= 400, JSON.stringify(ran));
  }
  assert.deepEqual({ ...(await read('SELECT name, note FROM item WHERE id = 1')) }, { name: 'One', note: 'first' });

  // App MCP: the same update and delete, as tools.
  const mcp = startAppMcp(
    t,
    ['--app-mcp', '--api-integers', 'decimal-string', '--config', f.config, '--app', f.appDir, '--commands', f.commands],
    mcpEnv(token),
  );
  const tools = (await mcp.request('tools/list')).result.tools as { name: string }[];
  const tool = (prefix: string) => {
    const found = tools.find((each) => each.name.startsWith(prefix));
    assert.ok(found, `${prefix}: ${tools.map((each) => each.name).join(', ')}`);
    return found.name;
  };
  const call = async (name: string, args: object) => {
    const reply = (await mcp.request('tools/call', { name, arguments: args })).result as { isError: boolean; content: { text: string }[] };
    return { isError: reply.isError, text: reply.content.map((part) => part.text).join('\n') };
  };
  // A create names no record, so its tool takes the idempotency key and the input alone; the query still holds it.
  const counted = await count();
  const made = await call(tool('run_create-shelf'), { idempotencyKey: 'mcp-shelf-create-0001', input: { name: 'Tin' } });
  assert.equal(made.isError, false, made.text);
  assert.deepEqual({ ...(await read(`SELECT note FROM item WHERE name = 'Tin'`)) }, { note: 'shelf' });
  const strayed = await call(tool('run_create-shelf'), { idempotencyKey: 'mcp-shelf-create-0002', input: { name: 'Jar', note: 'attic' } });
  assert.equal(strayed.isError, true, strayed.text);
  assert.match(strayed.text, /ineligible_state/);
  assert.equal(await count(), counted + 1);
  const version = async (key: string) => {
    const prepared = await call(tool('prepare_update-shelf'), { key: { id: key } });
    assert.equal(prepared.isError, false, prepared.text);
    return Number(JSON.parse(prepared.text).version ?? JSON.parse(prepared.text).revision);
  };
  const out = await call(tool('run_update-shelf'), {
    key: { id: '2' },
    version: await version('2'),
    idempotencyKey: 'mcp-shelf-update-0001',
    input: { note: 'attic' },
  });
  assert.equal(out.isError, true, out.text);
  assert.match(out.text, /ineligible_state/);
  assert.deepEqual({ ...(await read('SELECT name, note FROM item WHERE id = 2')) }, { name: 'Big crate', note: 'shelf' });
  for (const [command, input] of [
    ['update-shelf', { name: 'Taken' }],
    ['delete-shelf', {}],
  ] as const) {
    const answers = [];
    for (const key of ['1', '999'])
      answers.push(
        await call(tool(`run_${command}`), { key: { id: key }, version: 0, idempotencyKey: `mcp-${command}-${key}-0001`, input }),
      );
    assert.deepEqual(
      answers.map((answer) => answer.isError),
      [true, true],
      JSON.stringify(answers),
    );
    const code = (text: string) => JSON.parse(text)?.error?.code ?? JSON.parse(text)?.code;
    assert.equal(code(answers[0].text), code(answers[1].text), JSON.stringify(answers));
  }
  assert.deepEqual({ ...(await read('SELECT name, note FROM item WHERE id = 1')) }, { name: 'One', note: 'first' });
  mcp.end();
}
