/**
 * The record history store on a live MySQL or MariaDB, in the database
 * `TABLEWALK_TEST_MYSQL` names: provisioning, the append inside the write's
 * own transaction, the read, and a refused foreign layout. The store's two
 * tables and the fixture's are dropped before and after.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MysqlAdapter } from '../packages/engine/src/adapters/mysql.js';
import { RECORD_HISTORY_TABLES, RecordHistoryUnavailable, historyKey } from '../packages/mistri/src/adapters/history/recordHistory.js';
import { bindRecordHistory } from '../packages/mistri/src/server/stores/writeCaptures.js';
import { attributeWrites } from '../packages/engine/src/adapters/writeAttribution.js';
import { provisionMysqlRecordHistory } from '../packages/mistri/src/adapters/history/mysqlRecordHistory.js';
import { liveSkip } from './live.js';
import { appStoresOf } from '../packages/mistri/src/server/stores/appStores.js';

const MYSQL = process.env.TABLEWALK_TEST_MYSQL;
const skip = liveSkip('mysql', MYSQL);

test("MySQL record history: provisioned once, appended in the write's transaction, read for one record", { skip }, async () => {
  const mysql = (await import('mysql2/promise')) as unknown as {
    createConnection(options: unknown): Promise<{
      query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
      end(): Promise<void>;
    }>;
  };
  const control = await mysql.createConnection({ uri: MYSQL });
  const adapter = new MysqlAdapter(MYSQL!);
  const reset = async () => {
    await control.query(`DROP TABLE IF EXISTS \`${RECORD_HISTORY_TABLES.change}\`, \`${RECORD_HISTORY_TABLES.meta}\`, rh_ticket`);
  };
  try {
    await reset();
    await control.query('CREATE TABLE rh_ticket (id INT PRIMARY KEY, status VARCHAR(20), salary INT) ENGINE=InnoDB');
    await control.query(`INSERT INTO rh_ticket VALUES (1, 'open', 100)`);
    assert.equal(await appStoresOf(adapter).recordHistoryReady(), false);
    assert.deepEqual(await provisionMysqlRecordHistory(MYSQL!), { version: 1, provisioned: true });
    assert.deepEqual(await provisionMysqlRecordHistory(MYSQL!), { version: 1, provisioned: false });
    assert.equal(await appStoresOf(adapter).recordHistoryReady(), true);

    const schema = await adapter.introspect();
    const table = schema.tables.find((candidate) => candidate.name === 'rh_ticket')!.id;
    bindRecordHistory(adapter, new Map([[table, { redact: new Set(['salary']) }]]));
    await attributeWrites({ actor: 'maya@example.com', name: 'Maya Chen', via: 'app', action: 'Close' }, () =>
      adapter.transaction((tx) => tx.update({ table, key: { id: 1 }, values: { status: 'closed', salary: 150 } })),
    );
    await adapter.update({ table, key: { id: 1 }, values: { status: 'open' } });
    await assert.rejects(
      adapter.transaction(async (tx) => {
        await tx.update({ table, key: { id: 1 }, values: { status: 'lost' } });
        throw new Error('handler failed');
      }),
      /handler failed/,
    );
    const read = await appStoresOf(adapter).readRecordHistory({ resource: table, key: historyKey({ id: 1 }), limit: 20 });
    assert.deepEqual(
      read.map((row) => [row.action, row.via, row.actor, row.actorName]),
      [
        ['', 'system', '', ''],
        ['Close', 'app', 'maya@example.com', 'Maya Chen'],
      ],
    );
    assert.deepEqual(read[1].changes, [
      { c: 'status', b: 'open', a: 'closed' },
      { c: 'salary', r: 1 },
    ]);

    await control.query(`CREATE TRIGGER rh_scrub BEFORE INSERT ON \`${RECORD_HISTORY_TABLES.change}\` FOR EACH ROW SET NEW.action = ''`);
    assert.equal(await appStoresOf(adapter).recordHistoryReady(), false);
    await assert.rejects(provisionMysqlRecordHistory(MYSQL!), RecordHistoryUnavailable);
    await control.query('DROP TRIGGER rh_scrub');
    await control.query(`DROP TABLE \`${RECORD_HISTORY_TABLES.change}\``);
    await assert.rejects(adapter.update({ table, key: { id: 1 }, values: { status: 'closed' } }));
    const [rows] = await control.query('SELECT status FROM rh_ticket WHERE id = 1');
    assert.equal((rows as Array<{ status: string }>)[0].status, 'open');
  } finally {
    await adapter.close();
    await reset().catch(() => {});
    await control.end();
  }
});
