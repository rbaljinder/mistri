/**
 * What a service desk asks of the platform, as the parsers take it: a conversation timeline (newest, composer, tone,
 * compact), a split that chooses its rows and its keys, a header that names its verbs, properties edited in place, a
 * quiet note, a heading left out, a footer group, and the theme roles that quiet the chrome.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { parseThemes } from '../packages/engine/src/shared/theme.js';
import { parseTestApp } from './support/commandCatalog.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { appProblems } from '../packages/mistri/src/server/app/apps.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

type Fragment = Record<string, unknown>;
const section = (body: Fragment) =>
  parsePagesConfig({ pages: [{ id: 'ticket', label: 'Ticket', base: 'ticket', sections: [body] }] }, 'pages')[0]
    .sections[0] as unknown as Record<string, unknown>;
const STREAM = { from: 'message', whose: 'ticket_id', at: 'sent_at', show: 'body' };
const timeline = (extra: Fragment = {}) => section({ kind: 'timeline', title: 'Conversation', streams: [STREAM], ...extra });

describe('a conversation timeline', () => {
  test('is oldest first, with a composer, tones and quiet system rows', () => {
    const got = timeline({
      newest: 'last',
      composer: { reply: 'reply', note: 'addNote' },
      tone: { kind: { internal: 'warn' } },
      compact: { kind: ['system'] },
    });
    assert.equal(got.newest, 'last');
    assert.deepEqual(got.composer, { reply: 'reply', note: 'addNote' });
    assert.deepEqual(got.tone, { kind: { internal: 'warn' } });
    assert.deepEqual(got.compact, { kind: ['system'] });
  });

  test('refuses what it cannot draw, by name', () => {
    assert.throws(() => timeline({ newest: 'sideways' }), /newest/);
    assert.throws(() => timeline({ composer: { note: 'addNote' } }), /reply/);
    assert.throws(() => timeline({ composer: { reply: 'reply' }, create: { label: 'Add' } }), /composer|create/);
    assert.throws(() => timeline({ tone: { kind: { internal: 'loud' } } }), /tone|loud/);
  });

  test('takes canned replies as a resource and its two columns', () => {
    const templates = { from: 'canned_reply', labelColumn: 'title', text: 'body' };
    assert.deepEqual(timeline({ composer: { reply: 'reply', templates } }).composer, { reply: 'reply', templates });
    assert.throws(
      () => timeline({ composer: { reply: 'reply', templates: { from: 'canned_reply', labelColumn: 'title' } } }),
      /needs "text"/,
    );
    assert.throws(() => timeline({ composer: { reply: 'reply', templates: { ...templates, tone: 'x' } } }), /tone/);
    // Which rows are offered: a condition, kept as written.
    assert.deepEqual(timeline({ composer: { reply: 'reply', templates: { ...templates, query: ' active = true ' } } }).composer, {
      reply: 'reply',
      templates: { ...templates, query: 'active = true' },
    });
    assert.throws(
      () => timeline({ composer: { reply: 'reply', templates: { ...templates, query: '' } } }),
      /"query" that is not a condition/,
    );
  });

  test("the App check reads a template's query against its resource", () => {
    const column = (name: string, type: string, primaryKey = false) => ({ name, type, nullable: !primaryKey, primaryKey });
    const table = (name: string, ...columns: ReturnType<typeof column>[]) => ({ id: name, name, schema: '', isView: false, columns });
    const schema = {
      label: 'Desk',
      dialect: 'sqlite',
      readAt: '',
      foreignKeys: [],
      tables: [
        table('ticket', column('id', 'INTEGER', true)),
        table('message', column('id', 'INTEGER', true), column('ticket_id', 'INTEGER'), column('sent_at', 'TEXT'), column('body', 'TEXT')),
        table('canned_reply', column('id', 'INTEGER', true), column('title', 'TEXT'), column('body', 'TEXT'), column('active', 'BOOLEAN')),
      ],
    } as unknown as DatabaseSchema;
    const app = parseAppConfig(
      {
        name: 'Desk',
        resources: { ticket: {}, message: {}, canned_reply: {} },
        views: { tickets: { kind: 'list', from: 'ticket' } },
        home: 'tickets',
      },
      'desk',
    );
    const problems = (query: string) => {
      const templates = { from: 'canned_reply', labelColumn: 'title', text: 'body', query };
      const pages = parsePagesConfig(
        {
          pages: [
            {
              id: 'ticket',
              label: 'Ticket',
              base: 'ticket',
              sections: [{ kind: 'timeline', title: 'Conversation', streams: [STREAM], composer: { reply: 'reply', templates } }],
            },
          ],
        },
        'pages',
      );
      return appProblems({ path: '/apps/desk/app.ts', app, pages, sources: {} } as never, schema).filter((p) => p.includes('templates'));
    };
    assert.deepEqual(problems('active = true'), []);
    assert.match(problems('retired = true').join('\n'), /the composer's templates: "query" does not read on "canned_reply": .*retired/);
  });
});

describe('a header names its verbs', () => {
  test('actions are a unique list, and the primary is one of them', () => {
    assert.deepEqual(
      (section({ kind: 'header', actions: ['reply', 'resolve'], primary: 'reply' }) as { headerActions?: string[] }).headerActions,
      ['reply', 'resolve'],
    );
    assert.throws(() => section({ kind: 'header', actions: [] }), /actions/);
    assert.throws(() => section({ kind: 'header', actions: ['reply', 'reply'] }), /actions/);
    assert.throws(() => section({ kind: 'header', actions: ['reply'], primary: 'resolve' }), /primary/);
  });

  test("a fact's word is said in facts; factLabels, the page's own reading, is refused with that spelling", () => {
    /* The published page model documents factLabels, from a field report: the refusal now says where the word goes. */
    const said = section({ kind: 'header', facts: [{ column: 'steps', after: { one: 'step', many: 'steps' } }] }) as {
      factLabels?: Record<string, unknown>;
    };
    assert.deepEqual(said.factLabels, { steps: { one: 'step', many: 'steps' } });
    assert.throws(
      () => section({ kind: 'header', facts: ['steps'], factLabels: { steps: { one: 'step', many: 'steps' } } }),
      /has no "factLabels": a fact's word is said in "facts" itself, as \{ column: 'steps'.* It takes: kind, status, facts/,
    );
  });
});

describe('fields and notes', () => {
  test('edit is true, on the fields a reader edits', () => {
    assert.equal(section({ kind: 'fields', show: ['status'], editable: true, presentation: 'properties' }).edit, true);
    assert.throws(() => section({ kind: 'fields', show: ['status'], edit: false }), /edit/);
    assert.throws(() => section({ kind: 'fields', show: ['status'], editable: true, presentation: 'facts' }), /edit/);
  });

  test('a note is quiet or a callout', () => {
    assert.equal(section({ kind: 'note', text: 'Mind the SLA.', variant: 'callout' }).variant, 'callout');
    assert.throws(() => section({ kind: 'note', text: 'Mind the SLA.', variant: 'loud' }), /variant/);
  });
});

describe('views and nav', () => {
  const RESOURCES = {
    ticket: {
      access: 'write',
      actions: { resolve: { label: 'Resolve', set: { status: 'done' } }, escalate: { label: 'Escalate', set: { status: 'hot' } } },
    },
  };
  const app = (view: Fragment, extra: Fragment = {}) =>
    parseTestApp(
      {
        name: 'x',
        resources: RESOURCES,
        auth: { roles: { agent: { read: true } } },
        views: { inbox: { kind: 'list', from: 'ticket', ...view } },
        home: 'inbox',
        nav: ['inbox'],
        ...extra,
      },
      'test/app.json',
    );
  const inbox = (view: Fragment) => (app(view).views as unknown as Record<string, Fragment>).inbox;

  test("a split chooses its rows in the queue's vocabulary and its keys from the resource's actions", () => {
    const got = inbox({
      split: { row: { primary: 'subject', lines: ['requester'], properties: ['priority'], badge: 'status', avatar: 'requester' } },
      shortcuts: { r: 'resolve', e: 'escalate' },
    });
    assert.deepEqual((got.presentation as { row?: unknown }).row, {
      primary: 'subject',
      lines: ['requester'],
      facts: ['priority'],
      badge: 'status',
      avatar: 'requester',
    });
    assert.deepEqual(got.keys, { r: 'resolve', e: 'escalate' });
  });

  test("refuses a key that runs nothing, takes the walk's own, or has no split to act on", () => {
    assert.throws(() => inbox({ split: {}, shortcuts: { x: 'nothing' } }), /does not declare/);
    assert.throws(() => inbox({ split: {}, shortcuts: { j: 'resolve' } }), /J and K/);
    assert.throws(() => inbox({ shortcuts: { r: 'resolve' } }), /split/);
    assert.throws(() => inbox({ split: { row: { lines: ['x'] } } }), /primary/);
  });

  test('heading is false or absent', () => {
    assert.equal(inbox({ heading: false }).heading, false);
    assert.throws(() => inbox({ heading: 'Inbox' }), /heading/);
  });

  test('a top-level nav group may be held at the foot', () => {
    const views = { inbox: { kind: 'list', from: 'ticket' }, help: { kind: 'list', from: 'ticket' } };
    const nav = app({}, { views, nav: ['inbox', { id: 'settings', label: 'Settings', placement: 'footer', children: ['help'] }] })
      .nav as Array<Record<string, unknown>>;
    assert.equal(nav[1].placement, 'footer');
    assert.throws(
      () =>
        app(
          {},
          { views, nav: [{ id: 'a', label: 'A', children: ['inbox', { id: 'b', label: 'B', placement: 'footer', children: ['help'] }] }] },
        ),
      /top level/,
    );
    assert.throws(() => app({}, { views, nav: ['inbox', { id: 'a', label: 'A', placement: 'header', children: ['help'] }] }), /placement/);
  });

  test('a top-level nav group may stand inline in the top bar, and is served so', () => {
    const views = { inbox: { kind: 'list', from: 'ticket' }, help: { kind: 'list', from: 'ticket' } };
    const nav = app({}, { views, nav: [{ id: 'places', label: 'Places', inline: true, children: ['inbox', 'help'] }] }).nav as Array<
      Record<string, unknown>
    >;
    assert.equal(nav[0].inline, true);
    assert.throws(
      () =>
        app({}, { views, nav: [{ id: 'a', label: 'A', children: ['inbox', { id: 'b', label: 'B', inline: true, children: ['help'] }] }] }),
      /top level/,
    );
    assert.throws(() => app({}, { views, nav: [{ id: 'a', label: 'A', inline: 'yes', children: ['help'] }] }), /"inline"/);
  });

  test('a nav group at any depth may start folded, and is served so', () => {
    const views = { inbox: { kind: 'list', from: 'ticket' }, help: { kind: 'list', from: 'ticket' } };
    const nav = app(
      {},
      {
        views,
        nav: [
          'inbox',
          { id: 'admin', label: 'Admin', folded: true, children: [{ id: 'more', label: 'More', folded: true, children: ['help'] }] },
        ],
      },
    ).nav as Array<Record<string, unknown>>;
    assert.equal(nav[1].folded, true);
    assert.equal((nav[1].children as Array<Record<string, unknown>>)[0].folded, true);
    assert.throws(() => app({}, { views, nav: [{ id: 'a', label: 'A', folded: false, children: ['help'] }] }), /"folded"/);
  });
});

describe('theme roles that quiet the chrome', () => {
  const theme = (light: Fragment) => ({
    id: 'quiet',
    label: 'Quiet',
    base: 'sage',
    light: { surface: '#ffffff', ink: '#222222', accent: '#006b73', ...light },
    dark: { surface: '#151515', ink: '#eeeeee', accent: '#87d8d3' },
  });
  test('rules, weight and the current nav entry are palette roles', () => {
    const [parsed] = parseThemes(
      [theme({ rulesSection: '#dddddd', rulesHead: '#999999', rulesWeight: '1px', navCurrent: '#e6f2f2', navOnCurrent: '#004b52' })],
      'app',
    )!;
    assert.equal(parsed.light.rulesWeight, '1px');
    assert.equal(parsed.light.navCurrent, '#e6f2f2');
  });
  test('refuses a weight it does not draw and a rule that is not a color', () => {
    assert.throws(() => parseThemes([theme({ rulesWeight: '9px' })], 'app'), /rulesWeight/);
    assert.throws(() => parseThemes([theme({ rulesSection: 'red; x' })], 'app'), /rulesSection/);
  });
});
