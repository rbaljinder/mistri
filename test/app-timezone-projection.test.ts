import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppConfig, zonedNow } from '../packages/mistri/src/shared/app.js';
import { authorityReport } from '../packages/mistri/src/shared/appAuthority.js';
import { servedApp, servedUi } from '../packages/mistri/src/shared/appPayload.js';
import { todayInZone } from '../packages/ui/src/datePickerModel.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const schema: DatabaseSchema = {
  label: 'Dates',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: [
    { id: 'task', name: 'task', schema: '', isView: false, columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }] },
  ],
};
const day = (date: Date) =>
  `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

test('served UI resolves the server zone without mutating an authored default', () => {
  const ui = Object.freeze({});
  const served = servedUi(ui);
  assert.equal(served.timezone, new Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.deepEqual(ui, {});
  for (const instant of ['2026-09-13T00:15:00Z', '2026-09-13T23:45:00Z']) {
    const now = new Date(instant);
    assert.equal(todayInZone(now, served.timezone), day(zonedNow(undefined, now)));
  }
});

test('explicit App zones retain precedence and agree with server Today across midnight', () => {
  for (const timezone of ['Pacific/Kiritimati', 'America/Los_Angeles', 'UTC']) {
    const ui = Object.freeze({ timezone });
    assert.equal(servedUi(ui).timezone, timezone);
    for (const instant of ['2026-09-13T00:15:00Z', '2026-09-13T23:45:00Z']) {
      const now = new Date(instant);
      assert.equal(todayInZone(now, servedUi(ui).timezone), day(zonedNow(timezone, now)));
    }
  }
});

test('ordinary and tenant shared App projection does not alter definitions or authority', () => {
  for (const tenant of [false, true]) {
    const app = parseAppConfig(
      {
        id: 'dates',
        name: 'Dates',
        ...(tenant ? { sources: { business: { connection: 'db' } }, auth: { rows: 'tenant', roles: { reader: { read: ['task'] } } } } : {}),
        resources: { task: { ...(tenant ? { owner: 'tenant' } : {}) } },
        views: { tasks: { kind: 'list', from: 'task' } },
        home: 'tasks',
      },
      'timezone fixture',
    );
    const before = structuredClone(app),
      authority = authorityReport(app);
    const projected = servedApp(app, schema);
    assert.equal(projected.ui.timezone, new Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.equal(app.ui.timezone, undefined);
    assert.deepEqual(app, before);
    assert.equal(authorityReport(app), authority);
  }
});
