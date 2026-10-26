import { spawn } from './spawned';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { provisionSqliteLiveChange } from '../../packages/mistri/src/adapters/live/sqliteLiveChange';
import { provisionSqliteRecordHistory } from '../../packages/mistri/src/adapters/history/sqliteRecordHistory';
import { migrateSqliteCommandJournal } from '../../packages/mistri/src/adapters/commands/commandJournal';

export const SESSION_APP_ID = 'session-workspace';

/** Each run owns both its application database and its real Better Auth store. */
/** The instant a `stamps` fixture's server reads as now, and the zone its App counts days in. */
export const STAMP_CLOCK = '2026-09-08T02:30:00Z';
export const STAMP_ZONE = 'America/Los_Angeles';

/** `stamps`: tickets carry resolved_at/resolved_on/resolved_by, which a Resolve action stamps and nothing else moves.
    `viewRoles`: a `requester` role beside `agent`, and an agents' queue over the same tickets that names `roles: ['agent']`.
    `portal` (with `viewRoles`): help articles a requester reads in place of tickets, a home with one find box over
    tickets and articles, and the top bar for requesters only (`placement: { top: ['requester'] }`). */
export async function startSessionApp(
  options: {
    fieldPolicy?: boolean;
    rowPolicy?: boolean;
    deletedPolicy?: boolean;
    stamps?: boolean;
    viewRoles?: boolean;
    portal?: boolean;
    /** Provision live sync's change store, as `migrate stores up` would: the page then follows other people's changes. */
    live?: boolean;
    /** The ticket page shows its history, and the store that keeps it is provisioned: live sync names who changed a ticket. */
    history?: boolean;
    /** Notes on a ticket, a timeline with a composer that sends `addNote`, and a Close command whose form asks a reason. */
    notes?: boolean;
    /** A PostgreSQL server's URL: the tickets (and their notes) live in a database of their own made on it, dropped at stop.
        Only the plain ticket fixture, with `live`, `history` and `notes`. */
    postgres?: string;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-session-browser-'));
  let database = join(directory, 'tickets.db');
  let dropDatabase: (() => Promise<void>) | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      const force = setTimeout(() => child?.kill('SIGKILL'), 5000);
      try {
        await closed;
      } finally {
        clearTimeout(force);
      }
    }
    await dropDatabase?.();
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    if (options.postgres) {
      const { default: pg } = await import('pg');
      const name = `tw_session_${process.pid}_${Date.now().toString(36)}`;
      const admin = new pg.Client({ connectionString: options.postgres });
      await admin.connect();
      await admin.query(`CREATE DATABASE ${name}`);
      await admin.end();
      const url = new URL(options.postgres);
      url.pathname = `/${name}`;
      database = url.href;
      dropDatabase = async () => {
        const dropping = new pg.Client({ connectionString: options.postgres });
        await dropping.connect();
        await dropping.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).finally(() => dropping.end());
      };
      const made = new pg.Client({ connectionString: database });
      await made.connect();
      await made.query(`CREATE TABLE ticket (id integer PRIMARY KEY, name text NOT NULL, status text NOT NULL);
        INSERT INTO ticket (id, name, status) VALUES (1, 'Session-owned ticket', 'open'), (2, 'Another ticket', 'open');
        CREATE TABLE ticket_note (id serial PRIMARY KEY, ticket_id integer NOT NULL REFERENCES ticket(id), body text NOT NULL, at timestamptz NOT NULL);`);
      await made.end();
      const { provisionPostgresLiveChange } = await import('../../packages/mistri/src/adapters/live/postgresLiveChange');
      const { provisionPostgresRecordHistory } = await import('../../packages/mistri/src/adapters/history/postgresRecordHistory');
      if (options.live) await provisionPostgresLiveChange(database);
      if (options.history) await provisionPostgresRecordHistory(database);
      const { migratePostgresCommandJournal } = await import('../../packages/mistri/src/adapters/commands/postgresCommandJournal');
      if (options.notes) await migratePostgresCommandJournal(database);
    } else {
      const db = new DatabaseSync(database);
      try {
        db.exec(`CREATE TABLE ticket (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL${options.fieldPolicy ? " DEFAULT 'open', private_note TEXT DEFAULT 'FIELD_PRIVATE_SENTINEL'" : ''}${options.stamps ? ', resolved_at TIMESTAMP, resolved_on DATE, resolved_by TEXT' : ''});
        INSERT INTO ticket (id,name,status) VALUES (1, 'Session-owned ticket', 'open'), (2, 'Another ticket', 'open');${
          options.notes
            ? `
        CREATE TABLE ticket_note (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES ticket(id), body TEXT NOT NULL, at TIMESTAMP NOT NULL);`
            : ''
        }${
          options.portal
            ? `
        INSERT INTO ticket (id,name,status) VALUES (3, 'Printer jam on floor 3', 'open');
        CREATE TABLE article (id INTEGER PRIMARY KEY, title TEXT NOT NULL, topic TEXT);
        INSERT INTO article VALUES (1, 'Clear a printer jam', 'Printers'), (2, 'Install the printer driver', 'Printers'), (3, 'Reset your password', 'Accounts');`
            : ''
        }`);
      } finally {
        db.close();
      }
      if (options.live) provisionSqliteLiveChange(database);
      if (options.history) provisionSqliteRecordHistory(database);
      if (options.notes) migrateSqliteCommandJournal(database);
    }
    const config = join(directory, 'connections.json');
    writeFileSync(config, JSON.stringify({ connections: [{ name: 'private-session-data', url: database, writable: true }] }));
    const authoring = join(directory, 'app');
    mkdirSync(authoring);
    const app = join(authoring, 'app.ts');
    writeFileSync(
      app,
      `import { defineApp, navGroup, page, history, now, me, action, timeline, stream } from ${JSON.stringify(pathToFileURL(resolve('packages/mistri/schema/app.mjs')).href)};
export default defineApp({
  id: '${SESSION_APP_ID}', name: 'Session workspace',${options.live ? ' live: true,' : ''}
  ${options.rowPolicy || options.notes ? "sources:{operations:{connection:'private-session-data'}}," : "connection:'private-session-data',"}
  auth: { providers: ['email'], signUp: 'open', defaultRole: 'agent', store: ${JSON.stringify(join(directory, 'sessions.db'))},
    ${options.rowPolicy ? "rows:'policy'," : ''} roles: { agent: { read: true, write: true${options.notes ? ", commands: ['addNote', 'closeTicket']" : ''}${options.notes && !options.fieldPolicy ? ", fields: {ticket: {read:['id','name','status'],write:['name','status']}, ticket_note: {read:['id','ticket_id','body','at'],write:[]}}" : ''}${options.fieldPolicy ? ", fields: {ticket: {read:['id','name','status'],write:['name']}}" : ''} }${options.viewRoles ? `, requester: { read: ${options.portal ? "['article']" : 'true'} }` : ''} } },
  resources: {${options.portal ? ' article: {},' : ''}${options.notes ? " ticket_note: { access: 'write' }," : ''} ticket: { access: 'write', delete: true, favorite: true${
    options.notes
      ? ", actions: { addNote: action('Add note', { command: 'addNote', header: false }), closeTicket: action('Close', { command: 'closeTicket' }) }"
      : ''
  }${
    options.stamps
      ? `,
    machine: { column: 'status', states: { open: { on: { resolve: { label: 'Resolve', to: 'resolved', set: { resolved_at: now, resolved_on: now, resolved_by: me } } } }, resolved: { final: true } } }`
      : ''
  } } },
  views: { tickets: { kind: 'list', label: 'Tickets', from: 'ticket', show: ['name', 'status', 'id'], open: 'page' }${
    options.viewRoles
      ? `,
    queue: { kind: 'list', label: 'Agent queue', from: 'ticket', show: ['name', 'status'], roles: ['agent'] }`
      : ''
  }${
    options.portal
      ? `,
    articles: { kind: 'list', label: 'Articles', from: 'article', show: ['title', 'topic'] },
    help: { kind: 'dashboard', label: 'Help center', sections: [{ kind: 'find', title: 'Find anything', resources: ['ticket', 'article'], placeholder: 'Search tickets and articles' }] }`
      : ''
  } },
  pages: { ticket: page('ticket', [{ kind: 'fields', show: ['name', 'status'${options.stamps ? ", 'resolved_at', 'resolved_on', 'resolved_by'" : ''}], columns: 2 }${
    options.notes
      ? ", timeline('Notes', [stream('ticket_note', 'ticket_id', 'at', 'body')], { newest: 'last', composer: { reply: 'addNote' } })"
      : ''
  }${options.history ? ', history()' : ''}]) },
  home: '${options.portal ? 'help' : 'tickets'}',
  nav: [${options.portal ? "'help', 'articles', " : ''}navGroup('records', 'Records', ['tickets'${options.viewRoles ? ", 'queue'" : ''}])],
  ui: { shell: { placement: ${options.portal ? "{ top: ['requester'] }" : "'top'"} }${options.stamps ? `, timezone: '${STAMP_ZONE}'` : ''} },
});
`,
    );
    if (options.notes)
      writeFileSync(
        join(authoring, 'commands.mjs'),
        `import { defineCommand, defineCommands, field } from ${JSON.stringify(pathToFileURL(resolve('packages/mistri/src/server/commands.ts')).href)};
export default defineCommands({
  addNote: defineCommand({ source: 'operations', target: 'ticket', write: ['ticket_note'],
    input: { body: field.textarea({ label: 'Note', max: 4000 }) },
    async handle({ db, record, now }, input) {
      await db.ticket_note.insert({ ticket_id: record.id, body: input.body, at: now().toISOString() });
    } }),
  closeTicket: defineCommand({ source: 'operations', target: 'ticket',
    input: { reason: field.text({ label: 'Reason' }) },
    async handle({ db, record }, input) { await db.ticket.update(record, { status: 'closed' }); } }),
});
`,
      );
    const policy = join(directory, 'policy.mjs');
    if (options.rowPolicy)
      writeFileSync(
        policy,
        `export default {appId:'${SESSION_APP_ID}',
      ${options.deletedPolicy ? "authorizeDeletedRecord: (principal, record) => principal.roles.includes('agent') && record.table === 'ticket' && record.row.id !== 2," : ''}
      resolveRows: () => ({ticket:{groups:[[{column:'id',op:'!=',value:2}]]}})};`,
      );
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => {
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', resolve);
    });
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
    const origin = `http://127.0.0.1:${port}`;
    child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'packages/mistri/src/server/index.ts',
        '--config',
        config,
        '--app',
        app,
        ...(options.rowPolicy ? ['--policy', policy] : []),
        '--port',
        String(port),
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: '',
          XDG_CONFIG_HOME: join(directory, 'xdg'),
          MISTRI_OPEN: '0',
          BETTER_AUTH_SECRET: 'isolated-browser-session-secret-at-least-thirty-two-characters',
          MISTRI_AUTH_ADMIN_EMAIL: '',
          MISTRI_AUTH_ADMIN_PASSWORD: '',
          ...(options.stamps ? { MISTRI_CLOCK: STAMP_CLOCK } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const processChild = child;
    let log = '';
    processChild.stdout!.on('data', (chunk) => {
      log += String(chunk);
    });
    processChild.stderr!.on('data', (chunk) => {
      log += String(chunk);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => done(new Error(`Session fixture startup timed out: ${log}`)), 30_000);
      const ready = () => {
        if (log.includes('Listening on ')) done();
      };
      const failed = () => done(new Error(`Session fixture exited during startup: ${log}`));
      const done = (error?: Error) => {
        clearTimeout(timer);
        processChild.stdout!.off('data', ready);
        processChild.off('exit', failed);
        processChild.off('error', done);
        if (error) reject(error);
        else resolve();
      };
      processChild.stdout!.on('data', ready);
      processChild.once('exit', failed);
      processChild.once('error', done);
      ready();
    });
    const accounts = await Promise.all(
      ['alice', 'bob'].map(async (name) => {
        /* Named as people are, so what is said of them reads as it would: "Alice changed this ticket". */
        const credentials = {
          name: `${name[0].toUpperCase()}${name.slice(1)}`,
          email: `${name}@example.test`,
          password: `session-fixture-${name}-password`,
        };
        const response = await fetch(`${origin}/api/auth/sign-up/email`, {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify(credentials),
          signal: AbortSignal.timeout(10_000),
        });
        const result = await response.json();
        if (!response.ok || typeof result.user?.id !== 'string')
          throw new Error(`Session fixture signup failed: ${JSON.stringify(result)}`);
        return { ...credentials, id: result.user.id as string };
      }),
    );
    /* Under open sign-up an unconfirmed address is nobody in particular (`me`,
       a stamp's person, the inbox): these accounts stand for people who
       followed their confirmation link. */
    const sessions = new DatabaseSync(join(directory, 'sessions.db'));
    try {
      sessions.prepare('UPDATE "user" SET emailVerified = 1').run();
    } finally {
      sessions.close();
    }
    return { origin, database, accounts, stop, store: join(directory, 'sessions.db') };
  } catch (error) {
    await stop();
    throw error;
  }
}
