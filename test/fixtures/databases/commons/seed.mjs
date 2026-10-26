/**
 * The Commons fixture: a makers' forum with nine boards, thirty-six members,
 * forty-odd threads and their replies over the last eight months, reactions,
 * tags, photos of finished projects, and a moderation queue with something in
 * it — spam held for review, open reports, a warned member. Deterministic
 * for a given day: every date is counted back from it.
 *
 *   node --import tsx test/fixtures/databases/commons/seed.mjs <new-file.db>
 *
 * The day is today in New York, the forum's, or `COMMONS_TODAY=YYYY-MM-DD`. Writes the database
 * and `<file>.json`, a writable connection named `commons`: members' posts
 * and reactions, readers' reports and moderators' decisions are commands that write
 * through it, and the App's grants keep every other write off. The command
 * journal, the record history the posts and threads keep and the store the
 * members' notifications are kept in are provisioned into the new file at once. Refuses an existing file or config.
 *
 * `seed-postgres.mjs` copies the file this writes into PostgreSQL.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrateSqliteCommandJournal } from '@mistriwork/mistri/maintenance';
import { provisionStores } from '@mistriwork/mistri/maintenance';
import { seedHistory } from './history.mjs';
import { shopToday } from './clock.mjs';
import { BOARDS, CHATTER, MEMBERS, TAGS, THREADS, WITH_AVATAR } from './community.mjs';
import { renderAvatar, renderBench, renderProject } from './images.mjs';

/* The shape, in the order a foreign key needs. Kept as data so the PostgreSQL
   copy can name the same tables in the same order. */
export const SCHEMA = `
  CREATE TABLE board(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL, position INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','read_only')), created_on DATE NOT NULL);
  CREATE TABLE member(id INTEGER PRIMARY KEY, handle TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
    account_id TEXT UNIQUE, email TEXT UNIQUE, team TEXT NOT NULL DEFAULT 'member' CHECK(team IN ('member','moderator','admin')),
    standing TEXT NOT NULL DEFAULT 'active' CHECK(standing IN ('active','warned','suspended')),
    location TEXT, bio TEXT, website TEXT, reputation INTEGER NOT NULL DEFAULT 0, joined_on DATE NOT NULL,
    version INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE member_avatar(id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL UNIQUE REFERENCES member(id),
    file_name TEXT NOT NULL, content_type TEXT NOT NULL, byte_size INTEGER NOT NULL, data BLOB NOT NULL);
  CREATE TABLE thread(id INTEGER PRIMARY KEY, board_id INTEGER NOT NULL REFERENCES board(id),
    author_id INTEGER NOT NULL REFERENCES member(id), title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','held','locked','removed')),
    pinned BOOLEAN NOT NULL DEFAULT 0, created_at TIMESTAMP NOT NULL, version INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE post(id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL REFERENCES thread(id),
    author_id INTEGER NOT NULL REFERENCES member(id), body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('published','held','hidden')),
    opening BOOLEAN NOT NULL DEFAULT 0, created_at TIMESTAMP NOT NULL, edited_at TIMESTAMP,
    version INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE post_image(id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES post(id),
    thread_id INTEGER NOT NULL REFERENCES thread(id), position INTEGER NOT NULL, caption TEXT NOT NULL,
    file_name TEXT NOT NULL, content_type TEXT NOT NULL, byte_size INTEGER NOT NULL, data BLOB NOT NULL, thumbnail BLOB);
  CREATE TABLE post_revision(id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES post(id),
    body TEXT NOT NULL, replaced_at TIMESTAMP NOT NULL);
  CREATE TABLE removal(id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES post(id),
    reason TEXT NOT NULL CHECK(reason IN ('spam','harassment','off_topic','misinformation','other')),
    body TEXT NOT NULL, note TEXT, removed_by TEXT, removed_at TIMESTAMP NOT NULL);
  CREATE TABLE reaction(id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES post(id),
    member_id INTEGER NOT NULL REFERENCES member(id),
    kind TEXT NOT NULL CHECK(kind IN ('like','thanks','helpful','laugh')), created_at TIMESTAMP NOT NULL,
    UNIQUE(post_id, member_id, kind));
  CREATE TABLE tag(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
    tone TEXT NOT NULL DEFAULT 'neutral' CHECK(tone IN ('good','warn','bad','info','neutral')));
  CREATE TABLE thread_tag(id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL REFERENCES thread(id),
    tag_id INTEGER NOT NULL REFERENCES tag(id), UNIQUE(thread_id, tag_id));
  CREATE TABLE report(id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES post(id),
    reason TEXT NOT NULL CHECK(reason IN ('spam','harassment','off_topic','misinformation','other')), details TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','actioned','dismissed')),
    created_at TIMESTAMP NOT NULL, resolved_at TIMESTAMP, resolution TEXT, version INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE warning(id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES member(id),
    reason TEXT NOT NULL CHECK(reason IN ('spam','harassment','off_topic','misinformation','other')),
    note TEXT NOT NULL, issued_by TEXT, issued_at TIMESTAMP NOT NULL);
  CREATE TABLE site_image(id INTEGER PRIMARY KEY, name TEXT NOT NULL, file_name TEXT NOT NULL,
    content_type TEXT NOT NULL, byte_size INTEGER NOT NULL, data BLOB NOT NULL);
  -- The references a record's lists find their rows by (mistri check names each).
  CREATE INDEX thread_board ON thread(board_id);
  CREATE INDEX thread_author ON thread(author_id);
  CREATE INDEX post_thread ON post(thread_id);
  CREATE INDEX post_author ON post(author_id);
  CREATE INDEX post_image_thread ON post_image(thread_id);
  CREATE INDEX post_image_post ON post_image(post_id);
  CREATE INDEX post_revision_post ON post_revision(post_id);
`;
export const TABLES = [
  'board',
  'member',
  'member_avatar',
  'thread',
  'post',
  'post_image',
  'post_revision',
  'removal',
  'reaction',
  'tag',
  'thread_tag',
  'report',
  'warning',
  'site_image',
];

/* A tiny deterministic generator, so every seed of one day is the same forum. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** The development mail service: each message, a sign-up's confirmation link among them, is one line in the server's log. */
export const mail = { name: 'mail', kind: 'email', url: 'log:', from: 'Commons <no-reply@example.test>' };

const DAY = 86_400_000;
/* The forum's wall clock, New York's: the seed counts in wall milliseconds (its `now` is 17:00 of the day there, read
   as if it were UTC), so these write the clock as it stands. The record history turns a stamp into an instant by way of
   the zone (clock.mjs). */
const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Every row of the forum, by table, dated back from `today` (YYYY-MM-DD). */
export function community(today) {
  const rand = random(20260904);
  const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  // Late afternoon of the day, so "today" has its morning's posts in it.
  const now = Date.parse(`${today}T17:00:00Z`);
  const rows = Object.fromEntries(TABLES.map((table) => [table, []]));

  BOARDS.forEach((board, i) =>
    rows.board.push({
      id: i + 1,
      name: board.name,
      slug: board.slug,
      description: board.description,
      position: (i + 1) * 1024,
      status: board.status,
      created_on: day(now - 250 * DAY),
    }),
  );
  const boardId = Object.fromEntries(BOARDS.map((board, i) => [board.slug, i + 1]));

  const memberId = Object.fromEntries(MEMBERS.map(([handle], i) => [handle, i + 1]));
  const firstPost = {};
  TAGS.forEach(([name, tone], i) => rows.tag.push({ id: i + 1, name, tone }));
  const tagId = Object.fromEntries(TAGS.map(([name], i) => [name, i + 1]));

  let postId = 0;
  const posts = [];
  const addPost = (thread, handle, body, at, extra = {}) => {
    const post = {
      id: ++postId,
      thread_id: thread.id,
      author_id: memberId[handle],
      body,
      status: 'published',
      opening: 0,
      created_at: stamp(at),
      edited_at: null,
      ...extra,
    };
    posts.push(post);
    firstPost[handle] = Math.min(firstPost[handle] ?? Infinity, at);
    return post;
  };

  // Oldest first, so ids read in the order the forum grew.
  const ordered = [...THREADS].sort((a, b) => b[5].days - a[5].days);
  const threadOf = {};
  const readers = {};
  ordered.forEach(([board, author, title, opening, replies, extra], i) => {
    const started = now - extra.days * DAY - between(1, 9) * 3_600_000 - between(0, 59) * 60_000;
    const thread = {
      id: i + 1,
      board_id: boardId[board],
      author_id: memberId[author],
      title,
      status: extra.locked ? 'locked' : 'open',
      pinned: extra.pinned ? 1 : 0,
      created_at: stamp(started),
    };
    rows.thread.push(thread);
    threadOf[title] = thread;
    readers[thread.id] = extra.readers;
    const first = addPost(thread, author, opening, started, { opening: 1 });
    (extra.tags ?? []).forEach((tag) => rows.thread_tag.push({ id: rows.thread_tag.length + 1, thread_id: thread.id, tag_id: tagId[tag] }));
    (extra.photos ?? []).forEach(([kind, caption], position) => {
      const { photo, thumb } = renderProject(kind, thread.id * 10 + position);
      rows.post_image.push({
        id: rows.post_image.length + 1,
        post_id: first.id,
        thread_id: thread.id,
        position: position + 1,
        caption,
        file_name: `${title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 40)}-${position + 1}.png`,
        content_type: 'image/png',
        byte_size: photo.byteLength,
        data: photo,
        thumbnail: thumb,
      });
    });
    // Replies follow the opening post by hours, then days; none lands in the future.
    let at = started;
    const all = [...replies];
    if (extra.readers >= 25) {
      for (let n = between(1, 3); n > 0; n--) {
        const handle = MEMBERS[between(4, MEMBERS.length - 3)][0];
        all.splice(between(1, all.length), 0, [handle, CHATTER[between(0, CHATTER.length - 1)]]);
      }
    }
    for (const [handle, body] of all) {
      const room = Math.max(1, (now - at) / (all.length + 1));
      at = Math.min(now - 60_000 * between(5, 90), at + Math.max(1_200_000, Math.min(room, between(1, 30) * 3_600_000)));
      addPost(thread, handle, body, at);
    }
    if (extra.spam) {
      first.status = 'held';
      thread.status = 'held';
    }
  });

  /* The moderation queue's contents, beside the ordinary posts. */
  const at = (days, hours = 0) => now - days * DAY - hours * 3_600_000;
  // Spam replies caught by the filter and held for a moderator.
  const heldSpam = [
    addPost(
      threadOf['Weather station, version three'],
      'deals',
      'Great build!! Get 80% off sensors and solar panels at my store, link in my profile. Today only!',
      at(0, 5),
      { status: 'held' },
    ),
    addPost(
      threadOf['What is the one tool you would save in a fire?'],
      'deals',
      'Soldering stations 80% off, best prices online, message me now for the list!!!',
      at(1, 3),
      { status: 'held' },
    ),
  ];
  // Earlier spam, already removed: its words are kept only in the moderators' record.
  const removedBody = 'Wholesale filament from the factory, all colors, cheapest prices online. Message me for a price list.';
  const removed = addPost(threadOf['Stringing everywhere on PETG'], 'deals', 'This post was removed by the moderators.', at(18, 2), {
    status: 'hidden',
  });
  rows.removal.push({
    id: 1,
    post_id: removed.id,
    reason: 'spam',
    body: removedBody,
    note: 'Advertising in a help thread. Account suspended.',
    removed_by: null,
    removed_at: stamp(at(18, 1)),
  });
  // A member who was warned, and whose next reply waits for review.
  const unkind = addPost(
    threadOf['Why does my op-amp oscillate?'],
    'felix',
    'Honestly, this is covered in every beginner guide. Read the datasheet before you post.',
    at(29, 20),
  );
  addPost(
    threadOf['Passive DI box: worth building?'],
    'felix',
    'Anyone who buys a commercial DI box is wasting their money, period. Build it or do not bother asking.',
    at(2, 6),
    { status: 'held' },
  );
  rows.warning.push({
    id: 1,
    member_id: memberId.felix,
    reason: 'harassment',
    issued_by: null,
    issued_at: stamp(at(26)),
    note: 'Two replies in a week talking down to people asking questions. Disagree with the idea, not the person.',
  });
  rows.warning.push({
    id: 2,
    member_id: memberId.deals,
    reason: 'spam',
    issued_by: null,
    issued_at: stamp(at(18)),
    note: 'Advertising in the Help Desk. Account suspended.',
  });

  // An author who tightened their post after publishing it: the moderators can read the first version.
  const weather = posts.find((post) => post.thread_id === threadOf['Weather station, version three'].id && post.opening);
  weather.edited_at = stamp(Date.parse(`${weather.created_at.replace(' ', 'T')}Z`) + 2 * 3_600_000);
  rows.post_revision.push({
    id: 1,
    post_id: weather.id,
    replaced_at: weather.edited_at,
    body: 'Version three of the weather station runs off a single 18650 and a small solar panel. It reports temperature, humidity, pressure and wind speed every five minutes over LoRa. More details soon.',
  });
  const guide = posts.find((post) => post.thread_id === threadOf['Tolerances for press-fit parts: a cheat sheet'].id && post.opening);
  guide.edited_at = stamp(Date.parse(`${guide.created_at.replace(' ', 'T')}Z`) + 26 * 3_600_000);
  rows.post_revision.push({
    id: 2,
    post_id: guide.id,
    replaced_at: guide.edited_at,
    body: guide.body.replace('0.3 mm clearance per side', '0.2 mm clearance per side'),
  });

  // Reports: open ones for the queue, and the history of ones already decided.
  // Reports are anonymous: the reader who sent one is not recorded.
  const report = (post, reason, details, hoursAfter, status = 'open', resolution = null) => {
    const created = Date.parse(`${post.created_at.replace(' ', 'T')}Z`) + hoursAfter * 3_600_000;
    rows.report.push({
      id: rows.report.length + 1,
      post_id: post.id,
      reason,
      details,
      status,
      created_at: stamp(Math.min(created, now - 600_000)),
      resolved_at: status === 'open' ? null : stamp(Math.min(created + 5 * 3_600_000, now - 300_000)),
      resolution,
    });
  };
  const spamThread = posts.find((post) => post.thread_id === threadOf['HUGE DISCOUNT on soldering stations, today only!!!'].id);
  report(spamThread, 'spam', 'Advertising, same account as before.', 1);
  report(spamThread, 'spam', null, 2);
  report(heldSpam[0], 'spam', 'Spam on my build thread.', 1);
  report(unkind, 'harassment', 'I did read the datasheet. This felt unkind.', 3);
  report(unkind, 'harassment', null, 5);
  report(removed, 'spam', null, 2, 'actioned', 'Removed as spam; account suspended.');
  report(removed, 'spam', 'Advertising in a help thread.', 3, 'actioned', 'Removed as spam; account suspended.');
  const patch = posts.find((post) => post.thread_id === threadOf['Patch of the week: generative ambient'].id && post.opening);
  report(patch, 'off_topic', 'Is this really about building synths?', 20, 'dismissed', 'On topic: patching is part of the board.');
  const lounge = posts.find(
    (post) => post.thread_id === threadOf['What is the one tool you would save in a fire?'].id && post.body.includes('hot glue'),
  );
  report(lounge, 'other', 'Just a joke, I think, but flagging in case.', 30, 'dismissed', 'A joke.');
  const fuzz = posts.find((post) => post.thread_id === threadOf['Fuzz pedal from an old schematic, with a twist'].id && post.opening);
  report(
    fuzz,
    'misinformation',
    'Silicon transistors in that circuit need different bias resistors than it says.',
    40,
    'dismissed',
    'A disagreement about bias values, not misinformation. Replied in thread.',
  );

  // Reactions: more on the threads more people read, the most on the opening post.
  const kinds = ['like', 'like', 'like', 'thanks', 'helpful'];
  const received = {};
  for (const post of posts) {
    if (post.status !== 'published') continue;
    const reach = readers[post.thread_id] ?? 5;
    const board = rows.thread[post.thread_id - 1].board_id;
    const count = Math.floor(rand() * reach * (post.opening ? 0.55 : 0.18));
    const seen = new Set();
    for (let n = 0; n < count; n++) {
      const who = between(1, MEMBERS.length - 2);
      const kind = board === boardId.lounge && rand() > 0.6 ? 'laugh' : kinds[between(0, kinds.length - 1)];
      if (who === post.author_id || seen.has(`${who}:${kind}`)) continue;
      seen.add(`${who}:${kind}`);
      const posted = Date.parse(`${post.created_at.replace(' ', 'T')}Z`);
      rows.reaction.push({
        id: rows.reaction.length + 1,
        post_id: post.id,
        member_id: who,
        kind,
        created_at: stamp(Math.min(now - 60_000, posted + between(10, 2000) * 60_000)),
      });
      received[post.author_id] = (received[post.author_id] ?? 0) + 1;
    }
  }

  MEMBERS.forEach(([handle, name, team, location, bio, website], i) => {
    const joined = Math.min(firstPost[handle] ?? now - between(3, 40) * DAY, now) - between(4, 60) * DAY;
    rows.member.push({
      id: i + 1,
      handle,
      display_name: name,
      account_id: null,
      email: null,
      team,
      standing: handle === 'deals' ? 'suspended' : handle === 'felix' ? 'warned' : 'active',
      location,
      bio,
      website,
      reputation: received[i + 1] ?? 0,
      joined_on: day(joined),
    });
    if (WITH_AVATAR.has(handle)) {
      const png = renderAvatar(i * 31 + 5);
      rows.member_avatar.push({
        id: rows.member_avatar.length + 1,
        member_id: i + 1,
        file_name: `${handle}.png`,
        content_type: 'image/png',
        byte_size: png.byteLength,
        data: png,
      });
    }
  });
  rows.post = posts;
  const bench = renderBench();
  rows.site_image.push({
    id: 1,
    name: 'Front page',
    file_name: 'commons-bench.png',
    content_type: 'image/png',
    byte_size: bench.byteLength,
    data: bench,
  });
  return rows;
}

export async function seed(file, today = process.env.COMMONS_TODAY ?? shopToday()) {
  file = resolve(file);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error('COMMONS_TODAY is a day: YYYY-MM-DD.');
  if (existsSync(file) || existsSync(`${file}.json`)) throw new Error(`Refusing to replace ${file}. Choose a new database path.`);
  mkdirSync(dirname(file), { recursive: true });
  const rows = community(today);
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA foreign_keys=ON; ${SCHEMA} BEGIN;`);
    for (const table of TABLES) {
      const list = rows[table];
      if (!list.length) continue;
      const columns = Object.keys(list[0]);
      const insert = db.prepare(`INSERT INTO ${table}(${columns.join(', ')}) VALUES(${columns.map(() => '?').join(', ')})`);
      for (const row of list) insert.run(...columns.map((column) => row[column]));
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  migrateSqliteCommandJournal(file);
  await provisionStores({ sqlite: file }, { only: ['record-history', 'inbox'] });
  // The week's threads and replies, as the App would have recorded them (history.mjs).
  seedHistory(file, today);
  // Open sign-up proves an address before `me` and the inbox find a member: the
  // confirmation link goes to the server's log here, and to a real mail service in production.
  writeFileSync(`${file}.json`, `${JSON.stringify({ connections: [{ name: 'commons', url: file, writable: true }, mail] }, null, 2)}\n`, {
    flag: 'wx',
  });
  return file;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw new Error('Usage: node --import tsx test/fixtures/databases/commons/seed.mjs <new-file.db>');
  console.log(await seed(process.argv[2]));
}
