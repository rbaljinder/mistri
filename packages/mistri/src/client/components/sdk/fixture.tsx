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
import { ComponentStyleScope } from '@mistriwork/ui/internal/ComponentStyleScope.js';
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
  type UiCommandHandle,
  type UiCommandOptions,
  type UiCommandOutcome,
  type UiFormOutcome,
  type UiFormState,
  type UiHost,
  type UiLook,
  type UiPageFrame,
  type UiAddress,
  type UiReferenceInput,
  type UiResourceChoices,
  type UiRow,
  type UiViewer,
} from './context.js';
import { say } from '../../copy/components/components/sdk/fixture.js';
import { heldReview, holdReview, reviewFresh, reviewOwner, staleReview } from '../../commandReviews.js';
import { captureAppFlagValues, type AppFlagValue } from '../../../shared/appFlagValues.js';
import { registerPageBlocks } from './pageBlocks.js';
import { sayAppMessage } from './appMessage.js';
import { totalFigure, totalGroups } from '../../../shared/customTotals.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import type { AppCommandField } from '../../../shared/command.js';
import { labelColumn, primaryKey, type TableMeta } from '@mistriwork/engine/shared/schema.js';

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
  | { kind: 'address'; href: string }
  | { kind: 'form'; view: string; prefill: Readonly<Record<string, string | number>>; at?: string }
  | { kind: 'composer'; text: string; mode?: 'reply' | 'note' };

/** A command a component ran or opened, recorded instead of sent. */
export interface CommandCall {
  command: string;
  mode: 'run' | 'open';
  key: Readonly<Record<string, unknown>>;
  input?: Readonly<Record<string, unknown>>;
}

/**
 * The App's catalog as a test holds it: the tables a resource names, each with its columns, so a row is titled as the
 * App titles it (its name column, `labelTemplate` aside) and a `useOptions(resource)` picker keys by the table's own
 * key. The shape of the schema the App serves; a column needs its `name` and `type`, and `primaryKey` where it is one.
 */
export interface FixtureCatalog {
  tables: ReadonlyArray<{
    name: string;
    id?: string;
    columns: ReadonlyArray<{
      name: string;
      type: string;
      primaryKey?: boolean;
      nullable?: boolean;
      references?: unknown;
      allowed?: readonly string[];
    }>;
  }>;
}

export interface RenderOptions {
  /** The App's catalog: what a row is titled by (`rowTitle`) and a resource's picker keys by. Without it, a guess: `title`, `name`, `label`, `subject`, then `id`. */
  catalog?: FixtureCatalog;
  /** Evaluated values only; omitted fixtures leave the flags reader unready. */
  flags?: Readonly<Record<string, AppFlagValue>>;
  /** Where `useAnalytics().emit` calls are collected, for a test to read. */
  analytics?: { name: string; fields?: Readonly<Record<string, string | number | boolean>> }[];
  data?: Fixtures;
  /** The page's record, for a section that declares `record`: its fields are read from here. A record's tab page
   * (`pages/<view>/[id]/<tab>.page.tsx`) is drawn on it: `useRecordKey` answers it. */
  record?: UiRow;
  /** Props beside the declaration's own: a test of one prop's effect. */
  props?: Record<string, unknown>;
  look?: string;
  /** The theme the look started from, where `look` is `'tenant'`; the look itself when unsaid. */
  preset?: string;
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
   * A page's fixed action (`useAction`) is served the same way, by its id.
   */
  commands?: Record<
    string,
    {
      label?: string;
      available?: (key: Readonly<Record<string, unknown>>) => boolean;
      outcome?: UiCommandOutcome;
      /** The resource the command writes: a `refresh` that changes it makes a review of it (`prepare`) stale, as live sync does. */
      resource?: string;
      /** Its inputs, by name, as the command declares them, for `useField`: a kind and the rules it is judged by. */
      input?: Record<string, FixtureInput>;
      /** What the server's check of a step answers (`<Steps>`): each named input's problem, by path; none unless said. */
      check?: (input: Readonly<Record<string, unknown>>, names: readonly string[]) => Readonly<Record<string, string>> | undefined;
    }
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
  /** Where what a page announces (`<CommandButton>`'s outcome) is collected, for a test to read; it is also drawn in a `status` region. */
  announced?: { text: string; tone: 'ok' | 'error' }[];
  /** What `useNavigate().publicLink` answers, by view key: a tenant's own links. None by default. */
  publicLinks?: Record<string, string>;
  /**
   * The resources the reader may not read, each with the status the server refuses it with: 401 signed out, 403 not
   * this reader's role. A read of one fails as the page's does, so a test sees the refused state; `refresh` can take
   * a grant away from a page already drawn.
   */
  refused?: Record<string, 401 | 403>;
  /**
   * A page's declared forms (`page.useForm`), by view key: the draft the reader has, a submit still pending, and how
   * the form ends when the test's page opens it. A form left out is not granted, and none is to a signed-out reader,
   * as with `commands`; either still opens, with no draft, and closes with nothing sent.
   */
  forms?: Record<string, FixtureForm>;
}

/** One declared form as a test sets it: a resumed draft, a submit not yet known to have landed, the outcome it closes with. */
interface FixtureForm {
  label?: string;
  steps?: ReadonlyArray<{ id: string; label: string }>;
  draft?: UiFormState['draft'];
  pending?: boolean;
  outcome?: UiFormOutcome;
}

/** One input of a fixture's command, as the command declares it: what `useField` binds to and judges by. */
interface FixtureInput {
  type: 'text' | 'textarea' | 'number' | 'money' | 'boolean' | 'date' | 'reference';
  label?: string;
  required?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  /** A money input kept in minor units, in `currency` (the App's unless said). */
  minor?: boolean;
  currency?: string;
  /** A reference's resource, whose fixture rows are its choices (`useOptions`), by its key (`id`) and label (`name`) columns. */
  from?: string;
  by?: string;
  labelColumn?: string;
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
  actions?: readonly string[];
  /** Its address parameters: names, or each name with its kind (`{ class: 'id' }`). */
  params?: readonly string[] | Readonly<Record<string, unknown>>;
  loader?: string;
}

/* An object condition (pageWhere.ts) judged on fixture rows as the server's query would judge it: a list is any of
   its values, null is empty, and digits match the number they spell, as a bare number does in the language. */
const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const same = (a: unknown, b: unknown) =>
  a === b || (a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b));
function compared(a: unknown, b: unknown): number {
  const x = Number(a),
    y = Number(b);
  if (typeof a !== 'boolean' && a !== '' && b !== '' && Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}
function holds(value: unknown, wanted: unknown): boolean {
  if (wanted === null) return value === null || value === undefined;
  if (Array.isArray(wanted)) return wanted.some((one) => same(value, one));
  if (!plainObject(wanted)) return same(value, wanted);
  return Object.entries(wanted).every(([op, operand]) => {
    if (operand === undefined) return true;
    if (op === 'not') return !holds(value, operand);
    if (value === null || value === undefined) return false;
    const text = String(value).toLowerCase(),
      part = String(operand).toLowerCase();
    if (op === 'gt') return compared(value, operand) > 0;
    if (op === 'gte') return compared(value, operand) >= 0;
    if (op === 'lt') return compared(value, operand) < 0;
    if (op === 'lte') return compared(value, operand) <= 0;
    if (op === 'contains') return text.includes(part);
    if (op === 'startsWith') return text.startsWith(part);
    if (op === 'endsWith') return text.endsWith(part);
    throw new Error(`The object form has no operator "${op}".`);
  });
}
function matches(row: UiRow, where: unknown): boolean {
  if (where === undefined || where === null) return true;
  if (Array.isArray(where)) return where.every((each) => matches(row, each));
  return Object.entries(where as Record<string, unknown>).every(([column, wanted]) => wanted === undefined || holds(row[column], wanted));
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
  where?: unknown,
  offset = 0,
): UiRow[] {
  return ordered(
    (data.tables[resource] ?? []).filter((row) => matches(row, where)),
    sort,
  )
    .slice(offset, offset + (limit ?? 20))
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

/* A row's name as the App's catalog titles it: the table's name column, else its key. Undefined without the table, and the
   caller guesses as a test without a catalog always has. */
function catalogTitle(catalog: FixtureCatalog | undefined, resource: string): ((row: UiRow) => string | undefined) | undefined {
  const found = catalog?.tables.find((candidate) => candidate.id === resource || candidate.name === resource);
  if (!found) return undefined;
  const table = found as unknown as TableMeta;
  const column = labelColumn(table);
  const keys = primaryKey(table);
  return (row) => {
    const named = column === undefined ? undefined : row[column];
    if (named !== null && named !== undefined && String(named) !== '') return String(named);
    const parts = keys.map((key) => row[key]).filter((part) => part !== null && part !== undefined);
    return parts.length ? parts.join('/') : undefined;
  };
}
const catalogKey = (catalog: FixtureCatalog | undefined, resource: string): string => {
  const found = catalog?.tables.find((candidate) => candidate.id === resource || candidate.name === resource);
  return (found && primaryKey(found as unknown as TableMeta)[0]) || 'id';
};
const guessedTitle = (row: UiRow): string | undefined => {
  for (const name of ['title', 'name', 'label', 'subject']) {
    if (row[name] !== null && row[name] !== undefined && String(row[name]) !== '') return String(row[name]);
  }
  const text = Object.entries(row).find(([name, value]) => name.endsWith('name') && typeof value === 'string' && value)?.[1];
  return typeof text === 'string' ? text : row.id === undefined || row.id === null ? undefined : String(row.id);
};

/* An address as the router says it for a table keyed by one column, or by several named: `/leads/127`, `/leads/127/map`;
   a view with a search and a tab is `/leads?tab=working&search=stone`. The App's own book writes the real ones (appAddress.ts). */
function fixtureHref(to: UiAddress): string {
  const query = (params: Readonly<Record<string, string>> | undefined) => {
    const text = params ? new URLSearchParams(params).toString() : '';
    return text ? `?${text}` : '';
  };
  if (to.kind === 'signIn') return '/sign-in';
  if (to.kind === 'view') return `/${encodeURIComponent(to.view)}${query(to.params)}`;
  if (to.kind === 'page') return `/${encodeURIComponent(to.path)}${query(to.params)}`;
  const entries = Object.entries(to.key);
  const id =
    entries.length === 1
      ? encodeURIComponent(String(entries[0][1]))
      : entries.map(([name, value]) => `${name}=${encodeURIComponent(String(value))}`).join(',');
  return `/${encodeURIComponent(to.view)}/${id}${to.tab ? `/${encodeURIComponent(to.tab)}` : ''}`;
}

export function fixtureHost(data: Fixtures, options: RenderOptions, navigations: Navigation[], commands: CommandCall[] = []): UiHost {
  /* Read at every call, not once: a test's `refresh` takes a grant away from a page already drawn. */
  const refuse = (resource: string) => {
    const status = options.refused?.[resource];
    if (status) throw Object.assign(new Error(say('fixtureRefused', { resource })), { status });
  };
  const look: UiLook = {
    look: options.look ?? 'workshop',
    preset: options.preset ?? options.look ?? 'workshop',
    mode: options.mode ?? 'light',
    density: 'comfortable',
  };
  /* A fresh page says nothing yet: an announcement left by the test before is not this one's. */
  // host-global: the test's own document, where the fixture said what it announced.
  if (typeof document !== 'undefined') document.getElementById('mistri-fixture-announce')?.remove();
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
  /* A command and a fixed action are served the same way here: by id, granted to a signed-in reader. */
  const handle = (id: string, kind: 'command' | 'action'): UiCommandHandle => {
    const entry = Object.hasOwn(served, id) ? served[id] : undefined;
    const granted = Boolean(entry) && viewer.signedIn;
    const label = entry?.label ?? id;
    const call =
      (mode: 'run' | 'open') =>
      async (
        key: Readonly<Record<string, unknown>>,
        input?: Readonly<Record<string, unknown>>,
        options: UiCommandOptions = {},
      ): Promise<UiCommandOutcome> => {
        /* A refusal is said by the run itself, as the page's is (commands.tsx), so a test reads it where a person would. */
        if (!granted) {
          const message = viewer.signedIn ? say('notGranted') : say('signInToDo');
          host.announce(message, 'error');
          return { status: 'refused', message };
        }
        /* A review handed back is judged as the page judges it (commands.tsx): one gone stale is refused and never recorded as a run. */
        const review = options.review && heldReview(options.review.token);
        if (options.review && (!review?.fresh || review.owner !== reviewOwner('fixture', id, 0, key))) {
          const message = say('reviewStale', { label });
          if (!options.quiet) host.announce(message, 'error');
          return { status: 'refused', code: 'stale', message };
        }
        if (options.review) staleReview(options.review.token);
        commands.push({ command: id, mode, key, ...(input ? { input } : {}) });
        const outcome =
          entry!.outcome ?? (mode === 'open' && kind === 'command' ? { status: 'closed' as const } : { status: 'applied' as const });
        if (outcome.status === 'refused' && !options.quiet) host.announce(outcome.message, 'error');
        /* A fixed action says its own outcome, as the page's does (commands.tsx); a command leaves it to its caller. */
        if (kind === 'action' && outcome.status === 'applied') host.announce(options.done ?? say('actionDone', { label }), 'ok');
        return outcome;
      };
    return {
      label,
      granted,
      available: async (key) => granted && (entry!.available?.(key) ?? true),
      run: call('run'),
      open: call('open'),
      ...(kind === 'command'
        ? {
            prepare: async (key: Readonly<Record<string, unknown>>, input?: Readonly<Record<string, unknown>>) => {
              if (!granted) return { status: 'refused' as const, message: viewer.signedIn ? say('notGranted') : say('signInToDo') };
              const token = holdReview(reviewOwner('fixture', id, 0, key), entry!.resource ?? '', key, 0);
              return Object.freeze({
                token,
                values: { ...input },
                get fresh() {
                  return reviewFresh(token);
                },
              });
            },
          }
        : {}),
      /* Served as the page serves it: a field with its label, the name said as words where the fixture gives none. */
      input: (name) => {
        const declared = entry?.input && Object.hasOwn(entry.input, name) ? entry.input[name] : undefined;
        const reference = declared?.type === 'reference' ? { by: 'id', labelColumn: 'name' } : {};
        return declared && ({ name, label: humanName(name), ...reference, ...declared } as AppCommandField);
      },
      check: async (input, names) => (granted ? { ...entry!.check?.(input, names) } : undefined),
    };
  };
  /* A reference input is read by its own key and label columns; a resource, by its catalog's key and title. */
  const choiceArm = (field: UiReferenceInput | UiResourceChoices) =>
    'resource' in field
      ? {
          from: field.resource,
          by: catalogKey(options.catalog, field.resource),
          where: field.where,
          label: (row: UiRow, key: string | number): string => title(field.resource, row) ?? String(key),
        }
      : {
          from: field.from,
          by: field.by,
          where: undefined,
          label: (row: UiRow, key: string | number): string => String(row[field.labelColumn] ?? key),
        };
  const title = (resource: string, row: UiRow) => (catalogTitle(options.catalog, resource) ?? guessedTitle)(row);
  const host: UiHost = {
    flags: { ...flags, snapshot: () => flags, subscribe: () => () => {}, load: async () => {} },
    analytics: {
      emit: (name, fields) => {
        options.analytics?.push({ name, ...(fields ? { fields } : {}) });
      },
    },
    scope: ['test'],
    /* A fixture's key is `id`, as its custom list's is (ListBody). */
    /* Asked one past the page, as the page host asks the server, so `more` is the same answer in a test. */
    rows: async (resource, { show, sort, limit, where, keys, offset }) => {
      refuse(resource);
      const size = limit ?? 20;
      const got = read(data, resource, keys && show?.length ? [...new Set([...show, 'id'])] : show, sort, size + 1, where, offset);
      return { rows: got.slice(0, size), more: got.length > size };
    },
    record: async (resource, key, show) => {
      refuse(resource);
      const row = (data.tables[resource] ?? []).find((candidate) =>
        Object.entries(key).every(([column, value]) => candidate[column] === value),
      );
      return row && pick(row, show?.length ? [...new Set([...show, ...Object.keys(key)])] : show);
    },
    breakdown: async (resource, { by, measure, limit }) => {
      refuse(resource);
      return breakdown(data, resource, by, measure, limit);
    },
    load: async () => options.loaded ?? null,
    openRecord: (resource, key, { mode = 'page' } = {}) => {
      navigations.push({ kind: 'record', resource, key, mode });
    },
    openView: (view, { tab, search, filters } = {}) => {
      navigations.push({ kind: 'view', view, ...(tab ? { tab } : {}), ...(search ? { search } : {}), ...(filters ? { filters } : {}) });
    },
    follow: (href) => {
      navigations.push({ kind: 'address', href });
    },
    openForm: (view, prefill = {}) => {
      navigations.push({ kind: 'form', view, prefill });
    },
    /* Read at every call, as `refused` is: a started-over draft is gone for the page's next read. */
    form: (view) => {
      const declared = () => options.forms?.[view] ?? {};
      return {
        state: async () => {
          const form = declared();
          return {
            label: form.label ?? view,
            granted: viewer.signedIn && Object.hasOwn(options.forms ?? {}, view),
            steps: form.steps ?? [],
            draft: form.draft ?? null,
            pending: form.pending ?? false,
          };
        },
        open: async (input, { at } = {}) => {
          navigations.push({
            kind: 'form',
            view,
            prefill: (input ?? {}) as Readonly<Record<string, string | number>>,
            ...(at === undefined ? {} : { at }),
          });
          return declared().outcome ?? { status: 'closed' };
        },
        startOver: async () => {
          const form = declared();
          if (!form.draft || form.pending) return false;
          options.forms = { ...options.forms, [view]: { ...form, draft: null } };
          return true;
        },
      };
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
    command: (id) => handle(id, 'command'),
    action: (id) => handle(id, 'action'),
    /* A reference's choices are its resource's fixture rows by their label, as the picker reads them; a refused
       resource is refused here too, so a test takes the reader's access away from a choice already made. */
    choices: async (field, text, { offset, limit }) => {
      const arm = choiceArm(field);
      refuse(arm.from);
      const wanted = text.trim().toLowerCase();
      const named = (data.tables[arm.from] ?? [])
        .filter((row) => matches(row, arm.where))
        .flatMap((row) => {
          const key = row[arm.by];
          return typeof key === 'string' || typeof key === 'number' ? [{ key, label: arm.label(row, key) }] : [];
        })
        .filter((option) => option.label.toLowerCase().includes(wanted))
        .sort((one, other) => one.label.localeCompare(other.label));
      return { options: named.slice(offset, offset + limit), more: named.length > offset + limit };
    },
    choiceName: async (field, key) => {
      const arm = choiceArm(field);
      refuse(arm.from);
      const row = (data.tables[arm.from] ?? []).find((candidate) => candidate[arm.by] === key && matches(candidate, arm.where));
      return row ? { key, label: arm.label(row, key) } : null;
    },
    href: (to) => fixtureHref(to),
    viewer: () => viewer,
    subscribeViewer: () => () => {},
    column: (resource, name) => {
      const sample = (data.tables[resource] ?? []).find((row) => row[name] !== null && row[name] !== undefined)?.[name];
      const type = typeof sample === 'number' ? 'numeric' : typeof sample === 'boolean' ? 'boolean' : 'text';
      return { meta: { name, type } as never, rule: authoredDisplay(data.display[`${resource}.${name}`]), label: name };
    },
    look: () => look,
    deployment: () => ({ name: 'Fixture App', mark: null, theme: look.look, locale: options.locale ?? null, basePath: '' }),
    token: (name) => options.tokens?.[name] ?? '',
    subscribeLook: () => () => {},
    app: true,
    message: (key, args) => sayAppMessage(options.messages, key, args),
    /* Said where a test finds it, as the page's live region says it: `findByText` reads what a button announced. */
    announce: (text, tone) => {
      options.announced?.push({ text, tone });
      if (typeof document === 'undefined') return;
      // host-global: the fixture renders into a test's own document, which has no shell to ask.
      let region = document.getElementById('mistri-fixture-announce');
      if (!region) {
        region = document.createElement('div');
        region.id = 'mistri-fixture-announce';
        region.setAttribute('role', 'status');
        // host-global: as above, the test's document.
        document.body.append(region);
      }
      region.textContent = text;
    },
    rowTitle: (resource, row) => title(resource, row),
  };
  return host;
}

/** A query cache as a test wants one: a failed read fails at once rather than after the page's retries. */
export const fixtureClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** The frame a component is drawn in: the fixture host, its measured width, and a query cache of its own. */
export function SectionFrame({
  host,
  id,
  width,
  children,
  className = 'custom-section',
  client: given,
}: {
  host: UiHost;
  id: string;
  width: number;
  children: ReactNode;
  className?: string;
  /** The test's own cache, when it refreshes what is drawn (`Drawn.refresh`); else one of the frame's own. */
  client?: QueryClient;
}) {
  const [client] = useState(() => given ?? fixtureClient());
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
function useFixturePage(declaration: AuthoredPage, address: Record<string, string> = {}, record?: UiRow): UiPageFrame {
  const [place, setPlace] = useState<Record<string, string>>(address);
  return useMemo(
    () => ({
      view: 'page',
      label: declaration.label,
      reads: declaration.reads,
      commands: declaration.commands ?? [],
      actions: declaration.actions ?? [],
      params: Array.isArray(declaration.params) ? declaration.params : Object.keys(declaration.params ?? {}),
      ...(declaration.loader ? { loader: declaration.loader } : {}),
      ...(record ? { record: { key: record } } : {}),
      get: (name) => place[name],
      set: (name, value) =>
        setPlace((before) => {
          const next = { ...before };
          if (value === undefined) delete next[name];
          else next[name] = value;
          return next;
        }),
    }),
    [declaration, place, record],
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
  const frame = useFixturePage(declaration, options.address, options.record);
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
  client,
}: {
  component: ComponentType<never>;
  declaration: Declared;
  options?: RenderOptions;
  navigations?: Navigation[];
  commands?: CommandCall[];
  client?: QueryClient;
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
      client={client}
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
