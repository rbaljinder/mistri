/**
 * The notification store's outbox: the notices that are also emailed, and
 * the people who asked for no email.
 *
 * A notice that is emailed gets a row here in the same transaction as the
 * notice itself (the engines' append), so a write that commits has queued
 * its mail and one that rolls back has queued none, and nothing is ever sent
 * from inside the write. The sender (server/email/outbox.ts) claims due rows
 * after the fact: a claim moves the row's due time a lease ahead and counts
 * the attempt, compared on the due time it read, so two senders cannot both
 * take one row, and a sender that dies mid-send leaves it to be taken again
 * when the lease runs out — at least once, never lost. A sent row is
 * deleted; the notice stays in the inbox. A row that keeps failing is kept
 * as `failed`, with the transport's reason, for an operator to read.
 *
 * One statement shape on every engine: the engines hand in how to run one.
 */
import { createHash } from 'node:crypto';
import { INBOX_TABLES } from './inboxTables.js';

/** A due row with what the message is made from. */
export interface QueuedMail {
  notice: number;
  /** Attempts before this one. */
  attempts: number;
  /** The due time this claim holds the row by: a settle compares on it. */
  claim: string;
  app: string;
  recipient: string;
  resource: string;
  key: string;
  title: string;
  uses: string[];
  actorName: string;
}

export type MailOutcome =
  | { kind: 'sent' }
  | { kind: 'skipped' }
  | { kind: 'retry'; at: string; error: string }
  | { kind: 'failed'; error: string };

/** What an adapter holding the store offers the sender. Private: never on the public Adapter. */
export interface InboxMailStore {
  /** Take up to `limit` of one App's rows due by `now`, each held until `until`. */
  claimMail(app: string, now: string, until: string, limit: number): Promise<QueuedMail[]>;
  /** The inboxes under one App with a row due by `now`: the App's own and its tenants' (`<app>/t.…`), so a
      tenant App's sender reads one statement a pass, not one per tenant. */
  dueInboxes(app: string, now: string): Promise<string[]>;
  settleMail(mail: Pick<QueuedMail, 'notice' | 'claim'>, outcome: MailOutcome): Promise<void>;
  emailOff(app: string, recipient: string): Promise<boolean>;
  setEmailOff(app: string, recipient: string, off: boolean, at: string): Promise<void>;
}

/* A nudge, in this process, that a write queued mail: the sender, backed off
   while idle, looks again soon. Sent while the writing transaction is still
   open, so the first look may find nothing yet; it then polls from its
   shortest wait, which sees the commit. It carries nothing and grants nothing. */
const queuedListeners = new Set<() => void>();
export function onMailQueued(listener: () => void): () => void {
  queuedListeners.add(listener);
  return () => {
    queuedListeners.delete(listener);
  };
}
export function mailQueued(): void {
  for (const listener of queuedListeners) {
    try {
      listener();
    } catch {
      /* The listener's failure is its own; the write goes on. */
    }
  }
}

/** How one engine runs a statement: rows back, or the count of rows changed. `?` marks each parameter. */
interface MailSql {
  all(sql: string, params: readonly unknown[]): Promise<Array<Record<string, unknown>>>;
  run(sql: string, params: readonly unknown[]): Promise<number>;
}

/** Who asked for no email, as the store keeps it: a digest, so the table is no list of addresses. */
const optoutHolder = (app: string, recipient: string) =>
  createHash('sha256').update(`${app}\u0000${recipient.trim().toLowerCase()}`, 'utf8').digest('hex');

/** How long the transport's reason is kept. */
const ERROR_CHARS = 500;

const uses = (text: unknown): string[] => {
  try {
    const parsed = typeof text === 'string' ? JSON.parse(text) : text;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
};

/**
 * The outbox over one engine. `table` quotes a reserved table's name as the
 * engine writes it; `through` runs statements on a writer, one call at a time.
 */
export function inboxMailStore(
  table: (name: string) => string,
  through: <T>(work: (sql: MailSql) => Promise<T>) => Promise<T>,
): InboxMailStore {
  const mail = table(INBOX_TABLES.mail),
    notice = table(INBOX_TABLES.notice),
    optout = table(INBOX_TABLES.optout);
  const store: InboxMailStore = {
    claimMail: (app: string, now: string, until: string, limit: number) =>
      through(async (sql) => {
        const bound = Math.max(1, Math.min(100, Math.trunc(limit)));
        const due = await sql.all(
          `SELECT m.notice AS notice, m.attempts AS attempts, m.due_at AS due_at, n.app AS app, n.recipient AS recipient,
          n.resource AS resource, n.key_json AS key_json, n.title AS title, n.uses_json AS uses_json, n.actor_name AS actor_name
        FROM ${mail} m JOIN ${notice} n ON n.id = m.notice
        WHERE m.state = 'queued' AND m.due_at <= ? AND n.app = ? ORDER BY m.due_at, m.notice LIMIT ${bound}`,
          [now, app],
        );
        const claimed: QueuedMail[] = [];
        for (const row of due) {
          const attempts = Number(row.attempts);
          const taken = await sql.run(`UPDATE ${mail} SET due_at = ?, attempts = ? WHERE notice = ? AND state = 'queued' AND due_at = ?`, [
            until,
            attempts + 1,
            String(row.notice),
            String(row.due_at),
          ]);
          if (taken !== 1) continue;
          claimed.push({
            notice: Number(row.notice),
            attempts,
            claim: until,
            app: String(row.app),
            recipient: String(row.recipient),
            resource: String(row.resource),
            key: String(row.key_json),
            title: String(row.title),
            uses: uses(row.uses_json),
            actorName: String(row.actor_name ?? ''),
          });
        }
        return claimed;
      }),
    dueInboxes: (app: string, now: string) =>
      through(async (sql) => {
        const under = `${app}/`;
        const due = await sql.all(
          `SELECT DISTINCT n.app AS app FROM ${mail} m JOIN ${notice} n ON n.id = m.notice
        WHERE m.state = 'queued' AND m.due_at <= ? AND (n.app = ? OR substr(n.app, 1, ${under.length}) = ?)`,
          [now, app, under],
        );
        return due.map((row) => String(row.app)).sort();
      }),
    settleMail: (held, outcome) =>
      through(async (sql) => {
        const at = [String(held.notice), held.claim];
        if (outcome.kind === 'sent' || outcome.kind === 'skipped') await sql.run(`DELETE FROM ${mail} WHERE notice = ? AND due_at = ?`, at);
        else if (outcome.kind === 'retry') {
          await sql.run(`UPDATE ${mail} SET due_at = ?, last_error = ? WHERE notice = ? AND due_at = ?`, [
            outcome.at,
            outcome.error.slice(0, ERROR_CHARS),
            ...at,
          ]);
        } else
          await sql.run(`UPDATE ${mail} SET state = 'failed', last_error = ? WHERE notice = ? AND due_at = ?`, [
            outcome.error.slice(0, ERROR_CHARS),
            ...at,
          ]);
      }),
    emailOff: (app, recipient) =>
      through(async (sql) => (await sql.all(`SELECT holder FROM ${optout} WHERE holder = ?`, [optoutHolder(app, recipient)])).length > 0),
    setEmailOff: (app, recipient, off, at) =>
      through(async (sql) => {
        const holder = optoutHolder(app, recipient);
        await sql.run(`DELETE FROM ${optout} WHERE holder = ?`, [holder]);
        if (off) await sql.run(`INSERT INTO ${optout} (holder, at) VALUES (?, ?)`, [holder, at]);
      }),
  };
  return Object.freeze(store);
}
