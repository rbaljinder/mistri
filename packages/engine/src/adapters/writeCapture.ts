/**
 * What rides beneath every write a dialect adapter runs, in the write's own
 * transaction: the App framework's record history and notices
 * (history/recordHistory.ts, inbox/inbox.ts), and live sync's one change row
 * per transaction (live/liveChange.ts). Beneath every facade, so a scoped
 * writer, a command and an Undo record exactly as a Save does.
 *
 * The adapter is the engine's and knows no store, so the capture is lent to
 * it: the framework installs one capturer (stores/writeCaptures.ts), which
 * says which of an adapter's tables it watches and, for one transaction,
 * hands back the capture that wraps its writes. The adapter hands over its
 * writer and the two reads a capture needs on it; with nothing installed,
 * as in the database browser, no write is captured.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { DeleteRequest, DeleteResult, InsertRequest, InsertResult, TellRequest, UpdateRequest, UpdateResult } from './adapter.js';
import type { MysqlConnection } from './mysqlDriver.js';
import type { PgQuery } from './postgresPool.js';

/** The transaction's writer, by dialect: a capture's own rows join it. */
type CaptureWriter =
  | { readonly dialect: 'postgres'; readonly client: PgQuery }
  | { readonly dialect: 'sqlite'; readonly db: DatabaseSync }
  | { readonly dialect: 'mysql'; readonly connection: MysqlConnection; readonly database: string };

/** What a capture reads on the writer. */
export interface CaptureSource {
  readonly writer: CaptureWriter;
  /** `lock` takes the row for the rest of the transaction (FOR UPDATE), so the before image is the one the write replaces. */
  read(
    table: string,
    key: Record<string, string | number>,
    columns?: string[],
    lock?: boolean,
  ): Promise<Record<string, unknown> | undefined>;
  /** Up to `limit` rows whose columns equal these values. */
  rows(table: string, where: Record<string, string | number>, columns: string[], limit: number): Promise<Record<string, unknown>[]>;
}

/** One transaction's capture: each write runs through it. */
interface WriteCapture {
  insert(request: InsertRequest, write: (request: InsertRequest) => Promise<InsertResult>): Promise<InsertResult>;
  update(request: UpdateRequest, write: (request: UpdateRequest) => Promise<UpdateResult>): Promise<UpdateResult>;
  remove(request: DeleteRequest, write: (request: DeleteRequest) => Promise<DeleteResult>): Promise<DeleteResult>;
  /** A flow's notify step (WriteTransaction.tell). */
  tell(request: TellRequest): Promise<void>;
  /**
   * Once, after the transaction's last operation has settled and just before
   * COMMIT, on the same writer: what a capture keeps per transaction rather
   * than per write (live sync's change row) is written here, so it commits or
   * rolls back with the writes it describes. A throw rolls the transaction back.
   */
  finish?(): Promise<void>;
  /** Once, after COMMIT was acknowledged. A nudge only: it never fails the write it follows. */
  committed?(): void;
}

interface WriteCapturer {
  /** Whether a write to this table of this adapter is captured, so that even a lone write runs inside a transaction the capture's rows can join. */
  captures(adapter: object, table: unknown): boolean;
  /** This transaction's capture, or undefined where the adapter captures nothing. */
  begin(adapter: object, source: CaptureSource): WriteCapture | undefined;
}

let installed: WriteCapturer | undefined;

/** Trusted framework code, once per process. */
export function installWriteCapture(capturer: WriteCapturer): void {
  installed = capturer;
}

export const capturesWrites = (adapter: object, table: unknown): boolean => installed?.captures(adapter, table) ?? false;

export const beginWriteCapture = (adapter: object, source: CaptureSource): WriteCapture | undefined => installed?.begin(adapter, source);

/** The adapters' one way to end a capture: its per-transaction rows, just before COMMIT. */
export const finishWriteCapture = async (capture: WriteCapture | undefined): Promise<void> => {
  await capture?.finish?.();
};

/** After COMMIT: a capture's nudge to whoever waits on committed changes. Never throws into the write. */
export const committedWriteCapture = (capture: WriteCapture | undefined): void => {
  try {
    capture?.committed?.();
  } catch {
    /* The write has committed; a listener's failure is its own. */
  }
};
