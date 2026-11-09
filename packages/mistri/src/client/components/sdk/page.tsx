/**
 * `@mistriwork/mistri/page`: a free-form page, one file each (`pages/<path>.page.tsx`); the file's name is its path.
 *
 *   const page = definePage({ label: 'Pick walk', reads: ['pick_list'], commands: ['pickList'],
 *     params: ['list'], loader: 'pickWalk', component: PickWalk });
 *   export default page;
 *   function PickWalk({ data }) { const [list, setList] = page.useParam('list'); … }
 *
 * What the page says of itself is read by the server without drawing it
 * (server/app/appPages.ts) and served back as its manifest, which the page
 * is drawn inside (UiPageFrame): the hooks bound to the definition read and
 * run only what it declares, and its loader's result arrives as `data`.
 *
 * `definePage` hands back a component — the page itself — with its hooks on
 * it. They are the SDK's own hooks: `page.useX` is the shape so the types
 * can bind them to this page's reads, commands and parameters
 * (packages/mistri/schema/page.d.ts), and so a linter still sees them as hooks.
 *
 * It is the one import a page needs: everything `@mistriwork/mistri/ui` exports, and beside it the page's own — the
 * platform's command form and per-row buttons, `Scope` and `List`, the layout's `Grid` and `Panel`, the platform's
 * sections as components (blocks.tsx) and the house controls (pageControls.ts), each part loaded when a page first
 * draws one. In the page this module is the page's own, reached through the import map like `@mistriwork/mistri/ui`;
 * its value exports are `PAGE_EXPORTS` (shared/uiSdk.ts), of which `UI_EXPORTS` is a part.
 */
import { createContext, createElement, useContext, useMemo, type ComponentType, type ReactNode } from 'react';
import { Refused } from '@mistriwork/kit/client/components/Notes.js';
import { useAction, useAddressState, useBreakdown, useCommand, useFile, useForm, useRecord, useRows } from './hooks.js';
import { Button, Loaded } from './kit.js';
import {
  scopedCondition,
  UiPageContext,
  UiParamKindsContext,
  UiScopeContext,
  useUiHost,
  type UiCommandOutcome,
  type UiScope,
} from './context.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { pageBlocks } from './pageBlocks.js';
import { state } from '@mistriwork/kit/client/core.js';
import { tableNamed } from '@mistriwork/engine/shared/schema.js';
import { idKeyOf, paramKinds, paramValue, type ParamValue } from './paramKinds.js';
import { say } from '../../copy/components/components/sdk/page.js';

export * from './index.js';
export { Card, Cluster, Columns, Empty, Heading, Loaded, Row, Stack, Stat, Value } from './kit.js';
export { Button };
/* A page's place in its address, as written: `page.useParam` reads it through this hook and checks it against the
   param's kind; this one is for a module the page draws that is not the page itself (a widget, the Console's rooms). */
export { useAddressState };
/* The platform's blocks (blocks.tsx): a part of their own, loaded when a page first draws one. They draw the
   platform's rooms, which reach this module again through the host, so the module that draws a free-form page hands
   in how they load (pageBlocks.ts) rather than this one importing them. */
const blocks = () => pageBlocks<typeof import('./blocks.js')>(say('blocksUnregistered'));
export const Rows = onDemand(blocks, 'Rows');
export const RecordCard = onDemand(blocks, 'RecordCard');
export const Metric = onDemand(blocks, 'Metric');
export const Chart = onDemand(blocks, 'Chart');
export const Breakdown = onDemand(blocks, 'Breakdown');
export const Timeline = onDemand(blocks, 'Timeline');
export const Tree = onDemand(blocks, 'Tree');
export const Gantt = onDemand(blocks, 'Gantt');
export const Board = onDemand(blocks, 'Board');
export const Calendar = onDemand(blocks, 'Calendar');
export const Gallery = onDemand(blocks, 'Gallery');
export const Split = onDemand(blocks, 'Split');
export const Assistant = onDemand(blocks, 'Assistant');
export const Tabs = onDemand(blocks, 'Tabs');
export const Steps = onDemand(blocks, 'Steps');

/* Controls bound to a param of the page (paramControls.tsx): the address is their state. A part of their own, fetched the
   first time a page draws one; the box they stand in holds a control's height (kit.css), so the part arrives in place. */
const paramControls = () => import('./paramControls.js');
function reserved<P extends object>(Part: ComponentType<P>): (props: P) => ReactNode {
  return (props) => (
    <div className="kit-param">
      <Part {...props} />
    </div>
  );
}
export const Choose = reserved(onDemand(paramControls, 'Choose', { quiet: true }));
export const Search = reserved(onDemand(paramControls, 'Search', { quiet: true }));
export const DateRange = reserved(onDemand(paramControls, 'DateRange', { quiet: true }));

/* The house controls, as the shell dresses its own (pageControls.ts): a part of their own with their rules, fetched
   the first time a page draws one, so a page that draws none carries none. */
const controls = () => import('./pageControls.js');
export const Avatar = onDemand(controls, 'Avatar', { quiet: true });
export const CheckCards = onDemand(controls, 'CheckCards', { quiet: true });
export const Checkbox = onDemand(controls, 'Checkbox', { quiet: true });
export const ChoiceCards = onDemand(controls, 'ChoiceCards', { quiet: true });
export const DateField = onDemand(controls, 'DateField', { quiet: true });
export const Drawer = onDemand(controls, 'Drawer', { quiet: true });
export const Modal = onDemand(controls, 'Modal', { quiet: true });
export const Pagination = onDemand(controls, 'Pagination', { quiet: true });
export const Popover = onDemand(controls, 'Popover', { quiet: true });
export const Select = onDemand(controls, 'Select', { quiet: true });
export const Slider = onDemand(controls, 'Slider', { quiet: true });
export const Switch = onDemand(controls, 'Switch', { quiet: true });
export const TextField = onDemand(controls, 'TextField', { quiet: true });
export const Tooltip = onDemand(controls, 'Tooltip', { quiet: true });
export const YesNo = onDemand(controls, 'YesNo', { quiet: true });

/** The page's grid: blocks and panels side by side by their `width`, wrapping as a dashboard's sections do. */
export function Grid({ children }: { children?: ReactNode }) {
  return <div className="page-body">{children}</div>;
}

/**
 * A line of words: `<Text tone="muted" size="sm">Not shared with your role.</Text>`. The default is the page's ink; `muted`
 * is its secondary ink, for a note or a caption; `danger` is the status colour for a refusal or a failure. It stands
 * in a Card or on the page and sets no layout of its own.
 */
export function Text({
  tone = 'default',
  size = 'md',
  children,
}: {
  tone?: 'default' | 'muted' | 'danger';
  size?: 'sm' | 'md';
  children?: ReactNode;
}) {
  return (
    <p className={['kit-text', tone === 'default' ? '' : `kit-text-${tone}`, size === 'sm' ? 'kit-text-sm' : ''].filter(Boolean).join(' ')}>
      {children}
    </p>
  );
}

/** A titled region of the grid, a dashboard section's box: `<Panel title="Open lines" width="half">…</Panel>`. */
export function Panel({
  title,
  width = 'full',
  children,
}: {
  title?: ReactNode;
  width?: 'full' | 'half' | 'third' | 'two-thirds';
  children?: ReactNode;
}) {
  return (
    <section className={`page-section width-${width}`}>
      {title !== undefined && <h2 className="page-section-title">{title}</h2>}
      {children}
    </section>
  );
}

/** What a page's component is drawn with: its loader's result, and the props the platform placed it with. */
export interface PageProps<D = unknown> {
  data: D;
  props: Readonly<Record<string, unknown>>;
}

const FIELDS = [
  'label',
  'icon',
  'nav',
  'roles',
  'reads',
  'commands',
  'actions',
  'params',
  'loader',
  'forms',
  'public',
  'description',
  'favorite',
  'head',
  'layout',
];

/** The keys `defineSurface` takes: a free-form page's, but what only something drawn by mistri has (server/app/appSurfaces.ts). */
const SURFACE_FIELDS = ['label', 'icon', 'description', 'favorite', 'roles', 'reads', 'commands', 'forms', 'loader'];

/** A surface as `defineSurface` makes it: its definition, for the server to read and a front end's types to follow. */
export interface SurfaceDefinition {
  readonly definition: Readonly<Record<string, unknown>>;
}

/**
 * What a front end the App draws itself may read and run (`surfaces/<key>.surface.ts`): a free-form page's manifest
 * with nothing to draw. The server reads it from the file; this is the same check where a front end imports it.
 */
export function defineSurface(definition: Record<string, unknown>): SurfaceDefinition {
  if (!definition || typeof definition !== 'object') throw new TypeError(say('defineSurfaceTakes'));
  for (const name of Object.keys(definition)) if (!SURFACE_FIELDS.includes(name)) throw new TypeError(say('defineSurfaceHasNo', { name }));
  return { definition: Object.freeze({ ...definition }) };
}

/** A page as `definePage` makes it: the component that draws it, its definition and its hooks. */
export interface PageDefinition<D = unknown> {
  (props: PageProps<D>): ReactNode;
  readonly definition: Readonly<Record<string, unknown>>;
  readonly useRows: typeof useRows;
  readonly useRecord: typeof useRecord;
  readonly useBreakdown: typeof useBreakdown;
  readonly useFile: typeof useFile;
  readonly useCommand: typeof useCommand;
  readonly useAction: typeof useAction;
  readonly useForm: typeof useForm;
  readonly useRecordKey: (resource: string) => Readonly<Record<string, unknown>>;
  readonly useParam: (name: string) => [ParamValue | undefined, (value: string | number | undefined, options?: { push?: boolean }) => void];
  /** The param controls, held to the page's params and reads by the types (schema/page.d.ts); the same components at run time. */
  readonly Choose: typeof Choose;
  readonly Search: typeof Search;
  readonly DateRange: typeof DateRange;
  /** A command's form over several steps, its step held in one of the page's params (steps.tsx). */
  readonly Steps: typeof Steps;
}

/** A free-form page: its label, reads, commands, actions, parameters and loader, and the component that draws it. */
export function definePage<D = unknown>(
  definition: Record<string, unknown> & { component: ComponentType<PageProps<D>> },
): PageDefinition<D> {
  if (!definition || typeof definition !== 'object' || typeof definition.component !== 'function')
    throw new TypeError(say('definePageTakes'));
  const { component, ...fields } = definition;
  for (const name of Object.keys(fields)) if (!FIELDS.includes(name)) throw new TypeError(say('definePageHasNo', { name }));
  const draw = component;
  const kinds = paramKinds(fields.params);
  // The kinds ride the page's context, so a control bound to a param reads its words without the page naming them twice.
  const Page = (props: PageProps<D>) => createElement(UiParamKindsContext.Provider, { value: kinds }, createElement(draw, props));
  function useParam(name: string) {
    const [raw, set] = useAddressState(name);
    const frame = useContext(UiPageContext);
    /* An id param named for a resource the page reads is that resource's key: text for a tenant's opaque ids. */
    const table = kinds[name] === 'id' && frame?.reads.includes(name) && state.schema ? tableNamed(state.schema, name) : undefined;
    return [paramValue(raw, kinds[name] ?? 'text', idKeyOf(table)), set] as [
      ParamValue | undefined,
      (value: string | number | undefined, options?: { push?: boolean }) => void,
    ];
  }
  /* A record's tab learns its record from the place it is drawn in, not from a param: the address is the record's
     own (`/compass/accounts/13/map`), and the resource is named so the key's type is that resource's key. */
  function useRecordKey(resource: string) {
    const frame = useContext(UiPageContext);
    const record = frame?.record;
    if (!record)
      throw new Error(typeof fields.label === 'string' ? say('recordKeyOutside', { label: fields.label }) : say('recordKeyUnnamed'));
    if (record.table !== undefined && record.table !== resource) throw new Error(say('recordKeyOther', { resource, table: record.table }));
    if (!frame.reads.includes(resource))
      throw new Error(say('recordKeyUnread', { label: frame.label, map: frame.reads.map((name) => `"${name}"`).join(', '), resource }));
    return record.key;
  }
  return Object.assign(Page, {
    definition: Object.freeze(fields),
    useRows,
    useRecord,
    useBreakdown,
    useFile,
    useCommand,
    useAction,
    useForm,
    useRecordKey,
    useParam,
    Choose,
    Search,
    DateRange,
    Steps,
  });
}

/**
 * A command's own form, behind a button: `<CommandForm command="releaseOrder" />`, or on one record,
 * `<CommandForm command="pickList" record={{ id: 12 }} />`. The platform's dialog, the one pipeline;
 * the button is not drawn for a reader who may not run the command.
 */
export function CommandForm({
  command,
  record,
  label,
  intent = 'secondary',
  onDone,
}: {
  command: string;
  record?: Readonly<Record<string, unknown>>;
  label?: ReactNode;
  intent?: 'primary' | 'secondary' | 'quiet';
  onDone?: (outcome: Awaited<ReturnType<ReturnType<typeof useCommand>['open']>>) => void;
}) {
  const handle = useCommand(command);
  const key = record ?? {};
  if (!handle.granted) return null;
  const busy = handle.pending(key);
  return (
    <Button
      intent={intent}
      busy={busy}
      disabled={busy || handle.available(key) === false}
      onClick={() => void handle.open(key).then((outcome) => onDone?.(outcome))}
    >
      {label ?? handle.label}
    </Button>
  );
}

/* The resource a `List`'s rows are of, for a button on one of them to name its row from (a command no action offers
   says none of its own). Not a Scope: blocks drawn in a row do not inherit the list's condition. */
const ListResource = createContext<string | undefined>(undefined);

type ButtonIntent = 'primary' | 'secondary' | 'quiet' | 'danger';
type ButtonSize = 'compact' | 'default' | 'large';
interface RowButtonProps {
  row: Readonly<Record<string, unknown>>;
  label?: string;
  intent?: ButtonIntent;
  size?: ButtonSize;
  done?: string;
  onDone?: (outcome: UiCommandOutcome) => void;
}

/* What a command's and an action's button share: drawn only for a reader granted it, held while the row's state does
   not allow it or a run on that row is on its way, and named with the row, so "Check in" on twenty rows reads as
   twenty different buttons. */
function RowButton({
  handle,
  row,
  label,
  intent = 'secondary',
  size = 'default',
  run,
}: Omit<RowButtonProps, 'done' | 'onDone'> & { handle: ReturnType<typeof useCommand>; run: () => void }) {
  const host = useUiHost();
  const scope = useContext(UiScopeContext);
  const listed = useContext(ListResource);
  if (!handle.granted) return null;
  const said = label ?? handle.label;
  const resource = handle.resource ?? listed ?? scope?.from;
  const title = resource ? host.rowTitle(resource, row) : undefined;
  const busy = handle.pending(row);
  return (
    <Button
      intent={intent}
      size={size}
      busy={busy}
      disabled={busy || handle.available(row) === false}
      aria-label={title ? `${said} ${title}` : said}
      onClick={run}
    >
      {said}
    </Button>
  );
}

/**
 * One command on one row: `<CommandButton command="checkIn" row={booking} />`. Its outcome is said in the page's live
 * region — in `done`'s words when given — and a refusal in the server's (the command's run says it). The hook
 * (`useCommand`) stays for what a button cannot say.
 */
export function CommandButton({ command, done, onDone, ...props }: RowButtonProps & { command: string }) {
  const handle = useCommand(command);
  const host = useUiHost();
  const label = props.label ?? handle.label;
  const run = () =>
    void handle.run(props.row, undefined, { label }).then((outcome) => {
      if (outcome.status === 'applied') host.announce(done ?? outcome.message ?? say('commandDone', { label }), 'ok');
      onDone?.(outcome);
    });
  return <RowButton handle={handle} run={run} {...props} />;
}

/** One of the page's fixed actions on one row, as `CommandButton` draws a command: `<ActionButton action="startVisit" row={visit} />`. */
export function ActionButton({ action, done, onDone, ...props }: RowButtonProps & { action: string }) {
  const handle = useAction(action);
  const label = props.label ?? handle.label;
  // An action says its own outcome (sdk/commands.tsx), in `done`'s words where given.
  const run = () =>
    void handle.run(props.row, undefined, { label, ...(done === undefined ? {} : { done }) }).then((outcome) => onDone?.(outcome));
  return <RowButton handle={handle} run={run} {...props} />;
}

/**
 * One resource and condition for the blocks inside it: `<Scope from="booking" where={{ class_session_id: classId }}>`.
 * A block that names no `from` reads the Scope's resource under its condition, its own `where` and `query` added by
 * "and"; one that names another resource reads that one alone; a Scope inside another on the same resource narrows it.
 */
export function Scope({ from, where, query, children }: { from: string; where?: unknown; query?: string; children?: ReactNode }) {
  const outer = useContext(UiScopeContext);
  // A condition written inline is a new object on every draw; what it says is what keeps the blocks' reads still.
  const said = JSON.stringify([from, where, query, outer]);
  const scope = useMemo<UiScope>(() => {
    const { where: conditions, query: text } = scopedCondition(outer, from, where, query);
    return { from, where: conditions, ...(text ? { query: text } : {}) };
  }, [said]); // eslint-disable-line react-hooks/exhaustive-deps
  return <UiScopeContext.Provider value={scope}>{children}</UiScopeContext.Provider>;
}

/* A row's React key: its key columns, which a `List` reads beside `show` (so they are the ones `show` did not name),
   else the whole row. Never its index: a row that leaves the list (checked in, say) would hand its focused button to
   the row after it. */
function rowKey(row: Readonly<Record<string, unknown>>, show: readonly string[] | undefined): string {
  const names = Object.keys(row);
  const keys = show ? names.filter((name) => !show.includes(name)) : [];
  return JSON.stringify((keys.length ? keys : names).map((name) => row[name]));
}

/**
 * Rows drawn by the page, one at a time: `<List from="booking" where={{ status: 'booked' }} show={['guest_name']}>{(b) => …}</List>`.
 * The read's states are the platform's (Loaded's, and a note where the reader may not read it), so `children` draws
 * only rows; each row carries its key beside `show`, for a `CommandButton` on it.
 */
export function List({
  from,
  where,
  query,
  show,
  sort,
  limit,
  empty,
  label,
  children,
}: {
  from?: string;
  where?: unknown;
  query?: string;
  show?: readonly string[];
  sort?: string;
  limit?: number;
  empty?: ReactNode;
  label?: string;
  children: (row: Readonly<Record<string, unknown>>, index: number) => ReactNode;
}) {
  const scope = useContext(UiScopeContext);
  const resource = from ?? scope?.from;
  if (!resource) throw new Error(say('listNamesNoResource'));
  const condition = scopedCondition(scope, resource, where, query);
  const rows = useRows(resource, {
    ...(condition.where.length ? { where: condition.where.length === 1 ? condition.where[0] : condition.where } : {}),
    ...(condition.query ? { query: condition.query } : {}),
    ...(show ? { show } : {}),
    ...(sort ? { sort } : {}),
    ...(limit === undefined ? {} : { limit }),
    keys: true,
  });
  const status = (rows.error as { status?: number } | null)?.status;
  if (rows.data === undefined && (status === 401 || status === 403))
    return <Refused text={say(status === 401 ? 'listForMembers' : 'listNotYours')} />;
  return (
    <Loaded query={rows} empty={empty}>
      {(data) => (
        <ListResource.Provider value={resource}>
          <ul className="kit-stack kit-gap-tight" aria-label={label}>
            {data.map((row, index) => (
              <li key={rowKey(row, show)}>{children(row, index)}</li>
            ))}
          </ul>
          {/* A list cut at its limit says so, so a reader never takes the first rows for all of them. */}
          {rows.page.hasMore && <p className="kit-list-more">{say('listShowingFirst', { count: data.length })}</p>}
        </ListResource.Provider>
      )}
    </Loaded>
  );
}
