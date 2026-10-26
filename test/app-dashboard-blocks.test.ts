/**
 * The dashboard building blocks the Tray look asked for, as authored: a
 * section's own windows (named in the address by its title), a list embed
 * that works as its room, an activity feed across resources, a display
 * rule's photo avatar and its value icons. Each is parsed here, refused by
 * name where it cannot mean anything, and judged against the catalog.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppConfig, resolveDisplay, resolveViews, type AppDashboardView } from '../packages/mistri/src/shared/app.js';
import { appAddressBook, routeTable } from '../packages/mistri/src/shared/appAddress.js';
import { areaBox, gridTemplateAreas, layoutAreas, layoutGrid, reflowLayout } from '../packages/engine/src/shared/dashLayout.js';
import { iconGlyphsIn } from '../packages/mistri/src/server/app/iconPayload.js';
import { historyRules } from '../packages/mistri/src/server/recordHistory.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const column = (name: string, type = 'TEXT', primaryKey = false) => ({ name, type, nullable: !primaryKey, primaryKey });
const schema: DatabaseSchema = {
  label: 'Blocks',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [
    { name: 'photo_person', from: { table: 'photo', columns: ['person_id'] }, to: { table: 'person', columns: ['id'] } },
  ] as DatabaseSchema['foreignKeys'],
  tables: [
    { id: 'person', name: 'person', schema: '', isView: false, columns: [column('id', 'INTEGER', true), column('name')] },
    {
      id: 'photo',
      name: 'photo',
      schema: '',
      isView: false,
      columns: [column('id', 'INTEGER', true), column('person_id', 'INTEGER'), column('data', 'BLOB'), column('file_name')],
    },
    {
      id: 'task',
      name: 'task',
      schema: '',
      isView: false,
      columns: [column('id', 'INTEGER', true), column('title'), column('status'), column('priority'), column('due_on', 'DATE')],
    },
  ],
};

const app = (views: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  parseAppConfig(
    {
      name: 'Blocks',
      resources: {
        task: {
          display: { priority: { tone: { high: 'bad', '*': 'neutral' }, icons: { high: 'cell-signal-high', low: 'cell-signal-low' } } },
        },
        person: { display: { name: { avatar: { from: 'photo', whose: 'person_id' } } } },
        photo: { file: { content: 'data', name: 'file_name' } },
      },
      views: { tasks: { kind: 'list', from: 'task', show: ['title', 'status'], actions: undefined }, ...views },
      home: 'tasks',
      nav: ['tasks', ...('overview' in views ? ['overview'] : [])],
      ...extra,
    },
    'blocks fixture',
  );

const dash = (sections: unknown[], aside?: unknown[]) => ({
  overview: { kind: 'dashboard', label: 'Overview', sections, ...(aside ? { aside } : {}) },
});

test("a section with its own windows is named in the address by its title, and its phrases are judged like the dashboard's", () => {
  const parsed = app(
    dash([
      { kind: 'chart', title: 'Tasks by day', from: 'task', by: 'day due_on', over: 'due_on', windows: ['last 7 days', 'last 30 days'] },
      { kind: 'metric', title: 'Open', from: 'task', query: 'status = open' },
    ]),
  );
  const section = (parsed.views.overview as AppDashboardView).sections[0];
  assert.equal(section.windowKey, 'tasks-by-day');
  assert.deepEqual(section.windows, ['last 7 days', 'last 30 days']);
  const served = resolveViews(parsed, schema).overview as AppDashboardView;
  assert.equal(served.error, undefined, served.error);
  // No section follows the dashboard's window, so it offers none.
  assert.equal(served.windows, undefined);
  const rows = routeTable(
    appAddressBook({ views: parsed.views, order: ['tasks', 'overview'], resources: {}, pages: [], tables: schema.tables }),
    '/blocks',
  );
  assert.ok(
    rows.some((row) => row.path === '/blocks/overview?period.tasks-by-day=…'),
    JSON.stringify(rows),
  );
  const bad = resolveViews(
    app(dash([{ kind: 'chart', title: 'By day', from: 'task', by: 'day due_on', over: 'due_on', windows: ['last fortnight'] }])),
    schema,
  ).overview as AppDashboardView;
  assert.match(bad.error ?? '', /By day/);
});

test('windows without an over, two sections with one name, and a board embed with windows are refused by name', () => {
  assert.throws(
    () => app(dash([{ kind: 'chart', title: 'A', from: 'task', by: 'status', windows: ['last 7 days'] }])),
    /"windows" and no "over"/,
  );
  assert.throws(
    () =>
      app(
        dash([
          { kind: 'chart', title: 'By day', from: 'task', by: 'day due_on', over: 'due_on', windows: ['last 7 days'] },
          { kind: 'breakdown', title: 'By-day', from: 'task', by: 'status', over: 'due_on', windows: ['last 7 days'] },
        ]),
      ),
    /read as "by-day" in the address/,
  );
  assert.throws(
    () => app(dash([{ kind: 'chart', title: 'A', from: 'task', by: 'status', over: 'due_on', windows: ['last 7 days', 'Last 7 days'] }])),
    /twice/,
  );
  assert.throws(() => app(dash([{ kind: 'note', text: 'x', windows: ['last 7 days'] }])), /windows/);
});

test('an interactive embed is a list in the main flow: not in the aside, not a board', () => {
  const parsed = app(dash([{ kind: 'view', view: 'tasks', interactive: true }]));
  assert.equal((parsed.views.overview as AppDashboardView).sections[0].interactive, true);
  assert.throws(
    () => app(dash([{ kind: 'note', text: 'x' }], [{ kind: 'view', view: 'tasks', interactive: true }])),
    /interactive in the aside/,
  );
  assert.throws(
    () =>
      app({
        board: { kind: 'list', from: 'task', board: { by: 'status', primary: 'title' } },
        ...dash([{ kind: 'view', view: 'board', interactive: true }]),
      }),
    /read-only/,
  );
  assert.throws(() => app(dash([{ kind: 'view', view: 'tasks', interactive: 'yes' }])), /"interactive" that is not true or false/);
});

test('an activity names declared resources, each with a mark, and turns their history on', () => {
  const parsed = app(
    dash(
      [{ kind: 'note', text: 'x' }],
      [{ kind: 'activity', title: 'Latest', resources: { task: { icon: 'check-circle' }, person: {} }, limit: 6 }],
    ),
  );
  const section = (parsed.views.overview as AppDashboardView).aside![0];
  assert.deepEqual(section.resources, { task: { icon: 'check-circle' }, person: {} });
  assert.deepEqual([...historyRules(parsed, []).keys()].sort(), ['person', 'task']);
  assert.throws(() => app(dash([{ kind: 'activity', resources: {} }])), /one to twelve resources/);
  assert.throws(() => app(dash([{ kind: 'activity', resources: { nothing: {} } }])), /nothing/);
  assert.throws(() => app(dash([{ kind: 'activity', resources: { task: { icon: 'kanbam' } } }])), /not one of the App icons/);
  assert.throws(() => app(dash([{ kind: 'activity', resources: { task: {} }, limit: 51 }])), /1 to 50/);
  assert.throws(() => app(dash([{ kind: 'activity', resources: { task: {} }, over: 'due_on' }])), /over/);
});

test("a value's icons and a person's photo parse, resolve against the catalog and send their glyphs", () => {
  const parsed = app({});
  const { display, warnings } = resolveDisplay(parsed, schema);
  assert.deepEqual(display['person.name'].avatar, { from: 'photo', whose: 'person_id' });
  assert.deepEqual(display['task.priority'].icons, { high: 'cell-signal-high', low: 'cell-signal-low' });
  assert.deepEqual(warnings, []);
  assert.deepEqual(Object.keys(iconGlyphsIn(parsed.resources) ?? {}).sort(), ['cell-signal-high', 'cell-signal-low']);
  // A reader whose catalog leaves out the photos keeps the initials, and nothing is said.
  const narrow = { ...schema, tables: schema.tables.filter((table) => table.id !== 'photo'), foreignKeys: [] };
  assert.equal(resolveDisplay(parsed, narrow).display['person.name'].avatar, true);
  // A photo resource that is not files, or a column that does not point here, is the author's typo.
  const wrong = parseAppConfig(
    {
      name: 'Wrong',
      resources: { person: { display: { name: { avatar: { from: 'task', whose: 'id' } } } }, task: {} },
      views: { tasks: { kind: 'list', from: 'task' } },
      home: 'tasks',
      nav: ['tasks'],
    },
    'wrong fixture',
  );
  assert.match(resolveDisplay(wrong, schema).warnings.join('\n'), /not a resource whose rows are files/);
  const refuse = (rule: unknown) => () =>
    parseAppConfig(
      {
        name: 'R',
        resources: { task: { display: { priority: rule } } },
        views: { tasks: { kind: 'list', from: 'task' } },
        home: 'tasks',
        nav: ['tasks'],
      },
      'refuse fixture',
    );
  assert.throws(refuse({ icons: { high: 'nope' } }), /not one of the App icons/);
  assert.throws(refuse({ icons: {} }), /value → App icon/);
  assert.throws(refuse({ icons: { high: 'fire' }, avatar: true }), /not both/);
  assert.throws(refuse({ icons: { high: 'fire' }, format: 'money' }), /figure/);
  assert.throws(refuse({ avatar: { from: 'photo' } }), /"whose"/);
  assert.throws(refuse({ avatar: 'yes' }), /"avatar" that is not true/);
});

test('a display rule says stored values as words beside its tone, and a figure takes none', () => {
  const said = (rule: unknown) =>
    parseAppConfig(
      {
        name: 'W',
        resources: { task: { display: { status: rule } } },
        views: { tasks: { kind: 'list', from: 'task' } },
        home: 'tasks',
        nav: ['tasks'],
      },
      'words fixture',
    );
  const parsed = said({ values: { PUB: ' Published ' }, tone: { PUB: 'good' } });
  assert.deepEqual(resolveDisplay(parsed, schema).display['task.status'], {
    values: { PUB: 'Published' },
    humanize: true,
    tone: { PUB: 'good' },
  });
  assert.throws(() => said({ values: {} }), /stored value → word/);
  assert.throws(() => said({ values: { PUB: '' } }), /"PUB" a word/);
  assert.throws(() => said({ humanize: false }), /has no "humanize"/);
  assert.throws(() => said({ values: { PUB: 'Published' }, format: 'money' }), /a figure/);
  assert.throws(() => said({ values: { PUB: 'Published' }, bar: 5 }), /a figure/);
});

test('a funnel is parsed with its stages, judged a stage at a time, and refused by name where it cannot mean anything', () => {
  const stages = [
    { label: 'Created' },
    { label: 'Started', query: 'status in (doing, done)' },
    { label: 'Shipped', query: 'status = done' },
  ];
  const parsed = app(dash([{ kind: 'funnel', title: 'Task road', from: 'task', query: 'priority != low', stages, to: false }]));
  const section = (parsed.views.overview as AppDashboardView).sections[0];
  assert.equal(section.kind, 'funnel');
  assert.deepEqual(section.stages, stages);
  assert.equal(section.noDrill, true);
  const served = resolveViews(parsed, schema).overview as AppDashboardView;
  assert.equal(served.error, undefined, served.error);

  // A stage that names a column the table does not have is refused by the stage's title.
  const missing = resolveViews(
    app(
      dash([
        {
          kind: 'funnel',
          title: 'Road',
          from: 'task',
          stages: [{ label: 'Created' }, { label: 'Late', query: 'overdue_since is not empty' }],
        },
      ]),
    ),
    schema,
  ).overview as AppDashboardView;
  assert.match(missing.error ?? '', /stage "Late"/);

  const refused = (funnel: Record<string, unknown>) => () =>
    app(dash([{ kind: 'funnel', title: 'Road', from: 'task', stages, ...funnel }]));
  assert.throws(refused({ stages: [{ label: 'Only' }] }), /needs "stages": 2 to 8/);
  assert.throws(refused({ stages: [{ label: 'A' }, { label: 'a' }] }), /repeats the label "a"/);
  assert.throws(refused({ stages: [{ label: 'A', optional: true }, { label: 'B' }] }), /first stage is every row/);
  assert.throws(refused({ stages: [{ label: 'A' }, { label: 'B', query: 'status = done order by id' }] }), /conditions/);
  assert.throws(refused({ by: 'status' }), /"by"/);
  // Renamed before 1.0: a stage's words are its label, and the old key says so rather than being ignored.
  assert.throws(refused({ stages: [{ title: 'A' }, { label: 'B' }] }), /stage 1 has "title", which is now "label"/);
  // The chart shape it replaces says where it went rather than drawing something else.
  assert.throws(
    () => app(dash([{ kind: 'chart', title: 'Road', from: 'task', by: 'status', shape: 'funnel' }])),
    /which is now funnel\(title, from, stages\)/,
  );
});

/* ---------- areas: sections placed in the areas of a grid ---------- */

const metricIn = (area: string, title = `Open ${area}`) => ({ kind: 'metric', title, from: 'task', query: 'status = open', area });
const laid = (sections: unknown[], areas: unknown, extra: Record<string, unknown> = {}) =>
  app({ overview: { kind: 'dashboard', label: 'Overview', sections, areas, ...extra } });
const sound = [
  metricIn('kpis'),
  { kind: 'chart', title: 'Tasks by day', from: 'task', by: 'day due_on', area: 'trend' },
  { kind: 'funnel', title: 'Road', from: 'task', stages: [{ label: 'Created' }, { label: 'Done', query: 'status = done' }], area: 'side' },
  { kind: 'breakdown', title: 'By status', from: 'task', by: 'status', area: 'mix' },
  { kind: 'rows', title: 'Newest', from: 'task', show: ['title', 'status'], limit: 5, area: 'work' },
];
const template = ['kpis kpis kpis', 'trend trend side', 'mix   work  side'];
const problemsOf = (build: () => unknown): string[] => {
  try {
    build();
  } catch (err) {
    return (err as { problems?: string[] }).problems ?? [(err as Error).message];
  }
  return [];
};

test("a dashboard's areas are read as rows of equal tracks, served as authored, and sections name the area they stand in", () => {
  const parsed = laid(sound, template);
  const view = parsed.views.overview as AppDashboardView;
  assert.deepEqual(view.areas, ['kpis kpis kpis', 'trend trend side', 'mix work side']);
  assert.deepEqual(
    view.sections.map((section) => section.area),
    ['kpis', 'trend', 'side', 'mix', 'work'],
  );
  const served = resolveViews(parsed, schema).overview as AppDashboardView;
  assert.equal(served.error, undefined, served.error);
  assert.deepEqual(served.areas, view.areas);
  assert.equal(served.sections[1].area, 'trend');
  // Several sections in one area stack in source order; `.` leaves a cell empty.
  const stacked = laid([metricIn('a', 'One'), metricIn('b', 'Two'), metricIn('b', 'Three')], ['a b', '. b']);
  assert.deepEqual(
    (stacked.views.overview as AppDashboardView).sections.map((section) => section.area),
    ['a', 'b', 'b'],
  );
});

test('a dashboard\'s old "layout" is refused with the word that replaced it', () => {
  const said = problemsOf(() => app({ overview: { kind: 'dashboard', label: 'Overview', sections: sound, layout: template } })).join('\n');
  assert.match(said, /has "layout", which is now "areas"/);
});

test('areas that cannot be drawn is refused in words, every refusal in one pass', () => {
  const refusing = (areas: unknown, sections: unknown[] = sound) => problemsOf(() => laid(sections, areas)).join('\n');
  assert.match(refusing(['kpis kpis', 'trend']), /rows of different lengths \(row 1 has 2, row 2 has 1\)/);
  assert.match(refusing(['a b c d e']), /5 columns in a row\. At most 4/);
  assert.match(refusing(Array.from({ length: 9 }, () => 'a b')), /9 rows\. At most 8/);
  assert.match(refusing([]), /not a list of rows/);
  assert.match(refusing(['Kpis kpis']), /"Kpis", which is not an area name/);
  assert.match(refusing(['span span']), /"span", which is not an area name/);
  assert.match(
    refusing(['kpis kpis side', 'trend . side', 'mix work side', 'side . .']),
    /"side" is not a rectangle: it covers row 1 column 3, row 2 column 3, row 3 column 3 and row 4 column 1/,
  );
  // The shape is said before the sections are judged: one refusal, not its echo from every section.
  assert.doesNotMatch(refusing(['kpis kpis', 'trend']), /does not have/);
  // A section in no area, with its place in the source; one in an area the template lacks, with the nearest name.
  const loose = [...sound.slice(0, 4), { kind: 'rows', title: 'Newest', from: 'task', show: ['title'] }];
  assert.match(refusing(template, loose), /every section names the "area" it stands in\. Without one: section 5 \("Newest"\)/);
  const slip = [...sound.slice(0, 4), { ...sound[4], area: 'wrok' }];
  const said = refusing(template, slip);
  assert.match(said, /section 5 stands in "wrok", which "areas" does not have\. Did you mean "work"\?/);
  assert.match(said, /"work" is empty\. Place a section in it, or replace it with \./);
  // All of them in one pass, as the sections' own refusals are.
  const both = problemsOf(() =>
    laid(
      [
        { ...sound[0], area: 'nowhere' },
        { ...sound[1], area: 'Bad' },
        { ...sound[2], area: 'Worse' },
      ],
      ['kpis trend'],
    ),
  );
  assert.equal(both.length, 2, both.join('\n'));
});

test('an area is refused beside what places a section otherwise', () => {
  const at = (index: number, extra: Record<string, unknown>, areas: unknown = template) =>
    problemsOf(() =>
      laid(
        sound.map((section, i) => (i === index ? { ...section, ...extra } : section)),
        areas,
      ),
    ).join('\n');
  assert.match(at(3, { width: 'half' }), /section 4 has a "width" beside its "area": the area sets its width/);
  assert.match(
    problemsOf(() => laid(sound, template, { aside: [{ kind: 'metric', title: 'Aside', from: 'task' }] })).join('\n'),
    /"areas" and an "aside"/,
  );
  assert.match(problemsOf(() => app(dash(sound))).join('\n'), /section 1 has an "area", and the dashboard has no "areas"/);
  assert.match(
    problemsOf(() =>
      laid([{ kind: 'firstRun', title: 'Start', steps: [{ label: 'Add a task', to: 'tasks' }], area: 'kpis' }, ...sound], template),
    ).join('\n'),
    /first run, which leads the dashboard outside its areas: it takes no "area"/,
  );
  // A first run needs no area: it leads the dashboard, outside the grid.
  assert.deepEqual(
    problemsOf(() => laid([{ kind: 'firstRun', title: 'Start', steps: [{ label: 'Add a task', to: 'tasks' }] }, ...sound], template)),
    [],
  );
  assert.match(at(0, { area: 'a b' }), /not an area name/);
});

test('the areas of a template come in reading order, and a hidden area gives its cells to its left neighbour', () => {
  const grid = layoutGrid(['kpis kpis kpis', 'trend trend side', 'mix work side']);
  assert.deepEqual(layoutAreas(grid), ['kpis', 'trend', 'side', 'mix', 'work']);
  assert.deepEqual(areaBox(grid, 'side'), { row: 1, column: 2, rows: 2, columns: 1 });
  assert.equal(areaBox(grid, 'nowhere'), undefined);
  assert.equal(gridTemplateAreas(grid), '"kpis kpis kpis" "trend trend side" "mix work side"');
  // The side column hides: its cells go to the area on its left in each row.
  assert.deepEqual(reflowLayout(grid, new Set(['side'])), [
    ['kpis', 'kpis', 'kpis'],
    ['trend', 'trend', 'trend'],
    ['mix', 'work', 'work'],
  ]);
  // A first-column area gives its cells to the right, where that keeps the area a rectangle.
  assert.deepEqual(reflowLayout(layoutGrid(['a b', 'c b']), new Set(['a'])), [
    ['.', 'b'],
    ['c', 'b'],
  ]);
  assert.deepEqual(reflowLayout(layoutGrid(['a b', 'a c']), new Set(['a'])), [
    ['b', 'b'],
    ['c', 'c'],
  ]);
  // A row left with no area is dropped.
  assert.deepEqual(reflowLayout(layoutGrid(['kpis kpis', 'a b']), new Set(['kpis'])), [['a', 'b']]);
  assert.deepEqual(reflowLayout(layoutGrid(['a a', 'b c']), new Set(['a'])), [['b', 'c']]);
  // A neighbour that would stop being a rectangle is not given the cells.
  assert.deepEqual(reflowLayout(layoutGrid(['a a', 'a b', '. b']), new Set(['b'])), [
    ['a', 'a'],
    ['a', 'a'],
  ]);
  assert.deepEqual(reflowLayout(layoutGrid(['x y', 'z y', 'z w']), new Set(['y'])), [
    ['x', 'x'],
    ['z', '.'],
    ['z', 'w'],
  ]);
  // Nothing hidden, nothing changed; everything hidden, nothing left.
  assert.deepEqual(reflowLayout(grid, new Set()), grid);
  assert.deepEqual(reflowLayout(layoutGrid(['a b']), new Set(['a', 'b'])), []);
});
