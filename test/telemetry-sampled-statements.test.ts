/**
 * Which statements open a span (adapters/telemetry/drivers.ts, trace.ts). An ordinary statement is a span inside any
 * trace; a PRAGMA or a catalog read — the engine's own checks, which run by the dozen around every command, and
 * each cost two random ids even in a trace the exporter drops (a field report) — is a span only inside a *sampled*
 * trace; and outside any span, which is startup's catalog reads and nobody's trace, none is.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { instrumentDrivers, instrumentPg } from '../packages/engine/src/adapters/telemetry/drivers.js';
import { addSink, inSpan, setSampler, startSpan, type SpanRecord } from '../packages/engine/src/adapters/telemetry/trace.js';

const statements: SpanRecord[] = [];
const remove = addSink({
  onEnd(span) {
    if (span.attributes['db.system.name']) statements.push(span);
  },
});
instrumentDrivers();
/* pg's client, over one that answers without a server: the same wrapper node:sqlite's has, on the other dialect. */
class FakeClient {
  query(_text: string): Promise<unknown> {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
}
instrumentPg({ Client: FakeClient as never });
after(() => {
  remove();
  setSampler(() => true);
});

/** The summaries of the statements a run opens a span for. */
async function opened(
  sampled: boolean | 'outside',
  run: (sqlite: DatabaseSync, pg: FakeClient) => Promise<void> | void,
): Promise<string[]> {
  statements.length = 0;
  setSampler(() => sampled === true);
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE job(id INTEGER PRIMARY KEY, title TEXT)');
  statements.length = 0;
  try {
    if (sampled === 'outside') await run(sqlite, new FakeClient());
    else await inSpan('request', { kind: 'server' }, () => run(sqlite, new FakeClient()));
  } finally {
    sqlite.close();
  }
  return statements.map((span) => span.attributes['db.query.summary'] as string);
}

const ordinary = async (sqlite: DatabaseSync, pg: FakeClient) => {
  sqlite.prepare('SELECT id FROM job WHERE id = ?').get(1);
  await pg.query('SELECT id FROM job WHERE id = $1');
};
const internal = async (sqlite: DatabaseSync, pg: FakeClient) => {
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.prepare('PRAGMA table_info(job)').all();
  sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all();
  sqlite.prepare('SELECT name FROM sqlite_master').all();
  await pg.query('SELECT relname FROM pg_catalog.pg_class');
  await pg.query('SELECT column_name FROM information_schema.columns');
};

test('a PRAGMA or a catalog read opens no span beneath an unsampled trace, on either dialect', async () => {
  assert.deepEqual(await opened(false, internal), []);
});

test('the same statements are spans beneath a sampled trace', async () => {
  const spans = await opened(true, internal);
  assert.equal(spans.length, 6, JSON.stringify(spans));
  assert.ok(
    spans.some((summary) => /PRAGMA/i.test(summary)),
    JSON.stringify(spans),
  );
});

test('an ordinary SELECT is a span whether or not the trace is sampled', async () => {
  for (const sampled of [false, true]) assert.equal((await opened(sampled, ordinary)).length, 2, `sampled: ${sampled}`);
});

test('an unsampled trace still holds the ordinary statements among the internal ones', async () => {
  const spans = await opened(false, async (sqlite, pg) => {
    await internal(sqlite, pg);
    await ordinary(sqlite, pg);
  });
  assert.equal(spans.length, 2, JSON.stringify(spans));
});

test('outside any span nothing is traced, internal or not, sampled or not (childOnly)', async () => {
  assert.deepEqual(
    await opened('outside', async (sqlite, pg) => {
      await ordinary(sqlite, pg);
      await internal(sqlite, pg);
    }),
    [],
  );
  setSampler(() => true);
  assert.equal(startSpan('x', { childOnly: true, sampledOnly: false }).recording, false);
  assert.equal(startSpan('x', { childOnly: true, sampledOnly: true }).recording, false);
});

test('sampledOnly is read at the span, not the statement: a sampled parent opens it, an unsampled one does not', () => {
  setSampler(() => false);
  inSpan('unsampled', {}, () => {
    assert.equal(startSpan('internal read', { childOnly: true, sampledOnly: true }).recording, false);
    const ordinarySpan = startSpan('ordinary read', { childOnly: true });
    assert.equal(ordinarySpan.recording, true);
    ordinarySpan.end();
  });
  setSampler(() => true);
  inSpan('sampled', {}, () => {
    const span = startSpan('internal read', { childOnly: true, sampledOnly: true });
    assert.equal(span.recording, true);
    span.end();
  });
});
