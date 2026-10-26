import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { navViewKeys, type AppNavNode } from '../packages/mistri/src/shared/app.js';

/** The groups around a view in nav, outermost first. */
function groupsAround(
  nodes: readonly AppNavNode[],
  key: string,
  outer: Array<{ id: string; label: string }> = [],
): Array<{ id: string; label: string }> | undefined {
  for (const node of nodes) {
    if (!('group' in node)) {
      if ('view' in node && node.view === key) return outer;
      continue;
    }
    const found = groupsAround(node.children, key, [...outer, { id: node.group, label: node.label }]);
    if (found) return found;
  }
  return undefined;
}

test('Service Atlas loads six navigation roots and a meaningful organization subgroup', async () => {
  const { app } = await loadApp(resolve('test/fixtures/apps/service-desk'));
  assert.deepEqual(
    app.nav.map((node) => ('group' in node ? node.group : 'view' in node ? node.view : undefined)),
    ['operate', 'change', 'request', 'fulfill', 'estate', 'directory'],
  );
  const directory = app.nav.find((node) => 'group' in node && node.group === 'directory');
  const organization =
    directory && 'group' in directory ? directory.children.find((node) => 'group' in node && node.group === 'organization') : undefined;
  assert.ok(organization && 'group' in organization);
  assert.equal(organization.label, 'Organization');
  assert.deepEqual(
    navViewKeys(organization.children).map((key) => {
      const view = app.views[key];
      return 'table' in view ? view.table : undefined;
    }),
    ['support_team', 'department', 'location'],
  );
});

test('Service Atlas structural navigation preserves all destinations, controls, and group identities', async () => {
  const { app } = await loadApp(resolve('test/fixtures/apps/service-desk'));
  const keys = navViewKeys(app.nav);
  assert.equal(keys.length, 25);
  assert.deepEqual(
    keys.map((key) => {
      const view = app.views[key];
      return 'table' in view ? view.table : `dashboard ${key}`;
    }),
    [
      'dashboard operations',
      'dashboard incident-triage',
      'incident',
      'problem',
      'dashboard change-queue',
      'change_request',
      'change_approval',
      'change_task',
      'dashboard service-catalog',
      'service_request',
      'request_item',
      'request_approval',
      'dashboard fulfillment-queue',
      'purchase_order',
      'fulfillment_task',
      'order_line',
      'service',
      'asset',
      'knowledge_article',
      'person',
      'support_team',
      'department',
      'location',
      'vendor',
      'sla_policy',
    ],
  );
  const team = keys.find((key) => {
    const view = app.views[key];
    return 'table' in view && view.table === 'support_team';
  });
  assert.ok(team);
  assert.deepEqual(groupsAround(app.nav, team), [
    { id: 'directory', label: 'Directory' },
    { id: 'organization', label: 'Organization' },
  ]);
  const incident = Object.values(app.views).find((view) => 'table' in view && view.table === 'incident');
  assert.ok(incident && 'table' in incident);
  assert.deepEqual(incident.filters, ['name', 'priority', 'status', 'team_id', 'service_id']);
  assert.equal(incident.tabs?.[0].segment, 'active');
  assert.equal(app.resources?.incident.segments?.active.query, 'status != resolved and status != closed');
  assert.deepEqual(app.resources?.incident.form?.defaults, { status: 'new', priority: 'normal', sla_id: 3 });
  assert.deepEqual(
    app.resources?.incident.actions?.map((action) => action.label),
    ['Triage incident', 'Start investigation', 'Pend incident', 'Resolve incident', 'Resume investigation', 'Close incident'],
  );
});
