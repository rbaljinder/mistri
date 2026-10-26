/**
 * The header's New menu (`ui.shell.new`, PREVIEW): what an author may name,
 * what a reader is served, and which lines a reader is offered. The button
 * itself is NewMenu.test.tsx; the menu in a running App is
 * e2e/shell-new-menu.spec.ts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTestApp as parseAppConfig } from './support/commandCatalog.js';
import { servedUi } from '../packages/mistri/src/shared/appPayload.js';
import { newMenuEntries } from '../packages/mistri/src/shared/appNewMenu.js';

const raise = { id: 'raise', version: 1, input: { note: { type: 'text' } } };
const raw = (shellNew: unknown, extra: Record<string, unknown> = {}) => ({
  id: 'desk',
  name: 'Desk',
  resources: { ticket: { access: 'write' }, change: {} },
  auth: { roles: { agent: { read: true, commands: ['raise'] } } },
  views: {
    tickets: { kind: 'list', from: 'ticket' },
    changes: { kind: 'list', from: 'change' },
    board: { kind: 'dashboard', label: 'Board', sections: [{ kind: 'view', view: 'tickets' }] },
    'raise-change': { kind: 'form', label: 'Raise a change', command: raise },
    ...extra,
  },
  home: 'tickets',
  nav: ['tickets', 'changes', 'board'],
  ui: { shell: { new: shellNew } },
});

test('a New entry names a list or a signed-in form, by view or by the command the form runs', () => {
  const app = parseAppConfig(raw([{ view: 'tickets' }, { command: 'raise', label: 'Change', icon: 'arrows-left-right' }]), 'fixture');
  assert.deepEqual(app.ui.shell?.new, [{ view: 'tickets' }, { command: 'raise', label: 'Change', icon: 'arrows-left-right' }]);
  /* The form is in no nav: the New menu is its reference, so it is not refused as unreachable. */
  assert.deepEqual(servedUi(app.ui, app.views).shell?.new, [
    { view: 'tickets' },
    { view: 'raise-change', command: 'raise', label: 'Change', icon: 'arrows-left-right' },
  ]);
});

test('mistri check refuses a New entry that opens nothing a New can open', () => {
  const refused: Array<[unknown, RegExp]> = [
    [[], /must be a list of what the New menu makes/],
    [[{ view: 'nowhere' }], /names view "nowhere", which is not one of this App's views/],
    [[{ view: 'board' }], /which is a dashboard/],
    [[{ command: 'missing' }], /names command "missing", which no signed-in form runs/],
    [[{ view: 'tickets', command: 'raise' }], /view|command/],
    [[{}], /view|command/],
    [[{ view: 'tickets' }, { view: 'tickets' }], /a second time/],
    [[{ view: 'tickets', label: ' ' }], /label/],
    [[{ view: 'tickets', colour: 'red' }], /colour/],
    [[{ view: 'tickets', icon: 'not-an-icon' }], /icon/],
  ];
  /* The form in nav too, so a refused entry is the only problem. */
  const listed = (entries: unknown, extra?: Record<string, unknown>) => ({
    ...raw(entries, extra),
    nav: ['tickets', 'changes', 'board', 'raise-change'],
  });
  for (const [entries, message] of refused) {
    assert.throws(() => parseAppConfig(listed(entries), 'fixture'), message, JSON.stringify(entries));
  }
  assert.throws(
    () =>
      parseAppConfig(
        listed([{ view: 'apply' }], {
          apply: { kind: 'form', public: true, label: 'Apply', command: { id: 'apply', version: 1, input: { note: { type: 'text' } } } },
        }),
        'fixture',
      ),
    /which is a public form/,
  );
  assert.throws(
    () => parseAppConfig(listed([{ command: 'raise' }], { again: { kind: 'form', label: 'Again', command: raise } }), 'fixture'),
    /both run/,
  );
});

test('a reader is offered the lines whose table they may add to and whose command they were granted', () => {
  const app = parseAppConfig(raw([{ view: 'tickets' }, { view: 'changes' }, { command: 'raise' }]), 'fixture');
  const served = servedUi(app.ui, app.views).shell?.new;
  const noun = (_view: string, table: string) => table.charAt(0).toUpperCase() + table.slice(1);
  const lines = (granted: string[] | undefined, writes: string[]) =>
    newMenuEntries(served, app.views, { grantedCommands: granted, canAdd: (table) => writes.includes(table) }, noun).map(
      ({ view, label }) => `${view}:${label}`,
    );
  assert.deepEqual(lines(['raise'], ['ticket', 'change']), ['tickets:Ticket', 'changes:Change', 'raise-change:Raise a change']);
  assert.deepEqual(lines(undefined, ['ticket']), ['tickets:Ticket']);
  assert.deepEqual(lines([], []), [], 'nothing this reader may make: no lines, and so no button');
  /* A view this reader was not served is not a line, whatever was authored. */
  const { tickets: _gone, ...rest } = app.views;
  assert.deepEqual(
    servedUi(app.ui, rest).shell?.new?.map((entry) => entry.view),
    ['changes', 'raise-change'],
  );
  const { 'raise-change': _form, tickets: _list, changes: _other, ...none } = app.views;
  assert.equal(servedUi(app.ui, none).shell?.new, undefined, 'no entry served, no key');
});

test('a long New menu groups its lines under headings, each line carrying its group to the reader', () => {
  /* The form is reachable only through the group: a grouped entry is a reference as a plain one is. */
  const app = parseAppConfig(
    raw([{ view: 'changes' }, { label: 'Service desk', children: [{ view: 'tickets' }, { command: 'raise', label: 'Change' }] }]),
    'fixture',
  );
  assert.deepEqual(app.ui.shell?.new, [
    { view: 'changes' },
    { view: 'tickets', group: 'Service desk' },
    { command: 'raise', label: 'Change', group: 'Service desk' },
  ]);
  const served = servedUi(app.ui, app.views).shell?.new;
  assert.deepEqual(served, [
    { view: 'changes' },
    { view: 'tickets', group: 'Service desk' },
    { view: 'raise-change', command: 'raise', label: 'Change', group: 'Service desk' },
  ]);
  const offered = newMenuEntries(served, app.views, { grantedCommands: ['raise'], canAdd: () => true }, (_v, table) => table);
  assert.deepEqual(
    offered.map(({ label, group }) => [label, group]),
    [
      ['change', undefined],
      ['ticket', 'Service desk'],
      ['Change', 'Service desk'],
    ],
  );
  const listed = (entries: unknown) => ({ ...raw(entries), nav: ['tickets', 'changes', 'board', 'raise-change'] });
  const refused: Array<[unknown, RegExp]> = [
    [[{ label: 'Desk', children: [] }], /children is a non-empty list/],
    [[{ label: ' ', children: [{ view: 'tickets' }] }], /is a group: its label is the heading/],
    [[{ label: 'Desk', children: [{ label: 'Inner', children: [{ view: 'tickets' }] }] }], /groups do not nest/],
    [
      [
        { label: 'Desk', children: [{ view: 'tickets' }] },
        { label: 'Desk', children: [{ view: 'changes' }] },
      ],
      /a second group headed "Desk"/,
    ],
    [[{ label: 'Desk', children: [{ view: 'tickets' }] }, { view: 'tickets' }], /a second time/],
    [[{ label: 'Desk', children: [{ view: 'nowhere' }] }], /group "Desk", names view "nowhere"/],
    [[{ label: 'Desk', children: [{ view: 'tickets' }], icon: 'tray' }], /icon/],
  ];
  for (const [entries, message] of refused) {
    assert.throws(() => parseAppConfig(listed(entries), 'fixture'), message, JSON.stringify(entries));
  }
});
