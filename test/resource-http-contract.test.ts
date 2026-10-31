import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Adapter } from '../packages/engine/src/adapters/adapter.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { ResourceHttpBody, ResourceHttpMode, ResourceHttpPath } from '../packages/engine/src/shared/resourceHttp.js';

// Exercise JSON from the real routes, not a cast or a product runtime validator.
// Request bodies are checked against the frozen shared contract; assertions below
// independently check wire keys, projection and observable database effects.
type Reply = { status: number; body: any };
type Fixture = {
  adapter: Adapter;
  other: Adapter;
  table: string;
  note: string;
  row(id?: number): Record<string, unknown> | undefined;
  call<P extends ResourceHttpPath>(path: P, body: ResourceHttpBody<P>): Promise<Reply>;
};
const secret = 'PRIVATE_HTTP_CONTRACT_DRIVER';

async function fixture(mode: ResourceHttpMode, run: (f: Fixture) => Promise<void>, sourceCeiling = false) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-http-contract-'));
  const owner = basename(directory);
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  const registry = new Registry();
  let server: Server | undefined;
  try {
    db.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE physical_team(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE physical_item(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
        team INTEGER REFERENCES physical_team(id), score INTEGER NOT NULL DEFAULT 7);
      CREATE TABLE physical_note(id INTEGER PRIMARY KEY, item INTEGER REFERENCES physical_item(id));
      INSERT INTO physical_team VALUES (1, 'North'), (2, 'South');
      INSERT INTO physical_item(id, name, team) VALUES (1, 'Alpha', 1), (2, 'Beta', 1), (3, 'Gamma', 2);
      INSERT INTO physical_note VALUES (1, 1);`);
    registry.add({ id: owner, name: owner, url: file, source: 'config', writable: true });
    if (sourceCeiling) db.exec(`ALTER TABLE physical_team ADD COLUMN private_note TEXT NOT NULL DEFAULT '${secret}';`);
    const adapter = (await registry.open(owner)).adapter;
    // Expose the capability before App adapters capture their supported methods.
    adapter.estimateCount = async () => undefined;
    let other = adapter;
    if (sourceCeiling) {
      const otherFile = join(directory, 'default.db');
      const otherDb = new DatabaseSync(otherFile);
      try {
        otherDb.exec(`CREATE TABLE physical_team(id INTEGER PRIMARY KEY, name TEXT, private_note TEXT);
          CREATE TABLE physical_item(id INTEGER PRIMARY KEY, name TEXT, team INTEGER REFERENCES physical_team(id), score INTEGER);
          CREATE TABLE physical_note(id INTEGER PRIMARY KEY, item INTEGER REFERENCES physical_item(id));
          INSERT INTO physical_team VALUES (1, 'WRONG_SOURCE', '${secret}');
          INSERT INTO physical_item VALUES (1, 'WRONG_SOURCE', 1, 99);`);
      } finally {
        otherDb.close();
      }
      registry.add({ id: `${owner}-default`, name: 'Default', url: otherFile, source: 'config', writable: false });
      other = (await registry.open(`${owner}-default`)).adapter;
      registry.setActive(`${owner}-default`);
    }
    const bind = (prefix: string) => ({
      [`${prefix}item`]: { physical: 'physical_item', ...(prefix ? {} : { access: 'write', delete: true }) },
      [`${prefix}team`]: { physical: 'physical_team' },
      [`${prefix}note`]: { physical: 'physical_note' },
    });
    const definition = parseAppConfig(
      {
        id: 'contract-app',
        name: 'Contract App',
        ...(sourceCeiling
          ? {
              sources: {
                main: { connection: `${owner}-default`, default: true },
                inventory: { connection: owner },
              },
            }
          : { connection: owner }),
        resources: { ...bind(''), ...(sourceCeiling ? bind('inventory.') : {}) },
        auth: {
          roles: {
            operator: {
              read: true,
              write: true,
              ...(sourceCeiling
                ? {
                    fields: {
                      'inventory.item': { read: ['id', 'name', 'team'] },
                      'inventory.team': { read: ['id', 'name'] },
                    },
                  }
                : {}),
            },
          },
        },
        views: { items: { kind: 'list', from: sourceCeiling ? 'inventory.item' : 'item' } },
        home: 'items',
        nav: ['items'],
      },
      'HTTP contract fixture',
    );
    const host: AppHost = {
      app: { path: join(directory, 'app.ts'), app: definition, pages: [], sources: {} },
      pages: [],
      auth: {
        spec: definition.auth!,
        store: 'unused',
        close: async () => {},
        handler: async () => {},
        session: async () => ({ id: 'contract-account', who: 'operator@example.test', role: 'operator' }),
      },
    };
    const bound = { host: '127.0.0.1', port: 0 };
    server = createApp({ registry, bound, ...(mode === 'app' ? { apps: [host] } : {}) });
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    await run({
      adapter,
      other,
      table: mode === 'app' ? (sourceCeiling ? 'inventory.item' : 'item') : 'physical_item',
      note: mode === 'app' ? 'note' : 'physical_note',
      row: (id = 2) => {
        const row = db.prepare('SELECT * FROM physical_item WHERE id = ?').get(id);
        return row ? { ...row } : undefined;
      },
      call: async (path, body) => {
        const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(5000),
          body: JSON.stringify({ ...(mode === 'app' ? { app: 'contract-app' } : { conn: owner }), ...body }),
        });
        return { status: response.status, body: await response.json() };
      },
    });
  } finally {
    if (server) {
      const closed = new Promise<void>((resolve) => server!.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
    await registry.closeAll();
    db.close();
    clearJournal(owner);
    rmSync(directory, { recursive: true, force: true });
  }
}

function keys(body: any, expected: readonly string[]) {
  assert.deepEqual(Object.keys(body).sort(), [...expected].sort(), JSON.stringify(body));
}
function success(reply: Reply) {
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.ok(!reply.body.errors?.length, JSON.stringify(reply.body));
  return reply.body;
}
function diagnostics(body: any) {
  assert.ok(Array.isArray(body.errors) && body.errors.length > 0, JSON.stringify(body));
  for (const error of body.errors) {
    assert.equal(typeof error.message, 'string');
    assert.ok(error.message.length > 0);
    assert.ok(Object.keys(error).every((key) => ['message', 'code', 'at', 'fields'].includes(key)));
    if ('at' in error) assert.equal(typeof error.at, 'number');
    for (const field of error.fields ?? []) assert.deepEqual(Object.keys(field).sort(), ['field', 'message']);
  }
  for (const field of ['rows', 'columns', 'applied', 'undoId']) assert.equal(Object.hasOwn(body, field), false);
}
function projection(body: any, mode: ResourceHttpMode, sql: boolean, explain = false) {
  assert.equal(Object.hasOwn(body, 'sql'), mode === 'db' && sql);
  assert.equal(Object.hasOwn(body, 'explain'), mode === 'db' && explain);
  if (mode === 'app') {
    assert.equal(Object.hasOwn(body, 'joins'), false);
    assert.doesNotMatch(JSON.stringify(body), /physical_|PRIVATE_HTTP_CONTRACT_DRIVER/);
  } else if (sql) {
    keys(body.sql, ['text', 'params']);
    assert.equal(typeof body.sql.text, 'string');
    assert.ok(Array.isArray(body.sql.params));
  }
}
function rows(body: any) {
  assert.ok(Array.isArray(body.columns));
  assert.ok(Array.isArray(body.rows));
  assert.equal(typeof body.ms, 'number');
  assert.ok(Number.isFinite(body.ms) && body.ms >= 0);
}
function publicHistory(body: any) {
  assert.equal(body.reverted, false);
  assert.ok(Array.isArray(body.writes));
  for (const entry of body.writes) {
    assert.ok(
      Object.keys(entry).every((key) =>
        ['id', 'kind', 'at', 'summary', 'by', 'revertible', 'reason', 'undoState', 'blocksUndo'].includes(key),
      ),
      JSON.stringify(entry),
    );
    assert.equal(typeof entry.id, 'number');
    assert.equal(typeof entry.at, 'string');
    assert.equal(typeof entry.summary, 'string');
    assert.equal(typeof entry.revertible, 'boolean');
  }
  if (body.next) keys(body.next, ['id', 'kind', 'at', 'summary']);
}

// Throw only after SQLite has executed COMMIT, proving unknown is not rejected
// and is not safe to retry. A new disposable writer is used for every case.
function loseCommitAcknowledgement(adapter: Adapter) {
  const transaction = adapter.transaction!.bind(adapter);
  adapter.transaction = (run) =>
    transaction(async (tx) => {
      const result = await run(tx);
      const writer = Reflect.get(adapter, 'writeDb') as DatabaseSync;
      const exec = writer.exec.bind(writer);
      writer.exec = (sql) => {
        exec(sql);
        if (sql === 'COMMIT') throw new Error(secret);
      };
      return result;
    });
}

for (const mode of ['app', 'db'] as const) {
  for (const route of ['/api/view/run', '/api/run', '/api/breakdown'] as const) {
    test(`${mode} resource wire: ${route} text limit is the default and explicit pagination overrides it`, async () => {
      await fixture(mode, async (f) => {
        for (const { textLimit, limit, expected } of [
          { textLimit: 1, limit: undefined, expected: 1 },
          { textLimit: 2, limit: null, expected: 2 },
          { textLimit: 1, limit: 2, expected: 2 },
          { textLimit: 2, limit: '1', expected: 1 },
        ]) {
          const text =
            route === '/api/breakdown'
              ? `${f.table} count by name sort name asc limit ${textLimit}`
              : `${f.table} show name, team.name as team_name order by id asc limit ${textLimit}`;
          const body = success(
            route === '/api/run' ? await f.call(route, { q: text, limit, offset: 1 }) : await f.call(route, { text, limit, offset: 1 }),
          );
          assert.equal(route === '/api/breakdown' ? body.breakdown.limit : body.limit, expected);
          assert.equal(body.rows.length, expected, JSON.stringify({ route, textLimit, limit, body }));
          assert.deepEqual(
            body.rows.map((row: { name: string }) => row.name),
            ['Beta', 'Gamma'].slice(0, expected),
          );
          assert.equal(body.offset, 1);
          assert.equal(body.total, 3, 'text and page limits do not limit the exact count');
          projection(body, mode, route !== '/api/run', true);
        }
      });
    });
  }

  test(`${mode} resource wire: structured query, exact/estimated count and record query-bar envelopes`, async () => {
    await fixture(mode, async (f) => {
      const query = success(
        await f.call('/api/query', {
          table: f.table,
          columns: ['name'],
          orderBy: [{ column: 'id', direction: 'desc' }],
          limit: '1.9',
          offset: '1.9',
        }),
      );
      keys(query, ['columns', 'rows', 'ms', 'order', ...(mode === 'db' ? ['sql'] : [])]);
      rows(query);
      assert.deepEqual(query.columns, ['name']);
      assert.deepEqual(query.rows, [{ name: 'Beta' }]);
      assert.deepEqual(query.order, { order: [{ column: 'id', direction: 'desc' }], implicit: false });
      projection(query, mode, true);
      const count = success(await f.call('/api/count', { table: f.table, exactCount: true }));
      assert.deepEqual(count, { count: 3, exact: true });
      f.adapter.estimateCount = async () => 60_001;
      assert.deepEqual(success(await f.call('/api/count', { table: f.table })), { count: 60_001, exact: false });
      const run = success(
        await f.call('/api/run', { q: `${f.table} show id`, columns: ['name'], limit: '1', offset: '1', exactCount: true }),
      );
      keys(run, [
        'table',
        'columns',
        'rows',
        'ms',
        'total',
        'exactTotal',
        'limit',
        'offset',
        'order',
        'bounds',
        'errors',
        ...(mode === 'db' ? ['sql', 'explain'] : []),
      ]);
      // The page's bounds are its order's columns, read for the next step though the list shows only the name.
      assert.deepEqual(run.bounds, { first: { id: 2 }, last: { id: 2 } });
      rows(run);
      assert.deepEqual(run.rows, [{ name: 'Beta' }]);
      assert.equal(run.table, f.table);
      assert.equal(run.total, 3);
      assert.equal(run.exactTotal, true);
      assert.equal(run.limit, 1);
      assert.equal(run.offset, 1);
      assert.deepEqual(run.errors, []);
      assert.equal(run.order.implicit, true);
      projection(run, mode, true, true);
      const estimated = success(await f.call('/api/run', { q: `${f.table} show name`, limit: 1 }));
      assert.equal(estimated.total, 60_001);
      assert.equal(estimated.exactTotal, false);
      assert.deepEqual(
        success(await f.call('/api/count', { table: f.table, filter: { groups: [[{ column: 'name', op: '=', value: 'Beta' }]] } })),
        { count: 1, exact: true },
      );
    });
  });

  for (const counts of [true, false]) {
    test(`${mode} resource wire: view and query-bar fallback with ${counts ? 'exact' : 'absent'} optional totals`, async () => {
      await fixture(mode, async (f) => {
        if (!counts) {
          f.adapter.countView = undefined;
          f.adapter.countBreakdown = undefined;
        }
        const text = `${f.table} show name, team.name as team_name`;
        for (const route of ['/api/view/run', '/api/run'] as const) {
          const reply =
            route === '/api/run'
              ? await f.call(route, { q: text, limit: 1, offset: 1 })
              : await f.call(route, { text, limit: 1, offset: 1 });
          const body = success(reply);
          keys(body, [
            'view',
            'text',
            'columns',
            'resolved',
            'rows',
            'ms',
            'limit',
            'offset',
            'errors',
            ...(counts ? ['total'] : []),
            ...(route === '/api/run' ? ['table', 'bounds'] : ['more']),
            ...(mode === 'app' ? ['joinCount'] : ['joins', 'explain', ...(route === '/api/view/run' ? ['sql'] : [])]),
          ]);
          rows(body);
          assert.deepEqual(body.rows, [{ name: 'Beta', team_name: 'North' }]);
          assert.equal(body.view.base, f.table);
          assert.equal(body.limit, 1);
          assert.equal(body.offset, 1);
          assert.equal(body.total, counts ? 3 : undefined);
          assert.deepEqual(body.errors, []);
          if (route === '/api/view/run') assert.equal(body.more, true);
          if (mode === 'app') {
            assert.equal(body.joinCount, 1);
            for (const column of body.resolved)
              assert.ok(
                Object.keys(column).every((key) =>
                  ['path', 'name', 'table', 'column', 'type', 'nullable', 'primaryKey', 'hops', 'aggregate'].includes(key),
                ),
              );
          } else assert.equal(body.joins.length, 1);
          projection(body, mode, route === '/api/view/run', true);
        }
        const last = success(await f.call('/api/view/run', { view: { base: f.table, columns: ['name'] }, limit: 1, offset: 2 }));
        assert.deepEqual(last.rows, [{ name: 'Gamma' }]);
        assert.equal(last.more, !counts, 'count-free full pages use a conservative more heuristic');
        assert.equal(Object.hasOwn(last, 'total'), counts);
        const empty = success(await f.call('/api/view/run', { view: { base: f.table, columns: ['name'] }, limit: 1, offset: 3 }));
        assert.deepEqual(empty.rows, []);
        assert.equal(empty.more, false);
      });
    });
    for (const structured of [true, false]) {
      test(`${mode} resource wire: ${structured ? 'structured' : 'text'} breakdown with ${counts ? 'exact' : 'absent'} optional totals`, async () => {
        await fixture(mode, async (f) => {
          if (!counts) f.adapter.countBreakdown = undefined;
          const body = success(
            await f.call(
              '/api/breakdown',
              structured
                ? { def: { base: f.table, by: [{ path: 'team' }], measures: [{ fn: 'count' }] }, limit: '1', offset: '0' }
                : { text: `${f.table} count by team`, limit: '1', offset: '0' },
            ),
          );
          // `team` is a reference, so its groups come with their teams' names.
          keys(body, [
            'breakdown',
            'columns',
            'resolved',
            'rows',
            'offset',
            'ms',
            'names',
            ...(counts ? ['total'] : []),
            ...(!structured ? ['text', 'section'] : []),
            ...(mode === 'db' ? ['sql', ...(!structured ? ['explain'] : [])] : []),
          ]);
          rows(body);
          assert.equal(body.breakdown.base, f.table);
          assert.equal(body.breakdown.limit, 1);
          assert.equal(body.offset, 0);
          assert.equal(body.total, counts ? 2 : undefined);
          if (!structured) {
            assert.equal(body.section.table, f.table);
            assert.equal(typeof body.text, 'string');
          }
          for (const measure of body.resolved)
            assert.ok(Object.keys(measure).every((key) => ['name', 'kind', 'fn', 'path', 'type', 'bucket'].includes(key)));
          projection(body, mode, true, !structured);
          assert.equal(body.rows.length, 1, 'the executed page must respect the limit reported in the envelope');
          // Named for the page's groups only: the peek row past the limit is not in the answer.
          assert.deepEqual(
            Object.keys(body.names.team),
            body.rows.map((row: any) => String(row.team)),
          );
        });
      });
    }
  }

  test(`${mode} resource wire: parser failures are HTTP 200 without partial rows; bad columns are transport failures`, async () => {
    await fixture(mode, async (f) => {
      for (const reply of [
        await f.call('/api/run', { q: '' }),
        await f.call('/api/run', { q: `${f.table} absent_column = 1` }),
        await f.call('/api/view/run', { text: `${f.table} show absent_column` }),
        await f.call('/api/breakdown', { text: `${f.table} count by absent_column` }),
        await f.call('/api/breakdown', { def: { base: f.table, by: [{ path: 'absent_column' }], measures: [{ fn: 'count' }] } }),
      ]) {
        assert.equal(reply.status, 200, JSON.stringify(reply.body));
        diagnostics(reply.body);
        assert.ok(Object.keys(reply.body).every((key) => key === 'errors' || (mode === 'db' && key === 'explain')));
        if (mode === 'app') projection(reply.body, mode, false);
      }
      const invalid = await f.call('/api/query', { table: f.table, columns: ['absent_column'] });
      assert.equal(invalid.status, 400);
      assert.equal(typeof invalid.body.error, 'string');
      assert.match(invalid.body.error, /absent_column/);
      for (const field of ['rows', 'outcome', 'sql']) assert.equal(Object.hasOwn(invalid.body, field), false);
    });
  });

  test(`${mode} resource wire: ordinary update acknowledgements, legacy form, expected guard and ${mode === 'db' ? 'public Undo' : 'no Undo'}`, async () => {
    await fixture(mode, async (f) => {
      const saved = success(
        await f.call('/api/update', {
          table: f.table,
          key: { id: 2 },
          values: { name: 'Saved' },
          column: 'name',
          value: 'Ignored',
          expected: { name: 'Beta' },
        }),
      );
      // An App has no Undo: its acknowledgement carries no token.
      keys(saved, ['affected', 'applied', ...(mode === 'db' ? ['undoId', 'sql'] : [])]);
      assert.equal(saved.affected, 1);
      assert.deepEqual(saved.applied, { name: 'Saved' });
      assert.equal(typeof saved.undoId, mode === 'db' ? 'number' : 'undefined');
      assert.equal(f.row()?.name, 'Saved');
      projection(saved, mode, true);
      const stale = await f.call('/api/update', { table: f.table, key: { id: 2 }, values: { name: 'Stale' }, expected: { name: 'Beta' } });
      assert.equal(stale.status, 409);
      assert.equal(typeof stale.body.error, 'string');
      if (mode === 'app') assert.equal(stale.body.code, 'record_conflict');
      assert.equal(Object.hasOwn(stale.body, 'outcome'), false);
      assert.equal(f.row()?.name, 'Saved');
      if (mode === 'app') {
        const none = await f.call('/api/revert', { confirm: true, expectedId: 1 });
        assert.equal(none.status, 404);
        assert.deepEqual(none.body, { error: 'An App has no Undo.' });
      } else {
        const preview = success(await f.call('/api/revert', {}));
        keys(preview, ['reverted', 'writes', 'next']);
        publicHistory(preview);
        assert.equal(preview.writes.length, 1);
        assert.equal(preview.next.id, saved.undoId);
        assert.equal(f.row()?.name, 'Saved', 'Undo preview cannot mutate');
        const wrong = await f.call('/api/revert', { confirm: true, expectedId: saved.undoId + 1 });
        assert.equal(wrong.status, 409);
        assert.equal(wrong.body.outcome, 'not_applied');
        assert.equal(wrong.body.reverted, false);
        const undone = success(await f.call('/api/revert', { confirm: true, expectedId: saved.undoId }));
        keys(undone, ['reverted', 'outcome', 'undone', 'steps']);
        assert.equal(undone.reverted, true);
        assert.equal(undone.outcome, 'applied');
        keys(undone.undone, ['id', 'kind', 'summary']);
        assert.equal(undone.undone.id, saved.undoId);
        assert.equal(f.row()?.name, 'Beta');
        assert.deepEqual(success(await f.call('/api/revert', {})), { reverted: false, writes: [] });
      }
      const legacy = success(await f.call('/api/update', { table: f.table, key: { id: 2 }, column: 'name', value: 'Legacy' }));
      assert.deepEqual(legacy.applied, { name: 'Legacy' });
      assert.equal(f.row()?.name, 'Legacy');
    });
  });

  test(`${mode} resource wire: insert defaults and duplicate rejection; delete impact preview/confirm${mode === 'db' ? ' and restore' : ''}`, async () => {
    await fixture(mode, async (f) => {
      const inserted = success(await f.call('/api/insert', { table: f.table, values: { id: 9, name: 'Created' } }));
      keys(inserted, ['key', 'row', 'applied', ...(mode === 'db' ? ['undoId', 'sql'] : [])]);
      assert.deepEqual(inserted.key, { id: 9 });
      assert.deepEqual(inserted.row, { id: 9, name: 'Created', team: null, score: 7 });
      assert.deepEqual(inserted.applied, { id: 9, name: 'Created' });
      projection(inserted, mode, true);
      const duplicate = await f.call('/api/insert', { table: f.table, values: { id: 9, name: 'Duplicate' } });
      assert.equal(duplicate.status, 409);
      diagnostics(duplicate.body);
      assert.equal(duplicate.body.outcome, 'rejected');
      if (mode === 'app') {
        assert.equal(duplicate.body.errors[0].code, 'duplicate_value');
        // The key it clashed on, by name and beside its field (UX-5).
        assert.deepEqual(duplicate.body.errors[0].fields, [{ field: 'id', message: 'Another record already has this value.' }]);
      }
      assert.equal(f.row(9)?.name, 'Created');
      for (const confirm of [undefined, false]) {
        const preview = success(await f.call('/api/delete', { table: f.table, key: { id: 9 }, confirm }));
        keys(preview, ['impact', 'deleted']);
        assert.equal(preview.deleted, false);
        assert.deepEqual(preview.impact, [], 'zero-count incoming references are intentionally omitted');
        assert.equal(f.row(9)?.name, 'Created');
      }
      if (mode === 'db') assert.equal(success(await f.call('/api/revert', {})).next.id, inserted.undoId);
      const deleted = success(await f.call('/api/delete', { table: f.table, key: { id: 9 }, confirm: true }));
      keys(deleted, ['impact', 'deleted', 'affected', ...(mode === 'db' ? ['undoId', 'sql'] : [])]);
      assert.equal(deleted.deleted, true);
      assert.equal(deleted.affected, 1);
      assert.equal(f.row(9), undefined);
      projection(deleted, mode, true);
      if (mode === 'db') {
        const restored = success(await f.call('/api/revert', { confirm: true, expectedId: deleted.undoId }));
        assert.equal(restored.outcome, 'applied');
        assert.deepEqual(f.row(9), inserted.row);
        const uncreated = success(await f.call('/api/revert', { confirm: true, expectedId: inserted.undoId }));
        assert.equal(uncreated.outcome, 'applied');
        assert.equal(f.row(9), undefined);
      }
      const restricted = await f.call('/api/delete', { table: f.table, key: { id: 1 }, confirm: true });
      assert.equal(restricted.status, 409);
      assert.equal(restricted.body.deleted, false);
      assert.equal(restricted.body.outcome, 'rejected');
      assert.equal(restricted.body.impact[0].table, f.note);
      assert.equal(restricted.body.impact[0].count, 1);
      assert.deepEqual(restricted.body.impact[0].columns, ['item']);
      assert.ok(Array.isArray(restricted.body.impact[0].filter.groups));
      diagnostics(restricted.body);
      assert.equal(f.row(1)?.name, 'Alpha');
    });
  });

  // An App has no Undo, so only the database browser's revert can lose its acknowledgement.
  for (const kind of mode === 'db' ? (['update', 'insert', 'delete', 'revert'] as const) : (['update', 'insert', 'delete'] as const)) {
    test(`${mode} resource wire: ${kind} lost commit acknowledgement is unknown without a success token`, async () => {
      await fixture(mode, async (f) => {
        const older = success(await f.call('/api/update', { table: f.table, key: { id: 2 }, values: { name: 'Earlier' } }));
        loseCommitAcknowledgement(f.adapter);
        const reply =
          kind === 'update'
            ? await f.call('/api/update', { table: f.table, key: { id: 2 }, values: { name: 'Uncertain' } })
            : kind === 'insert'
              ? await f.call('/api/insert', { table: f.table, values: { id: 9, name: 'Uncertain' } })
              : kind === 'delete'
                ? await f.call('/api/delete', { table: f.table, key: { id: 2 }, confirm: true })
                : await f.call('/api/revert', { confirm: true, expectedId: older.undoId });
        assert.equal(reply.status, 200, JSON.stringify(reply.body));
        assert.equal(reply.body.outcome, 'unknown');
        diagnostics(reply.body);
        for (const field of ['affected', 'key', 'row']) assert.equal(Object.hasOwn(reply.body, field), false);
        if (kind === 'delete') assert.equal(reply.body.deleted, null);
        if (kind === 'revert') {
          assert.equal(reply.body.reverted, false);
          assert.equal(reply.body.undone.id, older.undoId);
        }
        if (mode === 'app') {
          assert.doesNotMatch(JSON.stringify(reply.body), new RegExp(secret));
          assert.equal(reply.body.errors[0].code, kind === 'revert' ? 'undo_failed' : 'write_unconfirmed');
        }
        assert.equal(f.row(kind === 'insert' ? 9 : 2)?.name, kind === 'delete' ? undefined : kind === 'revert' ? 'Beta' : 'Uncertain');
        if (mode === 'db') {
          const preview = success(await f.call('/api/revert', {}));
          publicHistory(preview);
          assert.equal(Object.hasOwn(preview, 'next'), false);
          assert.equal(preview.writes[0].undoState, 'unknown');
          assert.equal(preview.writes[0].revertible, false);
          const retry = await f.call('/api/revert', { confirm: true, expectedId: older.undoId });
          assert.equal(retry.status, 409);
          assert.equal(retry.body.outcome, 'not_applied');
        }
      });
    });
  }
}

test("App text pagination stays on its named source and cannot relax that source's field ceiling", async () => {
  await fixture(
    'app',
    async (f) => {
      const reads: string[] = [];
      for (const method of ['query', 'count', 'estimateCount', 'runView', 'countView', 'runBreakdown', 'countBreakdown'] as const) {
        Reflect.set(f.other, method, () => assert.fail(`${method} must not run on the active/default source`));
        const original = Reflect.get(f.adapter, method);
        if (typeof original === 'function')
          Reflect.set(f.adapter, method, (...args: unknown[]) => {
            reads.push(method);
            return Reflect.apply(original, f.adapter, args);
          });
      }
      for (const route of ['/api/view/run', '/api/run', '/api/breakdown'] as const) {
        const text =
          route === '/api/breakdown'
            ? `${f.table} count by name sort name asc limit 1`
            : `${f.table} show name, team.name as team_name order by id asc limit 1`;
        const body = success(route === '/api/run' ? await f.call(route, { q: text, limit: 2 }) : await f.call(route, { text, limit: 2 }));
        assert.deepEqual(
          body.rows.map((row: { name: string }) => row.name),
          ['Alpha', 'Beta'],
        );
        assert.equal(body.total, 3);
        assert.equal(route === '/api/breakdown' ? body.breakdown.base : body.view.base, 'inventory.item');
        projection(body, 'app', route !== '/api/run', true);
        assert.doesNotMatch(JSON.stringify(body), /WRONG_SOURCE|private_note|score/);
      }
      assert.ok(reads.includes('runView') && reads.includes('countView'));
      assert.ok(reads.includes('runBreakdown') && reads.includes('countBreakdown'));
      reads.length = 0;
      for (const path of ['score', 'team.private_note']) {
        const viewText = `${f.table} show name, ${path} limit 1`;
        const breakdownText = `${f.table} count by ${path} limit 1`;
        for (const reply of [
          await f.call('/api/run', { q: viewText, limit: 2 }),
          await f.call('/api/view/run', { view: { base: f.table, columns: ['name'] }, text: viewText, limit: 2 }),
          await f.call('/api/breakdown', { text: breakdownText, limit: 2 }),
          // A benign structured projection cannot launder forbidden authoritative
          // text when the permission wrapper materializes it to apply pagination.
          await f.call('/api/breakdown', {
            def: { base: f.table, by: [{ path: 'name' }], measures: [{ fn: 'count' }], text: breakdownText },
            limit: 2,
          }),
        ]) {
          assert.equal(reply.status, 200, JSON.stringify(reply.body));
          diagnostics(reply.body);
          projection(reply.body, 'app', false);
          assert.doesNotMatch(JSON.stringify(reply.body), /WRONG_SOURCE|PRIVATE_HTTP_CONTRACT_DRIVER/);
        }
      }
      assert.deepEqual(reads, [], 'forbidden text is refused before either rows or counts reach a physical reader');
    },
    true,
  );
});
