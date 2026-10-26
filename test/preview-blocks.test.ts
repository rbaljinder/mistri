/**
 * Three blocks a service desk asked for (0.8.13, Preview), as the parsers and the catalog check take them: a
 * conversation's other side (`side` on a timeline), a calendar's shaded spans (`backdrop`), and an author's component
 * on a dashboard as a record page places one.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePagesConfig, validatePage, type PageDef } from '../packages/engine/src/shared/page.js';
import { planPageSections } from '../packages/engine/src/shared/pagePlans.js';
import { timelineSide } from '../packages/engine/src/shared/pageModel.js';
import { resolveViews, type AppDashboardView, type AppListView } from '../packages/mistri/src/shared/app.js';
import { fieldAccessibleApp } from '../packages/mistri/src/server/app/appFieldProjection.js';
import type { DatabaseSchema, TableMeta } from '../packages/engine/src/shared/schema.js';
import { parseTestApp } from './support/commandCatalog.js';

const col = (name: string, type: string, primaryKey = false) => ({ name, type, nullable: !primaryKey, primaryKey });
const table = (id: string, columns: TableMeta['columns']): TableMeta => ({ id, name: id, schema: '', isView: false, columns });

/* A ticket, its caller, and the messages and calls its conversation merges; a change and the blackouts around it. */
const SCHEMA: DatabaseSchema = {
  label: 'Desk',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [
    { name: 'ticket_caller', from: { table: 'ticket', columns: ['caller_id'] }, to: { table: 'person', columns: ['id'] } },
    { name: 'message_ticket', from: { table: 'message', columns: ['ticket_id'] }, to: { table: 'ticket', columns: ['id'] } },
    { name: 'message_author', from: { table: 'message', columns: ['author_id'] }, to: { table: 'person', columns: ['id'] } },
    { name: 'ticket_company', from: { table: 'ticket', columns: ['company_id'] }, to: { table: 'company', columns: ['id'] } },
    { name: 'note_company', from: { table: 'company_note', columns: ['company_id'] }, to: { table: 'company', columns: ['id'] } },
    { name: 'work_ticket', from: { table: 'work_time', columns: ['ticket_id'] }, to: { table: 'ticket', columns: ['id'] } },
  ],
  tables: [
    table('person', [col('id', 'INTEGER', true), col('name', 'TEXT')]),
    table('company', [col('id', 'INTEGER', true), col('name', 'TEXT')]),
    table('ticket', [col('id', 'INTEGER', true), col('title', 'TEXT'), col('caller_id', 'INTEGER'), col('company_id', 'INTEGER')]),
    table('message', [
      col('id', 'INTEGER', true),
      col('ticket_id', 'INTEGER'),
      col('author_id', 'INTEGER'),
      col('body', 'TEXT'),
      col('kind', 'TEXT'),
      col('sent_at', 'DATETIME'),
    ]),
    table('company_note', [col('id', 'INTEGER', true), col('company_id', 'INTEGER'), col('body', 'TEXT'), col('written_at', 'DATETIME')]),
    /* Time logged on a ticket: its author is `person_id`, not `author_id`. */
    table('work_time', [
      col('id', 'INTEGER', true),
      col('ticket_id', 'INTEGER'),
      col('person_id', 'INTEGER'),
      col('note', 'TEXT'),
      col('logged_at', 'DATETIME'),
    ]),
    table('change', [col('id', 'INTEGER', true), col('title', 'TEXT'), col('starts_on', 'DATE'), col('ends_on', 'DATE')]),
    table('blackout', [
      col('id', 'INTEGER', true),
      col('name', 'TEXT'),
      col('starts_on', 'DATE'),
      col('ends_on', 'DATE'),
      col('note', 'TEXT'),
    ]),
  ],
};

const MESSAGES = { from: 'message', whose: 'ticket_id', at: 'sent_at', show: 'body', author: 'author_id' };
const page = (section: Record<string, unknown>): PageDef =>
  parsePagesConfig({ pages: [{ id: 'ticket', label: 'Ticket', base: 'ticket', sections: [section] }] }, 'pages')[0];
const conversation = (extra: Record<string, unknown> = {}, streams: unknown[] = [MESSAGES]) =>
  page({ kind: 'timeline', title: 'Conversation', streams, newest: 'last', ...extra });

describe("a conversation's other side", () => {
  test('is a condition, kept as written, beside newest, tone and compact', () => {
    const section = conversation({
      side: ' author_id = record.caller_id ',
      tone: { kind: { internal: 'warn' } },
      compact: { kind: ['system'] },
    }).sections[0] as { side?: string; newest?: string };
    assert.equal(section.side, 'author_id = record.caller_id');
    assert.equal(section.newest, 'last');
    assert.throws(() => conversation({ side: '' }), /"side" that is not a condition like "author_id = record.caller_id"/);
    assert.throws(() => conversation({ side: 7 }), /"side" that is not a condition/);
  });

  test("names the record by the stream's own way back to it, and never inside a quoted value", () => {
    assert.equal(timelineSide('author_id = record.caller_id', { path: 'ticket_id' }), 'author_id = ticket_id.caller_id');
    assert.equal(
      timelineSide("body = 'record.caller_id' or author_id = record.caller_id", { path: 'ticket_id' }),
      "body = 'record.caller_id' or author_id = ticket_id.caller_id",
    );
    assert.equal(timelineSide('kind = customer', { path: 'ticket_id', of: 'company_id' }), 'kind = customer');
    assert.equal(timelineSide('author_id = record.caller_id', { path: 'company_id', of: 'company_id' }), undefined);
  });

  test('is judged against every stream by the real parser, in the words the author wrote', () => {
    assert.equal(validatePage(SCHEMA, conversation({ side: 'author_id = record.caller_id' })).error, undefined);
    assert.equal(validatePage(SCHEMA, conversation({ side: "kind = 'customer'" })).error, undefined);
    assert.match(validatePage(SCHEMA, conversation({ side: 'writer_id = record.caller_id' })).error ?? '', /"side":.*writer_id/);
    assert.match(
      validatePage(SCHEMA, conversation({ side: 'author_id = record.calller_id' })).error ?? '',
      /"side": "calller_id" is not a column on ticket\. Did you mean "caller_id"\?/,
    );
    assert.match(validatePage(SCHEMA, conversation({ side: 'author_id = 1 sort sent_at' })).error ?? '', /"side": it is a condition/);
    /* A stream about another row has no way back to the record: never on a side that names it, and refused one of its own. */
    const about = { from: 'company_note', whose: 'company_id', about: 'company_id', at: 'written_at', show: 'body' };
    assert.equal(validatePage(SCHEMA, conversation({ side: 'author_id = record.caller_id' }, [MESSAGES, about])).error, undefined);
    assert.match(
      validatePage(SCHEMA, conversation({ side: 'author_id = record.caller_id' }, [about])).error ?? '',
      /stream "company_note": "side" names the record \(record\.…\), and this stream is about "company_id"/,
    );
    assert.match(
      validatePage(SCHEMA, conversation({}, [MESSAGES, { ...about, side: 'company_id = record.company_id' }])).error ?? '',
      /stream "company_note": "side" names the record/,
    );
  });

  const WORK = { from: 'work_time', whose: 'ticket_id', at: 'logged_at', show: 'note', author: 'person_id' };
  const sidesOf = (def: PageDef) =>
    (
      planPageSections(SCHEMA, def, { id: 7 }, {}, new Date(0)) as Array<{ streams: Array<{ side?: { view?: { filter?: unknown } } }> }>
    )[0].streams.map((stream) => (stream.side ? JSON.stringify(stream.side.view?.filter) : undefined));

  test('applies to each stream whose table has its columns; a stream without them is never on the far side', () => {
    // The work-time stream has no author_id: it is read in full, and none of its rows is the caller's.
    const def = conversation({ side: 'author_id = record.caller_id' }, [MESSAGES, WORK]);
    assert.equal(validatePage(SCHEMA, def).error, undefined);
    const [messages, work] = sidesOf(def);
    assert.match(messages ?? '', /author_id/);
    assert.equal(work, undefined);
    // A column no stream has is still named, by the first stream that cannot read it.
    assert.match(
      validatePage(SCHEMA, conversation({ side: 'writer_id = record.caller_id' }, [MESSAGES, WORK])).error ?? '',
      /stream "message": "side":.*writer_id/,
    );
  });

  test("a stream's own side replaces the section's, and is judged on that stream alone", () => {
    const def = conversation({ side: 'author_id = record.caller_id' }, [MESSAGES, { ...WORK, side: 'person_id = record.caller_id' }]);
    assert.equal(validatePage(SCHEMA, def).error, undefined);
    assert.equal((def.sections[0] as { streams: Array<{ side?: string }> }).streams[1].side, 'person_id = record.caller_id');
    const [messages, work] = sidesOf(def);
    assert.match(messages ?? '', /author_id/);
    assert.match(work ?? '', /person_id/);
    // Alone, without the section's.
    assert.deepEqual(sidesOf(conversation({}, [MESSAGES, { ...WORK, side: 'person_id = record.caller_id' }]))[0], undefined);
    assert.match(
      validatePage(SCHEMA, conversation({}, [MESSAGES, { ...WORK, side: 'author_id = record.caller_id' }])).error ?? '',
      /stream "work_time": "side":.*author_id/,
    );
    assert.throws(() => conversation({}, [{ ...WORK, side: ' ' }]), /stream 1 has a "side" that is not a condition/);
    // Every stream saying its own leaves the section's read by none: refused rather than ignored.
    assert.match(
      validatePage(
        SCHEMA,
        conversation({ side: 'author_id = record.caller_id' }, [
          { ...MESSAGES, side: 'kind = customer' },
          { ...WORK, side: 'person_id = record.caller_id' },
        ]),
      ).error ?? '',
      /"side" is read by no stream/,
    );
  });

  const marksOf = (def: PageDef) =>
    (
      planPageSections(SCHEMA, def, { id: 7 }, {}, new Date(0)) as Array<{
        streams: Array<{ view?: { columns?: Array<{ path: string }> } }>;
      }>
    )[0].streams.map((stream) => (stream.view?.columns ?? []).map((column) => column.path).includes('kind'));

  test('tone and compact rules are read on each stream that has their column; a stream may say its own', () => {
    const rules = { tone: { kind: { internal: 'warn' } }, compact: { kind: ['system'] } };
    // Time logged has no `kind`: the rules are read on the messages, and the time lines say their own dress.
    const def = conversation(rules, [MESSAGES, { ...WORK, compact: true, tone: 'neutral' }]);
    assert.equal(validatePage(SCHEMA, def).error, undefined);
    const streams = (def.sections[0] as { streams: Array<{ tone?: string; compact?: boolean }> }).streams;
    assert.deepEqual([streams[1].tone, streams[1].compact], ['neutral', true]);
    assert.deepEqual(marksOf(def), [true, false]);
    // Without its own, a stream that lacks the column is simply not dressed by the rule.
    assert.equal(validatePage(SCHEMA, conversation(rules, [MESSAGES, WORK])).error, undefined);
    // A rule no stream reads is a slip, named.
    assert.match(
      validatePage(SCHEMA, conversation(rules, [WORK])).error ?? '',
      /the "tone" or "compact" column "kind" is read by no stream: it is not a column on work_time/,
    );
    assert.match(
      validatePage(SCHEMA, conversation({ compact: { kind: ['system'] } }, [{ ...MESSAGES, compact: true }])).error ?? '',
      /"kind" is read by no stream/,
    );
    assert.throws(() => conversation({}, [{ ...WORK, compact: false }]), /stream 1 has a "compact" that is not true/);
    assert.throws(
      () => conversation({}, [{ ...WORK, tone: 'loud' }]),
      /stream 1 has a "tone" that is not one of good, warn, bad, info, neutral/,
    );
  });

  test('is planned as the same read narrowed by it, the rows told apart by their keys', () => {
    const def = conversation({ side: 'author_id = record.caller_id', limit: 30 });
    const [plan] = planPageSections(SCHEMA, def, { id: 7 }, {}, new Date(0)) as Array<{
      streams: Array<{ key?: string[]; view?: { columns?: Array<{ path: string }>; limit?: number }; side?: { view?: unknown } }>;
    }>;
    const [stream] = plan.streams;
    assert.deepEqual(stream.key, ['id']);
    assert.ok(
      stream.view?.columns?.some((column) => column.path === 'id'),
      'the read carries the key',
    );
    const side = stream.side?.view as { columns: Array<{ path: string }>; limit: number; filter: { groups: unknown[][] } };
    assert.deepEqual(
      side.columns.map((column) => column.path),
      ['id'],
    );
    assert.equal(side.limit, 30);
    assert.match(JSON.stringify(side.filter), /ticket_id\.caller_id/);
    // Without a side, nothing more is read.
    const [plain] = planPageSections(SCHEMA, conversation(), { id: 7 }, {}, new Date(0)) as Array<{
      streams: Array<{ side?: unknown; view?: { columns?: Array<{ path: string }> } }>;
    }>;
    assert.equal(plain.streams[0].side, undefined);
    assert.equal(
      plain.streams[0].view?.columns?.some((column) => column.path === 'id'),
      false,
    );
  });
});

describe("a calendar's shaded spans", () => {
  const app = (backdrop: unknown, resources: Record<string, unknown> = { change: {}, blackout: {} }) =>
    parseTestApp(
      {
        name: 'Changes',
        resources,
        views: {
          changes: {
            kind: 'list',
            from: 'change',
            presentation: { kind: 'calendar', date: 'starts_on', end: 'ends_on', primary: 'title', backdrop },
          },
        },
        home: 'changes',
        nav: ['changes'],
      },
      'backdrop fixture',
    );
  const SPAN = { from: 'blackout', start: 'starts_on', end: 'ends_on', labelColumn: 'name', tone: 'warn' };
  const judged = (backdrop: unknown) => (resolveViews(app(backdrop), SCHEMA).changes as { error?: string }).error;

  test('take one kind or several, each a resource, its two dates, a label and a tone', () => {
    const view = app(SPAN).views.changes as AppListView;
    assert.deepEqual((view.presentation as { backdrop?: unknown }).backdrop, [SPAN]);
    const two = app([SPAN, { ...SPAN, tone: undefined, labelColumn: 'note' }]).views.changes as AppListView;
    assert.equal((two.presentation as { backdrop?: unknown[] }).backdrop?.length, 2);
    assert.equal(judged(SPAN), undefined);
  });

  test('refuse what they cannot shade, by name', () => {
    assert.throws(() => app([]), /shades one to 4 kinds of span/);
    assert.throws(() => app([SPAN, SPAN, SPAN, SPAN, SPAN]), /shades one to 4 kinds of span/);
    assert.throws(() => app({ ...SPAN, tone: 'loud' }), /"tone" of "loud"\. Use good, warn, bad, info, neutral/);
    assert.throws(() => app({ ...SPAN, from: '' }), /has no "from"/);
    assert.throws(() => app({ ...SPAN, resource: 'blackout' }), /has "resource", which is now "from"/);
    assert.throws(() => app({ ...SPAN, colour: 'red' }), /colour/);
    assert.throws(() => app({ ...SPAN, start: 'person_id.starts_on' }), /start/);
    assert.throws(() => app(SPAN, { change: {} }), /blackout/);
  });

  test('are judged against the catalog: their table, two date columns and a label', () => {
    assert.match(judged({ ...SPAN, start: 'name' }) ?? '', /Calendar backdrop start: "name" is TEXT; a span runs between date columns/);
    assert.match(judged({ ...SPAN, end: 'missing' }) ?? '', /Calendar backdrop end: "missing" is not a column of "blackout"/);
    assert.match(
      judged({ ...SPAN, labelColumn: 'missing' }) ?? '',
      /Calendar backdrop labelColumn: "missing" is not a column of "blackout"/,
    );
  });

  test('are left out for a reader who cannot read them, and the calendar stands without them', () => {
    const without: DatabaseSchema = { ...SCHEMA, tables: SCHEMA.tables.filter((t) => t.id !== 'blackout') };
    const projected = fieldAccessibleApp(app(SPAN), without).views.changes as AppListView;
    assert.equal(projected.presentation?.kind, 'calendar');
    assert.equal((projected.presentation as { backdrop?: unknown }).backdrop, undefined);
    const readable = fieldAccessibleApp(app(SPAN), SCHEMA).views.changes as AppListView;
    assert.deepEqual((readable.presentation as { backdrop?: unknown }).backdrop, [SPAN]);
  });
});

describe('a custom section on a dashboard', () => {
  const component = { id: 'breaching', kind: 'section', module: './widgets/Breaching.tsx' };
  const app = (section: Record<string, unknown>, aside = false) =>
    parseTestApp(
      {
        name: 'Desk',
        resources: { ticket: {} },
        views: {
          tickets: { kind: 'list', from: 'ticket' },
          home: {
            kind: 'dashboard',
            label: 'Desk',
            windows: ['last 7 days', 'last 30 days'],
            [aside ? 'aside' : 'sections']: [{ kind: 'custom', title: 'Breaching now', component, ...section }],
            ...(aside ? { sections: [{ kind: 'metric', title: 'Open', from: 'ticket' }] } : {}),
          },
        },
        home: 'home',
        nav: ['home', 'tickets'],
      },
      'dashboard custom fixture',
    );

  test("takes a page's component, reads, props and the width keys every section takes, in the main flow or the aside", () => {
    const main = (app({ width: 'half', rows: { open: { from: 'ticket', show: ['id', 'title'] } } }).views.home as AppDashboardView)
      .sections[0];
    assert.equal(main.kind, 'custom');
    assert.equal((main as { width?: string }).width, 'half');
    const aside = (app({}, true).views.home as AppDashboardView).aside?.[0];
    assert.equal(aside?.kind, 'custom');
    assert.throws(() => app({ width: 'wide' }), /"width" of "wide"/);
    assert.throws(() => app({ record: ['id'] }), /record/);
  });
});
