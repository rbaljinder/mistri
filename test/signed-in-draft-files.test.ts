/**
 * Files on a signed-in saved form's draft (forms/draftFiles.ts, savedForms.ts): a step's staged files are taken into
 * rows beneath the draft's root in the step's own transaction; until the draft is submitted those files are readable
 * only through the draft (its owner), by the file route; an expired draft's purge deletes the bucket objects first and
 * the rows after, and leaves the draft whole when the bucket does not answer; and a submitted application's files
 * follow the record's normal scope.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { refuse } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { commandEnvelope } from '../packages/mistri/src/server/testing/appRequests.js';
import { parseTestApp } from './support/commandCatalog.js';
import { S3_CREDENTIAL_VARIABLES } from '../packages/mistri/src/server/files/fileStorage.js';
import { FAKE_S3_CREDENTIALS, startFakeS3, type FakeS3 } from './support/fakeS3.js';

let s3: FakeS3;
before(async () => {
  s3 = await startFakeS3();
  process.env[S3_CREDENTIAL_VARIABLES.accessKeyId] = FAKE_S3_CREDENTIALS.accessKeyId;
  process.env[S3_CREDENTIAL_VARIABLES.secretAccessKey] = FAKE_S3_CREDENTIALS.secretAccessKey;
});
after(async () => {
  delete process.env[S3_CREDENTIAL_VARIABLES.accessKeyId];
  delete process.env[S3_CREDENTIAL_VARIABLES.secretAccessKey];
  await s3.close();
});

const PNG = (fill = 1, size = 32) => {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
};
const docs = field.files('document', { max: 3, accept: 'image/*' });
const reference = (id: string, input: object) => ({ id, version: 1, input });
const nameInput = { full_name: { label: 'Full name', type: 'text', max: 60 } } as const;
const docsInput = { documents: docs } as const;
const submitInput = { consent: { label: 'These details are true', type: 'boolean' } } as const;

const commands = defineCommands({
  startApplication: defineCommand({
    targets: 'none',
    source: 'main',
    target: 'application',
    read: ['application', 'document', 'person'],
    write: ['application', 'document'],
    input: nameInput,
    async handle({ db, draft }, input) {
      if (!draft) return refuse('forbidden');
      if (draft.root) await db.application.update(await db.application.get(draft.root), input);
      else await db.application.insert({ ...input, ...draft.start });
      return {};
    },
  }),
  saveDocuments: defineCommand({
    targets: 'none',
    source: 'main',
    target: 'application',
    read: ['application', 'document', 'person'],
    write: ['application', 'document'],
    input: docsInput,
    async handle({ db, draft }, input) {
      const root = await db.application.get(draft!.root!);
      for (const photo of input.documents) await db.document.insertFile(photo, { application_id: root.id as number });
      return {};
    },
  }),
  submitApplication: defineCommand({
    targets: 'none',
    source: 'main',
    target: 'application',
    read: ['application', 'document', 'person'],
    write: ['application', 'document'],
    input: submitInput,
    async handle({ db, draft }) {
      const root = await db.application.get(draft!.root!);
      await db.application.update(root, { status: 'submitted' });
      return {};
    },
  }),
});
const IDS = ['startApplication', 'saveDocuments', 'submitApplication'];

const config = (bucket: object) => ({
  id: 'apply',
  name: 'Apply',
  auth: { me: { from: 'person', column: 'email' }, roles: { member: { read: true, commands: IDS } } },
  sources: { main: { connection: 'apply-db' } },
  resources: {
    person: {},
    application: { access: 'write' },
    document: {
      access: 'write',
      file: {
        content: 'data',
        name: 'file_name',
        type: 'content_type',
        size: 'byte_size',
        object: 'object_key',
        hash: 'sha256',
        storage: 'bucket',
        bucket,
      },
    },
  },
  views: {
    applications: { kind: 'list', from: 'application' },
    apply: {
      kind: 'form',
      label: 'Apply',
      command: reference('submitApplication', submitInput),
      steps: [
        { id: 'you', label: 'You', command: reference('startApplication', nameInput) },
        { id: 'docs', label: 'Documents', command: reference('saveDocuments', docsInput) },
      ],
      resume: { token: 'resume_token_hash', expires: 'resume_expires_at', progress: 'resume_progress', after: '14 days' },
      draft: { status: 'in_progress' },
      owner: 'person_id',
    },
  },
  home: 'applications',
  nav: ['applications', 'apply'],
});

interface Fixture {
  base: string;
  db: DatabaseSync;
  as: { email: string };
  post(path: string, body: unknown): Promise<{ status: number; body: any }>;
  draft(body: unknown): Promise<{ status: number; body: any }>;
  hold(bytes: Uint8Array, name?: string): Promise<string>;
  step(step: 'you' | 'docs', input: unknown): Promise<{ status: number; body: any }>;
  read(id: number): Promise<number>;
}

async function fixture(run: (f: Fixture) => Promise<void>) {
  s3.objects.clear();
  s3.failing = false;
  s3.refuse = undefined;
  const directory = mkdtempSync(join(tmpdir(), 'mistri-draft-files-'));
  const file = join(directory, 'apply.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE person(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL);
    INSERT INTO person VALUES (1, 'ann@example.test'), (2, 'bob@example.test');
    CREATE TABLE application(id INTEGER PRIMARY KEY, status TEXT NOT NULL, person_id INTEGER NOT NULL REFERENCES person(id),
      full_name TEXT, resume_token_hash TEXT, resume_expires_at TEXT, resume_progress TEXT);
    CREATE TABLE document(id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES application(id), file_name TEXT NOT NULL,
      content_type TEXT, byte_size INTEGER, data BLOB, object_key TEXT, sha256 TEXT);`);
  migrateSqliteCommandJournal(file);
  const registry = new Registry();
  registry.add({ id: 'apply-db', name: 'Apply', url: file, writable: true, source: 'config' });
  const app = parseTestApp(config({ name: s3.bucket, endpoint: s3.endpoint, pathStyle: true, prefix: 'drafts/' }), 'draft files fixture');
  const as = { email: 'ann@example.test' };
  const host: AppHost = {
    app: { app, path: '/private/app.ts', pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: '/private/auth.db',
      close() {},
      handler: async () => {},
      session: async () => ({ id: `account-${as.email}`, who: as.email, role: 'member' }),
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], commands: { appId: 'apply', registry: commands } });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    const base = `http://${bound.host}:${bound.port}`;
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/json', origin: base },
      });
      return { status: response.status, body: (await response.json()) as any };
    };
    let n = 0;
    const f: Fixture = {
      base,
      db,
      as,
      post,
      draft: (body) => post('/api/commands/draft', body),
      hold: async (bytes, name = 'id.png') => {
        const held = await post('/api/commands/files', {
          command: 'saveDocuments',
          field: 'documents',
          file: { name, type: 'image/png', data: Buffer.from(bytes).toString('base64') },
        });
        assert.equal(held.status, 200, JSON.stringify(held.body));
        return held.body.id as string;
      },
      step: (step, input) =>
        post('/api/commands/draft', {
          form: 'apply',
          op: 'step',
          step,
          request: commandEnvelope({
            command: step === 'you' ? 'startApplication' : 'saveDocuments',
            commandVersion: 1,
            key: {},
            expectedVersion: 0,
            input,
            idempotencyKey: `step-${step}-${String(++n).padStart(6, '0')}-key`,
          }),
        }),
      read: async (id) =>
        (
          await fetch(`${base}/api/file?app=apply&table=document&key=${encodeURIComponent(JSON.stringify({ id }))}`, {
            signal: AbortSignal.timeout(10_000),
          })
        ).status,
    };
    await run(f);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const documents = (f: Fixture) => f.db.prepare('SELECT * FROM document ORDER BY id').all() as Array<Record<string, any>>;

test('a file staged on a step is in the draft’s rows after it, and only its owner can read it', async () => {
  await fixture(async (f) => {
    assert.equal((await f.step('you', { full_name: 'Ann Lee' })).status, 200);
    const id = await f.hold(PNG(1), 'passport.png');
    const stepped = await f.step('docs', { documents: [id] });
    assert.equal(stepped.status, 200, JSON.stringify(stepped.body));
    const rows = documents(f);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].file_name, 'passport.png');
    assert.equal(rows[0].application_id, 1);
    assert.equal(s3.objects.size, 1, 'the bytes are in the bucket');
    assert.equal(await f.read(rows[0].id), 200, 'the draft’s owner reads it');
    f.as.email = 'bob@example.test';
    assert.equal(await f.read(rows[0].id), 404, 'another account does not');
    // Another account cannot take the file into a draft of their own either: it is held for Ann.
    assert.equal((await f.step('you', { full_name: 'Bob Roe' })).status, 200);
    assert.equal((await f.step('docs', { documents: [await f.hold(PNG(9), 'bob.png')] })).status, 200);
    assert.equal(documents(f).length, 2);
    f.as.email = 'ann@example.test';
    assert.equal(await f.read(documents(f)[1].id), 404, 'and Ann does not read Bob’s');
  });
});

test('after submit the file follows the record’s normal scope', async () => {
  await fixture(async (f) => {
    await f.step('you', { full_name: 'Ann Lee' });
    await f.step('docs', { documents: [await f.hold(PNG(2))] });
    const review = await f.draft({ form: 'apply', op: 'review' });
    assert.equal(review.status, 200, JSON.stringify(review.body));
    const done = await f.draft({
      form: 'apply',
      op: 'submit',
      version: review.body.version,
      request: commandEnvelope({
        command: 'submitApplication',
        commandVersion: 1,
        key: {},
        expectedVersion: 0,
        input: { consent: true },
        idempotencyKey: 'submit-draft-files-000001',
      }),
    });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const id = documents(f)[0].id;
    assert.equal(await f.read(id), 200);
    f.as.email = 'bob@example.test';
    assert.equal(await f.read(id), 200, 'a member who may read the resource reads a submitted application’s file');
  });
});

const expire = (f: Fixture) => f.db.prepare("UPDATE application SET resume_expires_at = '2020-01-01T00:00:00.000Z'").run();

test('purging an expired draft deletes its bucket objects and its rows', async () => {
  await fixture(async (f) => {
    await f.step('you', { full_name: 'Ann Lee' });
    await f.step('docs', { documents: [await f.hold(PNG(3))] });
    assert.equal(s3.objects.size, 1);
    expire(f);
    // Another person's first step runs the purge for the form.
    f.as.email = 'bob@example.test';
    assert.equal((await f.step('you', { full_name: 'Bob Roe' })).status, 200);
    assert.equal(s3.objects.size, 0, 'the object is gone');
    assert.equal(documents(f).length, 0);
    assert.deepEqual(
      (f.db.prepare('SELECT person_id FROM application').all() as Array<{ person_id: number }>).map((row) => row.person_id),
      [2],
      'only Bob’s new draft is left',
    );
  });
});

test('a bucket that fails leaves the draft whole, and the next pass removes it', async () => {
  await fixture(async (f) => {
    await f.step('you', { full_name: 'Ann Lee' });
    await f.step('docs', { documents: [await f.hold(PNG(4))] });
    expire(f);
    f.as.email = 'bob@example.test';
    s3.failing = true;
    const quiet = console.error;
    console.error = () => {};
    try {
      await f.step('you', { full_name: 'Bob Roe' });
    } finally {
      console.error = quiet;
    }
    s3.failing = false;
    assert.equal(s3.objects.size, 1, 'the object stays');
    assert.equal(documents(f).length, 1, 'and so does the row that names it');
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM application').get() as { n: number }).n, 2);
    // The bucket answers again: the next pass takes the object, then the rows.
    await f.step('you', { full_name: 'Bob Roe' });
    assert.equal(s3.objects.size, 0);
    assert.equal(documents(f).length, 0);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM application').get() as { n: number }).n, 1);
  });
});

test('a submitted application is never purged, whatever its expiry says', async () => {
  await fixture(async (f) => {
    await f.step('you', { full_name: 'Ann Lee' });
    await f.step('docs', { documents: [await f.hold(PNG(5))] });
    f.db.prepare("UPDATE application SET status = 'submitted', resume_expires_at = '2020-01-01T00:00:00.000Z'").run();
    f.as.email = 'bob@example.test';
    await f.step('you', { full_name: 'Bob Roe' });
    assert.equal(s3.objects.size, 1);
    assert.equal(documents(f).length, 1);
  });
});
