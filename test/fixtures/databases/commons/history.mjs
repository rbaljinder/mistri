/**
 * Commons's last week of record history, written from the seeded rows: the
 * threads started, the replies posted and the threads moderators locked, as
 * the App would have appended them in each write's own transaction (the
 * record history store, provisioned by `provisionSqliteRecordHistory`). It is
 * what the moderators' dashboard's activity feed and a post's History section
 * open on. A post's words are `audit.redact`ed (resources.ts), so its history
 * keeps that they were written and not what they said, as the App's does.
 * The seed makes no accounts, so each author is an address that reaches
 * nobody, from their handle, kept under the name they joined with: the name
 * a reader is shown, never the address.
 */
import { DatabaseSync } from 'node:sqlite';
import { wallInstant } from './clock.mjs';

const STORE = '__mistri_history_change';
const address = (handle) => `${handle}@commons.example.test`;
const instant = wallInstant;

export function seedHistory(file, today) {
  const db = new DatabaseSync(file);
  const since = new Date(`${today}T00:00:00Z`);
  since.setUTCDate(since.getUTCDate() - 7);
  const from = since.toISOString().replace('T', ' ').slice(0, 19);
  const now = new Date().toISOString();
  const rows = [];
  const add = (stamp, resource, id, kind, changes, [actor, name], action) => {
    const at = instant(stamp);
    if (at <= now)
      rows.push({
        at,
        resource,
        key: JSON.stringify({ id: String(id) }),
        kind,
        changes: JSON.stringify(changes),
        actor: address(actor),
        name,
        action,
      });
  };
  try {
    for (const t of db
      .prepare(`SELECT t.id, t.title, t.board_id, t.status, t.created_at, m.handle, m.display_name FROM thread t JOIN member m ON m.id = t.author_id
      WHERE t.created_at >= ?`)
      .all(from)) {
      add(
        t.created_at,
        'thread',
        t.id,
        'insert',
        [
          { c: 'title', a: t.title },
          { c: 'board_id', a: t.board_id },
          { c: 'status', a: 'open' },
        ],
        [t.handle, t.display_name],
        'Start a thread',
      );
    }
    for (const p of db
      .prepare(`SELECT p.id, p.thread_id, p.opening, p.created_at, m.handle, m.display_name FROM post p JOIN member m ON m.id = p.author_id
      WHERE p.created_at >= ? AND p.status = 'published' AND p.opening = 0`)
      .all(from)) {
      add(
        p.created_at,
        'post',
        p.id,
        'insert',
        [
          { c: 'thread_id', a: p.thread_id },
          { c: 'body', r: 1 },
          { c: 'status', a: 'published' },
        ],
        [p.handle, p.display_name],
        'Reply',
      );
    }
    rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const append = db.prepare(`INSERT INTO "${STORE}" (write_id, at, resource, key_json, kind, changes_json, actor, actor_name, via, action)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'app', ?)`);
    db.exec('BEGIN');
    rows.forEach((row, i) =>
      append.run(
        `seed-${String(i + 1).padStart(6, '0')}`,
        row.at,
        row.resource,
        row.key,
        row.kind,
        row.changes,
        row.actor,
        row.name,
        row.action,
      ),
    );
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  return rows.length;
}
