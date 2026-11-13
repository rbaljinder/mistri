/**
 * What a command's writes carry that the handler did not say: the state a machine's table starts in or moves to, the
 * stamps that come with it, a wall-clock moment, and a constant (`now`, `today`, `me`) written as an action's `set` is.
 * Moved out of businessCommandExecution.ts, which ran past the module-size ceiling; nothing here knows the execution.
 */
import { frozenWords } from '../../shared/appMachine.js';
import { nowStamp, written } from '../app/appStamps.js';
import { stampColumn } from '../../shared/appStamps.js';
import { stateStampColumn } from '@mistriwork/engine/shared/schema.js';
import { wallClockText, withWallClock } from '../app/wallClock.js';
import { Refusal, type QueryResult, type WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { recordRefusalCause } from '@mistriwork/engine/server/evidence.js';
import { personMatch, type CommandPeople } from './commandWhen.js';
import { BusinessCommandExecutionError } from './commandErrors.js';

/* ---------- the machines a command's writes meet (appMachine.ts) ---------- */

type CommandMachineBinding = NonNullable<import('./businessCommandAuthorization.js').BusinessCommandAuthorization['machine']>;
type Catalog = import('./commandDb.js').CommandCatalog | undefined;

/** The moment a state changed, as its `since` column holds it: what the `now` stamp writes there. */
function sinceValue(catalog: Catalog, table: string, column: string, now: Date, timezone: string | undefined): string {
  const meta = catalog?.[table]?.meta.columns.find((candidate) => candidate.name === column);
  return (meta && nowStamp(meta, now, timezone)) ?? wallClockText(new Date(Math.floor(now.getTime() / 1000) * 1000), timezone);
}

/**
 * A `Date` a handler writes into a zone-less timestamp column becomes the wall
 * clock of the App's zone, the digits a `now` stamp writes there, not the
 * driver's: `pg` formats a Date in the server process's zone, which
 * is where it happens to run. A zoned column keeps the instant, as it always did.
 */
export function bindMoments<T extends { table: string; values: Record<string, unknown> }>(
  authorized: { readonly catalog: Catalog; readonly timezone?: string },
  request: T,
): T {
  const columns = authorized.catalog?.[request.table]?.meta.columns;
  const values = withWallClock(columns, request.values, authorized.timezone);
  return values === request.values ? request : { ...request, values };
}

/**
 * A constant a handler writes (`db.ticket.update(row, { closed_at: now, closed_by: me })`): judged against its
 * column as an action's `set` is, and written as one is. `me` on a reference to the people table is the actor's
 * row, read in this transaction; anywhere else it is the actor's email.
 */
export async function commandConstant(
  authorized: {
    readonly actor: { readonly email?: string; readonly id?: string };
    readonly timezone?: string;
    readonly people?: CommandPeople;
  },
  tx: Pick<WriteTransaction, 'query'>,
  table: import('@mistriwork/engine/shared/schema.js').TableMeta,
  column: import('@mistriwork/engine/shared/schema.js').ColumnMeta,
  word: 'now' | 'today' | 'me',
  now: Date,
): Promise<string | number | boolean | null> {
  const reference = column.references?.table;
  const people = authorized.people;
  const toPeople = !!reference && !!people && (reference === people.id || reference === people.table);
  const judged = stampColumn(word, column, reference ? (toPeople ? people!.id : reference) : false, people?.id);
  if ('problem' in judged) {
    const hint = reference && !people && word === 'me' ? " Add the people table (auth.me) to the command's reads." : '';
    throw new Error(`${table.name}: ${judged.problem}${hint}`);
  }
  const who = authorized.actor.email;
  /* Nobody signed in, or nobody's row: this account cannot be the one recorded, so the command is not theirs to run. */
  const refused = (error: unknown) => {
    throw error instanceof Refusal ? recordRefusalCause(new BusinessCommandExecutionError('forbidden'), error) : error;
  };
  return written(
    judged.column,
    {
      now,
      ...(who ? { who } : {}),
      person: async () => {
        // The actor's account where the people table holds accounts (a tenant App's), else its email.
        const match = personMatch(authorized.actor, people!);
        if (match === null) return null;
        const found = await tx.query({
          table: people!.table,
          columns: [people!.key],
          limit: 2,
          offset: 0,
          filter: { groups: [[{ column: people!.column, op: '=', value: match }]] },
        });
        const key = found.rows.length === 1 ? found.rows[0][people!.key] : null;
        return typeof key === 'string' || typeof key === 'number' ? key : null;
      },
    },
    authorized.timezone,
  ).catch(refused);
}

const refusedMove = (cause: string, reason?: string) =>
  recordRefusalCause(new BusinessCommandExecutionError('ineligible_state', 'not_applied', undefined, undefined, reason), cause);

/** A new row of a machine's table starts in its first state, or one its `entry` names, and stamps `since`. */
export function machineInsert<T extends { table: string; values: Record<string, unknown> }>(
  machine: CommandMachineBinding | undefined,
  request: T,
  now: Date,
  catalog: Catalog,
  timezone: string | undefined,
): T {
  const graph = machine?.tables.get(request.table);
  if (!graph) return request;
  const state = request.values[graph.column];
  if (state !== undefined && (state === null || (String(state) !== graph.start && !graph.entry.has(String(state))))) {
    const starts = [graph.start, ...graph.entry].map((name) => `"${name}"`).join(', ');
    throw refusedMove(
      `A new "${request.table}" starts in ${starts}, as its machine on "${graph.column}" allows; the command inserted it in ` +
        `"${String(state)}". A command starts a record past the first state only where the machine's "entry" names that state.`,
      // The reader's sentence: the fixed "not eligible" said nothing about which state the new row was born in.
      `A new ${request.table} starts in ${starts}, not "${String(state)}": that state needs the machine's "entry".`,
    );
  }
  const entered = enteredValue(catalog, request, state === undefined ? graph.start : String(state), graph, now, timezone);
  return {
    ...request,
    values: {
      ...request.values,
      ...(state === undefined ? { [graph.column]: graph.start } : {}),
      ...(graph.since && !Object.hasOwn(request.values, graph.since)
        ? { [graph.since]: sinceValue(catalog, request.table, graph.since, now, timezone) }
        : {}),
      ...entered,
    },
  };
}

/** The state's own stamp (`ready_at` beside `ready`, appMachine.ts), as the record enters it, unless the write says it. */
function enteredValue(
  catalog: Catalog,
  request: { table: string; values: Record<string, unknown> },
  state: string,
  graph: { column: string; since?: string },
  now: Date,
  timezone: string | undefined,
): Record<string, string> {
  const column = stateStampColumn(state, catalog?.[request.table]?.meta.columns ?? [], graph);
  return column && !Object.hasOwn(request.values, column.name) ? { [column.name]: nowStamp(column, now, timezone)! } : {};
}

/** An update that moves a machine's column: along an edge of the graph from the stored state, stamping `since`. */
export async function machineUpdate<
  T extends { table: string; key: Record<string, unknown>; values: Record<string, unknown>; expected?: Record<string, unknown> },
>(
  machine: CommandMachineBinding | undefined,
  request: T,
  store: Pick<WriteTransaction, 'query'>,
  now: Date,
  catalog: Catalog,
  timezone: string | undefined,
  /** Columns the caller reads of the same row as it stands (an audit's before image): read with the state. */
  also: readonly string[] = [],
  read?: (found: QueryResult) => void,
): Promise<T> {
  const graph = machine?.tables.get(request.table);
  /* A frozen state takes no write, so a table that has one reads the state of every row it writes, not only a move. */
  if (!graph || (!graph.frozen.size && !Object.hasOwn(request.values, graph.column))) return request;
  /* Each state's own stamp is read with the state: a guarded write is guarded at every column it writes. */
  const columns = catalog?.[request.table]?.meta.columns ?? [];
  const stamps = [...new Set([...graph.moves.values()].flatMap((next) => [...next]))].flatMap(
    (state) => stateStampColumn(state, columns, graph)?.name ?? [],
  );
  const found = await store.query({
    table: request.table,
    columns: [...new Set([graph.column, ...(graph.since ? [graph.since] : []), ...stamps, ...also])],
    limit: 2,
    offset: 0,
    filter: {
      groups: [Object.entries(request.key).map(([column, value]) => ({ column, op: '=' as const, value: value as string | number }))],
    },
  });
  read?.(found);
  if (found.rows.length !== 1) return request;
  const words = graph.frozen.get(String(found.rows[0][graph.column]));
  if (words !== undefined)
    throw new BusinessCommandExecutionError('ineligible_state', 'not_applied', undefined, undefined, frozenWords(words));
  if (!Object.hasOwn(request.values, graph.column)) return request;
  const from = String(found.rows[0][graph.column]),
    to = String(request.values[graph.column]);
  if (from === to) return request;
  if (!graph.moves.get(from)?.has(to)) {
    const allowed = [...(graph.moves.get(from) ?? [])];
    throw refusedMove(
      `The machine of "${request.table}" moves "${graph.column}" from "${from}" ${allowed.length ? `only to ${allowed.map((state) => `"${state}"`).join(', ')}` : 'nowhere'}; ` +
        `the command wrote "${to}".`,
    );
  }
  const entered = enteredValue(catalog, request, to, graph, now, timezone);
  const since = graph.since && !Object.hasOwn(request.values, graph.since) ? graph.since : undefined;
  const added = { ...(since ? { [since]: sinceValue(catalog, request.table, since, now, timezone) } : {}), ...entered };
  if (!Object.keys(added).length) return request;
  /* A write guarded at the values it read (commandDb.ts) is guarded at what the machine adds too: it was read with the state. */
  return {
    ...request,
    values: { ...request.values, ...added },
    ...(request.expected
      ? {
          expected: {
            ...request.expected,
            ...Object.fromEntries(Object.keys(added).map((column) => [column, found.rows[0][column] ?? null])),
          },
        }
      : {}),
  };
}
