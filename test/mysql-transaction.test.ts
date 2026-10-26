import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asBackgroundWork, configureWriteOrder } from '../packages/engine/src/adapters/writeLanes.js';
import { Refusal, TransactionOutcomeUnknown, type WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import { MYSQL_READERS, MysqlAdapter } from '../packages/engine/src/adapters/mysql.js';

function outcomeFixture() {
  const adapter = new MysqlAdapter('mysql://localhost/shop');
  let next = 0;
  const connections: Array<{ id: number; readonly: boolean; ended: boolean; destroyed: boolean; statements: string[] }> = [];
  let hook: (text: string) => Promise<void> = async () => {};
  Reflect.set(adapter, 'open', async (readonly: boolean) => {
    const state = { id: ++next, readonly, ended: false, destroyed: false, statements: [] as string[] };
    connections.push(state);
    const execute = async (text: string): Promise<[unknown, unknown]> => {
      assert.equal(state.ended || state.destroyed, false, 'SQL on a disposed connection');
      state.statements.push(text);
      await hook(text);
      assert.equal(state.ended || state.destroyed, false, 'SQL resumed on a disposed connection');
      if (text === 'SELECT DATABASE() AS db') return [[{ db: 'shop' }], []];
      if (text.startsWith('SELECT ENGINE')) return [[{ ENGINE: 'InnoDB' }], []];
      if (text.includes('information_schema.TABLES')) return [[{ TABLE_TYPE: 'BASE TABLE' }], []];
      if (text.includes('information_schema.COLUMNS'))
        return [
          [
            { COLUMN_NAME: 'id', COLUMN_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_KEY: 'PRI', EXTRA: '' },
            { COLUMN_NAME: 'name', COLUMN_TYPE: 'text', IS_NULLABLE: 'NO', COLUMN_KEY: '', EXTRA: '' },
          ],
          [],
        ];
      if (text.includes('COUNT(*)')) return [[{ n: 1 }], [{ name: 'n' }]];
      if (text.startsWith('SELECT')) return [[{ id: 1, name: 'Item' }], [{ name: 'id' }, { name: 'name' }]];
      return [{ affectedRows: 1, insertId: 1 }, []];
    };
    return {
      execute,
      query: (sql: string | { sql: string }) => execute(typeof sql === 'string' ? sql : sql.sql),
      end: async () => {
        state.ended = true;
      },
      destroy: () => {
        state.destroyed = true;
      },
    };
  });
  return {
    adapter,
    connections,
    hook: (next: typeof hook) => {
      hook = next;
    },
  };
}

for (const kind of ['refusal', 'constraint'] as const) {
  for (const commit of [false, true]) {
    for (const rollbackFails of [false, true]) {
      test(`MySQL ${kind}: commit attempted=${commit}, rollback failure=${rollbackFails} classifies outcome and replaces uncertain writer`, async () => {
        const { adapter, connections, hook } = outcomeFixture();
        const original =
          kind === 'refusal'
            ? new Refusal('Private original refusal')
            : Object.assign(new Error('Private constraint detail'), { code: 'ER_DUP_ENTRY' });
        hook(async (text) => {
          if (commit && text === 'COMMIT') throw original;
          if (rollbackFails && text === 'ROLLBACK') throw new Error('Rollback acknowledgement lost');
        });
        try {
          await assert.rejects(
            adapter.transaction(async (tx) => {
              await tx.insert({ table: 'shop.item', values: { id: 1, name: 'Changed' } });
              if (!commit) throw original;
            }),
            (error) => {
              if (commit || rollbackFails) {
                assert.ok(error instanceof TransactionOutcomeUnknown);
                assert.equal(error instanceof Refusal, false);
                assert.equal(error.outcome, 'unknown');
                assert.equal(error.cause, original);
                assert.doesNotMatch(error.message, /Private|constraint|ER_DUP_ENTRY/);
              } else assert.equal(error, original);
              return true;
            },
          );
          const first = connections.find((connection) => !connection.readonly)!;
          assert.equal(first.destroyed, commit || rollbackFails);
          assert.equal(first.statements.includes('COMMIT'), commit);
          assert.equal(first.statements.at(-1), 'ROLLBACK');
          if (commit || rollbackFails) assert.equal((Reflect.get(adapter, 'writers') as Set<unknown>).size, 0);
          hook(async () => {});
          await adapter.transaction(async (tx) => assert.equal(await tx.count('shop.item'), 1));
          const writers = connections.filter((connection) => !connection.readonly);
          assert.equal(writers.length, commit || rollbackFails ? 2 : 1);
          assert.equal(writers.at(-1)!.destroyed, false);
        } finally {
          await adapter.close();
        }
      });
    }
  }
}

test('MySQL failed BEGIN discards session without invoking callback or ordinary fallback', async () => {
  const { adapter, connections, hook } = outcomeFixture();
  const original = new Refusal('BEGIN acknowledgement lost');
  hook(async (text) => {
    if (text === 'BEGIN') throw original;
  });
  try {
    await assert.rejects(
      adapter.transaction(async () => assert.fail('callback entered')),
      (error) => error === original,
    );
    const first = connections.find((connection) => !connection.readonly)!;
    assert.equal(first.destroyed, true);
    assert.equal((Reflect.get(adapter, 'writers') as Set<unknown>).size, 0);
    hook(async () => {});
    await adapter.transaction(async () => {});
    assert.equal(connections.filter((connection) => !connection.readonly).length, 2);
  } finally {
    await adapter.close();
  }
});

test('MySQL transaction queued behind a lost commit uses a fresh writer', async () => {
  const { adapter, connections, hook } = outcomeFixture();
  let failed = false;
  hook(async (text) => {
    if (text === 'COMMIT' && !failed) {
      failed = true;
      throw new Refusal('Lost commit');
    }
  });
  try {
    const first = adapter.transaction(async (tx) => tx.insert({ table: 'shop.item', values: { id: 1, name: 'First' } }));
    const second = adapter.transaction(async (tx) => tx.count('shop.item'));
    await assert.rejects(first, TransactionOutcomeUnknown);
    assert.equal(await second, 1);
    const writers = connections.filter((connection) => !connection.readonly);
    assert.deepEqual(
      writers.map((writer) => writer.destroyed),
      [true, false],
    );
  } finally {
    await adapter.close();
  }
});

for (const operation of ['update', 'remove'] as const) {
  test(`MySQL close during ${operation} preflight cannot reopen an autocommit writer`, async () => {
    const { adapter, connections } = outcomeFixture();
    const original = Reflect.get(adapter, 'countOn').bind(adapter) as (...args: unknown[]) => Promise<unknown>;
    Reflect.set(adapter, 'countOn', async (...args: unknown[]) => {
      const result = await original(...args);
      await adapter.close();
      return result;
    });
    try {
      await assert.rejects(
        adapter.transaction(async (tx) => {
          if (operation === 'update') await tx.update({ table: 'shop.item', key: { id: 1 }, values: { name: 'Escaped' } });
          else await tx.remove({ table: 'shop.item', key: { id: 1 } });
        }),
        TransactionOutcomeUnknown,
      );
      assert.equal(connections.filter((connection) => !connection.readonly).length, 1);
      assert.equal(
        connections.some((connection) => connection.statements.some((text) => /^(UPDATE|DELETE)/.test(text))),
        false,
      );
      assert.equal((Reflect.get(adapter, 'writers') as Set<unknown>).size, 0);
    } finally {
      await adapter.close();
    }
  });
}

test('MySQL disposal fallback failure cannot replace the unknown outcome or retain its writer', async () => {
  const { adapter, connections, hook } = outcomeFixture();
  const original = new Refusal('Commit acknowledgement lost');
  hook(async (text) => {
    if (text === 'COMMIT') throw original;
  });
  let endAttempted = false;
  try {
    await assert.rejects(
      adapter.transaction(async () => {
        const writer = Reflect.get(adapter, 'leased').getStore() as object;
        Reflect.set(writer, 'destroy', undefined);
        Reflect.set(writer, 'end', async () => {
          endAttempted = true;
          throw new Error('Close failed');
        });
      }),
      (error) => error instanceof TransactionOutcomeUnknown && error.cause === original,
    );
    assert.equal(endAttempted, true);
    assert.equal((Reflect.get(adapter, 'writers') as Set<unknown>).size, 0);
    hook(async () => {});
    await adapter.transaction(async () => {});
    assert.equal(connections.filter((connection) => !connection.readonly).length, 2);
  } finally {
    await adapter.close();
  }
});

for (const operation of ['insert', 'update', 'remove'] as const) {
  test(`MySQL transactional ${operation} retains its captured writer after an awaited metadata/preflight boundary`, async () => {
    const { adapter, connections } = outcomeFixture();
    const method = operation === 'insert' ? 'read' : 'countOn';
    const original = Reflect.get(adapter, method).bind(adapter) as (...args: unknown[]) => Promise<unknown>;
    let detached = false;
    Reflect.set(adapter, method, async (...args: unknown[]) => {
      const result = await original(...args);
      if (!detached && (method === 'countOn' || String(args[1]).includes('information_schema.COLUMNS'))) {
        detached = true;
        Reflect.get(adapter, 'leased').enterWith(undefined);
      }
      return result;
    });
    try {
      await adapter.transaction(async (tx) => {
        if (operation === 'insert') await tx.insert({ table: 'shop.item', values: { id: 1, name: 'Inserted' } });
        else if (operation === 'update') await tx.update({ table: 'shop.item', key: { id: 1 }, values: { name: 'Updated' } });
        else await tx.remove({ table: 'shop.item', key: { id: 1 } });
      });
      const writers = connections.filter((connection) => !connection.readonly);
      assert.equal(detached, true);
      assert.equal(writers.length, 1, 'must not open an autocommit writer');
      assert.ok(writers[0].statements.some((text) => text.startsWith(operation === 'remove' ? 'DELETE' : operation.toUpperCase())));
      assert.equal(writers[0].statements.at(-1), 'COMMIT');
    } finally {
      await adapter.close();
    }
  });
}

test('MySQL transaction reads, metadata and mutation preflights use the writer and expire together', async () => {
  const statements: Array<{ readonly: boolean; text: string }> = [];
  const adapter = new MysqlAdapter('mysql://localhost/shop');
  const open = async (readonly: boolean) => {
    let active = false;
    let ended = false;
    const execute = async (text: string): Promise<[unknown, unknown]> => {
      assert.equal(active, false, 'transaction operations must not interleave statements');
      assert.equal(ended, false);
      active = true;
      statements.push({ readonly, text });
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (text === 'SELECT DATABASE() AS db') return [[{ db: 'shop' }], []];
        if (text.startsWith('SELECT ENGINE')) return [[{ ENGINE: 'InnoDB' }], []];
        if (text.includes('information_schema.TABLES')) return [[{ TABLE_TYPE: 'BASE TABLE' }], []];
        if (text.includes('information_schema.COLUMNS'))
          return [
            [
              { COLUMN_NAME: 'id', COLUMN_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_KEY: 'PRI', EXTRA: '' },
              { COLUMN_NAME: 'name', COLUMN_TYPE: 'text', IS_NULLABLE: 'NO', COLUMN_KEY: '', EXTRA: '' },
            ],
            [],
          ];
        if (text.includes('COUNT(*)')) return [[{ n: 1 }], [{ name: 'n' }]];
        if (text.startsWith('SELECT')) return [[{ id: 1, name: 'Item' }], [{ name: 'id' }, { name: 'name' }]];
        return [{ affectedRows: 1, insertId: 1 }, []];
      } finally {
        active = false;
      }
    };
    return {
      execute,
      query: (sql: string | { sql: string }) => execute(typeof sql === 'string' ? sql : sql.sql),
      end: async () => {
        ended = true;
      },
    };
  };
  // Replace only driver creation, retaining catalog guards and SQL execution paths.
  Reflect.set(adapter, 'open', open);
  try {
    for (const fail of [false, true]) {
      let escaped!: WriteTransaction;
      const start = statements.length;
      const work = adapter.transaction(async (tx) => {
        escaped = tx;
        await tx.insert({ table: 'shop.item', values: { id: 1, name: 'Inserted' } });
        await Promise.all([
          tx.query({ table: 'shop.item', columns: ['name'], limit: 1, offset: 0 }),
          tx.count('shop.item'),
          tx.update({ table: 'shop.item', key: { id: 1 }, values: { name: 'Updated' } }),
        ]);
        await tx.remove({ table: 'shop.item', key: { id: 1 } });
        if (fail) throw new Error('Abort transaction');
      });
      if (fail) await assert.rejects(work, /Abort transaction/);
      else await work;
      const current = statements.slice(start);
      const within = current.slice(current.findIndex((statement) => statement.text === 'BEGIN'));
      assert.ok(within.length > 5);
      assert.ok(within.every((statement) => !statement.readonly));
      assert.ok(within.some((statement) => statement.text.includes('COUNT(*)')));
      assert.equal(within.at(-1)?.text, fail ? 'ROLLBACK' : 'COMMIT');
      const beforeLate = statements.length;
      await assert.rejects(() => escaped.query({ table: 'shop.item', limit: 1, offset: 0 }), /no longer active/);
      await assert.rejects(() => escaped.count('shop.item'), /no longer active/);
      await assert.rejects(() => escaped.insert({ table: 'shop.item', values: { name: 'Late' } }), /no longer active/);
      assert.equal(statements.length, beforeLate);
    }
    const beforeCaughtFailure = statements.length;
    await assert.rejects(
      adapter.transaction(async (tx) => {
        await tx.insert({ table: 'shop.item', values: { id: 1, name: 'Must roll back' } });
        await tx.update({ table: 'shop.item', key: { id: 1 }, values: { absent_column: 'Invalid' } }).catch(() => {});
      }),
      /no column called/,
    );
    const failed = statements.slice(beforeCaughtFailure);
    assert.equal(failed.at(-1)?.text, 'ROLLBACK');
    assert.equal(
      failed.some((statement) => statement.text === 'COMMIT'),
      false,
    );
    assert.deepEqual(
      statements.filter((statement) => statement.readonly).map((statement) => statement.text),
      ['SELECT DATABASE() AS db'],
    );
    await adapter.query({ table: 'shop.item', limit: 1, offset: 0 });
    assert.equal(statements.at(-1)?.readonly, true, 'ordinary browsing still uses the read-only client');
  } finally {
    await adapter.close();
  }
});

test('MySQL reads that overlap spread over up to four read-only connections, and reads one after another share one', async () => {
  const { adapter, connections, hook } = outcomeFixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let waiting = 0;
  try {
    await adapter.query({ table: 'shop.item', limit: 1, offset: 0 });
    assert.equal(connections.length, 1, 'one read, one connection');
    hook(async (text) => {
      if (!/^SELECT .*FROM `shop`\.`item`/s.test(text)) return;
      waiting++;
      await held;
    });
    const reads = Array.from({ length: 6 }, () => adapter.query({ table: 'shop.item', limit: 1, offset: 0 }));
    const deadline = Date.now() + 5_000;
    while (waiting < 6) {
      assert.ok(Date.now() < deadline, 'every read reached the database');
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const readers = connections.filter((connection) => connection.readonly);
    assert.equal(readers.length, MYSQL_READERS, 'six reads at once open no more than the ceiling');
    assert.equal(connections.length, readers.length, 'no read went to a writable connection');
    assert.ok(
      readers.every((reader) => reader.statements.some((text) => text.includes('`item`'))),
      'each reader carries a read',
    );
    release();
    await Promise.all(reads);
    const before = connections.length;
    for (let i = 0; i < 3; i++) await adapter.query({ table: 'shop.item', limit: 1, offset: 0 });
    assert.equal(connections.length, before, 'reads one after another open nothing new');
  } finally {
    release();
    await adapter.close();
  }
  assert.ok(
    connections.every((connection) => connection.ended || connection.destroyed),
    'close ends every reader',
  );
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('MySQL bounds foreground leases and keeps a background transaction off that pool', async () => {
  configureWriteOrder('keyed');
  const fixture = outcomeFixture();
  configureWriteOrder('serial');
  const { adapter, connections } = fixture;
  Reflect.set(adapter, 'writerSize', 1);
  const entered = deferred(),
    release = deferred(),
    backgroundEntered = deferred();
  const first = adapter.transaction(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  let secondStarted = false;
  const second = adapter.transaction(async () => {
    secondStarted = true;
  });
  const background = asBackgroundWork(() =>
    adapter.transaction(async () => {
      backgroundEntered.resolve();
    }),
  );
  try {
    await backgroundEntered.promise;
    assert.equal(secondStarted, false, 'foreground pool stays bounded while background proceeds');
    assert.equal(connections.filter((c) => !c.readonly).length, 2);
    assert.equal(connections.filter((c) => c.readonly).length, 1);
  } finally {
    release.resolve();
    await Promise.all([first, second, background]);
    await adapter.close();
  }
});

test('MySQL close wakes queued leases and refuses them without opening a replacement', async () => {
  configureWriteOrder('keyed');
  const { adapter, connections } = outcomeFixture();
  configureWriteOrder('serial');
  Reflect.set(adapter, 'writerSize', 1);
  const entered = deferred(),
    release = deferred();
  const first = adapter.transaction(async () => {
    entered.resolve();
    await release.promise;
  });
  const firstFailure = assert.rejects(first, TransactionOutcomeUnknown);
  await entered.promise;
  const second = adapter.transaction(async () => assert.fail('closed queued transaction entered'));
  const secondFailure = assert.rejects(second, /closed/);
  await adapter.close();
  release.resolve();
  await Promise.all([firstFailure, secondFailure]);
  assert.equal(connections.filter((c) => !c.readonly).length, 1);
});

for (const readonly of [true, false]) {
  test(`MySQL close while opening ${readonly ? 'reader' : 'writer'} disposes the late connection`, async () => {
    const { adapter, connections } = outcomeFixture();
    const open = Reflect.get(adapter, 'open').bind(adapter);
    const entered = deferred(),
      release = deferred();
    Reflect.set(adapter, 'open', async (reading: boolean) => {
      const connection = await open(reading);
      if (reading === readonly) {
        entered.resolve();
        await release.promise;
      }
      return connection;
    });
    const work = adapter.transaction(async () => assert.fail('closed transaction entered'));
    const failed = assert.rejects(work, /closed/);
    await entered.promise;
    await adapter.close();
    release.resolve();
    await failed;
    assert.ok(connections.every((connection) => connection.ended || connection.destroyed));
  });
}
