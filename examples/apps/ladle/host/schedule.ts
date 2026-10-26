/**
 * The school's public schedule as JSON, `GET /schedule.json`: the host's own code, not a mistri command.
 *
 * The public site needs one small read the staff App has no reason to own — the classes still to come and how many
 * seats each has left — so the host answers it from the same database with a driver of its own (here Node's SQLite,
 * read-only). It is mounted beside the mistri handler in server.ts and tested on its own (tests/schedule.test.ts).
 * Nothing private leaves: no guest, no email, only what the school prints on its own posters.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

export interface ScheduledClass {
  id: number;
  title: string;
  cuisine: string;
  chef: string;
  /** The school's wall clock, `YYYY-MM-DD HH:MM:SS`, as the database keeps it. */
  startsAt: string;
  /** US dollars. */
  price: number;
  seatsLeft: number;
}

/* The school's wall clock, the App's `ui.timezone`: a class that started an hour ago in Chicago is no longer on sale. */
const wall = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** The scheduled classes that have not started by `now`, soonest first, with the seats a booking has not taken. */
export function upcomingClasses(file: string, now: Date = new Date()): ScheduledClass[] {
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
  try {
    const rows = db
      .prepare(
        `SELECT c.id, c.title, c.cuisine, c.chef, c.starts_at, c.price,
                c.seats - COALESCE((SELECT SUM(b.party_size) FROM booking b
                                    WHERE b.class_session_id = c.id AND b.status != 'cancelled'), 0) AS seats_left
           FROM class_session c
          WHERE c.status = 'scheduled' AND c.starts_at > ?
          ORDER BY c.starts_at, c.id
          LIMIT 50`,
      )
      .all(wall.format(now)) as Array<Record<string, string | number>>;
    return rows.map((row) => ({
      id: Number(row.id),
      title: String(row.title),
      cuisine: String(row.cuisine),
      chef: String(row.chef),
      startsAt: String(row.starts_at),
      price: Number(row.price),
      seatsLeft: Math.max(0, Number(row.seats_left)),
    }));
  } finally {
    db.close();
  }
}

/** The route: GET (or HEAD) answers the schedule; anything else is refused. `now` is for a test's clock. */
export function scheduleRoute(file: string, now: () => Date = () => new Date()) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Only GET.' }));
      return;
    }
    const body = JSON.stringify({ classes: upcomingClasses(file, now()) });
    // A minute is fresh enough for a poster, and spares the database a read per visitor.
    res
      .writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' })
      .end(req.method === 'HEAD' ? undefined : body);
  };
}
