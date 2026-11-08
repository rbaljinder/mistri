/**
 * What `mistri upgrade` rewrites, as data. The rows come from the CHANGELOG's "Renamed" tables and the 1.0 release
 * candidates' notes; a row is added here in the release that renames something, with the CHANGELOG line beside it.
 *
 * Only a rename that reads the same wherever it is written belongs in `KEYS` or `NAMES`. One whose old word still
 * means something else in an App (a list's `head`, a list's `totals: [columns]`, `palette` as a variation) is
 * written with the context that tells them apart (`inside`, `shape`, `firstKey`), and one a reader cannot be told
 * apart by anything on the page goes to `REFUSED`, which names the line for a person to change.
 */

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

/** A property key renamed. It is only rewritten where every condition it names holds. */
interface KeyRename {
  from: string;
  to: string;
  /** Only in an object that is the value of this key (`recipes: { head }`). */
  inside?: string;
  /** Only when its value starts as this: a dashboard's `layout: [areas]` is not a page's `layout: 'showcase'`. */
  shape?: 'array' | 'object';
  /** Only when the object it names starts with one of these keys (`palette: { light, dark }`, not a variation). */
  firstKey?: readonly string[];
  /** Where the CHANGELOG says so. */
  note: string;
}

export const KEYS: readonly KeyRename[] = [
  { from: 'layout', to: 'areas', shape: 'array', note: "A dashboard's `layout: [...]` is `areas: [...]`" },
  {
    from: 'totals',
    to: 'figures',
    shape: 'object',
    note: "A custom section's `totals: { … }` is `figures: { … }`; a list's `totals: [columns]` is unchanged",
  },
  { from: 'head', to: 'header', inside: 'recipes', note: "A theme's `recipes.head` is `recipes.header`" },
  { from: 'currentInk', to: 'onCurrent', note: "A theme's `nav.currentInk` is `nav.onCurrent`" },
  {
    from: 'palette',
    to: 'colors',
    firstKey: ['light', 'dark'],
    note: '`defineTheme({ palette: { light, dark } })` is `colors`; `palette` names only a variation',
  },
];

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
}

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
];
