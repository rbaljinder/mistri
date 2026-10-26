/**
 * A role's `extends`: it holds every grant of the role it names, each the
 * union of both, as if written out; a loop, an undeclared role, another realm
 * or another kind of principal is refused; and authority.lock says both where
 * the grants came from and what the role holds in full.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { authorityReport } from '../packages/mistri/src/shared/appAuthority.js';
import { authoritySentences } from '../packages/mistri/src/server/app/authoritySentences.js';

const shop = (roles: Record<string, unknown>) =>
  parseAppConfig(
    {
      name: 'Bike shop',
      resources: { work_order: { access: 'write' }, part: { access: 'write' }, customer: { access: 'write' }, price_list: {} },
      auth: { roles },
      views: { orders: { kind: 'list', from: 'work_order' } },
      home: 'orders',
    },
    'app.ts',
  );

test('a role holds its parent’s grants and its own, through a chain', () => {
  const app = shop({
    mechanic: {
      read: ['work_order', 'part', 'customer'],
      write: ['work_order', 'part'],
      create: ['part'],
      commands: ['startRepair'],
      fields: { customer: { read: ['id', 'name'] } },
    },
    manager: { extends: 'mechanic', label: 'Shop manager', read: ['price_list'], write: ['customer'], commands: ['approveQuote'] },
    owner: { extends: 'manager', read: true, operations: ['readiness'] },
  });
  const roles = app.auth!.roles!;
  assert.deepEqual(roles.manager, {
    label: 'Shop manager',
    extends: 'mechanic',
    read: ['work_order', 'part', 'customer', 'price_list'],
    write: ['work_order', 'part', 'customer'],
    // The mechanic creates parts only; the manager everything it writes of its own: customers.
    create: ['part', 'customer'],
    commands: ['startRepair', 'approveQuote'],
    // Only the mechanic's side reads customers, and it narrows them: that narrowing is the one there is.
    fields: { customer: { read: ['id', 'name'], write: [] } },
  });
  assert.equal(roles.owner.extends, 'manager');
  assert.equal(roles.owner.read, true);
  assert.deepEqual(roles.owner.commands, ['startRepair', 'approveQuote']);
  assert.deepEqual(roles.owner.operations, ['readiness']);
  // The mechanic is untouched by those that extend it.
  assert.deepEqual(roles.mechanic.commands, ['startRepair']);
  assert.equal(roles.mechanic.extends, undefined);
});

test('a role that reads a resource whole keeps reading it whole', () => {
  const app = shop({
    clerk: { read: ['customer'], fields: { customer: { read: ['id', 'name'] } } },
    desk: { extends: 'clerk', read: ['customer'], write: ['customer'] },
  });
  assert.equal(app.auth!.roles!.desk.fields, undefined);
  /* A parent that reads a resource whole and never writes it widens the reads, not the writes: the child's own
     narrowing of what it writes holds. */
  const repairs = shop({
    front: { read: true, write: ['customer'] },
    lead: { extends: 'front', write: ['work_order'], fields: { work_order: { write: ['id'] } } },
  });
  assert.deepEqual(repairs.auth!.roles!.lead.fields, { work_order: { write: ['id'] } });
  // A parent that edits and never creates leaves its child the same, unless the child creates more.
  const edits = shop({ editor: { read: ['part'], write: ['part'], create: false }, senior: { extends: 'editor' } });
  assert.equal(edits.auth!.roles!.senior.create, false);
});

test('a loop, an undeclared role, another realm or kind of principal is refused by name', () => {
  assert.throws(() => shop({ a: { extends: 'b' }, b: { extends: 'a' } }), /role "b", "extends" loops \[role-extends\]: a → b → a/);
  assert.throws(() => shop({ a: { extends: 'a' } }), /loops \[role-extends\]: a → a/);
  assert.throws(() => shop({ a: { extends: 'mechanic' } }), /"mechanic", which is not a role the App declares \[role-extends\]/);
  assert.throws(
    () => shop({ bot: { service: true, read: ['part'] }, person: { extends: 'bot' } }),
    /a service role, and this one is a person \[role-extends\]/,
  );
});

test('authority.lock says where the grants came from, and lists them in full', () => {
  const app = shop({
    mechanic: { read: ['work_order'], commands: ['startRepair'] },
    manager: { extends: 'mechanic', commands: ['approveQuote'] },
  });
  const report = authorityReport(app);
  assert.match(report, /^role manager extends mechanic — /m);
  assert.match(report, /^role manager read work_order — /m);
  assert.match(report, /^role manager command startRepair — /m);
  assert.match(report, /^role manager command approveQuote — /m);
  const said = authoritySentences(report).find((sentence) => sentence.fact === 'role manager extends mechanic');
  assert.equal(said?.text, 'Role `manager` holds every grant of role `mechanic`, and those below.');
});
