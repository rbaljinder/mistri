/** Private compiler bridge over an already-held native snapshot. This is not
 * an authority constructor: the serving owner supplies the genuine callback
 * lease, maps resources and applies App authorization before using this adapter.
 * No method may dial the ordinary adapter or escape the snapshot lifetime. */
import { POSTGRES_STYLE, Refusal, type Adapter } from '@mistriwork/engine/adapters/adapter.js';
import type { PinnedPostgresRead } from '@mistriwork/engine/adapters/postgresReadCatalog.js';
import { compileView, compileViewCount } from '@mistriwork/engine/shared/view.js';

export function postgresSnapshotReads(read: PinnedPostgresRead): Adapter {
  read.assertCurrent();
  const unavailable = async (): Promise<never> => {
    throw new Refusal('This snapshot supports only checked views.');
  };
  return Object.freeze({
    dialect: 'postgres' as const,
    introspect: async () => {
      read.assertCurrent();
      return read.schema;
    },
    query: unavailable,
    count: unavailable,
    close: unavailable,
    runView: async (view, offset = 0) => {
      read.assertCurrent();
      const compiled = compileView(read.schema, view, POSTGRES_STYLE, offset);
      const result = await read.execute({ text: compiled.text, params: compiled.params });
      read.assertCurrent();
      return { ...result, columns: compiled.columns.map((column) => column.name), resolved: compiled.columns, joins: compiled.joins };
    },
    countView: async (view, limit) => {
      read.assertCurrent();
      const compiled = compileViewCount(read.schema, view, POSTGRES_STYLE, undefined, limit);
      const result = await read.execute({ text: compiled.text, params: compiled.params });
      read.assertCurrent();
      const raw = result.rows[0]?.n;
      if (
        result.rows.length !== 1 ||
        (typeof raw !== 'number' && typeof raw !== 'string') ||
        (typeof raw === 'string' && !/^(0|[1-9][0-9]*)$/.test(raw))
      ) {
        throw new Refusal('The snapshot count is unavailable.');
      }
      const count = Number(raw);
      if (!Number.isSafeInteger(count) || count < 0 || Object.is(count, -0) || (limit !== undefined && count > limit))
        throw new Refusal('The snapshot count is unavailable.');
      return count;
    },
  } satisfies Adapter);
}
