/**
 * What the shell this page runs in answers for the kit: the walk, the record
 * page and the lists ask here about the App, the visitor, the tenant and the
 * write guards, and never import the shell that knows.
 *
 * These were loose setters on core.js and its neighbours, each called at
 * import by whichever module owned the answer (appnav.js registered eight of
 * them as it loaded), so what the walk did depended on which modules had
 * been imported, and in what order. Now the shell names its answers once, at
 * boot (`installShell`): boot itself the sign-in (shellStart.js), the kit's
 * shell its record opener (app.js), the App framework's chrome its App and
 * its tenant (appNavigation.js's `appShell`), and the Workbench its Undo
 * (workbench.js). Unanswered, everything here is the Workbench's: no App, no
 * public visitor, no tenant, the raw column names, `null` for an empty value.
 *
 * A leaf: it imports nothing of the client but types, so any module may read
 * it, and reading it never drags a shell in behind it. The embed's build-time
 * aliases (src/embed/seams/) stay the other way a page is placed, for what
 * has to be decided before any module runs (the host element, the router,
 * the endpoint).
 */
import type { ComponentType, ReactNode, RefObject } from 'react';
import type { AppCommandAction, AppCommandReference, AppTarget } from '@mistriwork/engine/schema/model.js';
import type { BoundAppTarget } from '@mistriwork/engine/shared/appLinks.js';
import type { FieldError } from './fieldErrors.js';
import type { Present } from './components/TableView.js';
import type { ActionBarProps, CustomSectionFrame, FieldAdornment, RecordActions, SlotProps } from './components/pageContext.js';
import type { ShownApp } from './components/appRooms.js';
import type { DashboardDef, DashboardProps } from './components/dashboardModel.js';
import type { ListSpec } from './components/appListModel.js';
import type { RecordSurfacePage } from './components/recordSurface.js';
import type { PageEntry, PageSection } from './components/pageModel.js';
import type { RowEntry } from './components/Record.js';
import type { KnownPage } from './components/WorkPanel.js';
import type { documentAt } from './documents.js';
import type { DatabaseSchema, TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { CustomListPresentation } from '@mistriwork/engine/shared/appComponents.js';

/** A write the shell watches until its outcome is known (tenantMutationState.ts): opaque to the kit. */
type MutationAttempt = object;
type MutationKind = 'update' | 'insert' | 'delete' | 'command';

/** What the kit asks when a write leaves and when its answer arrives; the Workbench watches nothing. */
interface MutationGuard {
  start(kind: MutationKind, identity?: object): MutationAttempt | undefined;
  unknown(attempt: MutationAttempt | undefined): boolean;
  settle(attempt: MutationAttempt | undefined): boolean;
  hasUnresolved(): boolean;
}

/** A tenant session's requests: sent through the tenant's lease (tenantTransport.ts), or none. */
interface TenantRequests {
  read(path: string, body: Record<string, unknown> | undefined, connection: string | null | undefined): Promise<unknown>;
  mutate(path: string, body: unknown, connection: string | null | undefined): Promise<unknown>;
  isMutation(path: string): boolean;
}

/** How a tenant's links are read and written (tenantLink.ts). */
interface TenantLinks {
  parse(link: string, appId: string): { pathname: string; search: string; tenantId: string | null };
  qualify(address: string, appId: string, tenantId: string): string;
}

/** An App's addresses (publicAddress.ts): one canonical address per thing. The Workbench has none of its own. */
interface AppAddresses {
  /** The App's address for a walk, or undefined where it has none. */
  address(connection: string, stack: readonly object[]): string | undefined;
  /** The walk an App address names, or null where the address is not one. */
  stackFrom(hash: string): { connection: string; stack: object[]; slugged?: boolean } | null;
  /** A list one of the App's views opened, said as address parameters. */
  listParams(entry: { table: string; query: string; view?: string }, options?: { adoptOrder?: boolean }): string | undefined;
  /** The walk entry a view's key and search name, or null where no view has the key. */
  viewEntry(key: string, search: string): object | null;
  /** The natural key a record's address is written by, where the App gives it one. */
  needsNaturalKey(entry: object | undefined): { table: string; column: string } | undefined;
}

/** The Workbench's record of what a write did, so it can be taken back (undo.js); an App keeps none. */
interface UndoRecord {
  /** Read the journal again: a write landed. */
  refresh(): Promise<unknown> | void;
  /** Take back that write, or the latest. */
  last(expectedId?: unknown): Promise<unknown> | void;
  /** The Undo a confirmation carries for the write it confirms, or undefined where there is none. */
  toast(undoId: unknown, after?: () => void): { label: string; run: () => Promise<void> } | undefined;
}

export interface ShellMode {
  /** The App on screen, as its payload says it (the kit reads the parts it draws), or null in the Workbench. */
  app(): ShownApp | null;
  /** Whether an App is on screen. */
  inApp(): boolean;
  /** Why the App's source on disk no longer loads while the App served is its last good save, or '' (appLive.ts). */
  loadError(): string;
  /** When an App's record form saves: on Save, or as a field is left. */
  saveMode(): 'explicit' | 'blur';
  /** A signed-out visitor browsing an App's public part (publicVisitor.ts). */
  publicVisitor(): boolean;
  /** Whether a request is one of a public visitor's reads, the only kind that carries a tenant's public address (`?via=`, tenantPublicReads.ts); none in the Workbench. */
  publicRead(path: string): boolean;
  /** An explicit record name, or false where the name is not this reader's. */
  recordLabel(tableId: string): string | false | undefined;
  /** What to call a column, or null for its raw name. */
  label(tableId: string, column: string, contextPath: string): string | null;
  /** How a column's values dress, or null for as they are. */
  display(tableId: string, column: string): unknown;
  /** What an empty value reads as. */
  emptyWord(): string;
  /** The locale, currency and zones figures are written in, or null for the browser's (locale.ts). */
  format(): { locale?: string; currency?: string; timezone?: string; clockZone?: string } | null | undefined;
  /** Whether a table may be written from here, beyond the connection's own flag. */
  writeScope(tableId: string): boolean;
  /** Whether records open as pages, for a table or at all. */
  pageAffinity(tableId?: string): boolean;
  /** The page a table's records read through, or null for none; absent where pages are not read. */
  resolvePage: ((tableId: string) => Promise<string | null | undefined>) | null;
  /** How a record opens, when the shell decides: true handled, 'row' or `{ under }` a row route, false the walk's way. */
  openRecord(
    tableId: string,
    key: Record<string, unknown>,
    label: string,
    records?: unknown,
    list?: unknown,
  ): boolean | 'row' | { under: object };
  /** Begin reading the page a press on a record opens (recordPress.ts); null where nothing reads ahead. */
  prefetchRecord: ((pageId: string, tableId: string, key: Record<string, unknown>) => void) | null;
  /** A glance at one record over the list; null where nothing draws one. */
  peekRecord: ((tableId: string, key: Record<string, unknown>, label: string, records?: unknown, list?: unknown) => void) | null;
  /** What happens when the server asks for a sign-in. */
  unauthorized(info: unknown): void;
  /** Draw the App's sign-in in place, so a signed-out visitor comes back to this address (publicSurface.js); a no-op where none signs in. */
  signInHere(appId: string): void;
  /** A tenant session's requests, or null where there is no tenant. */
  tenant: TenantRequests | null;
  tenantLinks: TenantLinks | null;
  /** A write whose outcome the shell watches until it is known. */
  mutations: MutationGuard;
  /** Whether an account dialog's attempt is still unresolved, so a navigation must wait. */
  accountBusy(): boolean;
  /** Open the page builder on a page (pagebuilder.js): the Workbench's, the one shell that authors pages; null elsewhere. */
  editPage:
    | ((
        page: RecordSurfacePage,
        options: { recordKey?: Record<string, unknown>; onSaved?: (saved: { id: string; base: string }) => void; onDeleted?: () => void },
      ) => void)
    | null;
  /** The App's addresses, or null in the Workbench. */
  addresses: AppAddresses | null;
  undo: UndoRecord;
  /** Where an App's own components come from: a value renderer's or an input's module (componentSlot.tsx). */
  components: AppComponents;
  /** A list's App presentation in place of the grid, or null where there are none. */
  present: Present | null;
  /** The App's parts in the kit's lists and record page: drawn where the shell has them, left out where it has none. */
  slots: RecordSlots;
  /** The rooms only an App has, drawn where the content pane reaches them (Rooms.tsx). */
  rooms: AppRoomSlots;
}

/** What an App's home is drawn with (AppHome.tsx): the content pane's paint, its sentence, and the pages it knows. */
export interface AppHomeProps {
  /** The paint tick, which keys the home's room so a repaint starts it over. */
  paint: number;
  /** The sentence above the home, where the last paint left one. */
  said: ReactNode;
  /** The home dashboard's page entry, where the walk is on it. */
  entry: PageEntry | undefined;
  /** The pages this connection has, as the last read left them. */
  pages: KnownPage[];
}

/**
 * An App's own rooms, which the content pane (Content.tsx) and the record
 * page's rooms (Rooms.tsx) reach by the walk's entry and never import: null
 * where the shell has none, and the pane draws nothing in their place — an
 * entry that names one exists only where an App is on screen.
 */
interface AppRoomSlots {
  /** A dashboard's sections and the reader's controls (Dashboard.tsx), fetched the first time one is shown. */
  Dashboard: ComponentType<DashboardProps> | null;
  /** The App's home when nothing is on the walk (AppHome.tsx). */
  Home: ComponentType<AppHomeProps> | null;
  /** A signed-in form's room (FormRoom.tsx). */
  Form: ComponentType<{ entry: PageEntry }> | null;
  /** The signed-in person's notifications (InboxList.tsx). */
  Inbox: ComponentType<Record<string, never>> | null;
  /** The assistant's own page (AssistantPanel.tsx). */
  Assistant: ComponentType<{ conversation?: string }> | null;
  /** A free-form page (FreePage.tsx), where a dashboard entry names one. */
  Page: ComponentType<{ entry?: PageEntry; dashboard: DashboardDef; page: NonNullable<DashboardDef['page']> }> | null;
  /** A split's pick: its list kept beside the record (SplitRecordRoom.tsx). */
  SplitRecord: ComponentType<{ entry: RowEntry & { view?: string }; spec: ListSpec }> | null;
  /** A record put on paper (Document.tsx), where its address names one of its documents. */
  Document: ComponentType<{ entry: PageEntry | RowEntry; document: NonNullable<ReturnType<typeof documentAt>> }> | null;
}

/** An App's components, fetched for the kit's slots; the Workbench draws none. */
export interface AppComponents {
  /** The author's component `id`, or null for none. */
  load(id: string): Promise<unknown>;
  /** The platform's own input for a display rule's format (a rating's stars, a slider), or null. */
  builtIn(name: string): Promise<unknown>;
  /** Which build of `id` is current, so a save that changed it is asked for again. A hook: read in render. */
  useKey(id: string): string;
}

/** The parts only an App draws in the kit's lists and record page: a list's import, a record's verbs, and which values those verbs can move a field to. */
interface RecordSlots {
  /** The preference for which of a suite's Apps opens first (SuiteAppPreference.tsx), atop the preferences; null where there is no suite. */
  SuitePreference: ComponentType<Record<string, never>> | null;
  /** A list's import from a file (ImportButton.tsx), beside its New; null where the shell offers none. */
  ImportButton: ComponentType<{ table: TableMeta | undefined; view?: string; noun: { one: string; many: string } }> | null;
  /** A page section's list drawn by the App's own component (sdk/CustomList.tsx), fetched the first time one is drawn. */
  CustomList: ComponentType<{
    table: TableMeta;
    rows: Array<Record<string, unknown>>;
    spec: CustomListPresentation;
    interactive?: boolean;
    label?: string;
    page: { index: number; size: number };
  }> | null;
  /** A page's section drawn by the App's own component (sdk/CustomSection.tsx), fetched the first time a page holds one. */
  CustomSection: ComponentType<SlotProps & { frame: CustomSectionFrame }> | null;
  /** A timeline's composer, which sends through the App's commands (TimelineComposer.tsx); null where there are none. */
  TimelineComposer: ComponentType<{
    composer: NonNullable<PageSection['composer']>;
    recordKey: Record<string, string | number>;
    table?: string;
    onSent: () => void;
  }> | null;
  /** The record's verbs (Actions.tsx); null where the shell draws none. */
  ActionBar: ComponentType<ActionBarProps> | null;
  /** The values a record's verbs can set `column` to, for a workflow's steps and a field's pill. A hook: read in render. */
  useReachable(
    tableId: string,
    recordKey: Record<string, unknown>,
    column: string | undefined,
    actions: RecordActions | undefined,
  ): ReadonlySet<string>;

  /* The App's parts below are left out of the Workbench's answers rather than
     named null there: those answers are in every first page's script, a public
     page's too, whose brotli stands at its ceiling (scripts/bundle-budget.mjs).
     Absent is none, as null is above. */

  /** A selection's App commands, each sent once for the group through the command's form (commandState.ts, CommandForm.tsx). */
  bulkCommands?: BulkCommands;
  /** A command the App names outside any action, run on one record if this reader is granted it, else undefined: a tag's add and remove (sdk/commands.tsx). */
  recordCommand?: (command: AppCommandReference, label: string) => RecordCommandRun | undefined;
  /** A call to action that opens a room of one of the suite's Apps (AppTargetAction.tsx). */
  TargetAction?: ComponentType<TargetActionProps>;
  /** The suite's links as this reader may follow them now, or null where they may not (appTargetLinks.ts). A hook: read in render. */
  useTargetLinks?: () => { owner: { epoch: number } } | null;
  /** A form drawn over the record it is about (ViewFormDialog.tsx) — public, or the reader's own signed-in one — for a headline's call to action that says `open: 'modal'`. */
  FormDialog?: ComponentType<{ view: string; prefill: string; onClose: () => void }>;
  /** The nav's links to rooms of the suite's Apps, resolved for the menu (appNavTargets.ts). */
  navTargets?: NavTargets;
  /** A New form's lines and its live figures (FormLines.tsx), fetched the first time a form has either; none where it is absent. */
  formLines?: FormLinesPart;
  /** What a list draws in a row's empty cell in place of its empty mark (Grid.tsx `adornCell`), for these rows, and in a
      phone's summary's empty fact (`form: 'summary'`, RecordSummaries.tsx `adornFact`). A hook: read in render. */
  useCellMarks?: (
    table: TableMeta | undefined,
    rows: ReadonlyArray<Record<string, unknown>>,
  ) => ((row: Record<string, unknown>, column: string, form?: 'cell' | 'summary') => ReactNode | undefined) | undefined;
  /** What a record page draws at its own fields (pageContext.ts `FieldAdornment`), and whether that is still being
      asked; `onLanded` re-reads the record after one wrote to it. A hook: read in render, by every record page, routed
      or in a dialog. */
  useFieldAdornment?: (
    connection: string,
    table: string,
    key: Readonly<Record<string, unknown>> | undefined,
    onLanded: () => void,
  ) => { adorn?: FieldAdornment; held: readonly string[] };
}

/** A command run on one record: its outcome, a refusal already said where it was refused. */
type RecordCommandRun = (
  key: Record<string, string | number>,
  input: Readonly<Record<string, unknown>>,
) => Promise<{ status: string; message?: string }>;

/** Who a group's command run is for (commandState.ts `CommandOwner`): the selected records, in order. */
export interface BulkCommandOwner {
  connection: string;
  target: string;
  command: string;
  commandVersion: number;
  key: Record<string, unknown>;
  keys?: Array<Record<string, unknown>>;
  labels?: string[];
}

/** A group's command run as a list reads it (commandState.ts `CommandOperation`): its records and how it ended. */
export interface BulkCommandOperation {
  readonly identity: object;
  readonly owner: BulkCommandOwner;
  readonly action?: AppCommandAction;
  phase: 'pending' | 'success' | 'error' | 'unknown';
  message: string;
  /** The one record of the group the refusal named, when it named one. */
  refusedKey?: Record<string, unknown>;
}

interface BulkCommands {
  /** The runs in flight, which a list follows so a resumed group's form comes back. */
  operations: {
    subscribe(listener: () => void): () => void;
    version(): number;
    unresolvedGroups(connection: string, target: string): BulkCommandOperation[];
  };
  /** Whether each command can run on each record now; false while asked. A hook: read in render. */
  useAvailability(checks: Array<{ command: string; commandVersion: number; key: Record<string, unknown> }>, enabled: boolean): boolean[];
  /** The command's form, which prepares, asks and sends once for the group. */
  Form: ComponentType<{
    action: AppCommandAction;
    owner: BulkCommandOwner;
    targets: Array<{ key: Record<string, unknown>; label: string }>;
    onDeselect: (keys: Array<Record<string, unknown>>) => void;
    noun: { one: string; many: string };
    label: string;
    onClose: (settled?: BulkCommandOperation) => void;
    onDone: () => void;
    isCurrent: () => boolean;
    finalFocus: RefObject<HTMLElement | null>;
  }>;
}

interface TargetActionProps {
  label: string;
  to: AppTarget;
  /** Only a row returned through the source reader's current data transport. */
  row?: Readonly<Record<string, unknown>>;
  className?: string;
}

interface NavTargets {
  /** Follow the targets of the App's nav as this reader may reach them. A hook: read in render. */
  useFollow(app: ShownApp | null, schema: DatabaseSchema | null): unknown;
  /** Ask again, as a folded menu opens. */
  refresh(app: ShownApp, schema: DatabaseSchema | null): void;
  /** Where a target leads now, or undefined while it is asked or where it leads nowhere this reader may go. */
  hrefs(app: ShownApp, schema: DatabaseSchema | null): (target: BoundAppTarget) => string | undefined;
}

/** One line of a New form's lines grid: its values as the inputs hold them, and its key where the record had it. */
export interface LineDraft {
  /** The row's own name in the grid, kept across moves. */
  id: number;
  key?: Record<string, string | number>;
  values: Record<string, string>;
}

/** The lines part as a New form reads it, once fetched (`here`). */
export interface FormLines {
  LinesEditor: ComponentType<{
    title: string;
    table: TableMeta;
    columns: readonly string[];
    rows: LineDraft[];
    onChange: (rows: LineDraft[]) => void;
    ordered?: boolean;
    max?: number;
    problems?: Record<string, string>;
    summary?: ReactNode;
  }>;
  LiveValues: ComponentType<{
    table: TableMeta;
    names: readonly string[];
    values: Readonly<Record<string, string | null | undefined>>;
    lines: Readonly<Record<string, readonly LineDraft[]>>;
  }>;
  blankLine(): LineDraft;
  /** What is wrong with each line before the wire, keyed `${row}.${column}`. */
  lineProblems(
    table: TableMeta,
    columns: readonly string[],
    rows: readonly LineDraft[],
    filled?: readonly string[],
  ): Record<string, string>;
  /** A line's values as the save sends them. */
  lineValues(row: LineDraft, columns: readonly string[]): Record<string, string | null>;
  /** The server's word on a line's field, keyed as `lineProblems`. */
  lineServerProblems(table: TableMeta, errors: readonly FieldError[]): Record<string, string>;
}

interface FormLinesPart {
  /** Fetch the part; resolves once it is here, or once it could not come (it then says so, and a form goes without it). */
  ready(): Promise<void>;
  /** Whether the fetch has settled. */
  here(): boolean;
  /** The part, once fetched. */
  get(): FormLines | undefined;
}

const none = () => false;
const NOTHING_REACHABLE: ReadonlySet<string> = new Set();
const WORKBENCH: ShellMode = Object.freeze({
  app: () => null,
  inApp: none,
  loadError: () => '',
  saveMode: () => 'explicit' as const,
  publicVisitor: none,
  publicRead: none,
  recordLabel: () => undefined,
  label: () => null,
  display: () => null,
  emptyWord: () => 'null',
  format: () => null,
  writeScope: () => true,
  pageAffinity: none,
  resolvePage: null,
  openRecord: none,
  prefetchRecord: null,
  peekRecord: null,
  unauthorized: () => {},
  signInHere: () => {},
  tenant: null,
  tenantLinks: null,
  mutations: Object.freeze({ start: () => undefined, unknown: none, settle: none, hasUnresolved: none }),
  accountBusy: none,
  editPage: null,
  addresses: null,
  components: Object.freeze({ load: () => Promise.resolve(null), builtIn: () => Promise.resolve(null), useKey: (id: string) => id }),
  undo: Object.freeze({ refresh: () => {}, last: () => {}, toast: () => undefined }),
  present: null,
  slots: Object.freeze({
    SuitePreference: null,
    ImportButton: null,
    CustomList: null,
    CustomSection: null,
    TimelineComposer: null,
    ActionBar: null,
    useReachable: () => NOTHING_REACHABLE,
  }),
  rooms: Object.freeze({
    Dashboard: null,
    Home: null,
    Form: null,
    Inbox: null,
    Assistant: null,
    Page: null,
    SplitRecord: null,
    Document: null,
  }),
});

let mode: ShellMode = WORKBENCH;

/**
 * The shell's answers, named at boot. Each part of boot names what it owns —
 * boot the sign-in, the shell the rest — and a later part's answers are laid
 * over an earlier one's; whatever no part names stays the Workbench's.
 */
export function installShell(answers: Partial<ShellMode>): void {
  mode = Object.freeze({ ...mode, ...answers });
}

/** The answers in force. Read at the moment of asking, never kept: a shell installs once, but tests install their own. */
export function shell(): ShellMode {
  return mode;
}

/** Back to the Workbench's answers (tests). */
export function resetShell(): void {
  mode = WORKBENCH;
}
