/**
 * The host's own JSON route (host/schedule.ts), on its own: no mistri server, only the seeded database and Node's
 * `http`, as the school's repository would test a module of its own.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seed } from '../../../databases/ladle/seed.mjs';
import { scheduleRoute, upcomingClasses } from '../host/schedule.ts';

/* The seed's day, and a moment on it in Chicago: 5 PM CDT, before tonight's 6:30 PM class. */
const TODAY = '2026-09-14';
const EVENING = new Date('2026-09-14T22:00:00Z');

const directory = mkdtempSync(join(tmpdir(), 'ladle-schedule-'));
const file = seed(join(directory, 'ladle.db'), { today: TODAY, stores: false });
after(() => rmSync(directory, { recursive: true, force: true }));

describe('the schedule', () => {
  test('lists the scheduled classes not yet started, soonest first, with the seats a booking has not taken', () => {
    const classes = upcomingClasses(file, EVENING);
    assert.deepEqual(
      classes.map((lesson) => lesson.title),
      [
        'Fresh pasta by hand',
        'Dumplings from scratch',
        'Sourdough, start to loaf',
        'Tacos al pastor',
        'Weekend brunch',
        'Curry from the spice box',
        'Knife skills for weeknights',
        'French pastry: choux',
      ],
      'last week’s class is gone',
    );
    // Tonight's pasta: ten seats, parties of 2, 1, 3 and 2 booked, one of 1 cancelled.
    assert.deepEqual(classes[0], {
      id: 2,
      title: 'Fresh pasta by hand',
      cuisine: 'Italian',
      chef: 'Marco Bellini',
      startsAt: '2026-09-14 18:30:00',
      price: 85,
      seatsLeft: 2,
    });
    // Nothing a guest wrote leaves through it.
    assert.ok(classes.every((lesson) => !JSON.stringify(lesson).includes('@')));
  });

  test('drops a class once it has started, or once it is cancelled', () => {
    const later = new Date('2026-09-15T00:00:00Z'); // 7 PM in Chicago
    assert.equal(upcomingClasses(file, later)[0].title, 'Dumplings from scratch');
    const db = new DatabaseSync(file);
    try {
      db.prepare("UPDATE class_session SET status = 'cancelled' WHERE id = 3").run();
    } finally {
      db.close();
    }
    assert.equal(upcomingClasses(file, later)[0].title, 'Sourdough, start to loaf');
  });

  test('never reports fewer than no seats', () => {
    const db = new DatabaseSync(file);
    try {
      db.prepare('UPDATE class_session SET seats = 1 WHERE id = 4').run();
    } finally {
      db.close();
    }
    assert.equal(upcomingClasses(file, EVENING).find((lesson) => lesson.id === 4)?.seatsLeft, 0);
  });
});

describe('the route', () => {
  let server: Server;
  let origin = '';
  before(async () => {
    const route = scheduleRoute(file, () => EVENING);
    server = createServer((req, res) => route(req, res));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(() => new Promise<void>((done) => server.close(() => done())));

  test('answers GET with JSON a page may cache for a minute', async () => {
    const reply = await fetch(`${origin}/schedule.json`);
    assert.equal(reply.status, 200);
    assert.match(reply.headers.get('content-type') ?? '', /^application\/json/);
    assert.equal(reply.headers.get('cache-control'), 'public, max-age=60');
    const body = (await reply.json()) as { classes: Array<{ id: number }> };
    assert.equal(body.classes[0].id, 2);
  });

  test('answers HEAD without a body, and refuses a write', async () => {
    const head = await fetch(`${origin}/schedule.json`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const post = await fetch(`${origin}/schedule.json`, { method: 'POST', body: '{}' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
  });
});
