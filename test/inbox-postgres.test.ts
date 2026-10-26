/**
 * The notification store on a live PostgreSQL, in a database this run owns
 * (`ownedPostgresDatabase`): the layout provisioning pins, a notice written
 * inside the write's own transaction (and gone with it on a rollback), a
 * person's read, marking theirs read, and a refused foreign layout.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { attributeWrites } from '../packages/engine/src/adapters/writeAttribution.js';
import { INBOX_TABLES, INBOX_VERSION, InboxUnavailable } from '../packages/mistri/src/adapters/inbox/inbox.js';
import { bindNotices } from '../packages/mistri/src/server/stores/writeCaptures.js';
import { provisionPostgresInbox } from '../packages/mistri/src/adapters/inbox/postgresInbox.js';
import { LIVE_PG, ownedPostgresDatabase } from './support/jobStoreEngines.js';
import { liveSkip } from './live.js';
import { appStoresOf } from '../packages/mistri/src/server/stores/appStores.js';
import { runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';

const skip = liveSkip('postgres', LIVE_PG);

async function client(url: string) {
  const specifier = 'pg';
  const pg = (await import(specifier)) as unknown as {
    default: {
      Client: new (options: unknown) => {
        connect(): Promise<void>;
        end(): Promise<void>;
        query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
      };
    };
  };
  const created = new pg.default.Client({ connectionString: url });
  await created.connect();
  return created;
}

test(
  "PostgreSQL notifications: provisioned once, written in the write's transaction, read and marked by their person",
  { skip },
  async () => {
    const url = await ownedPostgresDatabase();
    const control = await client(url);
    const adapter = new PostgresAdapter(url, 'inbox');
    try {
      await control.query(
        `DROP TABLE IF EXISTS ${runtimeTable('postgres', INBOX_TABLES.notice)}, ${runtimeTable('postgres', INBOX_TABLES.meta)}, ${runtimeTable('postgres', INBOX_TABLES.mail)}, ${runtimeTable('postgres', INBOX_TABLES.optout)}, public.ib_ticket, public.ib_person`,
      );
      await control.query(`CREATE TABLE public.ib_person (id integer PRIMARY KEY, email text)`);
      await control.query(
        `CREATE TABLE public.ib_ticket (id integer PRIMARY KEY, title text, status text, owner_id integer REFERENCES public.ib_person(id), done boolean)`,
      );
      await control.query(`INSERT INTO public.ib_person VALUES (1, 'ann@example.test')`);
      await control.query(`INSERT INTO public.ib_ticket VALUES (1, 'Printer jam', 'open', 1, false)`);
      assert.equal(await appStoresOf(adapter).inboxReady(), false);
      assert.deepEqual(await provisionPostgresInbox(url), { version: INBOX_VERSION, provisioned: true });
      assert.deepEqual(await provisionPostgresInbox(url), { version: INBOX_VERSION, provisioned: false });
      assert.equal(await appStoresOf(adapter).inboxReady(), true);

      const schema = await adapter.introspect();
      const ticket = schema.tables.find((candidate) => candidate.name === 'ib_ticket')!.id;
      const person = schema.tables.find((candidate) => candidate.name === 'ib_person')!.id;
      bindNotices(
        adapter,
        new Map([
          [
            ticket,
            [
              {
                app: 'desk',
                on: { kind: 'update', columns: ['status'] },
                when: [[{ column: 'done', values: ['true'] }]],
                to: [{ column: 'owner_id', hops: [{ table: person, key: 'id', column: 'email' }] }],
                title: ['Ticket ', { column: 'title', hops: [] }, ' is ', { column: 'status', hops: [] }],
                open: { resource: 'ticket' },
                uses: ['ticket.title'],
                email: true,
              },
            ],
          ],
        ]),
      );
      // Not done: nobody hears.
      await adapter.update({ table: ticket, key: { id: 1 }, values: { status: 'waiting' } });
      // Done (a real boolean here), by someone else: the owner hears.
      await attributeWrites({ actor: 'bob@example.test', name: 'Bob', via: 'app' }, () =>
        adapter.transaction(async (tx) => {
          await tx.update({ table: ticket, key: { id: 1 }, values: { done: true, status: 'closed' } });
        }),
      );
      // A rolled-back write tells nobody.
      await assert.rejects(
        adapter.transaction(async (tx) => {
          await tx.update({ table: ticket, key: { id: 1 }, values: { status: 'reopened' } });
          throw new Error('handler failed');
        }),
        /handler failed/,
      );
      const read = await appStoresOf(adapter).readInbox({ app: 'desk', recipient: 'ann@example.test', limit: 20 });
      assert.deepEqual(
        read.map((row) => [row.title, row.actor, row.actorName, row.key, row.readAt]),
        [['Ticket Printer jam is closed', 'bob@example.test', 'Bob', '{"id":1}', null]],
      );
      assert.equal((await appStoresOf(adapter).readInbox({ app: 'desk', recipient: 'bob@example.test', limit: 20 })).length, 0);
      assert.equal(
        await appStoresOf(adapter).markInboxRead({ app: 'desk', recipient: 'bob@example.test', at: 'now', ids: [read[0].id] }),
        0,
      );
      assert.equal(
        await appStoresOf(adapter).markInboxRead({ app: 'desk', recipient: 'ann@example.test', at: 'now', ids: [read[0].id] }),
        1,
      );
      assert.equal(
        (await appStoresOf(adapter).readInbox({ app: 'desk', recipient: 'ann@example.test', limit: 20, unread: true })).length,
        0,
      );

      // The emailed notice's outbox row: claimed once, held by its lease, and gone when sent. Opting out is kept per person.
      const outbox = appStoresOf(adapter).inboxMail();
      const claimed = await outbox.claimMail('desk', '9999-01-01T00:00:00.000Z', '9999-01-01T00:02:00.000Z', 10);
      assert.deepEqual(
        claimed.map((mail) => [mail.recipient, mail.title, mail.attempts]),
        [['ann@example.test', 'Ticket Printer jam is closed', 0]],
      );
      assert.deepEqual(await outbox.claimMail('desk', '9999-01-01T00:00:00.000Z', '9999-01-01T00:02:00.000Z', 10), []);
      await outbox.settleMail(claimed[0], { kind: 'sent' });
      assert.equal((await control.query(`SELECT count(*)::int AS n FROM ${runtimeTable('postgres', INBOX_TABLES.mail)}`)).rows[0].n, 0);
      assert.equal(await outbox.emailOff('desk', 'ann@example.test'), false);
      await outbox.setEmailOff('desk', 'ann@example.test', true, 'now');
      assert.equal(await outbox.emailOff('desk', 'Ann@Example.test'), true);

      // An altered layout is refused, and a write that cannot write its notice fails whole.
      await control.query(`CREATE FUNCTION public.ib_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
      await control.query(
        `CREATE TRIGGER ib_scrub BEFORE INSERT ON ${runtimeTable('postgres', INBOX_TABLES.notice)} FOR EACH ROW EXECUTE FUNCTION public.ib_noop()`,
      );
      assert.equal(await appStoresOf(adapter).inboxReady(), false);
      await assert.rejects(provisionPostgresInbox(url), InboxUnavailable);
      // The adapter attested the store when it first read it; one that starts now refuses.
      const restarted = new PostgresAdapter(url, 'inbox, restarted');
      try {
        await assert.rejects(appStoresOf(restarted).readInbox({ app: 'desk', recipient: 'ann@example.test', limit: 5 }), InboxUnavailable);
      } finally {
        await restarted.close();
      }
      await control.query(`DROP TABLE ${runtimeTable('postgres', INBOX_TABLES.notice)}`);
      await assert.rejects(
        attributeWrites({ actor: 'bob@example.test', via: 'app' }, () =>
          adapter.update({ table: ticket, key: { id: 1 }, values: { status: 'open' } }),
        ),
      );
      assert.equal((await control.query('SELECT status FROM public.ib_ticket WHERE id = 1')).rows[0].status, 'closed');
    } finally {
      await adapter.close();
      await control.end();
    }
  },
);
