/**
 * What a list draws when its view says nothing of it: its columns, its order,
 * its tabs, its filters and a board to switch to. A coding agent's least
 * effort is a `listView(label, table)`, and the list it opens on is the one
 * nobody wrote, so it has to read as if somebody had: the name first, the
 * state beside it, what it belongs to, one date, the money, and nothing the
 * reader has already been told.
 *
 * Each piece is inferred only where the view declares none (app.ts
 * resolveListView), from the catalog and what the App says of the resource —
 * its record label, its display rules, its machine — never from a row, so the
 * list's first question is known before anything is read and nothing moves
 * when the rows arrive. Pure, so the server's projection and the tests read
 * one rule.
 */
import { isMoneyColumn } from './displayDefaults.js';
import { DUE } from './dueDate.js';
import { humanName } from './model.js';
import {
  columnKind,
  findTable,
  isFlagColumn,
  labelColumn,
  labelPath,
  looksLikeDate,
  primaryKey,
  referencesTo,
  type ColumnMeta,
  type DatabaseSchema,
  type TableMeta,
} from './schema.js';
import type { AppBoardList } from './listPresentations.js';

/** What the App says about the resource that the inference reads. */
export interface InferenceResource {
  /** The App's record label (`recordLabel`): the column, path or template a record is named by; false withholds it. */
  recordLabel?: string | false;
  /** Each column's display rule as drawn (declared over the conventions, displayDefaults.ts effectiveDisplay). */
  display?: Readonly<Record<string, { subtitle?: string; format?: string } | undefined>>;
  /** The resource's machine: its column and its states in order. */
  machine?: { column: string; states: readonly { name: string; label?: string; final?: boolean }[] };
}

/** One inferred tab: the label, the condition it adds (a sort clause after it where it reads its own order). */
interface InferredTab {
  label: string;
  query?: string;
}

/** A list never shows more than this many inferred columns; the grid leaves out what its room cannot hold (gridSizing.ts). */
const INFERRED_COLUMNS = 7;
/** A reference is a filter while the table it points at is this small: a picker of fifty names is read at a glance. */
const FILTER_TARGETS = 50;
/** Tabs for the open states one by one, at most: past it the open tab is the way in. */
const STATE_TABS = 5;
/** A machine whose open states number this many is drawn as lanes as well as rows. */
const BOARD_STATES = { min: 3, max: 7 } as const;

/* Text written to be read, not scanned: a list has no room for it, and its record page does. */
const LONG_TEXT =
  /(^|_)(description|body|notes?|summary|content|details|comments?|bio|message|text|html|markdown|instructions|access_notes)$/i;
/* The parts of a postal address: a place is said once, by the first of them the table keeps. */
const ADDRESS =
  /^(street|street_address|address|address_line_?\d|line_?\d|city|town|state|province|region|zip|zip_code|postal_code|postcode|country)$/i;
/* A start, in the order a person plans by. */
const START =
  /^(start|starts|start_date|starts_at|starts_on|start_at|start_on|scheduled_at|scheduled_on|scheduled_for|begins_at|begins_on|event_date|date)$/i;
/* When the row came to be: what newest first reads. */
const CREATED = /^(sys_)?(created|inserted|added|opened|raised|issued|ordered|received|submitted|signed_up|joined)(_at|_on|_date)?$/i;
/* A vocabulary that is the row's state where no machine moves it. */
const STATUS = /^(status|state|stage|phase)$/i;
/* The words of a vocabulary that a row ends in: over, however it ended. */
const FINAL_WORD =
  /^(done|complete|completed|closed|closed_won|closed_lost|cancelled|canceled|resolved|archived|rejected|declined|lost|won|missed|expired|void|voided|paid|delivered|shipped|failed|no_show|retired|withdrawn)$/i;
/* A vocabulary of urgency: toned on a board's card. */
const PRIORITY = /^(priority|urgency|severity|importance)$/i;

const columnOf = (table: TableMeta, name: string | undefined): ColumnMeta | undefined =>
  name === undefined ? undefined : table.columns.find((column) => column.name === name);

const isText = (column: ColumnMeta) => columnKind(column.type) === 'text' && !/json/i.test(column.type);
const isBinary = (column: ColumnMeta) => /blob|bytea|binary/i.test(column.type);
const isLong = (column: ColumnMeta) => isText(column) && (LONG_TEXT.test(column.name) || (column.text?.max ?? 0) > 255);
/* Pinned to one value by the schema: every row says the same, so a column of it says nothing. A distinct read would
   find more, but costs a statement per column on every catalog; the vocabulary is free. */
const isConstant = (column: ColumnMeta) => column.allowed?.length === 1;

/** The state a list's rows are in: the machine's column, else a vocabulary named like one. */
export function stateColumn(table: TableMeta, resource: InferenceResource = {}): string | undefined {
  if (resource.machine && columnOf(table, resource.machine.column)) return resource.machine.column;
  return table.columns.find((column) => STATUS.test(column.name) && (column.allowed?.length ?? 0) > 1)?.name;
}

/**
 * The states a list's tabs and board read, in order, each open or final: the machine's, else a status vocabulary's
 * with its final words read off what they say. Undefined where nothing says a row is ever over.
 */
function inferredStates(
  table: TableMeta,
  resource: InferenceResource = {},
): { column: string; states: Array<{ name: string; label: string; final: boolean }>; machine: boolean } | undefined {
  const column = stateColumn(table, resource);
  if (!column) return undefined;
  if (resource.machine?.column === column) {
    const states = resource.machine.states.map((state) => ({
      name: state.name,
      label: state.label ?? humanName(state.name),
      final: state.final === true,
    }));
    return states.some((state) => state.final) && states.some((state) => !state.final) ? { column, states, machine: true } : undefined;
  }
  const allowed = columnOf(table, column)?.allowed ?? [];
  const states = allowed.map((name) => ({ name, label: humanName(name), final: FINAL_WORD.test(name.trim().replace(/[\s-]+/g, '_')) }));
  return states.some((state) => state.final) && states.some((state) => !state.final) ? { column, states, machine: false } : undefined;
}

/** The one date a list shows and filters by: when it is due, else when it starts, else when it came to be. */
export function oneDate(table: TableMeta): string | undefined {
  const dates = table.columns.filter((column) => !column.primaryKey && !column.references && looksLikeDate(column));
  return (
    dates.find((column) => DUE.test(column.name))?.name ??
    dates.find((column) => START.test(column.name))?.name ??
    dates.find((column) => CREATED.test(column.name))?.name
  );
}

/** When a row came to be, for newest first. */
export const createdDate = (table: TableMeta): string | undefined =>
  table.columns.find((column) => !column.primaryKey && looksLikeDate(column) && CREATED.test(column.name))?.name;

/** When a row is due, where the table says: what an overdue row is late against. */
export const dueDate = (table: TableMeta): string | undefined =>
  table.columns.find((column) => !column.primaryKey && !column.references && looksLikeDate(column) && DUE.test(column.name))?.name;

/** The rows still under way, in the query language: the machine's open states, or the vocabulary's words that are not
    final. Undefined where nothing says a row is ever over. */
export function openQuery(table: TableMeta, resource: InferenceResource = {}): string | undefined {
  const states = inferredStates(table, resource);
  if (!states) return undefined;
  return states.machine
    ? `${states.column} is open`
    : inStates(
        states.column,
        states.states.filter((state) => !state.final).map((state) => state.name),
      );
}

const inStates = (column: string, names: readonly string[]) =>
  names.length === 1 ? `${column} = ${names[0]}` : `${column} in (${names.join(', ')})`;

/**
 * The column a list leads with: what the record is called, where it is one of its own required columns. A name a row
 * may leave blank (a visit's nullable summary) names nothing on the rows that leave it, so the row leads with what it
 * belongs to instead (`job_id`, said by the job's name), the first required reference with a name of its own.
 */
export function leadColumn(schema: DatabaseSchema, table: TableMeta, resource: InferenceResource = {}): string | undefined {
  const said = labelPath(schema, table, resource.recordLabel);
  const own = said && !said.includes('.') && !said.startsWith('$') ? columnOf(table, said) : undefined;
  const key = primaryKey(table);
  if (own && !key.includes(own.name) && !own.nullable) return own.name;
  /* A name the App chose stands even where a row may leave it blank: it is the author's word. */
  if (own && !key.includes(own.name) && typeof resource.recordLabel === 'string') return own.name;
  const parent = table.columns.find((column) => column.references && !column.nullable && namedTarget(schema, column));
  if (parent) return parent.name;
  if (own && !key.includes(own.name)) return own.name;
  return key.length === 1 ? key[0] : undefined;
}

/** Whether a reference points at a table whose records have a name of their own, so it is said as that name. */
function namedTarget(schema: DatabaseSchema, column: ColumnMeta): boolean {
  const target = column.references ? findTable(schema, column.references.table) : undefined;
  if (!target) return false;
  const named = labelColumn(target);
  return Boolean(target.labelTemplate || (named && !primaryKey(target).includes(named)));
}

/* A code a row is quoted by beside its name: its number, its SKU, its reference. A reference's second line reads the
   same rule (referenceSubline.ts). */
export const CODE = /^(number|code|sku|ref|reference|stock_ref)$|_(number|code|no|ref|reference)$/i;

/**
 * The second line under a list's name where its view names no columns and its display rule names none: a code the
 * row is also quoted by (a job's number under its title), proven unique by the catalog. Only a list whose columns
 * are inferred draws it, so a list an author arranged, and every record page, stays as written.
 */
export function inferListSubtitles(schema: DatabaseSchema, table: TableMeta, resource: InferenceResource = {}): Record<string, string> {
  const lead = leadColumn(schema, table, resource);
  const column = columnOf(table, lead);
  if (!column || column.primaryKey || column.references || resource.display?.[column.name]?.subtitle) return {};
  const code = table.columns.find(
    (other) =>
      other.name !== column.name &&
      !other.primaryKey &&
      !other.references &&
      isText(other) &&
      CODE.test(other.name) &&
      (table.unique ?? []).includes(other.name),
  );
  return code ? { [column.name]: code.name } : {};
}

/**
 * A list's columns where its view names none, in the order a row is read: its name (the display rule's second line
 * under it, where one exists), its state, what it belongs to by name, one date, its money, then its other short
 * words and figures. Left out: the key where the row has a name, a column pinned to one value, long text, a second
 * copy of what the name's second line already says, every date but the one, a postal address past its first part,
 * documents and bytes. The grid leaves out from the end what its room cannot hold.
 */
export function inferListColumns(schema: DatabaseSchema, table: TableMeta, resource: InferenceResource = {}): string[] {
  const lead = leadColumn(schema, table, resource);
  const key = primaryKey(table);
  const named = lead !== undefined && !key.includes(lead);
  const state = stateColumn(table, resource);
  const date = oneDate(table);
  const under = inferListSubtitles(schema, table, resource);
  const shownUnder = new Set(
    [lead, ...table.columns.filter((column) => column.references).map((column) => column.name)].flatMap((name) => {
      const sub = name === undefined ? undefined : (resource.display?.[name]?.subtitle ?? under[name]);
      return sub && !sub.includes('.') ? [sub] : [];
    }),
  );
  const firstAddress = table.columns.find((column) => ADDRESS.test(column.name))?.name;
  const left = (column: ColumnMeta): boolean =>
    column.name === lead ||
    column.name === state ||
    (named && column.primaryKey) ||
    (column.primaryKey && key.length > 1) ||
    isConstant(column) ||
    isLong(column) ||
    isBinary(column) ||
    /json/i.test(column.type) ||
    shownUnder.has(column.name) ||
    (looksLikeDate(column) && column.name !== date) ||
    (ADDRESS.test(column.name) && column.name !== firstAddress);
  const candidates = table.columns.filter((column) => !left(column));
  const references = candidates.filter((column) => column.references && namedTarget(schema, column));
  const money = candidates.filter(
    (column) => !column.references && (isMoneyColumn(column) || resource.display?.[column.name]?.format === 'money'),
  );
  const taken = new Set([...references, ...money].map((column) => column.name));
  const rest = candidates.filter((column) => !column.references && !taken.has(column.name) && column.name !== date);
  const words = rest.filter((column) => (column.allowed?.length ?? 0) > 1 || isFlagColumn(column));
  const figures = rest.filter((column) => !words.includes(column) && columnKind(column.type) === 'number' && !column.primaryKey);
  const texts = rest.filter((column) => !words.includes(column) && !figures.includes(column) && isText(column));
  const ordered = [
    ...(lead !== undefined ? [lead] : []),
    ...(state ? [state] : []),
    ...references.map((column) => column.name),
    ...(date ? [date] : []),
    ...money.map((column) => column.name),
    ...words.map((column) => column.name),
    ...figures.map((column) => column.name),
    ...texts.map((column) => column.name),
  ];
  return [...new Set(ordered)].slice(0, INFERRED_COLUMNS);
}

/**
 * The order a list reads in where its view says none: work that has a date to be done by is read soonest first —
 * the open tabs, by that date — and anything else newest first by when it came to be. A table with neither reads
 * by its name, never by its key. Undefined leaves the platform's own order (schema.ts defaultOrder).
 */
export function inferListSort(schema: DatabaseSchema, table: TableMeta, resource: InferenceResource = {}): string | undefined {
  const states = inferredStates(table, resource);
  const date = oneDate(table);
  const created = createdDate(table);
  /* Undated work after the dated, on every engine: SQLite and MySQL would put it first. */
  if (states && date && date !== created) return `${date} nulls last`;
  if (created) return `${created} desc`;
  const lead = leadColumn(schema, table, resource);
  const column = columnOf(table, lead);
  return column && !column.primaryKey && !column.references && isText(column) ? lead : undefined;
}

/**
 * Tabs where the view names none, from the machine (or a status vocabulary): Open — every state that is not final —
 * then each open state while there are two to five of them, Done — the final ones — and All. The open tabs read in
 * the list's order; Done and All read newest first, where finished work is looked back on.
 */
export function inferListTabs(_schema: DatabaseSchema, table: TableMeta, resource: InferenceResource = {}): InferredTab[] | undefined {
  const states = inferredStates(table, resource);
  if (!states) return undefined;
  const { column } = states;
  const open = states.states.filter((state) => !state.final);
  const final = states.states.filter((state) => state.final);
  const created = createdDate(table);
  const date = oneDate(table);
  const back = created ? `${created} desc` : date ? `${date} desc` : undefined;
  const sorted = (query: string | undefined, sort: string | undefined) =>
    sort === undefined ? query : `${query ? `${query} ` : ''}sort ${sort}`;
  const umbrella = new Set(['open', 'done', 'all']);
  const each =
    open.length >= 2 && open.length <= STATE_TABS
      ? open
          .filter((state) => !umbrella.has(state.label.trim().toLowerCase()))
          .map((state) => ({ label: state.label, query: inStates(column, [state.name]) }))
      : [];
  return [
    { label: 'Open', query: openQuery(table, resource)! },
    ...each,
    {
      label: 'Done',
      query: sorted(
        states.machine
          ? `${column} is not open`
          : inStates(
              column,
              final.map((state) => state.name),
            ),
        back,
      ),
    },
    { label: 'All', ...(back ? { query: sorted(undefined, back) } : {}) },
  ];
}

/**
 * Filters where the view names none: every vocabulary and yes-or-no among its own columns (the state too where no
 * tab says it already), each reference to a table of at most fifty records, and the one date.
 */
export function inferListFilters(schema: DatabaseSchema, table: TableMeta, resource: InferenceResource = {}, tabbed = false): string[] {
  const state = stateColumn(table, resource);
  const date = oneDate(table);
  const usable = (column: ColumnMeta) => !table.filterable || table.filterable.includes(column.name);
  const words = table.columns.filter(
    (column) =>
      usable(column) &&
      !column.primaryKey &&
      !column.references &&
      !isConstant(column) &&
      ((column.allowed?.length ?? 0) > 1 || isFlagColumn(column)) &&
      !(tabbed && column.name === state),
  );
  const references = table.columns.filter((column) => {
    if (!usable(column) || !column.references || !namedTarget(schema, column)) return false;
    const target = findTable(schema, column.references.table);
    return target?.approxRows !== undefined && target.approxRows <= FILTER_TARGETS;
  });
  const dated = date && usable(columnOf(table, date)!) ? [date] : [];
  /* The state leads, where it is a filter: it is what a list is most often narrowed by. */
  const ordered = [...words.filter((column) => column.name === state), ...references, ...words.filter((column) => column.name !== state)];
  return [...new Set([...ordered.map((column) => column.name), ...dated])];
}

/**
 * A board to switch the list to, where its machine has three to seven open states: a lane per state in the
 * machine's order, the final ones together in one folded Done lane, a card of the name, what it belongs to, the date and its
 * urgency toned. A card dropped in another lane runs the one verb that leads there (BoardList.tsx).
 */
export function inferBoard(schema: DatabaseSchema, table: TableMeta, resource: InferenceResource = {}): AppBoardList | undefined {
  const states = inferredStates(table, resource);
  if (!states?.machine) return undefined;
  const open = states.states.filter((state) => !state.final);
  if (open.length < BOARD_STATES.min || open.length > BOARD_STATES.max) return undefined;
  const primary = leadColumn(schema, table, resource);
  if (!primary || primaryKey(table).includes(primary)) return undefined;
  const reference = table.columns.find(
    (column) => column.references && column.name !== primary && !column.nullable && namedTarget(schema, column),
  );
  const date = oneDate(table);
  const priority = table.columns.find((column) => PRIORITY.test(column.name) && (column.allowed?.length ?? 0) > 1);
  const facts = [...(date ? [date] : []), ...(priority ? [priority.name] : [])];
  return {
    kind: 'board',
    by: states.column,
    primary,
    ...(reference ? { lines: [reference.name] } : {}),
    ...(facts.length ? { footer: facts.map((column) => ({ column })) } : {}),
    lanes: open.map((state) => state.name),
    done: states.states.filter((state) => state.final).map((state) => state.name),
  };
}

/** How many of the App's tables point at a table: what makes it the one the others are about. */
const incomingCount = (schema: DatabaseSchema, tableId: string, among: ReadonlySet<string>): number =>
  new Set(
    referencesTo(schema, tableId)
      .filter((fk) => fk.from.table !== tableId && among.has(fk.from.table))
      .map((fk) => fk.from.table),
  ).size;

/**
 * The table an App is about, for a home it did not declare: the one with a machine that the most of its other
 * tables point at, else the most pointed at; between two pointed at as often, the one that points at more (a job
 * before the technician it is filed under), then the App's own order.
 */
export function mainTable(schema: DatabaseSchema, tables: readonly { table: TableMeta; machine: boolean }[]): TableMeta | undefined {
  const among = new Set(tables.map((entry) => entry.table.id));
  const ranked = tables
    .map((entry, index) => ({
      ...entry,
      index,
      incoming: incomingCount(schema, entry.table.id, among),
      outgoing: new Set(
        schema.foreignKeys.filter((fk) => fk.from.table === entry.table.id && fk.to.table !== entry.table.id).map((fk) => fk.to.table),
      ).size,
    }))
    .sort((a, b) => Number(b.machine) - Number(a.machine) || b.incoming - a.incoming || b.outgoing - a.outgoing || a.index - b.index);
  return ranked[0]?.table;
}
