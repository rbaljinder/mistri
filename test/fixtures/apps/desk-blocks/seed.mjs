/**
 * The Desk blocks fixture's database: three tickets, one with a conversation (two messages from its caller, an
 * agent's reply, an internal note and a system line), and this month's changes with the freezes and holidays behind
 * them. People are agents and callers both: a message's author is a person, and so is a ticket's caller.
 *
 *   node --import tsx test/fixtures/apps/desk-blocks/seed.mjs <new-file.db>
 *
 * Writes the database and `<file>.json`, a writable connection named `desk`, and migrates the command journal the
 * two composer commands need. Refuses an existing file. Deterministic but for the month: the specs name tickets by id
 * (ticket 1 is the one with the conversation), and the changes, freezes and holidays fall on fixed days of the month
 * it is seeded in, because a calendar opens on today's month.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrateSqliteCommandJournal } from '@mistriwork/mistri/maintenance';

const SCHEMA = `PRAGMA foreign_keys=ON; BEGIN;
  CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE ticket (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, requester TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('open','pending','solved')),
    priority TEXT NOT NULL CHECK(priority IN ('low','normal','urgent')),
    caller_id INTEGER REFERENCES person(id), agent_id INTEGER REFERENCES person(id), opened_at TIMESTAMP NOT NULL
  );
  CREATE TABLE message (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, ticket_id INTEGER NOT NULL REFERENCES ticket(id),
    body TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('customer','reply','internal','system')), sent_at TIMESTAMP NOT NULL,
    author_id INTEGER REFERENCES person(id)
  );
  CREATE TABLE canned_reply (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL);
  CREATE TABLE change (id INTEGER PRIMARY KEY, name TEXT NOT NULL, starts_on DATE NOT NULL, ends_on DATE NOT NULL);
  CREATE TABLE freeze (id INTEGER PRIMARY KEY, name TEXT NOT NULL, starts_on DATE NOT NULL, ends_on DATE NOT NULL);
  CREATE TABLE holiday (id INTEGER PRIMARY KEY, name TEXT NOT NULL, starts_on DATE NOT NULL, ends_on DATE NOT NULL);
  CREATE INDEX message_ticket ON message(ticket_id);`;

/* A day of the month it is seeded in, as the calendar reads a date. */
const now = new Date();
const day = (n) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(n).padStart(2, '0')}`;

function insert(db, table, rows) {
  const columns = Object.keys(rows[0]);
  const statement = db.prepare(
    `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
  );
  for (const row of rows) statement.run(...columns.map((column) => row[column]));
}

export function seed(path) {
  const file = resolve(path);
  if (existsSync(file) || existsSync(`${file}.json`)) throw new Error(`Refusing to replace ${file}. Choose a new file.`);
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(SCHEMA);
    insert(db, 'person', [
      { id: 1, name: 'Robin Bell' },
      { id: 2, name: 'Ana Pereira' },
      { id: 3, name: 'Bo Chen' },
      { id: 4, name: 'Cy Dunn' },
    ]);
    const opened = (daysAgo) => new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
    insert(db, 'ticket', [
      {
        id: 1,
        name: 'VPN drops every hour',
        requester: 'Ana Pereira',
        status: 'open',
        priority: 'urgent',
        caller_id: 2,
        agent_id: 1,
        opened_at: opened(2),
      },
      {
        id: 2,
        name: 'Laptop swap',
        requester: 'Bo Chen',
        status: 'pending',
        priority: 'normal',
        caller_id: 3,
        agent_id: null,
        opened_at: opened(12),
      },
      {
        id: 3,
        name: 'Printer jammed',
        requester: 'Cy Dunn',
        status: 'solved',
        priority: 'low',
        caller_id: 4,
        agent_id: 1,
        opened_at: opened(20),
      },
    ]);
    insert(db, 'message', [
      {
        id: 1,
        name: 'Ana Pereira',
        ticket_id: 1,
        body: 'The VPN drops about once an hour.',
        kind: 'customer',
        sent_at: '2026-10-01T09:00:00Z',
        author_id: 2,
      },
      {
        id: 2,
        name: 'Ana Pereira',
        ticket_id: 1,
        body: "It started after Monday's update.",
        kind: 'customer',
        sent_at: '2026-10-01T09:02:00Z',
        author_id: 2,
      },
      {
        id: 3,
        name: 'Robin Bell',
        ticket_id: 1,
        body: 'Thanks, looking into it now.',
        kind: 'reply',
        sent_at: '2026-10-01T09:20:00Z',
        author_id: 1,
      },
      {
        id: 4,
        name: 'Robin Bell',
        ticket_id: 1,
        body: 'Likely the gateway firmware; ask network.',
        kind: 'internal',
        sent_at: '2026-10-01T09:30:00Z',
        author_id: 1,
      },
      {
        id: 5,
        name: 'System',
        ticket_id: 1,
        body: 'Priority raised to urgent',
        kind: 'system',
        sent_at: '2026-10-01T09:40:00Z',
        author_id: null,
      },
    ]);
    insert(db, 'canned_reply', [
      { id: 1, title: 'Restart first', body: 'Please restart the device and tell us whether it helps.' },
      { id: 2, title: 'Apology', body: 'Sorry for the wait — we are on it.' },
    ]);
    insert(db, 'change', [
      { id: 1, name: 'Firewall rules', starts_on: day(4), ends_on: day(4) },
      { id: 2, name: 'Gateway firmware', starts_on: day(15), ends_on: day(16) },
      { id: 3, name: 'Mail cutover', starts_on: day(22), ends_on: day(22) },
    ]);
    insert(db, 'freeze', [{ id: 1, name: 'Quarter-end freeze', starts_on: day(8), ends_on: day(12) }]);
    insert(db, 'holiday', [{ id: 1, name: 'Office closed', starts_on: day(25), ends_on: day(26) }]);
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  migrateSqliteCommandJournal(file);
  writeFileSync(`${file}.json`, `${JSON.stringify({ connections: [{ name: 'desk', url: file, writable: true }] }, null, 2)}\n`, {
    flag: 'wx',
  });
  return file;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw new Error('Usage: node --import tsx test/fixtures/apps/desk-blocks/seed.mjs <new-file.db>');
  console.log(seed(process.argv[2]));
}
