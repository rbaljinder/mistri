/** Authority-bearing DSL changes must trip both startup locks and reload gates. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { authorityDiff, authorityReport } from '../packages/mistri/src/shared/appAuthority.js';
import { authorityChange, authorityLockProblem } from '../packages/mistri/src/server/app/authorityLock.js';

const ordinary = () => ({
  name: 'Review',
  sources: { data: { connection: 'db' } },
  resources: { item: { access: 'write', delete: false } },
  views: { items: { kind: 'list', from: 'item' } },
  home: 'items',
});
const tenant = () => ({
  ...ordinary(),
  resources: { item: { owner: 'tenant' }, secret: { owner: 'platform' } },
  auth: { rows: 'tenant', tenancy: { platform: { label: 'Operator' } }, roles: { reader: { read: true, realm: 'tenant' } } },
});

function changed(before: unknown, after: unknown) {
  const a = parseAppConfig(before, 'fixture'),
    b = parseAppConfig(after, 'fixture');
  const lock = authorityReport(a),
    report = authorityReport(b);
  assert.notDeepEqual(authorityDiff(lock, report, 'facts'), []);
  assert.match(authorityLockProblem({ lock, report, lockPath: 'authority.lock' })!, /effective authority differs/);
  assert.match(authorityChange({ app: a }, { app: b })!, /authority changed/);
}

test('enabling deletion invalidates the authority lock and reload', () => {
  const after = ordinary();
  after.resources.item.delete = true;
  changed(ordinary(), after);
});
test('rebinding a named source invalidates the authority lock and reload', () => {
  const after = ordinary();
  after.sources.data.connection = 'other';
  changed(ordinary(), after);
});
test('changing ownership invalidates the authority lock and reload', () => {
  const after = tenant();
  after.resources.item.owner = 'global';
  changed(tenant(), after);
});
test('changing role realm invalidates the lock and reports the correct effective reads', () => {
  const before = tenant(),
    after = tenant();
  after.auth.roles.reader.realm = 'platform';
  changed(before, after);
  assert.doesNotMatch(authorityReport(parseAppConfig(before, 'fixture')), /role reader read secret/);
  assert.match(authorityReport(parseAppConfig(after, 'fixture')), /role reader read secret/);
});
test('presentation-only changes and absent versus false deletion preserve authority', () => {
  const before = ordinary(),
    after = { ...ordinary(), name: 'Another title', ui: { theme: { preset: 'sage' } } };
  const report = authorityReport(parseAppConfig(before, 'fixture'));
  assert.deepEqual(authorityDiff(report, authorityReport(parseAppConfig(after, 'fixture'))), []);
  const omitted = { ...before, resources: { item: { access: 'write' } } };
  assert.deepEqual(authorityDiff(report, authorityReport(parseAppConfig(omitted, 'fixture'))), []);
});
