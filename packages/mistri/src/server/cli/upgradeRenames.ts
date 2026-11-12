/**
 * What `mistri upgrade` rewrites, as data. The rows come from the CHANGELOG's "Renamed" tables and the 1.0 release
 * candidates' notes; a row is added here in the release that renames something, with the CHANGELOG line beside it.
 *
 * Only a rename that reads the same wherever it is written belongs in `KEYS` or `NAMES`. One whose old word still
 * means something else in an App (a list's `head`, a list's `totals: [columns]`, `palette` as a variation) is
 * written with the context that tells them apart (`inside`, `call`, `kind`, `parent`, `shape`, `firstKey`,
 * `component`), and one a reader cannot be told apart by anything on the page goes to `REFUSED`, which names the line
 * for a person to change.
 *
 * The rows the loaders refuse (shared/renamedWords.ts) are the source of the ones here: test/upgrade.test.ts holds
 * that each is a `KEYS` row or a `REFUSED` one, so a rename cannot reach `check` without reaching `upgrade`.
 */

import { RENAMED_TOKENS } from '@mistriwork/kit/shared/uiTokens.js';

/** The looks' tokens renamed before 1.0 (`--text` is `--ink`): the table `check` names them from too. */
export const TOKENS = RENAMED_TOKENS;

/** The package the App framework was published as, before `@mistriwork/mistri`. */
const OLD_PACKAGE = 'tablewalk';
const NEW_PACKAGE = '@mistriwork/mistri';

/** The entry points the old package had, which the new one keeps under its own name (packages/mistri/package.json `exports`). */
const ENTRY_POINTS = [
  'app',
  'page',
  'ui',
  'ui/testing',
  'commands',
  'policy',
  'jobs',
  'workflows',
  'handler',
  'testing',
  'maintenance',
  'openfeature',
  'integration',
  'react',
  'react/next',
  'react/react-router',
  'react/tanstack-router',
] as const;

/** A module specifier as the new package says it, or undefined when it is not one of the old package's. */
export function renamedModule(specifier: string): string | undefined {
  if (specifier.startsWith(`${OLD_PACKAGE}/schema/`)) return `${NEW_PACKAGE}/${specifier.slice(OLD_PACKAGE.length + 1)}`;
  const entry = specifier.startsWith(`${OLD_PACKAGE}/`) ? specifier.slice(OLD_PACKAGE.length + 1) : undefined;
  return entry !== undefined && (ENTRY_POINTS as readonly string[]).includes(entry) ? `${NEW_PACKAGE}/${entry}` : undefined;
}

/** Where a key stands, as the file's own words place it: every condition a row names must hold. */
export interface Guards {
  /** Only in an object that is the value of this key (`recipes: { head }`), or of one of them; `streams[]` is an item of the array a key holds. */
  inside?: string | readonly string[];
  /** Only in the object a call is given: `definePage({ title })`, `metric(title, from, { view })`. */
  call?: string;
  /** Only in an object that says what it is: `{ kind: 'list', table }`. */
  kind?: string;
  /** Only when the object this one stands in is a call's argument or says what it is (`fromRecord(table, { fallback: { base } })`). */
  parent?: { call?: string; kind?: string };
}

/** A property key renamed. It is only rewritten where every condition it names holds. */
interface KeyRename extends Guards {
  from: string;
  to: string;
  /** The table in shared/renamedWords.ts this row answers, when a loader refuses it. */
  table?: string;
  /** Only as an attribute of a component imported from the kit (`<Rows resource="…" />`), through whatever name it is imported as. */
  component?: boolean;
  /** The kit components that took the old word; another keeps it as its own (`<Value resource>` is Value's). */
  components?: readonly string[];
  /** Only when its value starts as this: a dashboard's `layout: [areas]` is not a page's `layout: 'showcase'`. */
  shape?: 'array' | 'object';
  /** Only when the object it names starts with one of these keys (`palette: { light, dark }`, not a variation). */
  firstKey?: readonly string[];
  /** Where the CHANGELOG says so. */
  note: string;
}

export const KEYS: readonly KeyRename[] = [
  { from: 'layout', to: 'areas', shape: 'array', table: 'dashboard', note: "A dashboard's `layout: [...]` is `areas: [...]`" },
  {
    from: 'totals',
    to: 'figures',
    shape: 'object',
    table: 'custom',
    note: "A custom section's `totals: { … }` is `figures: { … }`; a list's `totals: [columns]` is unchanged",
  },
  { from: 'head', to: 'header', inside: 'recipes', table: 'recipes', note: "A theme's `recipes.head` is `recipes.header`" },
  { from: 'currentInk', to: 'onCurrent', note: "A theme's `nav.currentInk` is `nav.onCurrent`" },
  {
    from: 'palette',
    to: 'colors',
    firstKey: ['light', 'dark'],
    note: '`defineTheme({ palette: { light, dark } })` is `colors`; `palette` names only a variation',
  },
  {
    from: 'title',
    to: 'label',
    call: 'definePage',
    table: 'page',
    note: "A page's `definePage({ title })` is `label`; a view's own `title` is unchanged",
  },
  {
    from: 'order',
    to: 'position',
    inside: 'nav',
    parent: { call: 'definePage' },
    table: 'page.nav',
    note: "A page's `nav.order` is `nav.position`",
  },
  { from: 'view', to: 'to', call: 'metric', table: 'metric', note: "A metric's `view` is `to`: the list view its card opens" },
  { from: 'tab', to: 'listTab', call: 'embed', table: 'view', note: 'A dashboard `embed(view, { tab })` is `listTab`' },
  { from: 'table', to: 'from', kind: 'list', table: 'list', note: "A list view's `table` is `from`" },
  { from: 'keys', to: 'shortcuts', kind: 'list', table: 'list', note: "A list view's `keys` is `shortcuts`" },
  { from: 'table', to: 'from', kind: 'dashboard', table: 'dashboard', note: "A dashboard view's `table` is `from`" },
  { from: 'resource', to: 'from', inside: 'backdrop[]', table: 'backdrop', note: "A calendar backdrop span's `resource` is `from`" },
  { from: 'to', to: 'end', inside: 'backdrop[]', table: 'backdrop', note: "A calendar backdrop span's `to` is `end`" },
  {
    from: 'label',
    to: 'labelColumn',
    inside: 'backdrop[]',
    table: 'backdrop',
    note: "A calendar backdrop span's `label` is `labelColumn`",
  },
  { from: 'facts', to: 'properties', kind: 'queue', table: 'queue', note: "A queue's captioned `facts` are `properties`" },
  { from: 'lines', to: 'properties', kind: 'cards', table: 'cards', note: "A cards presentation's captioned `lines` are `properties`" },
  {
    from: 'base',
    to: 'preset',
    inside: ['fallback', 'fields'],
    parent: { call: 'fromRecord' },
    table: 'branding',
    note: "A tenant branding row's `base` is `preset`",
  },
  {
    from: 'brandColor',
    to: 'accent',
    inside: ['fallback', 'fields'],
    parent: { call: 'fromRecord' },
    table: 'branding',
    note: "A tenant branding row's `brandColor` is `accent`",
  },
  {
    from: 'resource',
    to: 'from',
    component: true,
    /* The blocks that read a table by `from` (sdk/blocks.tsx); their `takes` refuses `resource`. */
    components: [
      'Metric',
      'Chart',
      'Breakdown',
      'Rows',
      'RecordCard',
      'Timeline',
      'Tree',
      'Gantt',
      'Board',
      'Calendar',
      'Gallery',
      'Split',
    ],
    table: 'block',
    note: "A kit block's `resource` is `from`",
  },
  /* A record page's sections, renamed before the helpers wrote them (engine renamedSectionWords.ts): read the same
     wherever the helper or the section's own `kind` places them. */
  ...(
    [
      ['edit', 'editable', { call: 'fields' }, "A fields section's `edit` is `editable`"],
      ['edit', 'editable', { kind: 'fields' }, "A fields section's `edit` is `editable`"],
      ['of', 'about', { call: 'related' }, "A related list's `of` is `about`"],
      ['of', 'about', { call: 'stream' }, "A timeline stream's `of` is `about`"],
      ['of', 'about', { inside: 'streams[]' }, "A timeline stream's `of` is `about`"],
      ['orderBy', 'sort', { call: 'related' }, "A related list's `orderBy` is `sort`, written like the query bar"],
    ] as const
  ).map(([from, to, guards, note]) => ({ from, to, ...guards, table: 'section', note })),
  {
    from: 'kind',
    to: 'intent',
    inside: 'links[]',
    table: 'link',
    note: "A headline link's emphasis `kind` is `intent`, as a button says it: 'primary' or 'secondary'",
  },
];

/** Where a kit component comes from: the one place an App imports the blocks. A package under this name is the kit's. */
export const KIT_MODULES: readonly string[] = ['@mistriwork/mistri/ui', '@mistriwork/kit'];

/** A string value renamed under a key. */
interface ValueRename {
  key: string;
  from: string;
  to: string;
  note: string;
}

export const VALUES: readonly ValueRename[] = [
  { key: 'face', from: 'sans', to: 'ui', note: "A display rule's `face: 'sans'` is `face: 'ui'`" },
  { key: 'face', from: 'mono', to: 'code', note: "A type role's `face: 'mono'` is `face: 'code'`" },
  { key: 'layout', from: 'listing', to: 'showcase', note: "A page's `layout: 'listing'` is `layout: 'showcase'`" },
];

/** An exported type renamed; its old name means nothing else. */
export const NAMES: Readonly<Record<string, string>> = {
  CustomTotal: 'CustomFigure',
  CustomDashTotal: 'CustomDashFigure',
  TotalValue: 'FigureValue',
  TotalGroup: 'FigureGroup',
};

/** A name that cannot be rewritten by looking at it, with what to write instead. */
interface Refusal {
  name: string;
  reason: string;
  /** Only as a name imported from the App entry point. */
  imported?: boolean;
  /** Set: `name` is a property key, refused only where it stands as these words place it, not as a name anywhere. */
  context?: Guards;
  /** The table in shared/renamedWords.ts this row answers, when a loader refuses it. */
  table?: string;
}

const STREAM_REASON =
  "was renamed with the stream's other part: `stream(from, whose, at, show, { detail })` is `stream(from, whose, at, text, { badge })`, and a page's `streams` entry says `text` and `badge`; which this is takes a reader";

export const REFUSED: readonly Refusal[] = [
  {
    name: 'flagSegments',
    reason:
      "became `audiences`, and a segment's values became an audience's rules (`roles`, `tenants`, `attributes`, `rollout`, `allow`, `deny`)",
  },
  ...['count', 'sum', 'min', 'max', 'latest'].map((name) => ({
    name,
    imported: true,
    reason: `a rollup is now \`rollup.${name}(…)\`; a command's own \`${name}\` from \`@mistriwork/mistri/commands\` is unchanged, so which one this is takes a reader`,
  })),
  ...[
    'provisionSqliteTenantStore',
    'provisionSqliteTenantAdministrationJournal',
    'provisionSqliteTenantInvitations',
    'provisionSqliteSupportAudit',
  ].map((name) => ({
    name,
    reason: 'is no longer exported; `provisionStores` from `@mistriwork/mistri/maintenance` makes the tenant stores',
  })),
  /* A key that is gone or moved has to be deleted or written elsewhere: no rewrite puts it right. */
  {
    name: 'path',
    context: { call: 'definePage' },
    table: 'page',
    reason: "is gone: the page is at its file's name (pages/pick-walk.page.tsx is /pick-walk), so delete it",
  },
  {
    name: 'icon',
    context: { inside: 'nav', parent: { call: 'definePage' } },
    table: 'page.nav',
    reason: "moved: a page's own `icon`, beside its `label`, not under `nav`",
  },
  {
    name: 'refresh',
    context: { kind: 'dashboard' },
    table: 'dashboard',
    reason: 'is gone: a dashboard follows changes as they happen and re-reads what depends on the time each minute, so delete it',
  },
  /* The positional word has no key to rename and the option's is a different part of the row: which a reader says. */
  ...(
    [
      ['detail', { call: 'stream' }],
      ['show', { inside: 'streams[]' }],
      ['detail', { inside: 'streams[]' }],
    ] as const
  ).map(([name, context]) => ({ name, context, table: 'stream', reason: STREAM_REASON })),
  /* A record page's section words whose new spelling is an argument, or takes another shape: a person writes it. */
  ...(
    [
      ['paths', { call: 'fields' }, "is the first argument now: `fields(['name', 'account_id.name'], { … })`, so move it there"],
      ['path', { call: 'related' }, 'is `whose`, the third argument now: `related(title, from, whose, { … })`, so move it there'],
      ['path', { call: 'stream' }, 'is `whose`, the second argument now: `stream(from, whose, at, text, { … })`, so move it there'],
      ['path', { inside: 'streams[]' }, "is `whose` now: the column on the stream's table that names this record"],
      ['tint', { call: 'timeline' }, "is `tone`, said as a display rule: `{ kind: { internal: 'warn' } }`"],
      ['tint', { call: 'stream' }, 'is `tone`: one tone for every row of the stream'],
      ['tint', { inside: 'streams[]' }, 'is `tone`: one tone for every row of the stream'],
      ['order', { call: 'timeline' }, "is `newest`, and says it as 'first' (the default) or 'last'"],
    ] as const
  ).map(([name, context, reason]) => ({ name, context, table: 'section', reason })),
];

/**
 * The generic names among the renamed tokens: third-party stylesheets declare them too (`--border`, `--text`, `--bg`),
 * so a `var(--border)` in a file mistri does not own may be someone else's property and is rewritten only where
 * nothing else could have set it. The others (`--text-dim`, `--border-strong`) are mistri's alone.
 */
export const GENERIC_TOKENS: ReadonlySet<string> = new Set(['--border', '--text', '--bg', '--danger', '--warn', '--ok', '--surface-2']);

/** A selector aimed at a third-party library's class: what it styles is the library's, so its tokens are too. */
export const THIRD_PARTY_SELECTOR = /\.(?:mui-|Mui|ant-|chakra-|bp\d+-|react-|ReactModal|swiper-|slick-)|\[class[~|^$*]?=/;
