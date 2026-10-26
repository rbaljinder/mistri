/**
 * A connection that hands out shape and never rows.
 *
 * The README's boundary — "rows entering an agent's context leave the
 * machine, so point it at development databases" — was a sentence asking to
 * be believed. `"rows": false` makes it a property of the connection: the
 * catalog, the counts, the lint and the plans still answer, and every path
 * that would return a value from a row refuses.
 *
 * Enforced by wrapping the adapter rather than by checking at each endpoint.
 * There are eight endpoints and fifteen tools today and there will be more,
 * and a rule spelled out in eighteen places is a rule with a hole in it. The
 * wrapper is the choke point every read already goes through, so a feature
 * added later inherits the boundary instead of having to remember it.
 *
 * What still answers is deliberate: shape is what an agent is here for. Which
 * tables exist, what points at what, how many rows there are, how much of a
 * column is null, what a statement's plan looks like. What it cannot have is
 * a value out of a row — including the ones `profile` reports, since a
 * minimum, a maximum and the most common values are row content however
 * aggregated.
 */
import { Refusal, type Adapter, type ProfileResult } from '../adapters/adapter.js';
import { configFileName } from './product.js';

const why = (name: string, what: string) =>
  new Refusal(
    `"${name}" is shape-only: ${what} would return data out of its rows. ` +
      'The catalog, row counts, null fractions, plans and lint still answer. ' +
      `Remove "rows": false from its entry in your ${configFileName()} to read rows from it.`,
  );

/**
 * The same adapter with every row-returning method refused.
 *
 * Methods are copied rather than proxied through a Proxy so that the optional
 * ones stay honestly absent: an adapter with no `runSql` must still look like
 * an adapter with no `runSql`, or callers that check for it before offering
 * SQL start offering it and failing.
 */
export function shapeOnly(adapter: Adapter, name: string): Adapter {
  const wrapped: Adapter = Object.create(Object.getPrototypeOf(adapter) as object) as Adapter;
  Object.assign(wrapped, adapter);

  /* Bound to the original: the copies above are the original's methods, and
     calling them on `wrapped` would work by accident on a plain object and
     break on a class instance holding private state. */
  const from = <K extends keyof Adapter>(key: K) => {
    const method = adapter[key];
    return typeof method === 'function' ? (method as (...args: unknown[]) => unknown).bind(adapter) : undefined;
  };

  wrapped.introspect = from('introspect') as Adapter['introspect'];
  wrapped.close = from('close') as Adapter['close'];
  wrapped.count = from('count') as Adapter['count'];
  /* Pool meters are counts and durations about connections, never a value
     out of a row; bound like the rest, so they read the original's pools. */
  if (adapter.poolStats) wrapped.poolStats = from('poolStats') as Adapter['poolStats'];

  wrapped.query = () => {
    throw why(name, 'reading rows');
  };
  if (adapter.runSql)
    wrapped.runSql = () => {
      throw why(name, 'running SQL');
    };
  if (adapter.runView)
    wrapped.runView = () => {
      throw why(name, 'running a view');
    };
  if (adapter.countView) wrapped.countView = from('countView') as Adapter['countView'];
  if (adapter.insert)
    wrapped.insert = () => {
      throw why(name, 'inserting');
    };
  if (adapter.update)
    wrapped.update = () => {
      throw why(name, 'updating');
    };
  if (adapter.remove)
    wrapped.remove = () => {
      throw why(name, 'deleting');
    };
  /* A transaction hands out `insert` and `remove` of its own, from inside the
     adapter, where the refusals above cannot reach them. Refused whole. */
  if (adapter.transaction)
    wrapped.transaction = () => {
      throw why(name, 'writing');
    };

  /* A breakdown's group keys *are* row values — `by status` answers with the
     statuses. The counts beside them would be safe and are not worth the
     surface: an answer with its labels blanked is not an answer. Counting the
     groups is a cardinality fact and stays, for the same reason `profile`
     keeps its distinct count. */
  if (adapter.runBreakdown)
    wrapped.runBreakdown = () => {
      throw why(name, 'grouping rows');
    };
  if (adapter.countBreakdown) wrapped.countBreakdown = from('countBreakdown') as Adapter['countBreakdown'];

  /* Profile keeps the numbers and loses the values. "52% null, 4,100
     distinct" is the fact that decides a LEFT join and carries nothing out
     of any row; a minimum, a maximum and the most common values carry rows. */
  if (adapter.profile) {
    const profile = from('profile') as Adapter['profile'];
    wrapped.profile = async (table: string, limits?: { sampleSize?: number }): Promise<ProfileResult> => {
      const result = await profile!(table, limits);
      return {
        ...result,
        columns: result.columns.map(({ min, max, common, ...rest }) => rest),
        redacted: 'Values withheld: this connection is shape-only.',
      };
    };
  }

  return wrapped;
}
