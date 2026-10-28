/**
 * A custom component's page, made of fixtures: a host (context.ts) that
 * answers each read from typed rows instead of a server and records every
 * navigation and every command instead of following them, and the frame each
 * kind of component is drawn in — a section, a list's rows, a page, a value,
 * an input. `@mistriwork/mistri/ui/testing` draws through it in a test, and a
 * Storybook story (an App's `*.examples.tsx`, examples()) draws through it
 * with no test runner at all.
 *
 * Each declared read is the fixture rows of its resource with the
 * declaration's own `show`, `sort` and `limit` applied — what the planner
 * would have asked for; the query is the server's to judge, so the rows a
 * fixture gives are the rows it answered.
 */
import { ComponentStyleScope } from '@mistriwork/ui/ComponentStyleScope.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { authoredDisplay, type DisplayRule } from '@mistriwork/kit/client/components/valueModel.js';

/** A display rule as the DSL writes it: `bar: 5` fills against 5. */
type AuthoredDisplay = Omit<DisplayRule, 'bar' | 'max'> & { bar?: boolean | number };
import {
  COMPACT_BELOW,
  UiHostContext,
  UiPageContext,
  UiSizeContext,
  type OpenMode,
  type UiCommandOutcome,
  type UiHost,
  type UiLook,
  type UiPageFrame,
  type UiRow,
  type UiViewer,
} from './context.js';
import { say } from '../../copy/components/components/sdk/fixture.js';
import { captureAppFlagValues, type AppFlagValue } from '../../../shared/appFlagValues.js';
import { registerPageBlocks } from './pageBlocks.js';
import { sayAppMessage } from './appMessage.js';
import { totalFigure, totalGroups } from '../../../shared/customTotals.js';

/* A page drawn here draws its blocks as an App's does (CustomPage.tsx): the platform's, loaded when one is first drawn. */
registerPageBlocks(() => import('./blocks.js'));

/** Rows by resource: what the test's server would have answered. */
export interface Fixtures {
  tables: Record<string, readonly UiRow[]>;
  display: Record<string, AuthoredDisplay>;
}

/** Typed fixture rows — `fixtures<Rows>({ pay_run: [{ id: 1, title: 'Aug 1–15', … }] })` — and, by `resource.column`, the display rules the App would dress them with. */
export function fixtures<R = Record<string, UiRow>>(
  tables: { [T in keyof R]?: ReadonlyArray<Partial<R[T]>> },
  options: { display?: Record<string, AuthoredDisplay> } = {},
): Fixtures {
  return { tables: tables as Record<string, readonly UiRow[]>, display: options.display ?? {} };
}

export type Navigation =
  | { kind: 'record'; resource: string; key: Readonly<Record<string, unknown>>; mode: OpenMode }
  | { kind: 'view'; view: string; tab?: string; search?: string; filters?: Readonly<Record<string, string>> }
  | { kind: 'form'; view: string; prefill: Readonly<Record<string, string | number>> }
  | { kind: 'composer'; text: string; mode?: 'reply' | 'note' };

/** A command a component ran or opened, recorded instead of sent. */
export interface CommandCall {
  command: string;
  mode: 'run' | 'open';
  key: Readonly<Record<string, unknown>>;
  input?: Readonly<Record<string, unknown>>;
}

export interface RenderOptions {
  /** Evaluated values only; omitted fixtures leave the flags reader unready. */
  flags?: Readonly<Record<string, AppFlagValue>>;
  /** Where `useAnalytics().emit` calls are collected, for a test to read. */
  analytics?: { name: string; fields?: Readonly<Record<string, string | number | boolean>> }[];
  data?: Fixtures;
  /** The page's record, for a section that declares `record`: its fields are read from here. */
  record?: UiRow;
  /** Props beside the declaration's own: a test of one prop's effect. */
  props?: Record<string, unknown>;
  look?: string;
  mode?: 'light' | 'dark';
  /** The section's width in pixels; below 420 it is compact, as on a phone. */
  width?: number;
  locale?: string;
  currency?: string;
  timezone?: string;
  /** Token values `useToken` answers, by name. */
  tokens?: Record<string, string>;
  /** Who is reading; signed out unless said. */
  viewer?: UiViewer;
  /**
   * The commands the reader is served, by id, each with its label, whether it is available on a record
   * (true unless said) and what a run answers (applied unless said). A command not named here is not granted.
   */
  commands?: Record<
    string,
    { label?: string; available?: (key: Readonly<Record<string, unknown>>) => boolean; outcome?: UiCommandOutcome }
  >;
  /** A free-form page's address parameters as the reader arrived with them. */
  address?: Record<string, string>;
  /** What a free-form page's loader answers: the page is drawn with it as `data`. */
  loaded?: unknown;
  /** A list's page: its total and where it is (a custom list's `rows` are its resource's fixture rows). */
  total?: number;
  page?: { index: number; size: number };
  /** Whether the list offers its reader a selection, as one with bulk actions does. */
  selection?: boolean;
  /** What `useFile` answers, by `resource/key` (`member_avatar/4`): a story's pictures. Unnamed files are a placeholder address. */
  files?: Record<string, string>;
  /** The App's catalog `useMessage` says, in the language under test: `{ 'help.title': 'Help center' }`. A key left out is said as itself. */
  messages?: Record<string, string>;
  /** What `useNavigate().publicLink` answers, by view key: a tenant's own links. None by default. */
  publicLinks?: Record<string, string>;
}

interface AuthoredRead {
  from: string;
  show: readonly string[];
  sort?: string;
  limit?: number;
}
interface AuthoredTotal {
  from: string;
  measure: string;
  by?: string;
}
export interface AuthoredSection {
  title?: string | { fallback: string };
  component: { id: string; props?: Record<string, { default?: unknown }> };
  record?: readonly string[];
  rows?: Readonly<Record<string, AuthoredRead>>;
  figures?: Readonly<Record<string, AuthoredTotal>>;
  props?: Readonly<Record<string, unknown>>;
  width?: string;
  region?: 'main' | 'aside';
}
/** A list view with a custom presentation, as `listView(…, { presentation: customList(…) })` returns it. */
export interface AuthoredList {
  from: string;
  label?: string;
  presentation: {
    component: { id: string; props?: Record<string, { default?: unknown }> };
    show: readonly string[];
    props?: Readonly<Record<string, unknown>>;
  };
  sort?: string;
}
/** A free-form page's definition, as `definePage(…)` holds it (`page.definition`). */
export interface AuthoredPage {
  label: string;
  reads: readonly string[];
  commands?: readonly string[];
  params?: readonly string[];
  loader?: string;
}

const pick = (row: UiRow, show: readonly string[] | undefined): UiRow =>
  show?.length ? Object.fromEntries(show.map((path) => [path, row[path]])) : { ...row };

function ordered(rows: readonly UiRow[], sort: string | undefined): UiRow[] {
  const keys = (sort ?? '')
    .split(',')
    .map((part) => part.trim().split(/\s+/))
    .filter(([column]) => column)
    .map(([column, direction]) => ({ column, down: direction?.toLowerCase() === 'desc' }));
  return [...rows].sort((a, b) => {
    for (const { column, down } of keys) {
      const x = a[column],
        y = b[column];
      if (x === y) continue;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      const less = typeof x === 'number' && typeof y === 'number' ? x < y : String(x) < String(y);
      return (less ? -1 : 1) * (down ? -1 : 1);
    }
    return 0;
  });
}

function read(
  data: Fixtures,
  resource: string,
  show: readonly string[] | undefined,
  sort: string | undefined,
  limit: number | undefined,
): UiRow[] {
  return ordered(data.tables[resource] ?? [], sort)
    .slice(0, limit ?? 20)
    .map((row) => pick(row, show));
}

/* A group or a measure as the server names its column: `status`, `day(moved_at)`; `count`, `sum(net)`. */
const BUCKETS = new Set(['day', 'week', 'month', 'quarter', 'year']);
function grouping(part: string): { name: string; value: (row: UiRow) => unknown } {
  const [first, second] = part.trim().split(/\s+/);
  if (second && BUCKETS.has(first)) {
    const cut = first === 'year' ? 4 : first === 'month' ? 7 : 10;
    /* A week is said by its Monday, as the server says it where the App names no locale. */
    const monday = (day: string) => {
      const at = new Date(`${day}T00:00:00Z`);
      if (Number.isNaN(at.getTime())) return null;
      at.setUTCDate(at.getUTCDate() - ((at.getUTCDay() + 6) % 7));
      return at.toISOString().slice(0, 10);
    };
    return {
      name: `${first}(${second})`,
      value: (row) => {
        if (row[second] === null || row[second] === undefined) return null;
        const text = String(row[second]).slice(0, cut);
        return first === 'week' ? monday(text) : text;
      },
    };
  }
  return { name: first, value: (row) => row[first] };
}

function breakdown(data: Fixtures, resource: string, by: string, measure: string | undefined, limit: number | undefined): UiRow[] {
  const groups = by ? by.split(',').map(grouping) : [];
  const [fn = 'count', column] = (measure ?? 'count').trim().split(/\s+/);
  const name = fn === 'count' ? 'count' : `${fn}(${column})`;
  const buckets = new Map<string, { keys: unknown[]; values: number[] }>();
  for (const row of data.tables[resource] ?? []) {
    const keys = groups.map((group) => group.value(row));
    const text = JSON.stringify(keys);
    const bucket = buckets.get(text) ?? { keys, values: [] };
    bucket.values.push(fn === 'count' ? 1 : Number(row[column] ?? 0));
    buckets.set(text, bucket);
  }
  const measured = (values: number[]) =>
    fn === 'count' || fn === 'sum'
      ? values.reduce((a, b) => a + b, 0)
      : fn === 'min'
        ? Math.min(...values)
        : fn === 'max'
          ? Math.max(...values)
          : values.reduce((a, b) => a + b, 0) / values.length;
  return [...buckets.values()]
    .slice(0, limit ?? 100_000)
    .map(({ keys, values }) => ({ ...Object.fromEntries(groups.map((group, i) => [group.name, keys[i]])), [name]: measured(values) }));
}

export function fixtureHost(data: Fixtures, options: RenderOptions, navigations: Navigation[], commands: CommandCall[] = []): UiHost {
  const look: UiLook = { look: options.look ?? 'workshop', mode: options.mode ?? 'light', density: 'comfortable' };
  const viewer = options.viewer ?? { signedIn: false };
  const served = options.commands ?? {};
  const values =
    options.flags === undefined
      ? undefined
      : captureAppFlagValues({ values: options.flags, version: { global: null, tenant: null } }).values;
  const flags = Object.freeze({
    ready: !!values,
    get(key: string) {
      if (!values || !Object.hasOwn(values, key)) throw new Error(say('flagFixtureUnavailable'));
      return values[key];
    },
  });
  return {
    flags: { ...flags, snapshot: () => flags, subscribe: () => () => {}, load: async () => {} },
    analytics: {
      emit: (name, fields) => {
        options.analytics?.push({ name, ...(fields ? { fields } : {}) });
      },
    },
    scope: ['test'],
    rows: async (resource, { show, sort, limit }) => read(data, resource, show, sort, limit),
    record: async (resource, key, show) => {
      const row = (data.tables[resource] ?? []).find((candidate) =>
        Object.entries(key).every(([column, value]) => candidate[column] === value),
      );
      return row && pick(row, show);
    },
    breakdown: async (resource, { by, measure, limit }) => breakdown(data, resource, by, measure, limit),
    load: async () => options.loaded ?? null,
    openRecord: (resource, key, { mode = 'page' } = {}) => {
      navigations.push({ kind: 'record', resource, key, mode });
    },
    openView: (view, { tab, search, filters } = {}) => {
      navigations.push({ kind: 'view', view, ...(tab ? { tab } : {}), ...(search ? { search } : {}), ...(filters ? { filters } : {}) });
    },
    openForm: (view, prefill = {}) => {
      navigations.push({ kind: 'form', view, prefill });
    },
    publicLink: (view) => (options.publicLinks && Object.hasOwn(options.publicLinks, view) ? options.publicLinks[view] : undefined),
    /* A fixture page draws one composer, so a fill lands: the test reads what was put there. */
    fillComposer: (text, mode) => {
      navigations.push({ kind: 'composer', text, ...(mode ? { mode } : {}) });
      return true;
    },
    fileAddress: (resource, key, { thumbnail } = {}) =>
      options.files?.[`${resource}/${Object.values(key).join('-')}`] ??
      `/fixture/${resource}/${Object.values(key).join('-')}${thumbnail ? '?thumb' : ''}`,
    command: (id) => {
      const entry = Object.hasOwn(served, id) ? served[id] : undefined;
      const granted = Boolean(entry) && viewer.signedIn;
      const call =
        (mode: 'run' | 'open') =>
        async (key: Readonly<Record<string, unknown>>, input?: Readonly<Record<string, unknown>>): Promise<UiCommandOutcome> => {
          if (!granted) return { status: 'refused', message: viewer.signedIn ? say('notGranted') : say('signInToDo') };
          commands.push({ command: id, mode, key, ...(input ? { input } : {}) });
          return entry!.outcome ?? (mode === 'open' ? { status: 'closed' } : { status: 'applied' });
        };
      return {
        label: entry?.label ?? id,
        granted,
        available: async (key) => granted && (entry!.available?.(key) ?? true),
        run: call('run'),
        open: call('open'),
      };
    },
    viewer: () => viewer,
    subscribeViewer: () => () => {},
    column: (resource, name) => {
      const sample = (data.tables[resource] ?? []).find((row) => row[name] !== null && row[name] !== undefined)?.[name];
      const type = typeof sample === 'number' ? 'numeric' : typeof sample === 'boolean' ? 'boolean' : 'text';
      return { meta: { name, type } as never, rule: authoredDisplay(data.display[`${resource}.${name}`]), label: name };
    },
    look: () => look,
    token: (name) => options.tokens?.[name] ?? '',
    subscribeLook: () => () => {},
    app: true,
    message: (key, args) => sayAppMessage(options.messages, key, args),
  };
}

/** The frame a component is drawn in: the fixture host, its measured width, and a query cache of its own. */
export function SectionFrame({
  host,
  id,
  width,
  children,
  className = 'custom-section',
}: {
  host: UiHost;
  id: string;
  width: number;
  children: ReactNode;
  className?: string;
}) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return (
    <QueryClientProvider client={client}>
      <UiHostContext.Provider value={host}>
        <UiSizeContext.Provider value={{ width, compact: width < COMPACT_BELOW }}>
          <ComponentStyleScope.Provider value={id}>
            <div className={className} data-component={id} style={{ width, maxWidth: '100%' }}>
              {children}
            </div>
          </ComponentStyleScope.Provider>
        </UiSizeContext.Provider>
      </UiHostContext.Provider>
    </QueryClientProvider>
  );
}

const propDefaults = (component: { props?: Record<string, { default?: unknown }> }) =>
  Object.fromEntries(
    Object.entries(component.props ?? {}).flatMap(([name, prop]) => (prop.default === undefined ? [] : [[name, prop.default]])),
  );

/** The props the page would hand a section's component for this declaration, over fixture rows. */
export function sectionProps(declaration: AuthoredSection, data: Fixtures, options: RenderOptions): Record<string, unknown> {
  const rows = Object.fromEntries(
    Object.entries(declaration.rows ?? {}).map(([name, spec]) => [name, read(data, spec.from, spec.show, spec.sort, spec.limit)]),
  );
  const record = options.record && declaration.record?.length ? pick(options.record, declaration.record) : options.record;
  const empty = Object.keys(rows).length > 0 && Object.values(rows).every((list) => !list.length) && !record;
  const title = typeof declaration.title === 'object' ? declaration.title.fallback : declaration.title;
  return {
    record,
    rows,
    /* The fixtures' own rows, counted: a fixture cannot judge a query, so a figure is over every row of its resource. */
    figures: Object.fromEntries(
      Object.entries(declaration.figures ?? {}).map(([name, spec]) => {
        const answered = breakdown(data, spec.from, spec.by ?? '', spec.measure, undefined);
        const none = spec.measure.trim().split(/\s+/)[0] === 'count' ? 0 : null;
        return [name, spec.by ? totalGroups(answered) : answered.length ? totalFigure(answered) : none];
      }),
    ),
    props: { ...propDefaults(declaration.component), ...declaration.props, ...options.props },
    section: { title, width: declaration.width ?? 'full', region: declaration.region ?? 'main' },
    state: empty ? 'empty' : 'ready',
  };
}

/** A list's selection, kept by the frame as the platform keeps one for a list with bulk actions. */
function useFixtureSelection(enabled: boolean, keyOf: (row: UiRow) => string) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  return enabled
    ? {
        count: selected.size,
        has: (row: UiRow) => selected.has(keyOf(row)),
        toggle: (row: UiRow) =>
          setSelected((before) => {
            const next = new Set(before);
            if (!next.delete(keyOf(row))) next.add(keyOf(row));
            return next;
          }),
        clear: () => setSelected(new Set()),
      }
    : undefined;
}

/** The props the platform hands a custom list's component: a page of rows with exactly `show` beside their keys. */
function ListBody({
  component,
  declaration,
  data,
  options,
  host,
}: {
  component: ComponentType<Record<string, unknown>>;
  declaration: AuthoredList;
  data: Fixtures;
  options: RenderOptions;
  host: UiHost;
}) {
  const size = options.page?.size ?? 20;
  const index = options.page?.index ?? 0;
  const all = ordered(data.tables[declaration.from] ?? [], declaration.sort);
  const keys = ['id'];
  const rows = all
    .slice(index * size, index * size + size)
    .map((row) => pick(row, [...new Set([...keys, ...declaration.presentation.show])]));
  const selection = useFixtureSelection(options.selection === true, (row) => String(row.id));
  return createElement(component, {
    rows,
    total: options.total ?? all.length,
    page: { index, size, more: (index + 1) * size < (options.total ?? all.length) },
    open: (row: UiRow, how: { mode?: OpenMode } = {}) => host.openRecord(declaration.from, { id: row.id }, { mode: how.mode ?? 'page' }),
    selection,
    props: { ...propDefaults(declaration.presentation.component), ...declaration.presentation.props, ...options.props },
    list: { resource: declaration.from, label: declaration.label ?? declaration.from, show: declaration.presentation.show },
  });
}

/** A free-form page's frame over fixtures: its address kept in the frame, as the walk keeps a page's. */
function useFixturePage(declaration: AuthoredPage, address: Record<string, string> = {}): UiPageFrame {
  const [place, setPlace] = useState<Record<string, string>>(address);
  return useMemo(
    () => ({
      view: 'page',
      label: declaration.label,
      reads: declaration.reads,
      commands: declaration.commands ?? [],
      params: declaration.params ?? [],
      ...(declaration.loader ? { loader: declaration.loader } : {}),
      get: (name) => place[name],
      set: (name, value) =>
        setPlace((before) => {
          const next = { ...before };
          if (value === undefined) delete next[name];
          else next[name] = value;
          return next;
        }),
    }),
    [declaration, place],
  );
}

function PageBody({
  component,
  declaration,
  options,
}: {
  component: ComponentType<Record<string, unknown>>;
  declaration: AuthoredPage;
  options: RenderOptions;
}) {
  const frame = useFixturePage(declaration, options.address);
  return (
    <UiPageContext.Provider value={frame}>
      {createElement(component, { data: options.loaded ?? null, props: { ...options.props } })}
    </UiPageContext.Provider>
  );
}

/** A section's component drawn over fixtures, as the page would draw it: for a story, or anything else without a server. */
export function FixtureSection<P>({
  component,
  declaration,
  options = {},
}: {
  component: ComponentType<P>;
  declaration: AuthoredSection;
  options?: RenderOptions;
}) {
  const data = options.data ?? fixtures({});
  const [host] = useState(() => fixtureHost(data, options, []));
  return (
    <SectionFrame host={host} id={declaration.component.id} width={options.width ?? 960}>
      {createElement(component as ComponentType<Record<string, unknown>>, sectionProps(declaration, data, options))}
    </SectionFrame>
  );
}

/* ---------- examples: one module a test and a story share ---------- */

type Declared = AuthoredSection | AuthoredList | AuthoredPage | { id: string; kind?: string };
const kindOf = (declaration: Declared): 'section' | 'list' | 'page' | 'value' =>
  'presentation' in declaration ? 'list' : 'reads' in declaration ? 'page' : 'component' in declaration ? 'section' : 'value';

/** A component drawn over fixtures as its placement draws it, whatever its kind: what an example renders. */
export function FixtureComponent({
  component,
  declaration,
  options = {},
  navigations = [],
  commands = [],
}: {
  component: ComponentType<never>;
  declaration: Declared;
  options?: RenderOptions;
  navigations?: Navigation[];
  commands?: CommandCall[];
}) {
  const data = options.data ?? fixtures({});
  const [host] = useState(() => fixtureHost(data, options, navigations, commands));
  const kind = kindOf(declaration);
  const width = options.width ?? 960;
  const drawn = component as unknown as ComponentType<Record<string, unknown>>;
  const id =
    'presentation' in declaration
      ? declaration.presentation.component.id
      : 'reads' in declaration
        ? 'page'
        : 'component' in declaration
          ? declaration.component.id
          : declaration.id;
  const body =
    kind === 'list' ? (
      <ListBody component={drawn} declaration={declaration as AuthoredList} data={data} options={options} host={host} />
    ) : kind === 'page' ? (
      <PageBody component={drawn} declaration={declaration as AuthoredPage} options={options} />
    ) : kind === 'section' ? (
      createElement(drawn, sectionProps(declaration as AuthoredSection, data, options))
    ) : (
      createElement(drawn, {
        value: options.props?.value,
        row: options.record,
        column: options.props?.column ?? { name: 'value', resource: '' },
        context: options.props?.context ?? 'record',
        compact: (options.props?.context ?? 'record') !== 'record',
      })
    );
  return (
    <SectionFrame
      host={host}
      id={id}
      width={width}
      className={kind === 'value' ? 'custom-value' : kind === 'list' ? 'custom-list' : kind === 'page' ? 'custom-room' : 'custom-section'}
    >
      {body}
    </SectionFrame>
  );
}

/** One example: its options over the examples' shared ones (`examples()`), as a story's args. */
export interface Example {
  args: RenderOptions;
  name?: string;
}
export function example(options: RenderOptions, name?: string): Example {
  return { args: options, ...(name ? { name } : {}) };
}

/**
 * A component's examples: the default export of an App's `widgets/*.examples.tsx`, with each
 * `export const Name = example({...})` one of them. Storybook draws each as a story (its
 * indexer reads the `example(` exports), and a test renders the same one (`renderExample`),
 * so what a story shows is what a test checks.
 */
export function examples(
  component: ComponentType<never>,
  declaration: Declared,
  shared: RenderOptions = {},
  meta: { title?: string } = {},
) {
  const title =
    typeof (declaration as AuthoredSection).title === 'string'
      ? ((declaration as AuthoredSection).title as string)
      : (declaration as AuthoredPage | AuthoredList).label;
  return {
    ...(meta.title ? { title: meta.title } : {}),
    component,
    parameters: { layout: 'padded', controls: { disable: true }, mistri: { declaration, shared } },
    render: (args: RenderOptions) => {
      const options = { ...shared, ...args };
      const kind = kindOf(declaration);
      const drawn = <FixtureComponent component={component} declaration={declaration} options={options} />;
      /* A section or a list stands where the page puts one: in a page section, under its title. */
      return kind === 'section' || kind === 'list' ? (
        <section className="page-section" style={{ maxWidth: options.width ?? 960 }}>
          {title ? <h2 className="page-section-title">{title}</h2> : null}
          {drawn}
        </section>
      ) : (
        <div style={{ maxWidth: options.width ?? 960 }}>{drawn}</div>
      );
    },
  };
}
