/**
 * What one write costs a tenant's page, with its database 25 ms away.
 *
 * A field report: one write on a record page set off 65 to 112 requests
 * and took 11 to 32 seconds to settle, its PostgreSQL backends mostly idle in
 * transaction until the pool ran out. The page asked every list and count on
 * it again for every change, took the live echo of its own write for someone
 * else's and asked again, and every read snapshot walked the whole catalog
 * first. This holds the refresh to what the write can affect, once, in at most
 * two waves, the catalog digest to once per trust window, and every
 * transaction to its own statements (latencyProxy.ts reads them off the wire).
 */
import { expect, test, type Page } from './support/harness';
import { DEALERS, IGNITION_SKIP, startIgnition, type IgnitionFixture } from './support/ignitionServer';
import { enter, openRoom, openRow } from './support/ignitionSession';
import { startLatencyProxy, type LatencyProxy, type Statement } from './support/latencyProxy';

/** A statement that reads the catalog rather than the App's data. */
const CATALOG = /pg_catalog\.|\bpg_class\b|\bpg_roles\b|information_schema/;

/** The catalog digest (postgresCatalogDigest.ts), alone or inside the message that begins a snapshot. */
const DIGEST = /AS fingerprint FROM seen/;

interface Asked {
  path: string;
  start: number;
  end?: number;
  /** A batch's reads (tenantTransport.ts `batched`): asked in one moment, sent as one request. */
  reads?: string[];
}

/** Every API request from now on but the live stream, with when it went out and when it was answered. */
function record(page: Page): Asked[] {
  const asked: Asked[] = [];
  const open = new Map<object, Asked>();
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.includes('/api/') || url.pathname.endsWith('/api/live') || url.pathname.includes('/api/tenant/context/')) return;
    const batch = url.pathname.endsWith('/api/boot')
      ? (request.postDataJSON() as { reads?: Array<{ path: string }> } | null)?.reads
      : undefined;
    const entry: Asked = {
      path: url.pathname.replace(/^.*\/api\//, '/api/') + (url.search ? '?' + url.searchParams.get('app') : ''),
      start: Date.now(),
      ...(batch ? { reads: batch.map((read) => read.path.split('?')[0]) } : {}),
    };
    asked.push(entry);
    open.set(request, entry);
  });
  const done = (request: object) => {
    const entry = open.get(request);
    if (entry) entry.end = Date.now();
  };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  return asked;
}

/** Round-trip waves: a request is one wave after the latest wave answered before it went out. */
function waves(asked: Asked[]): number {
  const depth = new Map<Asked, number>();
  for (const entry of [...asked].sort((a, b) => a.start - b.start))
    depth.set(entry, 1 + Math.max(0, ...asked.filter((earlier) => earlier.end! <= entry.start).map((earlier) => depth.get(earlier) ?? 0)));
  return Math.max(0, ...depth.values());
}

/** Qualify the open lead, through the form when the command asks for one. */
async function qualify(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Qualify lead', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Qualify lead' });
  if (await form.isVisible().catch(() => false)) {
    await form.getByRole('button', { name: 'Qualify lead', exact: true }).click();
    await form.getByRole('button', { name: 'Done', exact: true }).click();
  }
}

/**
 * The flights a command request's own transaction took: the connection in the
 * request's window that fenced the tenant (every tenant write does, and the
 * background pollers never), and how many times it sent after hearing the
 * server ready again (latencyProxy.ts). Each flight is a round trip.
 */
function ownFlights(sent: Statement[], entry: Asked): { connection?: number; flights: number } {
  const inside = sent.filter((statement) => statement.at >= entry.start && statement.at <= entry.end!);
  const fencing = new Map<number, number>();
  for (const statement of inside)
    if (/(__mistri_|mistri\."?)tenant_(tenant|membership)/.test(statement.text))
      fencing.set(statement.connection, (fencing.get(statement.connection) ?? 0) + 1);
  const connection = [...fencing.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (connection === undefined) return { flights: 0 };
  return {
    connection,
    flights: new Set(inside.filter((statement) => statement.connection === connection).map((statement) => statement.flight)).size,
  };
}

interface Ahead {
  at: number;
  committed: boolean;
  sent: number;
  taken: number;
  answered: number;
  missed: number;
  left: string[];
  redone: number;
}

/* The round trips the save's own transaction may take: tightened as each step lands. */
const SAVE_FLIGHTS = 3;
/* The prepare's, the read that fills the form: 10, then 7 with the opening reads sent ahead, 4 once stores were attested
   at start, 2 with the record's row sent behind the BEGIN (commandPrepare.ts withPreparedAhead): the BEGIN's flight and
   the COMMIT's. */
const PREPARE_FLIGHTS = 2;

async function settle(asked: Asked[], quiet = 2500, timeout = 60_000): Promise<void> {
  const began = Date.now();
  for (;;) {
    const last = Math.max(0, ...asked.map((entry) => entry.end ?? Date.now()));
    if (asked.every((entry) => entry.end) && Date.now() - last > quiet) return;
    if (Date.now() - began > timeout) throw new Error('never settled');
    await new Promise((done) => setTimeout(done, 100));
  }
}

test.describe('a write on a tenant record page, 25 ms from its database', () => {
  test.skip(IGNITION_SKIP !== false, String(IGNITION_SKIP));
  test.setTimeout(240_000);
  let app: IgnitionFixture;
  let proxy: LatencyProxy;
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    proxy = await startLatencyProxy(process.env.TABLEWALK_TEST_PG!, 25);
    app = await startIgnition({ live: true, route: (url) => proxy.route(url), env: { MISTRI_AHEAD_REPORT: '1' } });
  });
  test.afterAll(async () => {
    await app?.stop();
    await proxy?.close();
  });

  test('qualify a lead', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await enter(page, app, app.account('dealer_admin', DEALERS.north).email, DEALERS.north);
    await openRoom(page, 'lead');
    /* A warm server: the first write after boot also reads what a write keeps
       for its epoch (the journal's and the scope's catalog, the tenant store's
       attestation), so another new lead is qualified first and the one measured
       is the second. */
    await openRow(page, 'L-2002', true);
    await qualify(page);
    await expect(page.getByRole('button', { name: 'Qualify lead', exact: true })).toHaveCount(0);
    await page.goBack();
    await openRow(page, 'L-2001', true);
    const seen = record(page);
    await settle(seen);
    const mark = seen.length;
    const clicked = Date.now();
    await qualify(page);
    await settle(seen);
    const asked = seen.slice(mark);
    const last = Math.max(...asked.map((entry) => entry.end!));
    const write = asked.findIndex((entry) => entry.path.startsWith('/api/commands/execute'));
    expect(write, 'the write went out').toBeGreaterThanOrEqual(0);
    /* What each write transaction sent ahead behind its BEGIN, and what it then
       asked (postgres.ts reportWriteAhead): `taken` answered from what was sent,
       `missed` asked in its own round trip, `left` sent and never asked, `redone`
       a sent-ahead failure that rolled back and began again without it. */
    const aheads = app
      .output()
      .split('\n')
      .filter((line) => line.startsWith('mistri-ahead '))
      .map((line) => JSON.parse(line.slice('mistri-ahead '.length)) as Ahead)
      .filter((report) => report.at >= clicked);
    const executed = ownFlights(proxy.statements(clicked), asked[write]).flights;
    const prepare = asked.findIndex((entry) => entry.path.startsWith('/api/commands/prepare'));
    const prepared = prepare < 0 ? undefined : ownFlights(proxy.statements(clicked), asked[prepare]).flights;
    const after = asked.slice(write + 1);
    const sent = proxy.statements(clicked);
    const digests = sent.filter((statement) => DIGEST.test(statement.text)).length;
    const held = proxy.heldOpen(clicked, 100);
    const shape = (text: string, params?: string[]) =>
      process.env.STORM_DETAIL === 'full'
        ? text.replace(/\s+/g, ' ') + (params?.length ? ` [${params.join(',')}]` : '')
        : text.replace(/\s+/g, ' ').slice(0, 70) + (CATALOG.test(text) && params?.length ? ` [${params.join(',').slice(0, 60)}]` : '');
    // What a failure needs to be read: every request, and what reached the database.
    console.log(
      JSON.stringify(
        {
          calls: asked.length,
          after: after.length,
          wavesAfter: waves(after),
          settleMs: last - clicked,
          paths: asked.map(
            (entry) =>
              `${entry.start - clicked}..${entry.end! - clicked} ${entry.path}${entry.reads ? ` [${entry.reads.join(', ')}]` : ''}`,
          ),
          statements: sent.length,
          catalog: sent.filter((statement) => CATALOG.test(statement.text)).length,
          digests,
          held: held.map((wait) => `${wait.waited}ms after ${shape(wait.after)} -> ${shape(wait.next)}`),
          aheads,
          /* Round trips each command request's own transaction took, and its time. */
          flights: Object.fromEntries(
            asked
              .filter((entry) => entry.path.startsWith('/api/commands/'))
              .map((entry) => [entry.path, { flights: ownFlights(sent, entry).flights, ms: entry.end! - entry.start }]),
          ),
          /* What each command request sent, by connection: the background pollers
             ride their own, so the request's are the busy ones. */
          during: Object.fromEntries(
            asked
              .filter((entry) => entry.path.startsWith('/api/commands/'))
              .map((entry) => {
                const by: Record<number, string[]> = {};
                for (const statement of sent)
                  if (statement.at >= entry.start && statement.at <= entry.end!)
                    (by[statement.connection] ??= []).push(
                      `+${statement.at - entry.start} f${statement.flight} ${shape(statement.text, statement.params)}`,
                    );
                return [
                  entry.path,
                  process.env.STORM_DETAIL ? by : Object.fromEntries(Object.entries(by).map(([id, list]) => [id, list.length])),
                ];
              }),
          ),
        },
        null,
        1,
      ),
    );
    /* Before: the echo of the page's own write asked the record page again (a second compose), forgot the first
       compose's answers so each section asked on its own, and every list and count on the page was asked again for
       every change: 11 requests in 4 waves after the write, and the catalog digest in each of their 53 snapshots. */
    expect(
      after.flatMap((entry) => entry.reads ?? [entry.path]).filter((path) => path.startsWith('/api/pages/compose')),
      'the record page composed once',
    ).toHaveLength(1);
    expect(after.length, after.map((entry) => entry.path).join(', ')).toBeLessThanOrEqual(3);
    expect(waves(after), 'the refresh settles in at most two waves').toBeLessThanOrEqual(2);
    expect(digests, 'the catalog digest is read once per trust window, not per snapshot').toBeLessThanOrEqual(8);
    expect(held, 'no transaction waits on anything but its own statements').toEqual([]);
    /* The save's own round trips: 32; 14 once its opening reads and locks rode
       behind the BEGIN (the fence, the receipt lookup, the target locked and read
       once in full, every later read of it by key answered from that row); 6 once
       the read after the write left with the write, and the receipt, its audit
       and the live change with the final fence; 3 once runtime stores were
       attested when opened, not at each fence, and the fence before COMMIT
       became local: BEGIN and its reads, the write and its read, COMMIT. */
    expect(executed, 'the save takes its round trips').toBeLessThanOrEqual(SAVE_FLIGHTS);
    if (prepared !== undefined) expect(prepared, 'the prepare takes its round trips').toBeLessThanOrEqual(PREPARE_FLIGHTS);
    const saved = aheads.filter((report) => report.committed);
    expect(saved.length, 'the save reported what it sent ahead').toBeGreaterThanOrEqual(1);
    for (const report of saved) {
      expect(report.left, 'everything sent ahead was asked').toEqual([]);
      expect(report.redone, 'nothing sent ahead failed').toBe(0);
    }
  });
});
