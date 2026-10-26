/**
 * `@mistriwork/engine`, as the tree has it (scripts/boundary/entries.json): the part of the engine the database
 * browser reads a database through, and the smallest surface a second product can stand on. A connection string
 * becomes an adapter (`connect`); the adapter reads the catalog into a schema, and runs a query-language read or a
 * keyset page of one. Anything else the engine owns is reached through these, or is not the package's yet.
 *
 * Kept small on purpose: a name added here is a name the engine package will have to keep, so it is added when a
 * product outside the tree needs it, not because it is exported somewhere below.
 */
export { connect } from './adapters/connect.js';
export type { Adapter, QueryRequest, SqlRequest, SqlResult } from './adapters/adapter.js';
export type { QueryResult } from './shared/reads.js';
export {
  defaultOrder,
  findTable,
  labelColumn,
  primaryKey,
  referencesFrom,
  referencesTo,
  tableNamed,
  type ColumnMeta,
  type DatabaseSchema,
  type Dialect,
  type ForeignKey,
  type Order,
  type TableMeta,
} from './shared/schema.js';
export { explain, parseQuery, quoteValue, type QueryError } from './shared/query.js';
export {
  keysetAfter,
  keysetOrder,
  pageBounds,
  readPageStep,
  reversedOrder,
  type Boundary,
  type PageBounds,
  type PageStep,
} from './shared/keysetPage.js';
