/*
 * The columns of its target each issued actor reads, where its roles' grants
 * narrow them. Keyed by the actor object the command authorizer issued
 * (businessCommandAuthorization.ts), so no caller can name another's.
 * `initial` and `availability` are given the record through it
 * (commandPrepare.ts, commandAvailability.ts), because what they return
 * reaches the actor — a prefilled form, a button — while the handler, whose
 * output is its declared shape, reads the record whole.
 */
import type { BusinessCommandActor } from './businessCommands.js';

const readableTarget = new WeakMap<BusinessCommandActor, ReadonlySet<string>>();

/** Record what an issued actor reads of its command's target. The authorizer's only. */
export function issueTargetColumns(actor: BusinessCommandActor, columns: Iterable<string>): void {
  readableTarget.set(actor, new Set(columns));
}

/** A target row as its actor may see it: the columns its grants withhold, left out. */
export function visibleTargetRow<Row extends Readonly<Record<string, unknown>>>(actor: BusinessCommandActor, row: Row): Row {
  const columns = readableTarget.get(actor);
  return columns ? (Object.freeze(Object.fromEntries(Object.entries(row).filter(([column]) => columns.has(column)))) as Row) : row;
}

const unreadableTarget = new WeakSet<BusinessCommandActor>();

/** Record that an issued actor reads nothing of its command's target (no read grant on it, or a visitor). The authorizer's only. */
export function issueTargetUnreadable(actor: BusinessCommandActor): void {
  unreadableTarget.add(actor);
}

/**
 * Whether this actor may be told a value of the column in the target: a refusal that names a record's value
 * (commandSaying.ts) says it only to a person whose grants read it.
 */
export function mayReadTargetColumn(actor: BusinessCommandActor, column: string): boolean {
  if (unreadableTarget.has(actor)) return false;
  const columns = readableTarget.get(actor);
  return columns ? columns.has(column) : true;
}
