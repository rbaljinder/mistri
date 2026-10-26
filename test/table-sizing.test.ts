import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dashboard, rows } from '@mistriwork/mistri/app';
import { parseAppConfig, resolveViews } from '../packages/mistri/src/shared/app.js';
import { pageConfig, parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { TABLE_SIZINGS } from '../packages/engine/src/shared/tableSizing.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const schema: DatabaseSchema = {
  label: 'Demo',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: [
    {
      id: 'ticket',
      name: 'ticket',
      schema: '',
      isView: false,
      columns: [
        { name: 'id', type: 'integer', nullable: false, primaryKey: true },
        { name: 'name', type: 'text', nullable: false, primaryKey: false },
      ],
    },
  ],
};

test('sizing survives helpers, runtime parsing, view resolution and record config round trips', () => {
  for (const sizing of [...TABLE_SIZINGS, undefined]) {
    const options = sizing === undefined ? {} : { sizing };
    const authored = {
      name: 'Desk',
      resources: { ticket: {} },
      views: {
        tickets: { kind: 'list', label: 'Tickets', from: 'ticket', query: 'id > 0', ...options },
        overview: dashboard('Overview', [rows('Recent', 'ticket', { show: ['id', 'name'], ...options })]),
      },
      home: 'overview',
      nav: ['tickets', 'overview'],
    };
    const app = parseAppConfig(authored, 'test');
    const views = resolveViews(app, schema);
    const resolved = [views.tickets, views.overview];
    assert.ok('table' in resolved[0]);
    assert.equal('sizing' in resolved[0] ? resolved[0].sizing : undefined, sizing);
    const dash = resolved[1];
    assert.ok('sections' in dash);
    assert.equal(dash.sections[0].sizing, sizing);
    if (sizing === undefined) {
      assert.equal(Object.hasOwn(resolved[0], 'sizing'), false);
      assert.equal(Object.hasOwn(dash.sections[0], 'sizing'), false);
    }
    // A page's list takes `sizing` only from a mistri.json page; an App's page leaves it out.
    const configPage = {
      label: 'Ticket',
      base: 'ticket',
      sections: [{ kind: 'list', title: 'Notes', from: 'note', whose: 'ticket_id', ...options }],
    };
    const [parsed] = parsePagesConfig({ pages: [configPage] }, 'test');
    const emitted = pageConfig(parsed);
    assert.equal((emitted.sections![0] as { sizing?: string }).sizing, sizing);
    assert.deepEqual(parsePagesConfig({ pages: [JSON.parse(JSON.stringify(emitted))] }, 'roundtrip')[0], parsed);
  }
});

test('all list authoring surfaces reject malformed sizing rather than silently choosing a default', () => {
  for (const sizing of ['auto', 'FIT', ' fit ', '', null, false, 1, {}, []]) {
    assert.throws(
      () =>
        parseAppConfig(
          {
            name: 'Desk',
            resources: { ticket: {} },
            views: { tickets: { kind: 'list', from: 'ticket', sizing } },
            home: 'tickets',
            nav: ['tickets'],
          },
          'test',
        ),
      /sizing.*fit.*scroll/,
    );
    assert.throws(
      () =>
        parseAppConfig(
          {
            name: 'Desk',
            resources: { ticket: {} },
            views: { overview: { kind: 'dashboard', label: 'Overview', sections: [{ kind: 'rows', from: 'ticket', sizing }] } },
            home: 'overview',
            nav: ['overview'],
          },
          'test',
        ),
      /sizing.*fit.*scroll/,
    );
    assert.throws(
      () =>
        parsePagesConfig(
          { pages: [{ label: 'Ticket', base: 'ticket', sections: [{ kind: 'list', from: 'note', whose: 'ticket_id', sizing }] }] },
          'test',
        ),
      /sizing.*fit.*scroll/,
    );
  }
});

test('sizing is refused on section kinds that cannot render a table', () => {
  for (const section of [
    { kind: 'metric', from: 'ticket' },
    { kind: 'note', text: 'Text' },
    { kind: 'board', from: 'ticket', by: 'name' },
  ]) {
    assert.throws(
      () =>
        parseAppConfig(
          {
            name: 'Desk',
            resources: { ticket: {} },
            views: { overview: { kind: 'dashboard', label: 'Overview', sections: [{ ...section, sizing: 'fit' }] } },
            home: 'overview',
            nav: ['overview'],
          },
          'test',
        ),
      /sizing.*only a rows section/,
    );
  }
  for (const kind of ['fields', 'metric', 'breakdown', 'timeline']) {
    assert.throws(
      () => parsePagesConfig({ pages: [{ label: 'Ticket', base: 'ticket', sections: [{ kind, sizing: 'fit' }] }] }, 'test'),
      /sizing belongs on a related list/,
    );
  }
});

test('a record page in an App refuses sizing on a related list: it is a mistri.json page option', () => {
  const app = {
    name: 'Desk',
    resources: { ticket: {}, note: {} },
    views: { tickets: { kind: 'list', from: 'ticket' } },
    home: 'tickets',
    nav: ['tickets'],
    pages: { ticket: { base: 'ticket', sections: [{ kind: 'list', title: 'Notes', from: 'note', whose: 'ticket_id', sizing: 'fit' }] } },
  };
  assert.throws(() => parseAppConfig(app, 'test'), /has "sizing", which only a config file page takes/);
});
