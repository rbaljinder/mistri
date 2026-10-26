/**
 * The blocks the Lumen look asked for, as authored: a dashboard's banner, its
 * steps, its date-range button, a donut's total and a smooth line, a board
 * card's category and footer, a nav entry's dot, a stack of avatars and a
 * row's lead icon. Each is parsed here, and refused by name where it cannot
 * mean anything.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listProblem, parseAppConfig, type AppDashboardView, type AppListView } from '../packages/mistri/src/shared/app.js';

const app = (views: Record<string, unknown>, extra: Record<string, unknown> = {}, resources: Record<string, unknown> = {}) =>
  parseAppConfig(
    {
      name: 'Lumen blocks',
      resources: {
        task: {
          display: {
            status: { tone: { done: 'good', blocked: 'bad' }, icons: { open: 'circle-dashed', done: 'check-circle' } },
            kind: { colors: { design: 1, research: 3 } },
            people: { format: 'avatars' },
            title: { icon: { mark: 'lightning', toneOf: 'status' } },
          },
        },
        picture: { file: { content: 'data', name: 'file_name' } },
        ...resources,
      },
      views: { tasks: { kind: 'list', from: 'task', show: ['title', 'status'] }, ...views },
      home: 'tasks',
      nav: ['tasks', ...Object.keys(views)],
      ...extra,
    },
    'lumen fixture',
  );

const dash = (sections: unknown[], more: Record<string, unknown> = {}) => ({
  overview: { kind: 'dashboard', label: 'Overview', sections, ...more },
});
const sections = (parsed: ReturnType<typeof app>) => (parsed.views.overview as AppDashboardView).sections;

test("a banner is a note's variant: a title, a short eyebrow, an action and a file row's picture", () => {
  const [banner] = sections(
    app(
      dash([
        {
          kind: 'note',
          title: 'Turn visitors into customers',
          text: 'Create a campaign.',
          variant: 'banner',
          eyebrow: ' Growth ',
          action: { label: 'Open tasks', to: 'tasks' },
          image: { from: 'picture', key: 1, alt: 'A desk with a plant' },
        },
      ]),
    ),
  );
  assert.equal(banner.variant, 'banner');
  assert.equal(banner.eyebrow, 'Growth');
  assert.equal(banner.image?.from, 'picture');
  assert.throws(() => app(dash([{ kind: 'note', text: 'x', eyebrow: 'New' }])), /only a banner carries/);
  assert.throws(() => app(dash([{ kind: 'note', text: 'x', variant: 'hero' }])), /takes 'banner'/);
  assert.throws(() => app(dash([{ kind: 'note', text: 'x', variant: 'banner' }])), /has no "title"/);
  assert.throws(() => app(dash([{ kind: 'note', title: 'T', text: 'x', variant: 'banner', eyebrow: 'x'.repeat(41) }])), /short tag/);
  assert.throws(
    () => app(dash([{ kind: 'note', title: 'T', text: 'x', variant: 'banner', image: { from: 'picture', key: 1 } }])),
    /needs an "alt"/,
  );
  assert.throws(
    () => app(dash([{ kind: 'note', title: 'T', text: 'x', variant: 'banner', image: { from: 'task', key: 1, alt: 'a' } }])),
    /image/,
  );
});

test("steps are a breakdown's shape over one plain column, with a short note per value", () => {
  const [steps] = sections(
    app(dash([{ kind: 'breakdown', title: 'Flow', from: 'task', by: 'status', shape: 'steps', notes: { open: ' Waiting ' } }])),
  );
  assert.equal(steps.shape, 'steps');
  assert.deepEqual(steps.notes, { open: 'Waiting' });
  assert.throws(() => app(dash([{ kind: 'breakdown', title: 'F', from: 'task', by: 'status', shape: 'donut' }])), /"bars" .* or "steps"/);
  assert.throws(
    () => app(dash([{ kind: 'breakdown', title: 'F', from: 'task', by: 'month due_on', shape: 'steps' }])),
    /name the column alone/,
  );
  assert.throws(
    () => app(dash([{ kind: 'breakdown', title: 'F', from: 'task', by: 'status', notes: { open: 'x' } }])),
    /add shape: 'steps'/,
  );
  assert.throws(
    () => app(dash([{ kind: 'breakdown', title: 'F', from: 'task', by: 'status', shape: 'steps', notes: { open: 'x'.repeat(81) } }])),
    /1 to 80 characters/,
  );
});

test("a donut's total, a smooth line and the dashboard's date-range button", () => {
  const parsed = app(
    dash(
      [
        { kind: 'chart', title: 'Kinds', from: 'task', by: 'kind', shape: 'donut', total: 'Tasks' },
        { kind: 'chart', title: 'By month', from: 'task', by: 'month due_on, kind', curve: 'smooth', over: 'due_on' },
      ],
      { windows: ['last 30 days'], windowControl: 'button' },
    ),
  );
  const [donut, line] = sections(parsed);
  assert.equal(donut.total, 'Tasks');
  assert.equal(line.curve, 'smooth');
  assert.equal((parsed.views.overview as AppDashboardView).windowControl, 'button');
  assert.throws(() => app(dash([{ kind: 'chart', title: 'K', from: 'task', by: 'kind', total: 'Tasks' }])), /not a donut/);
  assert.throws(() => app(dash([{ kind: 'chart', title: 'K', from: 'task', by: 'kind', shape: 'bar', curve: 'smooth' }])), /only a line/);
  assert.throws(() => app(dash([{ kind: 'chart', title: 'K', from: 'task', by: 'kind', curve: 'wavy' }])), /"smooth" or "straight"/);
  assert.throws(() => app(dash([{ kind: 'note', text: 'x' }], { windowControl: 'dial' })), /"segmented" or "button"/);
});

test("a board card's category and footer are local columns; the category is not the lane", () => {
  const parsed = app({
    board: {
      kind: 'list',
      from: 'task',
      board: { by: 'status', primary: 'title', category: 'kind', footer: [{ column: 'due_on', icon: 'calendar' }, 'people'] },
    },
  });
  const board = (parsed.views.board as AppListView).presentation as { category?: string; footer?: unknown };
  assert.equal(board.category, 'kind');
  assert.deepEqual(board.footer, [{ column: 'due_on', icon: 'calendar' }, { column: 'people' }]);
  const boardWith = (more: Record<string, unknown>) =>
    app({ board: { kind: 'list', from: 'task', board: { by: 'status', primary: 'title', ...more } } });
  assert.throws(() => boardWith({ category: 'status' }), /the board's "by"/);
  assert.throws(() => boardWith({ footer: ['a', 'b', 'c', 'd', 'e'] }), /one to four local columns/);
  assert.throws(() => boardWith({ footer: ['due_on', { column: 'due_on' }] }), /twice/);
});

test("a nav entry's dot is one of the eight chart colors", () => {
  const nav = (color: unknown) =>
    app({ launch: { kind: 'list', from: 'task', show: ['title'] } }, { nav: ['tasks', { to: 'launch', label: 'Launch', color }] });
  assert.equal((nav(2).nav[1] as { color?: number }).color, 2);
  assert.throws(() => nav(9), /one of the theme's eight chart colors/);
});

test('avatars, a lead icon toned by another column, and category colors are display rules', () => {
  const display = app({}).resources?.task?.display ?? {};
  assert.equal(display.people?.format, 'avatars');
  assert.deepEqual(display.title?.icon, { mark: 'lightning', toneOf: 'status' });
  assert.deepEqual(display.kind?.colors, { design: 1, research: 3 });
  const withDisplay = (rule: Record<string, unknown>) => app({}, {}, { task: { display: rule } });
  assert.throws(() => withDisplay({ kind: { colors: { design: 9 } } }), /chart colors, 1 to 8/);
  assert.throws(() => withDisplay({ title: { icon: { mark: 'lightning', hue: 'x' } } }), /"icon"/);
  assert.throws(() => withDisplay({ title: { icon: 7 } }), /not an App icon or \{ mark, toneOf \}/);
});

test('the formats that draw a value their own way, a ring and a slider are display rules, refused where they mean nothing', () => {
  const withDisplay = (rule: Record<string, unknown>) => app({}, {}, { task: { display: rule } }).resources?.task?.display ?? {};
  const display = withDisplay({
    score: { format: 'rating', outOf: 10, tone: { '<= 3': 'bad' } },
    hue: { format: 'color' },
    opens: { format: 'time' },
    renews: { format: 'month' },
    model: { format: 'year' },
    settings: { format: 'json' },
    tag: { format: 'qr' },
    done: { format: 'percent', ring: true },
    term: { slider: { min: 12, max: 84, step: 12 } },
  });
  assert.equal(display.score?.outOf, 10);
  assert.deepEqual(display.score?.tone, { '<= 3': 'bad' });
  assert.deepEqual(
    ['hue', 'opens', 'renews', 'model', 'settings', 'tag'].map((column) => display[column]?.format),
    ['color', 'time', 'month', 'year', 'json', 'qr'],
  );
  assert.equal(display.done?.ring, true);
  assert.deepEqual(display.term?.slider, { min: 12, max: 84, step: 12 });

  assert.throws(() => withDisplay({ hue: { format: 'color', tone: { x: 'bad' } } }), /draws the value its own way; it takes no "tone"/);
  assert.throws(() => withDisplay({ tag: { format: 'qr', icon: 'tag' } }), /it takes no "icon"/);
  assert.throws(() => withDisplay({ score: { outOf: 5 } }), /add format: 'rating'/);
  assert.throws(() => withDisplay({ score: { format: 'rating', outOf: 12 } }), /from 3 to 10/);
  assert.throws(() => withDisplay({ done: { format: 'percent', ring: 'yes' } }), /"ring" that is not true/);
  assert.throws(() => withDisplay({ done: { ring: true } }), /add format: 'percent'/);
  assert.throws(() => withDisplay({ done: { format: 'percent', ring: true, bar: true } }), /one or the other/);
  assert.throws(() => withDisplay({ term: { slider: { min: 5, max: 5 } } }), /not \{ min, max, step\? \}/);
  assert.throws(() => withDisplay({ term: { slider: { min: 0, max: 10, by: 1 } } }), /"slider"/);
  assert.throws(() => withDisplay({ term: { slider: { min: 0, max: 10, step: 20 } } }), /positive number inside its range/);
  assert.throws(() => withDisplay({ term: { format: 'email', slider: { min: 0, max: 10 } } }), /moves a number/);
});

test('a code read by the camera and a signature are inputs of a plain column: true, and nothing else dressing it', () => {
  const withDisplay = (rule: Record<string, unknown>) => app({}, {}, { task: { display: rule } }).resources?.task?.display ?? {};
  const display = withDisplay({ upc: { scan: true }, signed: { signature: true } });
  assert.equal(display.upc?.scan, true);
  assert.equal(display.signed?.signature, true);
  assert.throws(() => withDisplay({ upc: { scan: 'yes' } }), /"scan" that is not true/);
  assert.throws(() => withDisplay({ upc: { scan: true, format: 'qr' } }), /"scan", a text's camera input; it takes no "format"/);
  assert.throws(() => withDisplay({ signed: { signature: true, tone: { x: 'bad' } } }), /a signature pad; it takes no "tone"/);
  assert.throws(() => withDisplay({ upc: { scan: true, signature: true } }), /entered one way/);
});

test('a tree hangs records under their parent column; a gantt chart runs them between two dates', () => {
  const list = (presentation: Record<string, unknown>) =>
    (app({ plan: { kind: 'list', from: 'task', show: ['title'], presentation } }).views.plan as AppListView).presentation;
  assert.deepEqual(list({ kind: 'tree', parent: 'parent_id', primary: 'title', lines: ['owner_id.name'] }), {
    kind: 'tree',
    parent: 'parent_id',
    primary: 'title',
    lines: ['owner_id.name'],
  });
  assert.deepEqual(list({ kind: 'gantt', start: 'starts_on', end: 'due_on', primary: 'title', by: 'owner_id.name', progress: 'done' }), {
    kind: 'gantt',
    start: 'starts_on',
    end: 'due_on',
    primary: 'title',
    by: 'owner_id.name',
    progress: 'done',
  });
  assert.throws(() => list({ kind: 'tree', parent: 'parent_id', primary: 'title', lines: ['a', 'b'] }), /at most 1 local column/);
  assert.throws(() => list({ kind: 'gantt', start: 'due_on', end: 'due_on', primary: 'title' }), /same column as "start"/);
  assert.throws(() => list({ kind: 'gantt', start: 'a', end: 'b', primary: 'title', sort: 'a' }), /sort/);

  const column = (name: string, type: string, primaryKey = false) => ({ name, type, nullable: !primaryKey, primaryKey });
  const task = {
    id: 'task',
    name: 'task',
    schema: '',
    isView: false,
    columns: [
      column('id', 'INTEGER', true),
      column('title', 'TEXT'),
      column('parent_id', 'INTEGER'),
      column('other_id', 'INTEGER'),
      column('starts_on', 'DATE'),
      column('due_on', 'DATE'),
      column('done', 'INTEGER'),
    ],
  };
  const schema = {
    tables: [task],
    foreignKeys: [
      { from: { table: 'task', columns: ['parent_id'] }, to: { table: 'task', columns: ['id'] } },
      { from: { table: 'task', columns: ['other_id'] }, to: { table: 'other', columns: ['id'] } },
    ],
  } as never;
  assert.equal(listProblem({ kind: 'tree', parent: 'parent_id', primary: 'title' }, task, schema), undefined);
  assert.match(listProblem({ kind: 'tree', parent: 'other_id', primary: 'title' }, task, schema)!, /must reference "task" itself/);
  assert.equal(
    listProblem({ kind: 'gantt', start: 'starts_on', end: 'due_on', primary: 'title', progress: 'done' }, task, schema),
    undefined,
  );
  assert.match(
    listProblem({ kind: 'gantt', start: 'title', end: 'due_on', primary: 'title' }, task, schema)!,
    /a bar runs between date columns/,
  );
  assert.match(
    listProblem({ kind: 'gantt', start: 'starts_on', end: 'due_on', primary: 'title', progress: 'title' }, task, schema)!,
    /numeric column/,
  );
});

test('a display rule may set a column in the data, reading or code face, and refuses any other', () => {
  const withDisplay = (rule: Record<string, unknown>) => app({}, {}, { task: { display: rule } }).resources?.task?.display ?? {};
  const display = withDisplay({ vin: { face: 'code' }, status: { face: 'ui', values: { open: 'Open' } }, ref: { face: 'data' } });
  assert.deepEqual(
    ['vin', 'status', 'ref'].map((column) => display[column]?.face),
    ['code', 'ui', 'data'],
  );
  assert.equal(display.status?.values?.open, 'Open');
  assert.throws(() => withDisplay({ vin: { face: 'mono' } }), /"face" of "mono". Use data, ui, code/);
  // Renamed before 1.0: the interface face is `ui`, as the theme says it.
  assert.throws(() => withDisplay({ status: { face: 'sans' } }), /"face" of "sans", which is now "ui"/);
});
