import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestWorkspace, startTestApp, assertAuthorizationMatrix } from '@mistriwork/mistri/testing';

test('a disposable authored App is ready for API tests', async (t) => {
  const workspace = await createTestWorkspace();
  t.after(() => workspace.close());
  const database = await workspace.database('business.db', (db) =>
    db.exec(`
    CREATE TABLE application(id INTEGER PRIMARY KEY, status TEXT NOT NULL);
    INSERT INTO application VALUES (1, 'pending');
  `),
  );
  await workspace.write('app/app.json', {
    id: 'credit-desk',
    name: 'Credit desk',
    resources: { application: {} },
    views: { applications: { kind: 'list', from: 'application' } },
    home: 'applications',
    nav: ['applications'],
  });
  const host = await startTestApp({ workspace, directory: workspace.path('app'), database });
  const anonymous = host.client();
  await assertAuthorizationMatrix([{ name: 'readiness', client: anonymous, path: '/readyz', status: 200 }]);
  const response = await anonymous.request('/readyz');
  assert.equal(response.status, 200);
});
