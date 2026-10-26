/**
 * The schema-typed layer checks what the docs say it checks: a `show`, a
 * card's lines, a label and a related list's `whose` are the table's own
 * columns and label paths, walked hop by hop through the generated
 * `References`; and a helper — `listView()`, `action()`, `related()` —
 * keeps the author's literal names, so the outer `satisfies` judges them
 * name by name. Each `@ts-expect-error` is a mistake
 * that used to compile and fail only at `mistri check`, or not at all.
 *
 * The schema is typed by the real generator, so these also pin what it
 * writes: the hops a path may take, and the table each lands on.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commandTypes, typesForSchema } from '../packages/mistri/src/server/typegen.js';
import type { ColumnMeta, DatabaseSchema, ForeignKey } from '../packages/engine/src/shared/schema.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const column = (name: string, type = 'text'): ColumnMeta => ({ name, type, nullable: name !== 'id', primaryKey: name === 'id' });
const table = (id: string, columns: string[]) => ({
  id,
  schema: 'main',
  name: id,
  isView: false,
  columns: columns.map((name) => column(name)),
});
const reference = (from: string, columns: string[], to: string, name = `${from}_${columns.join('_')}_fkey`): ForeignKey => ({
  name,
  from: { table: from, columns },
  to: { table: to, columns: columns.map(() => 'id') },
});

/* A help desk: a person is on a team and has a manager; a team has a lead;
   a ticket has an owner and a team; a reply belongs to a ticket and has an
   author. `audit` points twice at `ticket` over the same column, so that hop
   is only nameable by its constraints, and once through a composite key. */
const SCHEMA: DatabaseSchema = {
  label: 'helpdesk',
  dialect: 'sqlite',
  readAt: '2026-09-22',
  tables: [
    table('team', ['id', 'name', 'lead_id']),
    table('person', ['id', 'name', 'email', 'team_id', 'manager_id']),
    table('ticket', ['id', 'subject', 'status', 'priority', 'owner_id', 'team_id', 'closed_at', 'resolution']),
    table('reply', ['id', 'ticket_id', 'author_id', 'body', 'sent_at']),
    table('audit', ['id', 'ticket_id', 'team_id', 'note']),
  ],
  foreignKeys: [
    reference('team', ['lead_id'], 'person'),
    reference('person', ['team_id'], 'team'),
    reference('person', ['manager_id'], 'person'),
    reference('ticket', ['owner_id'], 'person'),
    reference('ticket', ['team_id'], 'team'),
    reference('reply', ['ticket_id'], 'ticket'),
    reference('reply', ['author_id'], 'person'),
    reference('audit', ['ticket_id'], 'ticket', 'audit_ticket_fkey'),
    reference('audit', ['ticket_id'], 'ticket', 'audit_ticket_again_fkey'),
    reference('audit', ['team_id', 'ticket_id'], 'ticket', 'audit_team_ticket_fkey'),
  ],
};

function compile(source: string, hidden: Record<string, string[]> = {}, files: Record<string, string> = {}, schema = SCHEMA) {
  const dir = mkdtempSync(join(ROOT, 'test', '.dsl-typing-'));
  try {
    writeFileSync(join(dir, 'mistri-schema.d.ts'), typesForSchema(schema, undefined, undefined, hidden));
    writeFileSync(join(dir, 'app.ts'), source);
    for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);
    return spawnSync(
      process.execPath,
      [
        join(ROOT, 'node_modules/typescript/bin/tsc'),
        '--noEmit',
        '--ignoreConfig',
        '--strict',
        '--skipLibCheck',
        '--module',
        'nodenext',
        '--moduleResolution',
        'nodenext',
        '--allowImportingTsExtensions',
        '--target',
        'es2022',
        '--pretty',
        'false',
        join(dir, 'app.ts'),
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: 120_000 },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the generator writes each hop a label path may take, and where it lands', () => {
  const types = typesForSchema(SCHEMA);
  assert.match(types, /^ {2}person: \{ manager_id: "person"; team_id: "team" \};$/m);
  assert.match(types, /^ {2}ticket: \{ owner_id: "person"; team_id: "team" \};$/m);
  assert.match(types, /^ {2}reply: \{ author_id: "person"; ticket_id: "ticket" \};$/m);
  // Two keys over one column are named by their constraints; a composite key by its columns joined with `+`.
  assert.match(
    types,
    /^ {2}audit: \{ audit_ticket_again_fkey: "ticket"; audit_ticket_fkey: "ticket"; "team_id\+ticket_id": "ticket" \};$/m,
  );
  assert.match(types, /^export type App = TypedAppConfig<Tables, References>;$/m);
  assert.match(types, /^export type Feature = TypedFeature<Tables, References>;$/m);
});

test('flag helpers, contributed IDs and generated value types retain the closed declaration contract', () => {
  const result = compile(`
    import { defineApp, defineFeature, flag, experiment, listView } from '@mistriwork/mistri/app';
    import type { AppConfig, FlagCapability, ExperimentDeclaration } from '@mistriwork/mistri/app';
    import type { Flags, FlagName } from './mistri-schema.js';
    import { useFlags } from '@mistriwork/mistri/ui';
    const epoch = experiment({ version: 'v1', unit: 'subject', control: 'a', startsAt: '2026-11-01T00:00:00.000Z',
      endsAt: '2026-11-15T00:00:00.000Z', conversionWindow: '48 hours', deliveryGrace: '24 hours',
      eligibility: { rollout: 100 }, allocation: [{ value: 'a', weight: 50 }, { value: 'b', weight: 50 }], primary: { conversion: 'submitted' } });
    const feature = defineFeature({ id: 'copy', flags: { heroCopy: flag.string('a', { owner: 'discovery', variants: ['a', 'b'], safeValue: 'a' }) },
      experiments: { heroCopy: epoch } });
    const app = defineApp({ name: 'Flags', resources: { ticket: {} }, home: 'tickets',
      views: { tickets: listView('Tickets', 'ticket') }, features: [feature],
      flags: { finder: flag.boolean(false, { owner: 'discovery' }) },
      auth: { roles: { release: { read: false, flags: [{ actions: ['manage'], environments: ['production'], owners: ['discovery'], ids: ['heroCopy', 'finder'] }],
        experiments: [{ actions: ['decide'], environments: ['production'], owners: ['discovery'], ids: ['heroCopy'] }] } } } });
    const name: FlagName<typeof app> = 'heroCopy';
    const values: Flags<typeof app> = { heroCopy: 'b', finder: true };
    const evaluated = useFlags<Flags<typeof app>>();
    const copyValue: 'a' | 'b' = evaluated.get('heroCopy');
    const enabledValue: boolean = evaluated.get('finder');
    // @ts-expect-error component SDK keys come from the composed manifest
    evaluated.get('missing');
    // @ts-expect-error a flag reader keeps the exact value type
    const notANumber: number = evaluated.get('finder');
    // @ts-expect-error unknown flag name
    const wrongName: FlagName<typeof app> = 'missing';
    // @ts-expect-error finite variant values are retained
    const wrongValue: Flags<typeof app>['heroCopy'] = 'c';
    // @ts-expect-error helper options are closed
    flag.string('a', { owner: 'discovery', typo: true });
    // @ts-expect-error boolean kills only return false
    flag.boolean(false, { owner: 'discovery', safeValue: true });
    // @ts-expect-error experiment declarations are closed
    experiment({ ...epoch, runtime: true });
    // @ts-expect-error eligibility cannot force a value
    experiment({ ...epoch, eligibility: { value: 'b' } });
    // @ts-expect-error metrics are closed
    experiment({ ...epoch, primary: { conversion: 'submitted', sql: 'select' } });
    // @ts-expect-error one malformed allocation arm cannot hide behind another valid arm
    experiment({ ...epoch, allocation: [{ value: 'a', weight: 50, typo: true }, { value: 'b', weight: 50 }] });
    // @ts-expect-error one malformed guardrail cannot hide behind another valid guardrail
    experiment({ ...epoch, guardrails: [{ conversion: 'withdrawn', maxIncrease: 0.02, sql: 'select' }, { conversion: 'abandoned', maxIncrease: 0.1 }] });
    const tooManyArms = [${Array.from({ length: 17 }, (_, i) => `{ value: '${i}', weight: 0 }`).join(', ')}] as const;
    const tooManyGuardrails = [${Array.from({ length: 17 }, (_, i) => `{ conversion: 'metric${i}', maxIncrease: 0.1 }`).join(', ')}] as const;
    // @ts-expect-error AN2 supports at most sixteen declared arms
    experiment({ ...epoch, allocation: tooManyArms });
    // @ts-expect-error AN2 supports at most sixteen declared guardrails
    experiment({ ...epoch, guardrails: tooManyGuardrails });
    // @ts-expect-error an experiment must have at least two arms
    experiment({ ...epoch, allocation: [{ value: 'a', weight: 100 }] });
    // @ts-expect-error management capabilities are separate vocabularies
    const cap: FlagCapability = { actions: ['decide'], environments: ['production'], owners: ['discovery'] };
    // @ts-expect-error a declared experiment key must name a flag
    defineApp({ name: 'Bad', home: 'items', views: { items: listView('Items', 'item') }, flags: { heroCopy: feature.flags.heroCopy }, experiments: { missing: epoch } });
    // @ts-expect-error a capability ID must name a contributed flag
    defineApp({ name: 'Bad', home: 'items', views: { items: listView('Items', 'item') }, flags: { heroCopy: feature.flags.heroCopy }, auth: { roles: { release: { read: false, flags: [{ actions: ['view'], environments: ['production'], owners: ['discovery'], ids: ['missing'] }] } } } });
    // @ts-expect-error raw definitions retain value kinds
    const bad: AppConfig['flags'] = { finder: { type: 'boolean', default: 'false', owner: 'discovery' } };
  `);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('appLink checks a type-only target manifest including feature contributions', () => {
  const result = compile(
    `
    import { appLink, defineApp, note, headline, page, dashboard } from '@mistriwork/mistri/app';
    import type targetManifest from './target.ts';
    type Target = typeof targetManifest;
    const home = appLink<Target>({ app: 'lender', kind: 'home' });
    const view = appLink<Target>({ app: 'lender', kind: 'view', view: 'overview' });
    const record = appLink<Target>({ app: 'lender', kind: 'record', resource: 'loan', key: { id: { column: 'id' } } });
    // @ts-expect-error wrong target App
    appLink<Target>({ app: 'leads', kind: 'home' });
    // @ts-expect-error missing view
    appLink<Target>({ app: 'lender', kind: 'view', view: 'missing' });
    // @ts-expect-error missing resource
    appLink<Target>({ app: 'lender', kind: 'record', resource: 'missing', key: { id: '1' } });
    // @ts-expect-error home cannot take a record key
    appLink<Target>({ app: 'lender', kind: 'home', key: { id: '1' } });
    defineApp({ id: 'leads', name: 'Leads', home: 'overview', resources: { application: {} },
      views: { overview: dashboard('Overview', [note('Continue', { action: { label: 'Lender', to: home } })]) },
      pages: { application: page('application', [
        note('Open record', { action: { label: 'Lender', to: record } }),
        headline('id', { links: [{ label: 'Lender', to: record }] }),
      ]) },
    });
  `,
    {},
    {
      'target.ts': `
    export default { id: 'lender', views: { applications: { kind: 'list' } }, resources: { application: {} },
      features: [{ id: 'extra', views: { overview: { kind: 'dashboard' } }, resources: { loan: {} } }] } as const;
  `,
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('show, paths, whose and helper literals are checked against the schema', () => {
  const compiled = compile(
    [
      'import { action, dashboard, fields, header, listView, metric, now, page, queue, related, rows, stream, timeline } from "@mistriwork/mistri/app";',
      'import type { App, Pages, Resources, Tables, Views } from "./mistri-schema.d.ts";',
      'import type { TypedAppConfig } from "@mistriwork/mistri/app";',
      '',
      "// What passes: columns, one- and two-hop paths, a caption, a longer path whose tail is the catalog's.",
      'const views = {',
      '  tickets: listView("Ticket", "ticket", { show: ["subject", "owner_id.name", "owner_id.team_id.name", "owner_id.team_id.lead_id.email"],',
      '    presentation: queue("subject", { lines: ["owner_id.name", "status"] }) }),',
      '  mine: listView("Mine", "ticket", { show: ["subject", "team_id.name"], filters: ["status"] }),',
      '  desk: dashboard("Desk", [rows("Recent", "ticket", { show: ["subject", "owner_id.name"] })]),',
      '} satisfies Views;',
      'const resources = {',
      '  ticket: { labels: { "owner_id.name": "Owner" }, recordLabel: "subject",',
      '    actions: { close: action("Close", { set: { status: "closed" }, reason: "resolution" }), reopen: action("Reopen", { set: { status: "open", closed_at: null } }) } },',
      '  person: { actions: { assign: action("Assign", { set: { name: "x" } }) } },',
      '  reply: { form: { defaults: { body: { from: "ticket_id.subject" }, sent_at: now } } },',
      '} satisfies Resources;',
      'const pages = {',
      '  ticket: page("ticket", [fields(["subject", "owner_id.name"]),',
      '    related("Replies", "reply", "ticket_id", { show: ["sent_at", { column: "author_id.name", label: "From" }] }),',
      '    // A list that only reads offers no Add; one that adds asks for its own columns.',
      '    related("Read only", "reply", "ticket_id", { create: false }),',
      '    related("Answer", "reply", "ticket_id", { create: { label: "Answer", show: ["body"], defaults: { sent_at: "now" } } }),',
      '    related("Their other tickets", "ticket", { same: ["owner_id"] }),',
      '    related("Like this", "ticket", { same: ["team_id"] }),',
      '    timeline("History", [stream("reply", "ticket_id", "sent_at", "body", { author: "author_id.name" })])]),',
      '  team: page("team", [metric("Replies to its tickets", "reply", { whose: "ticket_id.team_id" })]),',
      '  // A header that only names the verb to fill is the default head, told which.',
      '  person: page("person", [header({ primary: "assign" }), fields(["name"])]),',
      '} satisfies Pages;',
      'export default { name: "Helpdesk", resources, views, pages, home: "tickets" } satisfies App;',
      "// Without References, the first segment is still a column and the rest is the catalog's.",
      'export const open = { name: "Open", views: { t: listView("Ticket", "ticket", { show: ["owner_id.anything"] }) }, home: "t" } satisfies TypedAppConfig<Tables>;',
      '',
      '// @ts-expect-error A column the table does not have.',
      'export const typo = { t: listView("Ticket", "ticket", { show: ["statuz"] }) } satisfies Views;',
      '// @ts-expect-error The last name of a two-hop path is judged against the table it lands on.',
      'export const deep = { t: listView("Ticket", "ticket", { show: ["owner_id.team_id.nmae"] }) } satisfies Views;',
      '// @ts-expect-error A column that is not a reference cannot be followed.',
      'export const notHop = { t: listView("Ticket", "ticket", { show: ["subject.name"] }) } satisfies Views;',
      '// @ts-expect-error A queue says one hop at most.',
      'export const twoHopQueue = { t: listView("Ticket", "ticket", { presentation: queue("subject", { lines: ["owner_id.team_id.name"] }) }) } satisfies Views;',
      '// @ts-expect-error listView keeps its literals: a typo inside the helper fails where the view is checked.',
      'export const helperTypo = { t: listView("T", "ticket", { show: ["subjet"] }) } satisfies Views;',
      "// @ts-expect-error listView takes only a list view's keys.",
      'listView("T", "ticket", { shw: ["subject"] });',
      "// @ts-expect-error A dashboard list shows its own table's columns.",
      'export const dashTypo = { d: dashboard("D", [rows("Recent", "ticket", { show: ["subjet"] })]) } satisfies Views;',
      "// @ts-expect-error action() keeps its set's columns: one wrong beside a right one still fails.",
      'export const setTypo = { ticket: { actions: { close: action("Close", { set: { status: "closed", closed_att: null } }) } } } satisfies Resources;',
      '// @ts-expect-error The reason is a column too.',
      'export const reasonTypo = { ticket: { actions: { close: action("Close", { set: { status: "closed" }, reason: "resolutin" }) } } } satisfies Resources;',
      '// @ts-expect-error A label names a column or a label path.',
      'export const labelTypo = { ticket: { labels: { "owner_id.nmae": "Owner" } } } satisfies Resources;',
      "// @ts-expect-error A record page's fields are its base's.",
      'export const fieldsTypo = { t: page("ticket", [fields(["subjet"])]) } satisfies Pages;',
      "// @ts-expect-error A related list shows its own table's columns, through related().",
      'export const relatedShow = { t: page("ticket", [related("Replies", "reply", "ticket_id", { show: ["bdy"] })]) } satisfies Pages;',
      '// @ts-expect-error whose is a reference of the related table.',
      'export const whoseTypo = { t: page("ticket", [related("Replies", "reply", "tickt_id")]) } satisfies Pages;',
      "// @ts-expect-error A related list's New form asks for its own table's columns.",
      'export const createTypo = { t: page("ticket", [related("Replies", "reply", "ticket_id", { create: { label: "Add", show: ["bdy"] } })]) } satisfies Pages;',
      "// @ts-expect-error whose must lead back to the page's record, not to a table it cannot reach.",
      'export const whoseElsewhere = { t: page("team", [related("Replies", "reply", "ticket_id")]) } satisfies Pages;',
      "// @ts-expect-error A timeline stream walks back to the page's own record.",
      'export const streamElsewhere = { t: page("person", [timeline("History", [stream("reply", "ticket_id", "sent_at", "body")])]) } satisfies Pages;',
      "// @ts-expect-error A matched list names its own table's columns.",
      'export const similarTypo = { t: page("ticket", [related("Like this", "ticket", { same: ["tem_id"] })]) } satisfies Pages;',
      '// @ts-expect-error A value from a referenced record names a column of the table its reference lands on.',
      'export const fromTypo = { reply: { form: { defaults: { body: { from: "ticket_id.subjet" } } } } } satisfies Resources;',
      '// @ts-expect-error It takes one hop: a reference, then a column.',
      'export const fromDeep = { reply: { form: { defaults: { body: { from: "ticket_id.owner_id.name" } } } } } satisfies Resources;',
      '// @ts-expect-error A header says something: a status, facts, its primary or its destructive verbs.',
      'export const emptyHeader = { t: page("ticket", [header({})]) } satisfies Pages;',
    ].join('\n'),
  );
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
});

test('a typo in show reads as the name and the table it was judged against', () => {
  const compiled = compile(
    [
      'import type { Views } from "./mistri-schema.d.ts";',
      'export const views = { t: { kind: "list", from: "ticket", show: ["subject", "statuz"] } } satisfies Views;',
    ].join('\n'),
  );
  assert.notEqual(compiled.status, 0);
  assert.match(
    compiled.stdout,
    /error TS2820: Type '"statuz"' is not assignable to type 'LabelPath<Tables, References, "ticket">'\. Did you mean '"status"'\?/,
  );
});

/* A column no reader is served stays the App's: its own `hidden` names it on
   the second check as on the first, the access rules may name it, and a
   command's row carries it. Only a place that shows a column refuses it. */
test('hidden columns are typed apart: hidden and access rules take them, nothing that shows a column does', () => {
  const hidden = { ticket: ['resolution'], person: ['email'] };
  const types = typesForSchema(SCHEMA, undefined, undefined, hidden);
  assert.match(types, /^export type Hidden = \{\n {2}person: "email";\n {2}ticket: "resolution";\n\};$/m);
  assert.match(types, /^ {2}ticket: "id" \| "subject" \| "status" \| "priority" \| "owner_id" \| "team_id" \| "closed_at";$/m);
  assert.match(types, /^ {2}ticket: \{ id: string; .*; resolution: string \| null \};$/m);
  assert.match(types, /^export type App = TypedAppConfig<Tables, References, string, Hidden>;$/m);
  assert.match(types, /^export type Feature = TypedFeature<Tables, References, Hidden>;$/m);
  const compiled = compile(
    [
      'import type { App, Resources, Views, Pages } from "./mistri-schema.d.ts";',
      'import { page, fields, listView } from "@mistriwork/mistri/app";',
      'export const resources = {',
      '  ticket: { access: "write", hidden: ["resolution"], fields: { read: ["id", "subject", "resolution"] }, audit: { redact: ["resolution"] } },',
      '  person: { hidden: ["email"] },',
      '} satisfies Resources;',
      'export default { name: "Helpdesk", resources, views: { t: listView("Ticket", "ticket") }, home: "t",',
      '  auth: { roles: { agent: { read: true, fields: { ticket: { read: ["id", "subject", "resolution"] } } } }, me: { from: "person", column: "email" } } } satisfies App;',
      '// @ts-expect-error A hidden column is never shown.',
      'export const shown = { t: listView("Ticket", "ticket", { show: ["resolution"] }) } satisfies Views;',
      '// @ts-expect-error Nor on a record page.',
      'export const onPage = { t: page("ticket", [fields(["subject", "resolution"])]) } satisfies Pages;',
      '// @ts-expect-error Nor sorted by.',
      'export const sorted = { t: listView("Ticket", "ticket", { sort: "resolution desc" }) } satisfies Views;',
      '// @ts-expect-error A column the table does not have is still refused in hidden.',
      'export const typo = { ticket: { hidden: ["resolutoin"] } } satisfies Resources;',
      "// @ts-expect-error A role narrows a table's own columns.",
      'export const grant = { name: "H", auth: { roles: { agent: { read: true, fields: { ticket: { read: ["subjet"] } } } } } } satisfies App;',
    ].join('\n'),
    hidden,
  );
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
});

test("column names in a list's named orders, a board's sort, a search index and a dashboard's pick-filters are the schema's", () => {
  const compiled = compile(
    [
      'import type { Resources, Views } from "./mistri-schema.d.ts";',
      'import { board, dashboard, listView } from "@mistriwork/mistri/app";',
      'export const views = {',
      '  t: listView("Ticket", "ticket", { sort: [{ label: "Most urgent", sort: "priority desc" }, { label: "Subject", sort: "subject" }] }),',
      '  d: dashboard("Desk", [board("Board", "ticket", "status", { sort: "priority desc" })], { filters: ["team_id"] }),',
      '} satisfies Views;',
      'export const resources = { ticket: { search: { connection: "search", fields: ["subject"] }, address: "subject" } } satisfies Resources;',
      "// @ts-expect-error A named order sorts by its list's columns.",
      'export const named = { t: listView("Ticket", "ticket", { sort: [{ label: "Most urgent", sort: "priorty desc" }, { label: "Subject", sort: "subject" }] }) } satisfies Views;',
      "// @ts-expect-error A board sorts its cards by its table's columns.",
      'export const boardSort = { d: dashboard("Desk", [board("Board", "ticket", "status", { sort: "priorty" })]) } satisfies Views;',
      '// @ts-expect-error A pick-filter is a column of some table.',
      'export const pick = { d: dashboard("Desk", [], { filters: ["tem_id"] }) } satisfies Views;',
      "// @ts-expect-error A search index holds the resource's columns.",
      'export const index = { ticket: { search: { connection: "search", fields: ["subjet"] } } } satisfies Resources;',
      '// @ts-expect-error A natural key is one of its columns.',
      'export const address = { ticket: { address: "subjet" } } satisfies Resources;',
    ].join('\n'),
  );
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
});

test('an App split into features typechecks without casts: find, navGroup placement, a computed map, a stylesheet', () => {
  /* Each line here needed a cast in a large tenant App on 0.8.7 (G55). */
  const result = compile(
    `
    import { dashboard, defineApp, defineFeature, fields, find, header, listView, navGroup, page, action } from '@mistriwork/mistri/app';
    import type { App, Feature } from './mistri-schema.js';
    import './widget.css';
    const tickets = defineFeature({ id: 'tickets', resources: { ticket: { actions: { close: action('Close', { set: { status: 'closed' } }) } } },
      views: { tickets: listView('Tickets', 'ticket') },
      pages: { ticket: page('ticket', [header({ status: 'status', primary: 'close' }), fields(['subject'])]) } } satisfies Feature);
    const people = defineFeature({ id: 'people', resources: { person: {} }, views: { people: listView('People', 'person'),
      // Names from two features: the type kept only the names every feature shares, here none.
      finder: dashboard('Find', [find('Find anything', ['ticket', 'person'])]) } } satisfies Feature);
    // A map built from a table list is typed any; it erased every feature's actions, so the header above was refused.
    const tables = ['team', 'reply'] as const;
    const resources = Object.fromEntries([...tables.map((table) => [table, { owner: 'tenant' }])].map(([table, block]) => [table, block]));
    export default defineApp({ name: 'Split', resources, features: [tickets, people], home: 'tickets',
      views: { teams: listView('Teams', 'team') },
      nav: ['tickets', 'people', 'finder', navGroup('admin', 'Admin', ['teams'], { placement: 'footer', icon: 'gear' })],
    } satisfies App);
    defineApp({ name: 'Typed', resources: { team: {} }, features: [tickets, people], home: 'tickets',
      // @ts-expect-error a name no contributor declares is still refused
      views: { teams: listView('Teams', 'team'), lost: dashboard('Lost', [find('Find', ['ticket', 'nothing'])]) } });
    // @ts-expect-error a group's placement is the foot of the sidebar or nothing
    navGroup('admin', 'Admin', ['teams'], { placement: 'header' });
  `,
    {},
    { 'widget.css': '.widget { color: inherit; }' },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

/* The catalog as the App's own types see it: the ticket's segments ride on its table (appSegments.ts). */
const SEGMENTED: DatabaseSchema = {
  ...SCHEMA,
  tables: SCHEMA.tables.map((t) =>
    t.id === 'ticket' ? { ...t, segments: { open: 'status = open', urgent: 'open and priority = high' } } : t,
  ),
};

test('a list tab names a segment, with its own order in `sort`', () => {
  const compiled = compile(
    [
      'import type { Views } from "./mistri-schema.d.ts";',
      'import { listView } from "@mistriwork/mistri/app";',
      'export const views = { t: listView("Tickets", "ticket", { tabs: ["open", { segment: "urgent", sort: "priority desc" }, { label: "All", sort: "priority" }] }) } satisfies Views;',
    ].join('\n'),
    {},
    {},
    SEGMENTED,
  );
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
});

test('a segment misspelled — as a source, an option, a tab or a word in a query — is a type error where it is written', () => {
  const types = typesForSchema(SEGMENTED);
  assert.match(types, /export type Segments = \{\n {2}ticket: "open" \| "urgent";\n\};/);
  assert.match(types, /interface Register \{ schema\(\): \{ columns: Columns; references: References; segments: Segments \} \}/);
  const compiled = compile(
    [
      'import type { Views } from "./mistri-schema.d.ts";',
      'import { count, dashboard, listView, metric, rows } from "@mistriwork/mistri/app";',
      '// A rollup counts or sums the rows of a segment, as the segments doc says.',
      'export const urgent = count("ticket", { segment: "urgent" });',
      'export const openHigh = count("ticket", { segment: "open", query: "priority = high" });',
      '// @ts-expect-error — "urgnet" is not a segment of ticket',
      'export const typo = count("ticket", { segment: "urgnet" });',
      'export const views = {',
      '  d: dashboard("Home", [',
      '    metric("Urgent", "ticket.urgent"),',
      '    metric("Urgent, by name", "ticket", { segment: "urgent" }),',
      '    rows("Open and mine", "ticket", { query: "open and owner_id.name = sam" }),',
      '    // @ts-expect-error — "urgnet" is not a segment of ticket',
      '    metric("Typo", "ticket.urgnet"),',
      '    // @ts-expect-error — "nope" is not a segment of ticket',
      '    metric("Typo", "ticket", { segment: "nope" }),',
      '    // @ts-expect-error — a bare word is a segment, and "opne" is none',
      '    rows("Typo", "ticket", { query: "opne and priority = high" }),',
      '  ]),',
      '  // @ts-expect-error — a tab names a segment the ticket declares',
      '  t: listView("Tickets", "ticket", { tabs: ["opne"] }),',
      '} satisfies Views;',
    ].join('\n'),
    {},
    {},
    SEGMENTED,
  );
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
});

test('home may name a free-form page by its path, once the generated types name the pages', () => {
  const pages = commandTypes(undefined, 'Helpdesk', undefined, ['pick-walk']);
  const app = (home: string) =>
    [
      'import "./mistri-commands.d.ts";',
      'import { defineApp, listView } from "@mistriwork/mistri/app";',
      `export default defineApp({ name: "Helpdesk", resources: { ticket: {} }, views: { t: listView("Tickets", "ticket") }, home: ${home} });`,
    ].join('\n');
  for (const home of ['"pick-walk"', '[{ view: "pick-walk" }]', '"t"']) {
    const compiled = compile(app(home), {}, { 'mistri-commands.d.ts': pages });
    assert.equal(compiled.status, 0, `${home}: ${compiled.stdout}${compiled.stderr}`);
  }
  const typo = compile(app('"pick-wlak"'), {}, { 'mistri-commands.d.ts': pages });
  assert.notEqual(typo.status, 0, 'a path that is no page or view is a type error');
  assert.match(typo.stdout, /pick-wlak/);
});

test("a page's blocks take their section's words, each column typed to the block's resource", () => {
  const page = (show: string) => `
    import type {} from './mistri-schema.js';
    import { Rows, Metric, Tree } from '@mistriwork/mistri/page';
    Rows({ title: 'Open', from: 'ticket', show: [${show}], sort: 'subject', width: 'half' });
    Metric({ title: 'Open', from: 'ticket', query: 'status = open', better: 'down' });
    Tree({ from: 'person', parent: 'manager_id', primary: 'name' });
  `;
  const fine = compile(page("'subject', 'owner_id.name'"));
  assert.equal(fine.status, 0, fine.stdout + fine.stderr);
  const typo = compile(page("'subjet'"));
  assert.notEqual(typo.status, 0, 'a column the resource does not have is a type error');
  assert.match(typo.stdout, /subjet/);
});

test("a page's label and description take msg(), as a view's caption does", () => {
  const compiled = compile(`
    import type {} from './mistri-schema.js';
    import { msg } from '@mistriwork/mistri/app';
    import { definePage } from '@mistriwork/mistri/page';
    export default definePage({ label: msg('page.help.label'), description: msg('page.help.description'),
      reads: ['ticket'], component: () => null });
  `);
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
});

test("definePage takes no path: the file's name is the page's path", () => {
  const compiled = compile(`
    import type {} from './mistri-schema.js';
    import { definePage } from '@mistriwork/mistri/page';
    // @ts-expect-error The file's name is the path: pages/help.page.tsx is the page at /help.
    export default definePage({ path: 'help', label: 'Help', reads: ['ticket'], component: () => null });
  `);
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
});

test("every caption a reader sees takes msg(): a dashboard's, its sections', a document's, an action's, a nav group's, a step's", () => {
  const compiled = compile(`
    import { action, dashboard, document, embed, fields, firstRun, listView, metric, msg, navGroup, note, page, related, rows, step } from '@mistriwork/mistri/app';
    import type { Pages, Resources, Views } from './mistri-schema.d.ts';
    export const views = {
      tickets: listView(msg('ticket.plural'), 'ticket', { show: ['subject'], empty: { title: msg('ticket.none') } }),
      desk: dashboard(msg('desk.label'), [
        metric(msg('desk.open'), 'ticket', { query: 'status = open' }),
        rows(msg('desk.recent'), 'ticket', { show: ['subject'] }),
        note(msg('desk.note'), { title: msg('desk.noteTitle') }),
        firstRun(msg('desk.welcome'), [{ label: msg('desk.first'), to: 'tickets' }]),
        embed('tickets', { title: msg('desk.list') }),
      ], { description: msg('desk.description'), heading: msg('desk.heading') }),
    } satisfies Views;
    export const resources = {
      ticket: { actions: { close: action(msg('ticket.close'), { set: { status: 'closed' } }) } },
    } satisfies Resources;
    export const pages = {
      ticket: page('ticket', [fields(['subject'], { title: msg('ticket.details') }),
        related(msg('ticket.replies'), 'reply', 'ticket_id', { create: msg('ticket.reply') })]),
      slip: document('ticket', [fields(['subject'])], { label: msg('ticket.slip') }),
    } satisfies Pages;
    export const nav = [navGroup('work', msg('nav.work'), ['tickets', 'desk'])];
    export const asked = step(msg('form.contact'), ['name']);
  `);
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
});

/* A metric's typed query and a segment read a date phrase one way: `now` beside a timestamp is the
   instant, and beside a date the same, so either is accepted in both places or neither. */
const DATED: DatabaseSchema = {
  ...SCHEMA,
  tables: SCHEMA.tables.map((t) =>
    t.id === 'ticket'
      ? { ...t, columns: [...t.columns, { ...column('due_at'), type: 'timestamp with time zone' }, { ...column('due_on'), type: 'date' }] }
      : t,
  ),
};

test('`now` and the date phrases read the same in a segment and in a metric query, on a timestamp and on a date (G180)', () => {
  const compiled = compile(
    [
      'import type { Views } from "./mistri-schema.d.ts";',
      'import { dashboard, defineFeature, metric } from "@mistriwork/mistri/app";',
      'export const feature = defineFeature({',
      '  id: "late",',
      '  resources: { ticket: { segments: { late: "due_at < now", lateDay: "due_on < now", soon: "due_at = next 2 hours", quarter: "due_on = this quarter" } } },',
      '});',
      'export const views = {',
      '  d: dashboard("Home", [',
      '    metric("Late", "ticket", { query: "due_at < now" }),',
      '    metric("Late, by day", "ticket", { query: "due_on < now" }),',
      '    metric("Due soon", "ticket", { query: "due_at >= now and due_at = next 2 hours" }),',
      '    metric("Due this quarter", "ticket", { query: "due_on = this quarter or due_on = next quarter or due_on = last quarter" }),',
      '    // @ts-expect-error — a date is not a word',
      '    metric("Typo", "ticket", { query: "due_at < later" }),',
      '  ]),',
      '} satisfies Views;',
      'export const bad = defineFeature({',
      '  id: "bad",',
      '  // @ts-expect-error — the same word refused as a segment, as in the metric',
      '  resources: { ticket: { segments: { typo: "due_at < later" } } },',
      '});',
    ].join('\n'),
    {},
    {},
    DATED,
  );
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
});
