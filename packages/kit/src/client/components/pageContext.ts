/**
 * What every part of a page reads from the page around it: whether it is an
 * authoring preview, whose connection its reads go through, whether it is
 * still the current surface, and how a related New form opens inside a host.
 * Also the props one section is drawn from, and how a page says a name.
 *
 * Kept apart from Page.tsx so the head, the layout and each section can read
 * it without importing the page that draws them.
 */
import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import { ownedBy } from '../requestIdentity.js';
import { api as request, findTable, labelPath, recordLabel, state } from '../core.js';
import type { AppAction } from '@mistriwork/engine/schema/model.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { shell } from '../shellMode.js';
import { resourceOf } from './appRooms.js';
import type { DatabaseSchema, TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { RecordReadNames } from '@mistriwork/engine/shared/recordReads.js';
import type { FormCuration, InsertResult } from './NewRecord.js';
import type { PageDef, PageEntry, PageSection, SectionPlan } from './pageModel.js';

/* App mode reads pages in the app's words — derived human labels, real
   names kept in tooltips. The workbench reads them raw. */
export const spoken = (name: string) => (shell().inApp() ? humanName(name) : name);
/** Whether the page is an App's, for a section's words; through this module, so a section needs no edge of its own to appnav. */
export const inAppPage = () => shell().inApp();
export type RelatedCreator = (table: TableMeta, form: FormCuration, onAdded: (result: InsertResult) => void) => void;
/** The record's own verbs, as the head's bar has them: fixed edits and separately granted business commands. */
export interface RecordActions {
  list: AppAction[];
  matches: (when: string) => Promise<boolean>;
  queryScope?: number;
  canUpdate?: boolean;
  grantedCommands?: string[];
  /** Fixed actions a role of this reader runs here without write, by label. */
  grantedActions?: readonly string[];
}
/**
 * The record's verbs as a bar draws them (Actions.tsx, the App's): the props
 * the kit's record page, its related lists and a row's menu hand the bar the
 * shell installs (shellMode.ts `slots`).
 */
export interface ActionBarProps {
  tableId: string;
  actions: AppAction[];
  /** The record's key, as the API names it. */
  recordKey: Record<string, unknown>;
  /** What the record is called, for the confirmation. */
  label: string;
  /** Whether the record satisfies a condition in the query language. */
  matches: (when: string) => Promise<boolean>;
  /** Isolate visibility reads from retired route/modal owners, including the
   * same record reopened before an old invalidation request settles. */
  queryScope?: number;
  /** After a write: the page repaints so the record reads as it now is. */
  onDone: () => void;
  canUpdate?: boolean;
  /** Server-projected supported grants, never authored access policy. */
  grantedCommands?: string[];
  /** Fixed actions a role of this reader runs here without write, by label (the server's answer). */
  grantedActions?: readonly string[];
  /** Additional captured surface lifetime, stable through refresh/lease renewal. */
  isCurrent?: () => boolean;
  /** On a phone: one button, the rest in More, instead of wrapping. */
  compact?: boolean;
  /** A record header's reading of which verbs take something away: drawn after the rest, and quiet where
      they stand as buttons, so the filled first button is always the forward one. */
  destructive?: (action: AppAction) => boolean;
  /** A record header's `primary`: the label of the verb drawn filled and first, where it is shown now (actionOrder.ts). */
  primary?: string;
  /** A record header's `actions`: the verbs it draws as buttons, by id and in this order; every other verb is in More. */
  only?: readonly string[];
  /** Items drawn last in More, after the record's own verbs: Delete. Their presence alone gives the bar a More menu. */
  menuTail?: ReactNode;
  /** A row's own menu: every shown verb an item of one ⋯ menu the caller opens, no buttons. */
  menuOnly?: { label: string; open: boolean; onOpenChange: (open: boolean) => void };
  /** Every verb a quiet button, none filled: a related list's head, where the record's forward verb is not. */
  quiet?: boolean;
}
/** `onGone`: a section found the record itself missing, so the page says so once (Page.tsx). */
/* `recordName` is the page record's name as its title says it: a list of its
   children leaves it out of theirs (PageRelated.tsx). */
/**
 * What a host draws at a record's own field: in the empty mark's place when the field is empty, trailing the value on
 * the same line when it is not. Props only: the page knows nothing of what it is (an App's decision, mistri's), and
 * draws the empty mark itself when the host returns nothing.
 */
export type FieldAdornment = (
  field: Readonly<{ table: string; column: string; key: Readonly<Record<string, unknown>>; filled: boolean }>,
) => ReactNode;

export const PageRenderContext = createContext<{
  /** The host's field adornment (Page.tsx's `host.adorn`). */
  adorn?: FieldAdornment;
  /** The columns the host is still asking about. A field keeps its empty mark meanwhile, so it moves nothing; a header
      leaves an empty fact out altogether, so while one of these is an empty fact its facts' line waits rather than
      grow when the answer comes. Only these: a line that could never grow is never held. */
  adornHeld?: readonly string[];
  preview?: boolean;
  connection?: string;
  isCurrent?: () => boolean;
  openRelated?: RelatedCreator;
  actions?: RecordActions;
  onGone?: () => void;
  recordName?: string;
  /** A verb ran from a row of one of the page's lists: the record and its lists are read again. */
  onActionDone?: () => void;
}>({});
export function usePageApi() {
  const { connection } = useContext(PageRenderContext);
  const scoped: typeof request = (path, ...args) => {
    // Add only routing identity; preserve the selected route/body tuple. No
    // operation fields are changed and no endpoint falls back to an untyped API.
    const owned = connection && args[0] ? ([{ ...args[0], ...ownedBy(connection) }] as typeof args) : args;
    return request(path, ...owned);
  };
  return scoped;
}

/**
 * What the page hands a custom section beside a section's own props: its
 * request, whether it is a preview, and how every section says loading and a
 * failed read. Handed, not imported — the page's modules import each other in
 * a circle this chunk stays out of (test/repo/runtime-cycles). The App's
 * component draws it (sdk/CustomSection.tsx), reached through the shell's slot.
 */
export interface CustomSectionFrame {
  pageApi: ReturnType<typeof usePageApi>;
  preview?: boolean;
  Loading: ComponentType<{ section: SlotProps['section'] }>;
  SectionBox: ComponentType<{ section: SlotProps['section']; body: ReactNode; foldable: boolean; broken?: string; hidden?: boolean }>;
}

export interface SlotProps {
  page: PageDef;
  section: PageSection;
  index: number;
  plan: SectionPlan;
  base: TableMeta;
  recordKey: Record<string, unknown>;
  foldable: boolean;
  entry: PageEntry;
  onLabel?: (label: string) => void;
  onSectionLabel?: (index: number, label: string | undefined) => void;
  onEdit: (opts?: { inPlace?: boolean }) => void;
  /** The fields section that says the record's name in the head. */
  titleOwner?: number;
  onTitleEditor?: (index: number, render: (() => ReactNode) | undefined) => void;
  /** An empty related list said in one line with its neighbours: it draws its Add alone (PageEmptyRun.tsx). */
  collapsed?: boolean;
}

/**
 * How this reader's rows are named, as a record page's reads are built from
 * it (shared/recordReads.ts): the schema it was served, whether it reads in
 * an App's words, and each table's record name as its App says it. The
 * server builds the same requests from the same three (recordCompose.ts).
 */
export function recordReadNames(): RecordReadNames {
  return {
    schema: state.schema as unknown as DatabaseSchema,
    app: Boolean(shell().inApp()),
    recordLabel: (tableId: string) => recordLabel({ id: tableId } as TableMeta) as string | false | undefined,
    namePath: (table: TableMeta) => labelPath(table) as string | undefined,
    table: (id: string) => findTable(id) as TableMeta | undefined,
    defined: (id: string) => resourceOf(shell().app(), id)?.defined,
  };
}
