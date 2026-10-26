/**
 * The slice of `mysql2/promise` this file uses, declared structurally so the
 * package can stay an optional dependency. Someone browsing a SQLite file
 * should not have to install a MySQL driver to run the tool.
 */
export interface MysqlConnection {
  /** The server's id for this connection's thread: what KILL QUERY names. */
  readonly threadId?: number;
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  /* The options form, for the one call that needs `rowsAsArray`. */
  query(options: { sql: string; rowsAsArray?: boolean }): Promise<[unknown, unknown]>;
  execute(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
  destroy?(): void;
}
type CreateConnection = (config: Record<string, unknown>) => Promise<MysqlConnection>;

export interface FieldPacket {
  name: string;
}
export interface OkPacket {
  affectedRows?: number;
  /** The AUTO_INCREMENT value an insert assigned, 0 when none was. */
  insertId?: number | string;
}

export interface TableRow {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  TABLE_TYPE: string;
  TABLE_ROWS: number | string | null;
  TABLE_COMMENT: string | null;
}

export interface ColumnRow {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
  IS_NULLABLE: string;
  COLUMN_DEFAULT: string | null;
  COLUMN_KEY: string;
  COLUMN_COMMENT: string | null;
  EXTRA: string;
}

export interface IndexRow {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  INDEX_NAME: string;
  SEQ_IN_INDEX: number | string;
  NON_UNIQUE: number | string;
  COLUMN_NAME: string | null;
}

export interface KeyRow {
  CONSTRAINT_NAME: string;
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
  COLUMN_NAME: string;
  REFERENCED_TABLE_SCHEMA: string;
  REFERENCED_TABLE_NAME: string;
  REFERENCED_COLUMN_NAME: string;
  DELETE_RULE?: string;
}

/**
 * Load `mysql2` on demand.
 *
 * Imported lazily, and through a variable, so the driver is only required when
 * someone actually opens a MySQL URL. The indirection also stops the type
 * checker demanding the package be installed to compile this file.
 */
export async function driver(): Promise<CreateConnection> {
  const specifier = 'mysql2/promise';
  const mysql = (await import(specifier).catch(() => {
    throw new Error('MySQL support needs the "mysql2" package. Install it with: npm install mysql2');
  })) as { createConnection?: CreateConnection; default?: { createConnection?: CreateConnection } };
  const createConnection = mysql.createConnection ?? mysql.default?.createConnection;
  if (!createConnection) {
    throw new Error('Could not find a createConnection export in the "mysql2" package.');
  }
  return createConnection;
}
