/**
 * Triggers an App names, under a row policy, on PostgreSQL (docs/trigger-effects.md):
 * the keyed effects proven before the write under the transaction's own row
 * locks, the function's version read again before COMMIT, and the adversarial
 * tests the note lists that need a second connection. SQLite's are in
 * trigger-effects.test.ts.
 *
 * Live and opt-in: `TABLEWALK_TEST_PG` names a disposable database this file
 * may reset (it drops and recreates its own `te_` tables in `public` and the
 * schema `te_evil`); without it every case skips.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Refusal } from '../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import type { TriggerAcceptance, TriggerChange } from '../packages/engine/src/adapters/scoped/triggerProof.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { refusalCause } from '../packages/engine/src/shared/refusal.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;

interface Control extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
async function client(): Promise<Control> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as { default?: { Client: new (c: unknown) => Control }; Client?: new (c: unknown) => Control };
  const Client = (pg.Client ?? pg.default?.Client)!;
  const created = new Client({ connectionString: LIVE, statement_timeout: 10_000 });
  await created.connect();
  return created;
}

const RESET = [
  'DROP TABLE IF EXISTS public.te_history, public.te_entry, public.te_account, public.te_customer CASCADE',
  'DROP SCHEMA IF EXISTS te_evil CASCADE',
  'DROP FUNCTION IF EXISTS public.te_post(), public.te_audit(), public.te_move(), public.te_check(), public.te_unqualified(), public.te_peek(integer)',
];
const SETUP = [
  'CREATE TABLE public.te_customer (id integer PRIMARY KEY, owner text NOT NULL)',
  `CREATE TABLE public.te_account (id integer PRIMARY KEY, customer_id integer NOT NULL REFERENCES public.te_customer (id),
     status text NOT NULL DEFAULT 'open', posted_minor integer NOT NULL DEFAULT 0)`,
  'CREATE TABLE public.te_entry (id integer PRIMARY KEY, account_id integer NOT NULL REFERENCES public.te_account (id), amount integer NOT NULL)',
  `CREATE TABLE public.te_history (id bigserial PRIMARY KEY, entry_id integer NOT NULL,
     account_id integer NOT NULL REFERENCES public.te_account (id), what text NOT NULL)`,
  `INSERT INTO public.te_customer VALUES (1, 'ada'), (2, 'ben')`,
  `INSERT INTO public.te_account VALUES (1, 1, 'open', 500), (2, 2, 'closed', 900), (3, 2, 'open', 100)`,
  'INSERT INTO public.te_entry VALUES (10, 2, 50)',
  `CREATE FUNCTION public.te_post() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       UPDATE public.te_account SET posted_minor = posted_minor + NEW.amount WHERE id = NEW.account_id;
       RETURN NULL;
     END $$`,
  `CREATE FUNCTION public.te_audit() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       INSERT INTO public.te_history (entry_id, account_id, what) VALUES (NEW.id, NEW.account_id, 'posted');
       RETURN NULL;
     END $$`,
  `CREATE FUNCTION public.te_move() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       UPDATE public.te_account SET posted_minor = posted_minor - OLD.amount WHERE id = OLD.account_id;
       UPDATE public.te_account SET posted_minor = posted_minor + NEW.amount WHERE id = NEW.account_id;
       RETURN NULL;
     END $$`,
  `CREATE FUNCTION public.te_check() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF (SELECT status FROM public.te_account WHERE id = NEW.account_id) = 'closed' THEN
         RAISE EXCEPTION 'closed account';
       END IF;
       RETURN NEW;
     END $$`,
];
const POST = 'CREATE TRIGGER post_balance AFTER INSERT ON public.te_entry FOR EACH ROW EXECUTE FUNCTION public.te_post()';
const AUDIT = 'CREATE TRIGGER entry_audit AFTER INSERT ON public.te_entry FOR EACH ROW EXECUTE FUNCTION public.te_audit()';
const MOVE = 'CREATE TRIGGER move_entry AFTER UPDATE OF account_id ON public.te_entry FOR EACH ROW EXECUTE FUNCTION public.te_move()';
const CHECK = 'CREATE TRIGGER check_open BEFORE INSERT ON public.te_entry FOR EACH ROW EXECUTE FUNCTION public.te_check()';

const eq = (column: string, value: string | number) => ({ groups: [[{ column, op: '=' as const, value }]] });
const ada = (overrides: Record<string, RowScope[string]> = {}): RowScope => ({
  'public.te_customer': eq('owner', 'ada'),
  'public.te_account': eq('customer_id', 1),
  'public.te_entry': eq('account_id', 1),
  'public.te_history': eq('account_id', 1),
  ...overrides,
});
const naming = (...names: string[]): TriggerAcceptance => ({
  named: new Map([['public.te_entry', new Map(names.map((name) => [name, undefined]))]]),
});

const causeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Refusal, String(error));
    return String(refusalCause(error) ?? error.message);
  }
  return assert.fail('the write was not refused');
};
const heard = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Refusal, String(error));
    return `${error.constructor.name}: ${error.message}`;
  }
  return assert.fail('the write was not refused');
};

/** Whether a promise settles within the window; a lock that holds does not. */
async function settles(promise: Promise<unknown>, ms = 400): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

describe('triggers an App names, under a row policy, on PostgreSQL', { skip: liveSkip('postgres', LIVE) }, () => {
  let control: Control;
  const state = async () => ({
    accounts: (await control.query('SELECT id, customer_id, posted_minor FROM public.te_account ORDER BY id')).rows,
    entries: (await control.query('SELECT id, account_id, amount FROM public.te_entry ORDER BY id')).rows,
    history: (await control.query('SELECT entry_id, account_id, what FROM public.te_history ORDER BY id')).rows,
  });
  before(async () => {
    control = await client();
  });
  after(async () => {
    for (const statement of RESET) await control.query(statement).catch(() => {});
    await control.end();
  });
  async function withAdapter<T>(triggers: readonly string[], run: (adapter: PostgresAdapter) => Promise<T>): Promise<T> {
    for (const statement of [...RESET, ...SETUP, ...triggers]) await control.query(statement);
    const adapter = new PostgresAdapter(LIVE!, 'trigger effects', ['public']);
    try {
      return await run(adapter);
    } finally {
      await adapter.close();
    }
  }
  const insert = (
    adapter: PostgresAdapter,
    scope: RowScope,
    values: Record<string, string | number | boolean | null>,
    accepted?: TriggerAcceptance,
  ) => adapter.scopeTransaction(scope, (tx) => tx.insert({ table: 'public.te_entry', values }), accepted);

  test('a named projection and audit trigger run, and each row they changed is told', async () => {
    await withAdapter([POST, AUDIT], async (adapter) => {
      const changes: TriggerChange[] = [];
      await insert(
        adapter,
        ada(),
        { id: 11, account_id: 1, amount: 25 },
        { ...naming('post_balance', 'entry_audit'), changed: (change) => void changes.push(change) },
      );
      const now = await state();
      assert.equal(now.accounts[0].posted_minor, 525);
      assert.deepEqual(now.history, [{ entry_id: 11, account_id: 1, what: 'posted' }]);
      assert.deepEqual(
        changes.map((change) => [change.trigger, change.table, change.kind, change.key]),
        [
          ['entry_audit', 'public.te_history', 'insert', undefined],
          ['post_balance', 'public.te_account', 'update', { id: 1 }],
        ],
      );
      // Not named: refused as before, naming it.
      assert.match(
        await causeOf(insert(adapter, ada(), { id: 12, account_id: 1, amount: 1 }, naming('post_balance'))),
        /an insert fires the trigger "entry_audit"/,
      );
    });
  });

  test("adversarial 1: the request naming another customer's account is refused before the write; a missing one answers alike", async () => {
    await withAdapter([POST], async (adapter) => {
      const before = await state();
      const scope = ada({ 'public.te_entry': true });
      assert.match(
        await causeOf(insert(adapter, scope, { id: 11, account_id: 3, amount: 25 }, naming('post_balance'))),
        /The trigger "post_balance" on "public.te_entry" reaches a row of "public.te_account" outside the principal's rows/,
      );
      assert.equal(
        await heard(insert(adapter, scope, { id: 11, account_id: 99, amount: 1 }, naming('post_balance'))),
        await heard(insert(adapter, scope, { id: 11, account_id: 3, amount: 1 }, naming('post_balance'))),
      );
      assert.deepEqual(await state(), before);
    });
  });

  test('adversarial 2: keyed to OLD, through an update that moves the row, is refused before the write', async () => {
    await withAdapter([MOVE], async (adapter) => {
      const before = await state();
      assert.match(
        await causeOf(
          adapter.scopeTransaction(
            ada({ 'public.te_entry': true }),
            (tx) => tx.update({ table: 'public.te_entry', key: { id: 10 }, values: { account_id: 1 } }),
            naming('move_entry'),
          ),
        ),
        /The trigger "move_entry" on "public.te_entry" reaches a row of "public.te_account" outside the principal's rows/,
      );
      assert.deepEqual(await state(), before);
    });
  });

  test('adversarial 4: a function replaced while the transaction runs refuses it at COMMIT, and nothing it did remains', async () => {
    await withAdapter([POST, AUDIT], async (adapter) => {
      const before = await state();
      await assert.rejects(
        adapter.scopeTransaction(
          ada(),
          async (tx) => {
            await tx.insert({ table: 'public.te_entry', values: { id: 11, account_id: 1, amount: 25 } });
            await control.query(`CREATE OR REPLACE FUNCTION public.te_post() RETURNS trigger LANGUAGE plpgsql AS $$
              BEGIN UPDATE public.te_account SET posted_minor = 0 WHERE id = 2; RETURN NULL; END $$`);
          },
          naming('post_balance', 'entry_audit'),
        ),
        Refusal,
      );
      assert.deepEqual(await state(), before, 'the entry, projection and history all rolled back');
      // The replaced function writes by a constant: it is no longer accepted, named or not.
      assert.match(
        await causeOf(insert(adapter, ada(), { id: 11, account_id: 1, amount: 25 }, naming('post_balance', 'entry_audit'))),
        /named by the App, but outside the keyed-effect grammar/,
      );
    });
  });

  test('adversarial 7: a keyed read of a hidden row answers as a hidden row, whatever that row holds', async () => {
    await withAdapter([CHECK], async (adapter) => {
      const scope = ada({ 'public.te_entry': true });
      const closed = await causeOf(insert(adapter, scope, { id: 11, account_id: 2, amount: 1 }, naming('check_open')));
      const open = await causeOf(insert(adapter, scope, { id: 11, account_id: 3, amount: 1 }, naming('check_open')));
      assert.equal(closed, open);
      assert.doesNotMatch(closed, /closed account/);
      await control.query(`UPDATE public.te_account SET status = 'closed' WHERE id = 1`);
      await assert.rejects(insert(adapter, scope, { id: 11, account_id: 1, amount: 1 }, naming('check_open')), /closed account/);
    });
  });

  test("adversarial 8: a concurrent change of the account's owner is serialized by the row lock the proof takes", async () => {
    await withAdapter([POST], async (adapter) => {
      // Another session moves Ada's account to Ben and holds it uncommitted: the proof's FOR UPDATE waits for it.
      const other = await client();
      try {
        await other.query('BEGIN');
        await other.query('UPDATE public.te_account SET customer_id = 2 WHERE id = 1');
        const write = insert(adapter, ada(), { id: 11, account_id: 1, amount: 25 }, naming('post_balance'));
        write.catch(() => {});
        assert.equal(await settles(write), false, 'the proof waits on the row lock');
        await other.query('COMMIT');
        // Once it commits, the account is Ben's: the trigger's key is outside Ada's rows.
        assert.match(await causeOf(write), /reaches a row of "public.te_account" outside/);
        assert.equal((await state()).accounts[0].posted_minor, 500);
        // The other way round: the proof holds the row, and the owner change waits for the posting to commit.
        await control.query('UPDATE public.te_account SET customer_id = 1 WHERE id = 1');
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const posting = adapter.scopeTransaction(
          ada(),
          async (tx) => {
            await tx.insert({ table: 'public.te_entry', values: { id: 12, account_id: 1, amount: 5 } });
            await held;
          },
          naming('post_balance'),
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        await other.query('BEGIN');
        const move = other.query('UPDATE public.te_account SET customer_id = 2 WHERE id = 1');
        assert.equal(await settles(move), false, "the owner change waits for the posting's lock");
        release();
        await posting;
        await move;
        await other.query('COMMIT');
        assert.deepEqual((await state()).accounts[0], { id: 1, customer_id: 2, posted_minor: 505 });
      } finally {
        await other.query('ROLLBACK').catch(() => {});
        await other.end();
      }
    });
  });

  test('adversarial 9: an unqualified table, with a hostile schema first on the search_path, is refused', async () => {
    await withAdapter([], async (adapter) => {
      await control.query('CREATE SCHEMA te_evil');
      await control.query('CREATE TABLE te_evil.te_account (id integer PRIMARY KEY, posted_minor integer)');
      await control.query('INSERT INTO te_evil.te_account VALUES (1, 0)');
      await control.query(`CREATE FUNCTION public.te_unqualified() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN UPDATE te_account SET posted_minor = posted_minor + NEW.amount WHERE id = NEW.account_id; RETURN NULL; END $$`);
      await control.query(
        'CREATE TRIGGER unqualified AFTER INSERT ON public.te_entry FOR EACH ROW EXECUTE FUNCTION public.te_unqualified()',
      );
      await control.query('ALTER FUNCTION public.te_unqualified() SET search_path = te_evil, public').catch(() => {});
      assert.match(
        await causeOf(insert(adapter, ada(), { id: 11, account_id: 1, amount: 25 }, naming('unqualified'))),
        /an insert fires the trigger "unqualified" \(named by the App, but outside the keyed-effect grammar/,
      );
      assert.equal((await control.query('SELECT posted_minor FROM te_evil.te_account')).rows[0].posted_minor, 0);
      assert.equal((await state()).accounts[0].posted_minor, 500);
    });
  });

  test("an effect's table that runs a function of the database's, or a value that calls one, refuses the trigger before the write", async () => {
    await withAdapter([POST], async (adapter) => {
      const before = await state();
      await control.query("CREATE FUNCTION public.te_peek(integer) RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT $1'");
      // A CHECK on the account calling it: the trigger's update would run it, past the policy, so it is not accepted.
      await control.query('ALTER TABLE public.te_account ADD CONSTRAINT te_seen CHECK (public.te_peek(posted_minor) IS NOT NULL)');
      assert.match(
        await causeOf(insert(adapter, ada(), { id: 11, account_id: 1, amount: 25 }, naming('post_balance'))),
        /fires the trigger "post_balance" \(named by the App, but its write to "public\.te_account" runs the CHECK constraint "te_seen", it calls (public\.)?te_peek\(integer\)\)/,
      );
      await control.query('ALTER TABLE public.te_account DROP CONSTRAINT te_seen');
      // The value itself calling it (unqualified, as a qualified name is outside the grammar): PostgreSQL resolves the
      // call, and a function of the database's is not proven pure.
      await control.query(`CREATE OR REPLACE FUNCTION public.te_post() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN UPDATE public.te_account SET posted_minor = te_peek(posted_minor + NEW.amount) WHERE id = NEW.account_id; RETURN NULL; END $$`);
      assert.match(
        await causeOf(insert(adapter, ada(), { id: 11, account_id: 1, amount: 25 }, naming('post_balance'))),
        /fires the trigger "post_balance" \(named by the App, but outside the keyed-effect grammar: an expression of it runs a function mistri cannot prove writes nothing\)/,
      );
      assert.deepEqual(await state(), before);
    });
  });

  test('adversarial 11: a refusal at each posting stage leaves nothing behind', async () => {
    await withAdapter([POST, AUDIT], async (adapter) => {
      const before = await state();
      const both = naming('post_balance', 'entry_audit');
      await assert.rejects(
        insert(adapter, ada({ 'public.te_history': eq('what', 'manual') }), { id: 11, account_id: 1, amount: 5 }, both),
        Refusal,
      );
      await assert.rejects(
        adapter.scopeTransaction(
          ada(),
          async (tx) => {
            await tx.insert({ table: 'public.te_entry', values: { id: 11, account_id: 1, amount: 5 } });
            assert.equal(await tx.count('public.te_history'), 1);
            throw new Refusal('the command changed its mind');
          },
          both,
        ),
        /changed its mind/,
      );
      assert.deepEqual(await state(), before);
    });
  });

  test('a write that names triggers keeps its turn: an ordinary write asked after it runs after it', async () => {
    // The proof's module once loaded ahead of the transaction's turn, so a write asked meanwhile went first.
    await withAdapter([POST], async (adapter) => {
      const events: string[] = [];
      const scoped = adapter.scopeTransaction(
        ada(),
        async (tx) => {
          events.push('scoped');
          await tx.insert({ table: 'public.te_entry', values: { id: 11, account_id: 1, amount: 25 } });
        },
        naming('post_balance'),
      );
      const ordinary = adapter.insert({ table: 'public.te_customer', values: { id: 3, owner: 'cy' } }).then(() => {
        events.push('ordinary');
      });
      await Promise.all([scoped, ordinary]);
      assert.deepEqual(events, ['scoped', 'ordinary']);
      assert.equal((await state()).accounts[0].posted_minor, 525);
    });
  });
});

/* ---------- a review's bypasses: every key known before the statement, and compared as the proof compares ---------- */

describe(
  'a trigger key on PostgreSQL is known before the write and compared as the proof compares',
  { skip: liveSkip('postgres', LIVE) },
  () => {
    let control: Control;
    const RESET_R = ['DROP SCHEMA IF EXISTS te_r CASCADE', 'CREATE SCHEMA te_r'];
    const BASE_R = [
      'CREATE TABLE te_r.customer (id integer PRIMARY KEY, owner text NOT NULL)',
      'CREATE TABLE te_r.account (id integer PRIMARY KEY, customer_id integer NOT NULL REFERENCES te_r.customer (id), code text UNIQUE, note text, ref integer)',
      `INSERT INTO te_r.customer VALUES (1, 'ada'), (2, 'ben')`,
      `INSERT INTO te_r.account VALUES (1, 1, 'ab ', NULL, 1), (2, 2, 'zz', NULL, NULL), (3, 2, 'ab', NULL, NULL)`,
    ];
    const adaR = (more: RowScope = {}): RowScope => ({
      'te_r.customer': eq('owner', 'ada'),
      'te_r.account': eq('customer_id', 1),
      ...more,
    });
    const namedR = (entries: Record<string, string[]>): TriggerAcceptance => ({
      named: new Map(Object.entries(entries).map(([table, names]) => [`te_r.${table}`, new Map(names.map((name) => [name, undefined]))])),
    });
    /** A plpgsql trigger function and its row trigger, `body` between BEGIN and RETURN NULL. */
    const fires = (name: string, on: string, event: string, body: string) => [
      `CREATE FUNCTION te_r.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NULL; END $$`,
      `CREATE TRIGGER ${name} AFTER ${event} ON te_r.${on} FOR EACH ROW EXECUTE FUNCTION te_r.${name}()`,
    ];
    const settled = async (promise: Promise<unknown>): Promise<string> => {
      try {
        await promise;
        return 'committed';
      } catch (error) {
        assert.ok(error instanceof Refusal, String(error));
        return String(refusalCause(error) ?? error.message);
      }
    };
    const ben3 = async () => (await control.query('SELECT customer_id, note FROM te_r.account WHERE id = 3')).rows[0];
    before(async () => {
      control = await client();
    });
    after(async () => {
      await control.query('DROP SCHEMA IF EXISTS te_r CASCADE').catch(() => {});
      await control.end();
    });
    async function withSchema<T>(sql: readonly string[], run: (adapter: PostgresAdapter) => Promise<T>): Promise<T> {
      for (const statement of [...RESET_R, ...BASE_R, ...sql]) await control.query(statement);
      const adapter = new PostgresAdapter(LIVE!, 'trigger keys', ['te_r']);
      try {
        return await run(adapter);
      } finally {
        await adapter.close();
      }
    }
    /** Ada inserts an entry `values` into te_r.entry, its trigger `touch` named. */
    const entry = (adapter: PostgresAdapter, values: Record<string, string | number>, scope: RowScope = adaR({ 'te_r.entry': true })) =>
      settled(adapter.scopeTransaction(scope, (tx) => tx.insert({ table: 'te_r.entry', values }), namedR({ entry: ['touch'] })));

    test("a reference an effect copies from NEW's stored columns, of an array type, is refused as a key whatever it names", async () => {
      /* holder 1 is ada's and points at ben's slot '[2:3]={1,2}'; its trigger copies NEW.k into a new row. NEW.k, a
         column the update leaves as stored, was the driver's reading [1,2], and the proof checked ada's slot '{1,2}'
         while the trigger's row pointed at ben's. An array is not a type a key may be (keyTypes.ts): both refused. */
      await withSchema(
        [
          'CREATE TABLE te_r.slot (k integer[] PRIMARY KEY, customer_id integer NOT NULL REFERENCES te_r.customer (id))',
          'CREATE TABLE te_r.holder (id integer PRIMARY KEY, customer_id integer NOT NULL, k integer[] REFERENCES te_r.slot (k), note text)',
          'CREATE TABLE te_r.copy (id serial PRIMARY KEY, customer_id integer NOT NULL, k integer[] REFERENCES te_r.slot (k))',
          `INSERT INTO te_r.slot VALUES ('{1,2}', 1), ('[2:3]={1,2}', 2)`,
          `INSERT INTO te_r.holder VALUES (1, 1, '[2:3]={1,2}', NULL), (2, 1, '{1,2}', NULL)`,
          ...fires('copy_it', 'holder', 'UPDATE OF note', 'INSERT INTO te_r.copy (customer_id, k) VALUES (NEW.customer_id, NEW.k);'),
        ],
        async (adapter) => {
          const scope = adaR({
            'te_r.slot': eq('customer_id', 1),
            'te_r.holder': eq('customer_id', 1),
            'te_r.copy': eq('customer_id', 1),
          });
          const note = (id: number) =>
            settled(
              adapter.scopeTransaction(
                scope,
                (tx) => tx.update({ table: 'te_r.holder', key: { id }, values: { note: 'seen' } }),
                namedR({ holder: ['copy_it'] }),
              ),
            );
          for (const id of [1, 2]) assert.match(await note(id), /"te_r\.slot"\.k is of type integer\[\], which is not supported as a key/);
          assert.deepEqual((await control.query('SELECT customer_id, k::text FROM te_r.copy')).rows, []);
        },
      );
    });

    test('an update effect keyed by a serial id is refused before the write, not proven against the row it already moved', async () => {
      await withSchema(
        [
          'CREATE TABLE te_r.claim (id serial PRIMARY KEY, customer_id integer NOT NULL REFERENCES te_r.customer (id))',
          'INSERT INTO te_r.claim (customer_id) VALUES (1), (1)',
          ...fires('claim_it', 'claim', 'INSERT', 'UPDATE te_r.account SET customer_id = NEW.customer_id WHERE id = NEW.id;'),
        ],
        async (adapter) => {
          const outcome = await settled(
            adapter.scopeTransaction(
              adaR({ 'te_r.claim': eq('customer_id', 1) }),
              (tx) => tx.insert({ table: 'te_r.claim', values: { customer_id: 1 } }),
              namedR({ claim: ['claim_it'] }),
            ),
          );
          assert.match(outcome, /The trigger "claim_it" reaches a row of "te_r.account" by a value only the write assigns/);
          assert.equal((await ben3()).customer_id, 2);
        },
      );
    });

    test('an insert proven only after the statement may fire no keyed trigger on its table', async () => {
      await withSchema(
        [
          'CREATE TABLE te_r.req (id serial PRIMARY KEY, target integer NOT NULL, claimer integer NOT NULL)',
          'CREATE TABLE te_r.req_log (id serial PRIMARY KEY, req_id integer NOT NULL REFERENCES te_r.req (id), target integer NOT NULL, claimer integer NOT NULL)',
          ...fires(
            'log_req',
            'req',
            'INSERT',
            'INSERT INTO te_r.req_log (req_id, target, claimer) VALUES (NEW.id, NEW.target, NEW.claimer);',
          ),
          ...fires('apply_req', 'req_log', 'INSERT', 'UPDATE te_r.account SET customer_id = NEW.claimer WHERE id = NEW.target;'),
        ],
        async (adapter) => {
          const outcome = await settled(
            adapter.scopeTransaction(
              adaR({ 'te_r.req': true, 'te_r.req_log': true }),
              (tx) => tx.insert({ table: 'te_r.req', values: { target: 3, claimer: 1 } }),
              namedR({ req: ['log_req'], req_log: ['apply_req'] }),
            ),
          );
          assert.match(
            outcome,
            /The trigger "log_req" inserts a "te_r.req_log" row whose place in the principal's rows only the write can tell/,
          );
          assert.equal((await ben3()).customer_id, 2);
        },
      );
    });

    test('a row two effects of one write reach, where a write to it fires a keyed trigger, is refused before the write', async () => {
      await withSchema(
        [
          'CREATE TABLE te_r.vault (id integer PRIMARY KEY, customer_id integer NOT NULL REFERENCES te_r.customer (id))',
          'INSERT INTO te_r.vault VALUES (1, 1), (3, 2)',
          'CREATE TABLE te_r.entry (id integer PRIMARY KEY, account_id integer NOT NULL REFERENCES te_r.account (id), amount integer NOT NULL)',
          // a_ref runs first (PostgreSQL fires by name): b_touch's c_claim then keys on the ref a_ref set, not the one read.
          ...fires('a_ref', 'entry', 'INSERT', 'UPDATE te_r.account SET ref = NEW.amount WHERE id = NEW.account_id;'),
          ...fires('b_touch', 'entry', 'INSERT', "UPDATE te_r.account SET note = 'x' WHERE id = NEW.account_id;"),
          ...fires('c_claim', 'account', 'UPDATE OF note', 'UPDATE te_r.vault SET customer_id = NEW.customer_id WHERE id = NEW.ref;'),
        ],
        async (adapter) => {
          const outcome = await settled(
            adapter.scopeTransaction(
              adaR({ 'te_r.vault': eq('customer_id', 1), 'te_r.entry': eq('account_id', 1) }),
              (tx) => tx.insert({ table: 'te_r.entry', values: { id: 1, account_id: 1, amount: 3 } }),
              namedR({ entry: ['a_ref', 'b_touch'], account: ['c_claim'] }),
            ),
          );
          assert.match(outcome, /reaches a row of "te_r.account" that this write already reaches, and a write to it fires a trigger/);
          assert.equal((await control.query('SELECT customer_id FROM te_r.vault WHERE id = 3')).rows[0].customer_id, 2);
        },
      );
    });

    test('a key compared through a cast of one side (char(3) to text drops the trailing space) is refused when the catalog is read', async () => {
      await withSchema(
        [
          'CREATE TABLE te_r.entry (id integer PRIMARY KEY, code char(3) NOT NULL)',
          ...fires('touch', 'entry', 'INSERT', "UPDATE te_r.account SET note = 'touched' WHERE code = NEW.code;"),
        ],
        async (adapter) => {
          // Ada's account 1 has the code 'ab ', Ben's account 3 'ab'.
          const outcome = await entry(adapter, { id: 1, code: 'ab ' });
          assert.match(
            outcome,
            /fires the trigger "touch" \(named by the App, but a key of it compares through a cast or a conversion of one side/,
          );
          assert.equal((await ben3()).note, null);
        },
      );
    });

    test('a key between two types, with an operator for the pair or a cast to one (name and text, int8 and float8), is refused', async () => {
      await withSchema(
        [
          'CREATE TABLE te_r.entry (id integer PRIMARY KEY, code name NOT NULL)',
          'CREATE TABLE te_r.num (id integer PRIMARY KEY, n float8 NOT NULL)',
          'CREATE TABLE te_r.big (id int8 PRIMARY KEY, customer_id integer NOT NULL REFERENCES te_r.customer (id), note text)',
          // name = text has an operator of its own: nothing is cast, and it is not the key column's own equality.
          ...fires('touch', 'entry', 'INSERT', "UPDATE te_r.account SET note = 'touched' WHERE code = NEW.code;"),
          // int8 = float8 casts the key to float8, where two ids past 2^53 are one value.
          ...fires('round', 'num', 'INSERT', "UPDATE te_r.big SET note = 'touched' WHERE id = NEW.n;"),
        ],
        async (adapter) => {
          assert.match(
            await entry(adapter, { id: 1, code: 'ab' }),
            /fires the trigger "touch" \(named by the App, but a key of it compares by an operator that is not its column's own equality/,
          );
          assert.match(
            await settled(
              adapter.scopeTransaction(
                adaR({ 'te_r.num': true, 'te_r.big': eq('customer_id', 1) }),
                (tx) => tx.insert({ table: 'te_r.num', values: { id: 1, n: 1 } }),
                namedR({ num: ['round'] }),
              ),
            ),
            /fires the trigger "round" \(named by the App, but a key of it compares through a cast or a conversion of one side/,
          );
        },
      );
    });

    test("a unique index counts as a key only under the column's own collation, its type's default operator class, and checked at once", async () => {
      await withSchema(
        [
          `CREATE COLLATION te_r.ci (provider = icu, locale = 'und-u-ks-level2', deterministic = false)`,
          'CREATE TABLE te_r.acct (id integer PRIMARY KEY, customer_id integer NOT NULL REFERENCES te_r.customer (id), code text COLLATE te_r.ci NOT NULL, note text)',
          'CREATE UNIQUE INDEX acct_code ON te_r.acct (code COLLATE "C")',
          `INSERT INTO te_r.acct VALUES (1, 1, 'abc', NULL), (3, 2, 'ABC', NULL)`,
          'CREATE TABLE te_r.entry (id integer PRIMARY KEY, code text COLLATE te_r.ci NOT NULL)',
          ...fires('touch', 'entry', 'INSERT', "UPDATE te_r.acct SET note = 'touched' WHERE code = NEW.code;"),
          'CREATE TABLE te_r.tag (id integer PRIMARY KEY, customer_id integer NOT NULL REFERENCES te_r.customer (id), code text NOT NULL, note text)',
          'CREATE UNIQUE INDEX tag_code ON te_r.tag (code text_pattern_ops)',
          'CREATE TABLE te_r.slot (id integer PRIMARY KEY, customer_id integer NOT NULL REFERENCES te_r.customer (id), code text NOT NULL UNIQUE DEFERRABLE, note text)',
          'CREATE TABLE te_r.mark (id integer PRIMARY KEY, code text NOT NULL)',
          ...fires('pattern', 'mark', 'INSERT', "UPDATE te_r.tag SET note = 'touched' WHERE code = NEW.code;"),
          ...fires('later', 'mark', 'UPDATE', "UPDATE te_r.slot SET note = 'touched' WHERE code = NEW.code;"),
        ],
        async (adapter) => {
          // Unique under "C", compared under the column's case-folding collation: 'abc' finds Ada's row and Ben's.
          const outcome = await entry(adapter, { id: 1, code: 'abc' }, adaR({ 'te_r.acct': eq('customer_id', 1), 'te_r.entry': true }));
          assert.match(outcome, /fires the trigger "touch" \(named by the App, but its write to "acct" is not by a key of it\)/);
          assert.deepEqual((await control.query('SELECT note FROM te_r.acct ORDER BY id')).rows, [{ note: null }, { note: null }]);
          const scope = adaR({ 'te_r.tag': eq('customer_id', 1), 'te_r.slot': eq('customer_id', 1), 'te_r.mark': true });
          assert.match(
            await settled(
              adapter.scopeTransaction(
                scope,
                (tx) => tx.insert({ table: 'te_r.mark', values: { id: 1, code: 'x' } }),
                namedR({ mark: ['pattern'] }),
              ),
            ),
            /its write to "tag" is not by a key of it/,
          );
          await control.query("INSERT INTO te_r.mark VALUES (2, 'y')");
          assert.match(
            await settled(
              adapter.scopeTransaction(
                scope,
                (tx) => tx.update({ table: 'te_r.mark', key: { id: 2 }, values: { code: 'z' } }),
                namedR({ mark: ['later'] }),
              ),
            ),
            /its write to "slot" is not by a key of it/,
          );
        },
      );
    });

    test('a key column under a nondeterministic collation is refused, its unique constraint notwithstanding', async () => {
      await withSchema(
        [
          `CREATE COLLATION te_r.ci (provider = icu, locale = 'und-u-ks-level2', deterministic = false)`,
          'CREATE TABLE te_r.acct (id integer PRIMARY KEY, customer_id integer NOT NULL REFERENCES te_r.customer (id), code text COLLATE te_r.ci NOT NULL UNIQUE, note text)',
          'CREATE TABLE te_r.entry (id integer PRIMARY KEY, code text COLLATE te_r.ci NOT NULL)',
          ...fires('touch', 'entry', 'INSERT', "UPDATE te_r.acct SET note = 'touched' WHERE code = NEW.code;"),
        ],
        async (adapter) => {
          const outcome = await entry(adapter, { id: 1, code: 'abc' }, adaR({ 'te_r.acct': eq('customer_id', 1), 'te_r.entry': true }));
          assert.match(
            outcome,
            /its key "acct"\.code = NEW\.code compares under a nondeterministic collation \(text COLLATE "te_r"\."ci"\)/,
          );
        },
      );
    });

    test("a key compared by an `=` the search_path finds ahead of pg_catalog's is refused, and the hidden rows it would reach are untouched", async () => {
      const database = String((await control.query('SELECT current_database() AS d')).rows[0].d);
      try {
        await withSchema(
          [
            // Every row but the one named: what a key's own equality is not.
            'CREATE OPERATOR te_r.= (leftarg = text, rightarg = text, function = pg_catalog.textne)',
            `ALTER DATABASE "${database}" SET search_path = te_r, pg_catalog`,
            'CREATE TABLE te_r.entry (id integer PRIMARY KEY, code text NOT NULL)',
            ...fires('touch', 'entry', 'INSERT', "UPDATE te_r.account SET note = 'touched' WHERE code = NEW.code;"),
          ],
          async (adapter) => {
            const outcome = await entry(adapter, { id: 1, code: 'ab ' });
            assert.match(
              outcome,
              /fires the trigger "touch" \(named by the App, but a key of it compares by an operator that is not its column's own equality/,
            );
            assert.deepEqual((await control.query('SELECT id, note FROM te_r.account ORDER BY id')).rows, [
              { id: 1, note: null },
              { id: 2, note: null },
              { id: 3, note: null },
            ]);
          },
        );
      } finally {
        await control.query(`ALTER DATABASE "${database}" RESET search_path`);
      }
    });

    test("a delete effect on a table a foreign key references is refused before the write: a hidden row's reference does not change the answer", async () => {
      const outcome = (benUses: boolean) =>
        withSchema(
          [
            'CREATE TABLE te_r.tag (id integer PRIMARY KEY, customer_id integer NOT NULL REFERENCES te_r.customer (id))',
            'CREATE TABLE te_r.tag_use (id integer PRIMARY KEY, customer_id integer NOT NULL REFERENCES te_r.customer (id), tag_id integer REFERENCES te_r.tag (id))',
            'CREATE TABLE te_r.item (id integer PRIMARY KEY, customer_id integer NOT NULL REFERENCES te_r.customer (id), tag_id integer)',
            'INSERT INTO te_r.tag VALUES (5, 1)',
            'INSERT INTO te_r.item VALUES (1, 1, 5)',
            ...(benUses ? ['INSERT INTO te_r.tag_use VALUES (9, 2, 5)'] : []),
            ...fires('drop_tag', 'item', 'DELETE', 'DELETE FROM te_r.tag WHERE id = OLD.tag_id;'),
          ],
          async (adapter) => {
            const said = await settled(
              adapter.scopeTransaction(
                adaR({ 'te_r.tag': eq('customer_id', 1), 'te_r.tag_use': eq('customer_id', 1), 'te_r.item': eq('customer_id', 1) }),
                (tx) => tx.remove({ table: 'te_r.item', key: { id: 1 } }),
                namedR({ item: ['drop_tag'] }),
              ),
            );
            return { said, items: Number((await control.query('SELECT count(*) AS n FROM te_r.item')).rows[0].n) };
          },
        );
      const without = await outcome(false);
      assert.deepEqual(await outcome(true), without);
      assert.match(without.said, /it deletes from "tag", which a foreign key references/);
      assert.equal(without.items, 1);
    });

    test('an update effect that points a row at a parent answers alike whether that parent is hidden or missing, before the write', async () => {
      await withSchema(
        [
          'CREATE TABLE te_r.card (id integer PRIMARY KEY, customer_id integer NOT NULL REFERENCES te_r.customer (id), account_id integer REFERENCES te_r.account (id))',
          'INSERT INTO te_r.card VALUES (7, 1, 1)',
          'CREATE TABLE te_r.entry (id integer PRIMARY KEY, card_id integer NOT NULL, target integer NOT NULL)',
          ...fires('touch', 'entry', 'INSERT', 'UPDATE te_r.card SET account_id = NEW.target WHERE id = NEW.card_id;'),
        ],
        async (adapter) => {
          const scope = adaR({ 'te_r.card': eq('customer_id', 1), 'te_r.entry': true });
          const write = (target: number) =>
            adapter
              .scopeTransaction(
                scope,
                (tx) => tx.insert({ table: 'te_r.entry', values: { id: target, card_id: 7, target } }),
                namedR({ entry: ['touch'] }),
              )
              .then(
                () => 'committed',
                (error: unknown) => `${(error as Error).constructor.name}: ${(error as Error).message}`,
              );
          const hidden = await write(2);
          assert.equal(await write(99), hidden);
          assert.match(hidden, /^ScopeRefusal: /);
          assert.deepEqual((await control.query('SELECT account_id FROM te_r.card')).rows, [{ account_id: 1 }]);
        },
      );
    });

    test('a refusal names a collation by its schema: two collations of one name are told apart', async () => {
      try {
        await withSchema(
          [
            `CREATE COLLATION te_r."sv" (provider = icu, locale = 'sv-SE')`,
            `CREATE COLLATION public."sv" (provider = libc, locale = 'C')`,
            `CREATE TABLE te_r.acct (id integer PRIMARY KEY, customer_id integer NOT NULL REFERENCES te_r.customer (id), code text COLLATE te_r."sv" NOT NULL UNIQUE, note text)`,
            `CREATE TABLE te_r.entry (id integer PRIMARY KEY, code text COLLATE public."sv" NOT NULL)`,
            ...fires('touch', 'entry', 'INSERT', "UPDATE te_r.acct SET note = 'x' WHERE code = NEW.code;"),
          ],
          async (adapter) => {
            const outcome = await entry(adapter, { id: 1, code: 'ab' }, adaR({ 'te_r.acct': eq('customer_id', 1), 'te_r.entry': true }));
            assert.match(outcome, /compares text COLLATE "te_r"\."sv" with text COLLATE "public"\."sv"/);
          },
        );
      } finally {
        // The table that uses it first: the next test's schema is made anew.
        await control.query('DROP SCHEMA IF EXISTS te_r CASCADE');
        await control.query('DROP COLLATION IF EXISTS public."sv"');
      }
    });
  },
);
