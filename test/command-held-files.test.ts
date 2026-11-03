/**
 * Files a form holds for its command (server/commands/stagedFiles.ts, adapters/commands/commandStaging.ts): held
 * under the grant that runs the command, for the person who sent them, by an id only they were told; taken in the
 * command's own transaction, so a refusal holds them again and a commit uses them up; and, on a public form, within
 * the visitor's share and the form's, never read back out.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import {
  COMMAND_STAGED_TABLE,
  StagedFilesFull,
  stageSqliteFile,
  type StagedNamespace,
} from '../packages/mistri/src/adapters/commands/commandStaging.js';
import { pruneAll, prunes, sqlitePruneDb } from '../packages/mistri/src/adapters/retention/pruner.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { executeBusinessCommand, refuse } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands, type CommandFile } from '../packages/mistri/src/server/commands/businessCommands.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { publicPrincipal } from '../packages/mistri/src/server/commands/formHttp.js';
import {
  newVisitorToken,
  PUBLIC_STAGED_MOST,
  stageCommandFile,
  StageRefusal,
  stagedIdHash,
} from '../packages/mistri/src/server/commands/stagedFiles.js';
import { STAGED_FILE_ID } from '../packages/mistri/src/shared/command.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseTestApp } from './support/commandCatalog.js';

const APP = 'repairs';
const CONNECTION = 'held-files-db';
const PNG = (fill = 1, size = 32) => {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
};
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const agent = (id = 'account-ana') => ({ id, appId: APP, roles: ['tech'] });

const photos = field.files('repair_photo', { max: 3, accept: 'image/*' });
const reportInput = { title: field.text(), photos };
let behavior: 'store' | 'store-then-refuse' | 'ignore' = 'store';
let handed: unknown;

const commands = defineCommands({
  fileReport: defineCommand({
    source: 'main',
    target: 'repair',
    targets: 'none',
    write: ['repair', 'repair_photo'],
    input: reportInput,
    async handle({ db }, input) {
      handed = input.photos;
      const repair = await db.repair.insert({ title: input.title });
      if (behavior !== 'ignore')
        for (const photo of input.photos) await db.repair_photo.insertFile(photo, { repair_id: repair.id as number });
      if (behavior === 'store-then-refuse') refuse('ineligible_state');
    },
  }),
  signOff: defineCommand({
    source: 'main',
    target: 'repair',
    targets: 'none',
    write: ['repair', 'repair_photo'],
    input: { title: field.text(), signature: field.signature('repair_photo') },
    async handle({ db }, input) {
      handed = input.signature;
      const repair = await db.repair.insert({ title: input.title });
      await db.repair_photo.insertFile(input.signature as CommandFile, { repair_id: repair.id as number });
    },
  }),
  report: defineCommand({
    source: 'main',
    target: 'repair',
    targets: 'none',
    write: ['repair', 'repair_photo'],
    public: true,
    input: reportInput,
    async handle({ db }, input) {
      const repair = await db.repair.insert({ title: input.title });
      for (const photo of input.photos) await db.repair_photo.insertFile(photo, { repair_id: repair.id as number });
    },
  }),
});

let directory: string;
let db: DatabaseSync;
let registry: Registry;
let binding: ReturnType<typeof bindBusinessCommands>;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'mistri-held-files-'));
  const file = join(directory, 'repairs.db');
  db = new DatabaseSync(file);
  db.exec(`CREATE TABLE repair (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE repair_photo (id INTEGER PRIMARY KEY, repair_id INTEGER NOT NULL REFERENCES repair(id), file_name TEXT NOT NULL,
      content_type TEXT, byte_size INTEGER, data BLOB);`);
  migrateSqliteCommandJournal(file);
  clearJournal(CONNECTION);
  registry = new Registry();
  registry.add({ id: CONNECTION, name: 'Repairs', url: file, writable: true, source: 'config' });
  const app = parseTestApp(
    {
      id: APP,
      name: 'Repairs',
      sources: { main: { connection: CONNECTION, default: true } },
      resources: {
        repair: { access: 'write' },
        repair_photo: {
          access: 'write',
          file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size', maxBytes: 4096 },
        },
      },
      auth: { roles: { tech: { read: true, commands: ['fileReport', 'signOff'] } } },
      views: {
        repairs: { kind: 'list', from: 'repair' },
        report: {
          kind: 'form',
          label: 'Report a repair',
          public: true,
          submitLabel: 'Send',
          done: { title: 'Thanks' },
          command: { id: 'report', version: 1, input: reportInput },
        },
      },
      home: 'repairs',
    },
    'held files fixture',
  );
  const resources = await loadAppRuntimeResources(registry, app, CONNECTION);
  binding = bindBusinessCommands({ app, registry: commands, resources, writableConnection: () => true });
});

after(async () => {
  db.close();
  await registry.closeAll();
  clearJournal();
  rmSync(directory, { recursive: true, force: true });
});

let request = 0;
const run = (command: string, input: object, actor: object = agent(), options: object = {}) =>
  executeBusinessCommand(
    binding,
    actor as never,
    { command, commandVersion: 1, key: {}, expectedVersion: 0, idempotencyKey: `held-files-${String(++request).padStart(6, '0')}`, input },
    { door: 'api', ...options },
  );
const hold = (
  bytes: Uint8Array,
  options: { actor?: object; command?: string; field?: string; name?: string; type?: string; visitor?: string; now?: () => Date } = {},
) =>
  stageCommandFile(
    binding,
    (options.actor ?? agent()) as never,
    {
      command: options.command ?? 'fileReport',
      field: options.field ?? 'photos',
      file: { name: options.name ?? 'leak.png', type: options.type ?? 'image/png', data: base64(bytes) },
    },
    { ...(options.visitor ? { visitor: options.visitor } : {}), ...(options.now ? { now: options.now } : {}) },
  );
const count = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
const heldCount = () => count(`SELECT count(*) AS n FROM "${COMMAND_STAGED_TABLE}"`);
const rows = (table: string) => count(`SELECT count(*) AS n FROM ${table}`);
const refusedAt = (code: string, field?: string) => (error: unknown) =>
  (error as { code?: string }).code === code && (field === undefined || (error as { field?: string }).field === field);
const status = (code: number) => (error: unknown) => error instanceof StageRefusal && error.status === code;

describe('a signed-in form', () => {
  test('holds each file under an unguessable id, and the command lands them as rows in its own transaction', async () => {
    behavior = 'store';
    const first = await hold(PNG(1), { name: 'front.png' });
    const second = await hold(PNG(2), { name: 'back.jpg', type: 'image/jpeg' });
    assert.match(first.id, STAGED_FILE_ID);
    assert.notEqual(first.id, second.id);
    // The type is read from the bytes, not the name or the claim.
    assert.deepEqual({ ...second, id: undefined }, { id: undefined, name: 'back.jpg', type: 'image/png', size: 32 });
    // Only the id's hash is kept: nothing in the store is the id a request would send.
    const kept = db.prepare(`SELECT id_hash FROM "${COMMAND_STAGED_TABLE}"`).all() as Array<{ id_hash: string }>;
    assert.deepEqual(kept.map((row) => row.id_hash).sort(), [stagedIdHash(first.id), stagedIdHash(second.id)].sort());
    const before = rows('repair_photo');
    await run('fileReport', { title: 'Leaking tap', photos: [first.id, second.id] });
    assert.equal(rows('repair_photo'), before + 2);
    assert.deepEqual(
      db
        .prepare('SELECT file_name, content_type, byte_size FROM repair_photo ORDER BY id DESC LIMIT 2')
        .all()
        .map((row) => ({ ...row })),
      [
        { file_name: 'back.jpg', content_type: 'image/png', byte_size: 32 },
        { file_name: 'front.png', content_type: 'image/png', byte_size: 32 },
      ],
    );
    assert.equal(heldCount(), 0);
  });

  test("one person cannot commit another person's held file", async () => {
    behavior = 'store';
    const held = await hold(PNG(3), { actor: agent('account-ana') });
    await assert.rejects(
      run('fileReport', { title: 'Not mine', photos: [held.id] }, agent('account-ben')),
      refusedAt('invalid_input', 'photos'),
    );
    assert.equal(heldCount(), 1, 'the refusal takes nothing');
    await run('fileReport', { title: 'Mine', photos: [held.id] }, agent('account-ana'));
    assert.equal(heldCount(), 0);
  });

  test('an id is used once: a replay in a new request, a made-up id, or another field’s id is refused', async () => {
    behavior = 'store';
    const held = await hold(PNG(4));
    await run('fileReport', { title: 'Once', photos: [held.id] });
    await assert.rejects(run('fileReport', { title: 'Twice', photos: [held.id] }), refusedAt('invalid_input', 'photos'));
    const guessed = Buffer.alloc(32, 7).toString('base64url');
    await assert.rejects(run('fileReport', { title: 'Guessed', photos: [guessed] }), refusedAt('invalid_input', 'photos'));
    const signature = await hold(PNG(5), { command: 'signOff', field: 'signature' });
    await assert.rejects(run('fileReport', { title: 'Wrong field', photos: [signature.id] }), refusedAt('invalid_input', 'photos'));
    await assert.rejects(run('fileReport', { title: 'Not an id', photos: ['../../etc/passwd'] }), refusedAt('invalid_input', 'photos'));
    // Still held for the field it was sent for.
    await run('signOff', { title: 'Signed', signature: signature.id });
    assert.equal(heldCount(), 0);
  });

  test('a refused command leaves no rows, and its files stay held for the next try', async () => {
    const held = await hold(PNG(6));
    const [repairs, photosBefore] = [rows('repair'), rows('repair_photo')];
    behavior = 'store-then-refuse';
    await assert.rejects(run('fileReport', { title: 'Refused', photos: [held.id] }), refusedAt('ineligible_state'));
    assert.deepEqual([rows('repair'), rows('repair_photo'), heldCount()], [repairs, photosBefore, 1]);
    // A handler that is handed a file and stores nowhere is refused too: the file would be used up and kept nowhere.
    behavior = 'ignore';
    await assert.rejects(run('fileReport', { title: 'Dropped', photos: [held.id] }), refusedAt('invalid_result'));
    assert.deepEqual([rows('repair'), rows('repair_photo'), heldCount()], [repairs, photosBefore, 1]);
    behavior = 'store';
    await run('fileReport', { title: 'Taken', photos: [held.id] });
    assert.deepEqual([rows('repair_photo'), heldCount()], [photosBefore + 1, 0]);
  });

  test("holds only what the field takes, within the resource's cap", async () => {
    await assert.rejects(hold(new TextEncoder().encode('just words'), { name: 'notes.txt', type: 'text/plain' }), status(415));
    // A claimed picture whose bytes are not one is not a picture.
    await assert.rejects(hold(new TextEncoder().encode('<svg onload=alert(1)>'), { name: 'x.svg', type: 'image/svg+xml' }), status(415));
    await assert.rejects(hold(PNG(1, 5000)), status(413));
    await assert.rejects(hold(PNG(), { field: 'title' }), status(404));
    await assert.rejects(hold(PNG(), { command: 'report' }), status(403));
    await assert.rejects(hold(PNG(), { actor: { id: 'account-zed', appId: APP, roles: [] } }), status(403));
    assert.equal(heldCount(), 0);
  });

  test('a signature is one PNG, handed to the handler as one file', async () => {
    await assert.rejects(
      hold(new TextEncoder().encode('GIF89a....'), { command: 'signOff', field: 'signature', type: 'image/gif' }),
      status(415),
    );
    const held = await hold(PNG(9), { command: 'signOff', field: 'signature', name: 'signature.png' });
    await run('signOff', { title: 'Signed off', signature: held.id });
    assert.deepEqual(
      { ...(handed as CommandFile), data: undefined },
      { name: 'signature.png', type: 'image/png', size: 32, data: undefined },
    );
  });

  test('a file past its day is not taken, and the retention job deletes it', async () => {
    const day = 24 * 60 * 60 * 1000;
    const held = await hold(PNG(10), { now: () => new Date(Date.now() - day - 1000) });
    await assert.rejects(run('fileReport', { title: 'Late', photos: [held.id] }), refusedAt('invalid_input', 'photos'));
    assert.equal(heldCount(), 1);
    const deleted = await pruneAll(
      sqlitePruneDb(db),
      prunes().filter((rule) => rule.id === 'staged-files'),
      { history: null, commands: null, attempts: null },
    );
    assert.deepEqual(deleted, [{ id: 'staged-files', deleted: 1 }]);
    assert.equal(heldCount(), 0);
    // Where no retention job runs (an App that keeps everything forever), each new file clears lapsed ones, anyone's.
    await hold(PNG(12), { now: () => new Date(Date.now() - day - 1000) });
    await hold(PNG(13), { actor: publicPrincipal(APP, 'report'), command: 'report', visitor: newVisitorToken() });
    assert.equal(heldCount(), 1);
    db.exec(`DELETE FROM "${COMMAND_STAGED_TABLE}"`);
  });
});

describe('a public form', () => {
  const visitor = () => publicPrincipal(APP, 'report');
  const send = (input: object, token?: string) => run('report', input, visitor(), token ? { visitor: token } : {});

  test("holds a visitor's files by their own cookie, and no other visitor can submit them", async () => {
    const mine = newVisitorToken();
    const theirs = newVisitorToken();
    await assert.rejects(hold(PNG(), { actor: visitor(), command: 'report' }), status(403), 'no cookie, no file');
    const held = await hold(PNG(11), { actor: visitor(), command: 'report', visitor: mine });
    await assert.rejects(send({ title: 'Theirs', photos: [held.id] }, theirs), refusedAt('invalid_input', 'photos'));
    await assert.rejects(send({ title: 'Nobody', photos: [held.id] }), refusedAt('invalid_input', 'photos'));
    // A signed-in person cannot take a visitor's file either, nor a visitor a signed-in person's.
    await assert.rejects(run('fileReport', { title: 'Staff', photos: [held.id] }), refusedAt('invalid_input', 'photos'));
    await send({ title: 'Mine', photos: [held.id] }, mine);
    assert.equal(heldCount(), 0);
  });

  test('is no place to keep things: a visitor holds a few files at once, the form a share of every visitor’s, none read back', async () => {
    const token = newVisitorToken();
    const held = [];
    for (let at = 0; at < PUBLIC_STAGED_MOST.files; at++)
      held.push(await hold(PNG(at), { actor: visitor(), command: 'report', visitor: token }));
    await assert.rejects(hold(PNG(99), { actor: visitor(), command: 'report', visitor: token }), status(429));
    // The answer is the id, name, type and size: never the bytes; and no route reads a held file.
    assert.deepEqual(Object.keys(held[0]!).sort(), ['id', 'name', 'size', 'type']);
    // Every visitor together: the store refuses a file past the form's share, whoever sends it.
    const namespace = (db.prepare(`SELECT store_id, source_id, realm, tenant_id FROM "${COMMAND_STAGED_TABLE}" LIMIT 1`).get() ??
      {}) as Record<string, string>;
    const ns = [namespace.store_id, namespace.source_id, namespace.realm, namespace.tenant_id] as unknown as StagedNamespace;
    const now = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
      assert.throws(
        () =>
          stageSqliteFile(
            db,
            APP,
            ns,
            {
              idHash: stagedIdHash(newVisitorToken()),
              owner: `visitor:${stagedIdHash(newVisitorToken())}`,
              command: 'report',
              field: 'photos',
              name: 'one-more.png',
              type: 'image/png',
              size: 32,
              data: PNG(),
              expiresAt: now + 1000,
            },
            { files: 10, bytes: 1024, shared: { prefix: 'visitor:', bytes: 32 * PUBLIC_STAGED_MOST.files } },
            now,
          ),
        (error) => error instanceof StagedFilesFull && error.shared,
      );
    } finally {
      db.exec('ROLLBACK');
    }
    await send({ title: 'Full', photos: held.slice(0, 3).map((each) => each.id) }, token);
    db.exec(`DELETE FROM "${COMMAND_STAGED_TABLE}"`);
  });
});

test('field.files and field.signature are declared on the input itself, of a file resource the command writes', async () => {
  const { parseCommandInput } = await import('../packages/mistri/src/shared/commandInputParse.js');
  assert.deepEqual(parseCommandInput({ photos }, 'x')[0], {
    name: 'photos',
    label: 'Photos',
    required: true,
    type: 'files',
    from: 'repair_photo',
    max: 3,
    accept: ['image/*'],
  });
  assert.throws(() => parseCommandInput({ g: field.group({ photos }) }, 'x'), /not one inside a group/);
  assert.throws(() => parseCommandInput({ p: { ...photos, accept: 'images' } }, 'x'), /accept is a media type/);
  assert.throws(() => parseCommandInput({ p: { ...photos, max: 21 } }, 'x'), /from 1 to 20/);
  assert.throws(() => parseCommandInput({ p: { ...photos, default: 'x' } }, 'x'), /take no default/);
  assert.throws(
    () =>
      defineCommand({
        source: 'main',
        target: 'repair',
        targets: 'none',
        write: ['repair'],
        input: { photos },
        async handle() {},
      }),
    /takes files of "repair_photo"; declare it among the command's write/,
  );
});
