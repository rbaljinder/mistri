/**
 * A resource's `noOverlap` and `constraints` (shared/appDataRules.ts, server/app/appDataRules.ts), on the clinic
 * fixture's room bookings, a tenant App served as a deployment serves it, on SQLite and on PostgreSQL: one room, one
 * time, within a clinic. A booking that meets another is refused beside `starts_at` in the App's words, through a
 * command and through an edit; one that only touches another, a cancelled one and another clinic's are not in the
 * way. On PostgreSQL the rule is the database's exclusion constraint, so of several commands that each find the
 * room free, exactly one commits.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { liveSkip } from './live.js';
import { startClinic, type Engine } from './support/clinicFixture.ts';

const LIVE = process.env.TABLEWALK_TEST_PG;
const TAKEN = 'That room is taken then.';

async function evidence(t: TestContext, engine: Engine) {
  const { host } = await startClinic(t, engine);
  const north = await host.tenant('north', { roles: ['owner'] });
  const south = await host.tenant('south', { roles: ['reception'] });
  const book = (as: typeof north, room: string, from: string, to: string) =>
    as.command(
      'bookRoom',
      {},
      {
        room,
        starts_at: `2026-11-02 ${from}:00`,
        ends_at: `2026-11-02 ${to}:00`,
      },
    );
  const refusedAsTaken = (result: Awaited<ReturnType<typeof book>>) => {
    assert.equal(result.ok, false, JSON.stringify(result));
    if (result.ok) return;
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(result.code, 'invalid_input');
    assert.equal(result.field, 'starts_at');
    assert.equal(result.message, TAKEN);
    // Fixed words and a field: nothing of the booking it met, in a tenant App as anywhere.
    assert.doesNotMatch(JSON.stringify(result.body), /rb-north-1|09:00|constraint/);
  };

  await t.test("a command whose booking meets another is refused beside its start, in the rule's words", async () => {
    // The seed holds room A from nine to ten in each clinic.
    refusedAsTaken(await book(north, 'A', '09:30', '10:30'));
    refusedAsTaken(await book(north, 'A', '08:00', '11:00'));
    const rows = await north.rows('room_booking');
    assert.ok(rows.ok);
    assert.equal(rows.value.length, 1);
  });

  await t.test('a range is half-open, the rule is per room, and per clinic', async () => {
    const after = await book(north, 'A', '10:00', '11:00');
    assert.ok(after.ok, after.ok ? '' : after.message);
    const before = await book(north, 'A', '08:00', '09:00');
    assert.ok(before.ok, before.ok ? '' : before.message);
    const other = await book(north, 'B', '09:00', '10:00');
    assert.ok(other.ok, other.ok ? '' : other.message);
    // Another clinic's room A at eleven is no concern of north's ten-to-eleven... and north's is none of south's.
    const theirs = await book(south, 'A', '10:00', '11:00');
    assert.ok(theirs.ok, theirs.ok ? '' : theirs.message);
    refusedAsTaken(await book(south, 'A', '10:30', '10:45'));
  });

  await t.test("an edit meets the same rule, and a cancelled booking is in nobody's way", async () => {
    const rows = await north.rows('room_booking', { where: 'room = B' });
    assert.ok(rows.ok && rows.value.length === 1);
    const key = { id: String(rows.value[0]!.id) };
    // Moved into room A at nine, which the seed's booking holds.
    const moved = await north.update('room_booking', key, { room: 'A' });
    assert.equal(moved.ok, false);
    assert.ok(!moved.ok && moved.status === 422 && moved.code === 'validation_failed', JSON.stringify(moved));
    assert.equal(moved.ok ? undefined : moved.field, 'starts_at');
    assert.match(JSON.stringify(moved.ok ? '' : moved.body), /That room is taken then\./);
    // An edit that writes nothing the rule reads is not judged by it.
    const cancelled = await north.update('room_booking', { id: 'rb-north-1' }, { status: 'cancelled' });
    assert.ok(cancelled.ok, cancelled.ok ? '' : cancelled.message);
    const again = await north.update('room_booking', key, { room: 'A' });
    assert.ok(again.ok, again.ok ? '' : again.message);
    // And bringing the cancelled one back is refused: its slot is taken now.
    const back = await north.update('room_booking', { id: 'rb-north-1' }, { status: 'booked' });
    assert.equal(back.ok, false);
    assert.equal(back.ok ? undefined : back.field, 'starts_at');
  });

  await t.test("a constraint the App named is said as its field's refusal", async () => {
    const backwards = await book(north, 'C', '15:00', '14:00');
    assert.equal(backwards.ok, false);
    if (backwards.ok) return;
    assert.equal(backwards.code, 'invalid_input', JSON.stringify(backwards.body));
    assert.equal(backwards.field, 'ends_at');
    assert.equal(backwards.message, 'A booking ends after it starts.');
  });

  await t.test('of several commands that each find the room free, one commits', async () => {
    const tries = await Promise.all(Array.from({ length: 6 }, () => book(north, 'D', '13:00', '14:00')));
    const applied = tries.filter((result) => result.ok);
    assert.equal(applied.length, 1, JSON.stringify(tries.map((result) => (result.ok ? 'applied' : result.body))));
    for (const result of tries.filter((each) => !each.ok)) refusedAsTaken(result);
    const rows = await north.rows('room_booking', { where: 'room = D' });
    assert.ok(rows.ok);
    assert.equal(rows.value.length, 1);
  });
}

test('room bookings on SQLite do not overlap', { timeout: 240000 }, (t) => evidence(t, 'sqlite'));
test('room bookings on PostgreSQL do not overlap, under several writers', { skip: liveSkip('postgres', LIVE), timeout: 240000 }, (t) =>
  evidence(t, 'postgres'),
);

/* The declared rule and the database must agree before the App serves: a PostgreSQL table without the constraint
   the rule needs is an App that does not load, so the rule cannot hold on SQLite in development and be nothing at
   all where it is hosted. */
test(
  'on PostgreSQL an App whose noOverlap has no matching constraint does not start',
  { skip: liveSkip('postgres', LIVE), timeout: 240000 },
  async (t) => {
    const work = mkdtempSync(join(resolve('test'), '.no-overlap-'));
    t.after(() => rmSync(work, { recursive: true, force: true }));
    const app = join(work, 'clinic');
    cpSync(resolve('test/fixtures/apps/clinic'), app, { recursive: true });
    const file = join(app, 'resources.ts');
    const text = readFileSync(file, 'utf8');
    assert.ok(text.includes("when: 'status != cancelled', "));
    // The rule without its `when`: the seed's constraint holds only bookings not cancelled, which is another rule.
    writeFileSync(file, text.replace("when: 'status != cancelled', ", ''));
    await assert.rejects(
      () => startClinic(t, 'postgres', { app }),
      (error: Error) => {
        assert.match(error.message, /\[no-overlap-constraint\]/);
        assert.match(error.message, /holds only WHERE .*cancelled.*and the rule has no "when"/);
        // The statement to run, whole, with the tenant's column in it.
        assert.match(
          error.message,
          /ALTER TABLE room_booking ADD CONSTRAINT room_booking_no_overlap EXCLUDE USING gist \(clinic_id WITH =, room WITH =, tsrange\(starts_at, ends_at\) WITH &&\);/,
        );
        return true;
      },
    );
  },
);
