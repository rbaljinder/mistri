/**
 * A public command as an App API verb (api/apiPublicLane.ts): a token that
 * names a public form's command calls it as that form's door would — the
 * door's grants, no role — under its own id, `token:<id>`. So a token gains it
 * only by naming it, its role widens nothing, its receipts and kept attempts
 * are its own, a replay answers without the link, and the documents list the
 * verb only to a token that names it. SQLite here; the same on PostgreSQL, in
 * databases of its own, under TABLEWALK_TEST_PG.
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { COMMAND_JOURNAL_TABLES } from '../packages/mistri/src/adapters/commands/commandJournalSchema.js';
import { defineCommand, defineCommands, type BusinessCommandActor } from '../packages/mistri/src/server/commands/businessCommands.js';
import { shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { refuse, type RefusalKeepDb } from '../packages/mistri/src/server/commands/commandErrors.js';
import { configureFormKey } from '../packages/mistri/src/server/forms/formKey.js';
import { configureLinkBase } from '../packages/mistri/src/server/links/linkToken.js';
import { resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import { apiOwnerFixture, bodyOf, commandOwner, type Engine, type Said } from './support/apiOwnerFixture.js';
import { pgClient } from './support/tenantDialects.js';
import { postgresRuntimeSql } from './support/runtimeSql.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;

const sql = (engine: Engine) => {
  const id = engine === 'sqlite' ? 'INTEGER PRIMARY KEY' : 'SERIAL PRIMARY KEY';
  return `CREATE TABLE inquiry(id ${id}, note TEXT NOT NULL, actor TEXT NOT NULL);
     CREATE TABLE attempt(id ${id}, actor TEXT NOT NULL, code TEXT NOT NULL);`;
};

const ASK = { id: 'ask', version: 1, input: { note: { type: 'text', max: 80 } } };

const desk = (store: string) => ({
  id: 'desk',
  name: 'Desk',
  sources: { main: { connection: 'main', default: true } },
  resources: { inquiry: { access: 'write', links: { status: { show: ['note'] } } }, attempt: { access: 'write' } },
  views: {
    inquiries: { kind: 'list', from: 'inquiry' },
    ask: { kind: 'form', label: 'Ask', public: true, done: { title: 'Thanks' }, command: ASK },
  },
  home: 'inquiries',
  nav: ['inquiries'],
  auth: { store, roles: { operator: { read: true } } },
  api: { version: 1, roles: ['operator'], resources: { inquiry: { fields: ['id', 'note'] } }, commands: [ASK] },
});

async function deskFixture(t: TestContext, engine: Engine) {
  const seen: BusinessCommandActor[] = [];
  const commands = defineCommands({
    ask: defineCommand({
      targets: 'none',
      source: 'main',
      target: 'inquiry',
      read: ['inquiry'],
      write: ['inquiry', 'attempt'],
      refused: { writes: ['attempt'] },
      public: true,
      input: ASK.input as never,
      output: shape({ reference: text(), link: text() }),
      async handle({ tx, link, actor }, input) {
        seen.push(actor);
        const { note } = input as { note: string };
        // The App keys its wrong tries on who called plus what they said; the platform keeps no attempts of its own.
        if (note.startsWith('wrong'))
          refuse('That code is not right.', {
            keep: async (kept: RefusalKeepDb) => {
              await kept.attempt.insert({ actor: actor.id, code: note });
            },
          });
        const made = await tx.insert({ table: 'inquiry', values: { note, actor: actor.id } });
        return { reference: `Q-${made.key.id}`, link: (await link('status')) as unknown as string };
      },
    }),
  });
  const f = await apiOwnerFixture(t, {
    engine,
    app: desk,
    connections: { main: { sql: sql(engine), writable: true, journal: true } },
    commands,
    accounts: { ops: 'operator' },
  });
  const disposers = [configureFormKey('desk', { MISTRI_FORM_KEY: 'k'.repeat(40) }), configureLinkBase('desk', 'https://desk.example.test')];
  resetPublicFormLimits();
  t.after(() => {
    for (const dispose of disposers) dispose();
    resetPublicFormLimits();
  });
  return { f, seen };
}

/** One statement on a test's own business database, outside the API. */
async function rows(engine: Engine, url: string, query: string): Promise<Record<string, unknown>[]> {
  if (engine === 'sqlite') {
    const db = new DatabaseSync(url);
    try {
      return db
        .prepare(query)
        .all()
        .map((row) => ({ ...row }));
    } finally {
      db.close();
    }
  }
  const client = await pgClient(url);
  try {
    return (await client.query(postgresRuntimeSql(query))).rows as Record<string, unknown>[];
  } finally {
    await client.end();
  }
}

const json = (said: Said) => JSON.parse(bodyOf(said));
const status = (said: Said) => ('refused' in said ? said.refused : said.status);
const ask = (note: string, idempotencyKey: string) => ({
  command: 'ask',
  commandVersion: 1,
  key: {},
  expectedVersion: 0,
  input: { note },
  idempotencyKey,
});

async function servesThePublicVerb(t: TestContext, engine: Engine) {
  const { f, seen } = await deskFixture(t, engine);
  const owner = await commandOwner(f, engine, 'number');
  const plain = await f.issue('ops', ['operator']);
  const first = await f.issue('ops', ['operator'], ['command:ask']);
  const second = await f.issue('ops', ['operator'], ['command:ask']);

  // A token gains the verb only by naming it: every role-eligible operation is not a public one.
  assert.equal(status(await owner.execute(plain, ask('hello', 'public-verb-0001'))), 403);
  assert.equal(seen.length, 0);

  // The verb runs as the door's principal under the token's id: the operator role widens nothing.
  const said = await owner.execute(first, ask('hello', 'public-verb-0002'));
  assert.equal(status(said), 200, bodyOf(said));
  const answer = json(said);
  assert.equal(answer.result.reference, 'Q-1');
  assert.match(answer.result.link, /^https:\/\/desk\.example\.test\//);
  assert.equal(seen.length, 1);
  const caller = seen[0];
  assert.match(caller.id, /^token:[0-9a-f-]{36}$/);
  assert.deepEqual([...caller.roles], []);
  assert.equal(caller.kind, 'public');
  assert.equal((caller as { form?: string }).form, 'ask');

  // A replay with the same key and token answers the receipt without the link.
  const replay = json(await owner.execute(first, ask('hello', 'public-verb-0002')));
  assert.equal(replay.receipt.replayed, true);
  assert.equal(replay.receipt.id, answer.receipt.id);
  assert.equal(replay.result.reference, 'Q-1');
  assert.equal(Object.hasOwn(replay.result, 'link'), false);
  assert.equal(seen.length, 1);

  // Another token with the same key is another caller: its own receipt, its own row.
  const other = json(await owner.execute(second, ask('hello', 'public-verb-0002')));
  assert.notEqual(other.receipt.id, answer.receipt.id);
  assert.equal(other.receipt.replayed, false);
  assert.match(other.result.link, /^https:\/\/desk\.example\.test\//);
  const callers = [caller.id, seen[1].id];
  assert.notEqual(callers[0], callers[1]);
  assert.deepEqual(
    (await rows(engine, f.urls.main, 'SELECT note, actor FROM inquiry ORDER BY id')).map((row) => ({ ...row })),
    callers.map((actor) => ({ note: 'hello', actor })),
  );
  const receipts = await rows(engine, f.urls.main, `SELECT actor_id FROM "${COMMAND_JOURNAL_TABLES.receipt}" ORDER BY actor_id`);
  assert.deepEqual(
    receipts.map((row) => row.actor_id),
    [...callers].sort(),
  );

  // What a refusal keeps is keyed by the token: each one's wrong tries count apart.
  for (const [token, n] of [
    [first, 1],
    [first, 2],
    [second, 3],
  ] as const) {
    assert.notEqual(status(await owner.execute(token, ask('wrong-1234', `public-verb-wrong-${n}`))), 200);
  }
  const tries = await rows(engine, f.urls.main, "SELECT actor, count(*) AS n FROM attempt WHERE code = 'wrong-1234' GROUP BY actor");
  assert.deepEqual(Object.fromEntries(tries.map((row) => [row.actor, Number(row.n)])), { [callers[0]]: 2, [callers[1]]: 1 });

  // The documents list the verb only to a token that names it, marked as the door's.
  const spec = JSON.stringify(json(await owner.spec(first)));
  assert.match(spec, /"\/inquiry\/commands\/ask\/v1"/);
  assert.match(spec, /"x-mistri-door":"public"/);
  assert.doesNotMatch(spec, /eligible-roles/);
  assert.doesNotMatch(JSON.stringify(json(await owner.spec(plain))), /commands\/ask|x-mistri-door/);
  const named = (token: string) => owner.tools(token).then((said) => (json(said).tools as { name: string }[]).map((tool) => tool.name));
  assert.ok((await named(first)).some((name) => /ask/.test(name)));
  assert.ok(!(await named(plain)).some((name) => /ask/.test(name)));
}

async function spendsTheDoorsBudget(t: TestContext, engine: Engine) {
  const { f } = await deskFixture(t, engine);
  const owner = await commandOwner(f, engine, 'number');
  const token = await f.issue('ops', ['operator'], ['command:ask']);
  let limited: Said | undefined;
  for (let n = 0; n < 200 && !limited; n++) {
    const said = await owner.execute(token, ask(`note ${n}`, `public-verb-budget-${String(n).padStart(4, '0')}`));
    if (status(said) === 429) limited = said;
    else assert.equal(status(said), 200, bodyOf(said));
  }
  assert.ok(limited, 'the door budget never ran out');
  assert.match(String((limited as { headers?: Record<string, string> }).headers?.['retry-after']), /^\d+$/);
}

test('a public verb runs as its door, under the token that names it', (t) => servesThePublicVerb(t, 'sqlite'));
test('a public verb runs as its door on PostgreSQL', { skip: liveSkip('postgres', LIVE) }, (t) => servesThePublicVerb(t, 'postgres'));
test('a public verb spends the door submit budget, keyed by its token', (t) => spendsTheDoorsBudget(t, 'sqlite'));
