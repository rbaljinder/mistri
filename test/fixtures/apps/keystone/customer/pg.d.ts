/* The little of node-postgres the row policy uses. tablewalk depends on pg
   but ships no types for it, and a row policy has no database handle of its
   own, so the policy brings its own pool (policy.ts says why). */
declare module 'pg' {
  interface QueryResult<Row> {
    rows: Row[];
  }
  class Pool {
    constructor(options: { connectionString?: string; max?: number });
    query<Row>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>>;
  }
  const pg: { Pool: typeof Pool };
  export default pg;
}
