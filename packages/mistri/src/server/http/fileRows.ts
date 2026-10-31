/**
 * A file resource's rows on the wire, for both hosts that serve them: the
 * single-App server (readRoutes.ts, dataWriteRoutes.ts) and a tenant App's
 * (tenant/tenantHttp.ts). One reading of an upload — its bytes, name, type
 * and size into the columns the resource's `file` names — and one read of a
 * stored file by its record key, through whatever reader the host holds, so
 * the reader's grants and a tenant's isolation are the reader's, never this
 * module's. Where the bytes are kept — the row's `content`, or the bucket
 * its `object` names — is files/fileStorage.ts's.
 */
import { createHash } from 'node:crypto';
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import type { AppDef, AppFileRule } from '../../shared/app.js';
import { primaryKey, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { Bucket } from '../files/bucket.js';
import { bytesLabelled } from '@mistriwork/engine/server/http/reply.js';
import { serverRequest } from '@mistriwork/engine/server/serverRequests.js';
import { bucketOf, objectBelongs, type FileScope } from '../files/fileStorage.js';
import { pregenerateVariants, type SharedVariants } from './imageVariants.js';

const megabytes = (bytes: number) => `${Math.ceil((bytes / 1024 / 1024) * 10) / 10} MB`;
/* A file and its ceiling, in megabytes, unless that prints the same for both (2,000,001 and 2,000,000 bytes are both
   "2 MB"): then in bytes, so the sentence never says "is 2 MB; takes up to 2 MB". */
const sizes = (size: number, ceiling: number): [string, string] =>
  megabytes(size) === megabytes(ceiling)
    ? [`${size.toLocaleString('en-US')} bytes`, `${ceiling.toLocaleString('en-US')} bytes`]
    : [megabytes(size), megabytes(ceiling)];

/**
 * A file's name as it is stored and shown. A control character (a NUL, a line break) or a bidi override, which makes
 * "invoice\u202Etxt.exe" read as "invoiceexe.txt", becomes "_" rather than vanishing: removing a NUL made
 * "evil.png\0.html" the different name "evil.png.html". The download's ASCII filename does the same (appFileRead.ts).
 */
const fileName = (name: string): string => name.replace(/[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, '_').trim();

/**
 * An upload's row: the values the list sends (the parent the file belongs to)
 * and the file itself, its bytes, name, type and size in the columns the
 * resource's `file` names. The bytes cross as base64; the cap is the resource's.
 */
export function uploadValues(
  rule: AppFileRule | undefined,
  body: Record<string, unknown>,
): { values: Record<string, unknown> } | { status: number; error: string } {
  if (!rule) return { status: 404, error: 'This resource does not hold files.' };
  const file = body.file;
  if (!file || typeof file !== 'object' || Array.isArray(file))
    return { status: 400, error: 'An upload needs a file: { name, type?, data }.' };
  const { name, type, data } = file as Record<string, unknown>;
  if (typeof data !== 'string' || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
    return { status: 400, error: 'The file content must be base64.' };
  return fileValues(rule, { name, type, bytes: Buffer.from(data, 'base64') }, body.values ?? {});
}

/**
 * A new file row's values, from the file's bytes, name and type and the row's
 * other values: the one rule an upload and a command's `db.<file>.insertFile`
 * share — a name of at most 255 characters, the resource's (and host's) cap,
 * a media type or `application/octet-stream`, and the file's own columns
 * taken from the file, never from the values.
 */
/**
 * Where a public picture's copies are shared: the resource's bucket, under the App's own folder of it. A private or
 * tenant file keeps its copies on this server's disk alone: a copy in the bucket is outside the object sweep's reach
 * and would outlive the record, so only a public picture (whose hash the sweep knows) is shared. Undefined with no
 * bucket, no public reader, or no credentials for it.
 */
export function sharedVariantsOf(rule: AppFileRule): SharedVariants | undefined {
  if (!rule.bucket || !rule.public) return undefined;
  try {
    return { bucket: bucketOf(rule), prefix: rule.bucket.prefix ?? '', app: rule.app ?? rule.resource };
  } catch {
    return undefined;
  }
}

export function fileValues(
  rule: AppFileRule,
  file: { name: unknown; type?: unknown; bytes: Uint8Array },
  given: unknown,
): { values: Record<string, unknown>; stored?: () => void } | { status: number; error: string } {
  const { name, type, bytes } = file;
  const named = typeof name === 'string' ? fileName(name) : '';
  if (!named || named.length > 255) return { status: 400, error: 'A file needs a name of at most 255 characters.' };
  if (bytes.byteLength > rule.maxBytes) {
    const [size, ceiling] = sizes(bytes.byteLength, rule.maxBytes);
    return { status: 413, error: `"${named}" is ${size}; this App takes files up to ${ceiling}.` };
  }
  if (!given || typeof given !== 'object' || Array.isArray(given)) return { status: 400, error: 'Upload values must be an object.' };
  /* The thumbnail too: a copy set beside an upload would be a second picture
     under the file's name, drawn on every card in its place. */
  const fileColumns = [rule.content, rule.name, rule.type, rule.size, rule.thumbnail, rule.object, rule.hash].filter(Boolean);
  if (Object.keys(given).some((column) => fileColumns.includes(column)))
    return { status: 400, error: "The file's own columns come from the upload, not from values." };
  const media =
    typeof type === 'string' && type.length <= 127 && /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type.toLowerCase() : 'application/octet-stream';
  /* A public picture is made at its common widths once its row is committed, off the request, so the first visitor
     meets a finished one (imageVariants.ts). The caller runs `stored` after the commit: a row that rolls back, or an
     upload that is refused, never starts work. Made from these bytes whatever the row ends up as: a copy is named for
     its bytes' hash. */
  let stored: (() => void) | undefined;
  if (rule.public) stored = () => pregenerateVariants(bytes, sharedVariantsOf(rule));
  /* Marked as the server's: the hash is a column no request may name
     (appAccess.ts `serverRequest`), written here for the upload. */
  return {
    ...(stored ? { stored } : {}),
    values: serverRequest({
      ...given,
      [rule.content]: bytes,
      [rule.name]: named,
      ...(rule.type ? { [rule.type]: media } : {}),
      ...(rule.size ? { [rule.size]: bytes.byteLength } : {}),
      ...(rule.hash ? { [rule.hash]: createHash('sha256').update(bytes).digest('hex') } : {}),
    }),
  };
}

/** A stored file: its bytes, its name, the type its row claims (never trusted for the bytes). */
interface StoredFile {
  bytes: Uint8Array;
  name: string;
  claimed: string;
}

/** A file's row as read: its name, claimed type and stored hash, and its bytes or the object in the bucket that holds them. */
export type FileRow = { name: string; claimed: string; hash?: string } & (
  | { bytes: Uint8Array }
  | { object: string; bucket: Bucket; size?: number }
);

/**
 * One file's row by its record key — the thumbnail where asked and kept —
 * through the host's reader, or why not: a key that is not the table's whole
 * key, or no file there (which is also what a row the reader may not see
 * answers, and a row naming an object outside the reader's App, tenant and
 * table). The bytes are not fetched from a bucket here: the caller decides
 * whether to pass them on, sign a URL for them, or read them.
 */
export async function readFileRow(
  reader: Pick<Adapter, 'query'>,
  table: TableMeta,
  rule: AppFileRule,
  key: unknown,
  variant: unknown,
  scope: FileScope,
): Promise<FileRow | { status: number; error: string }> {
  const keyColumns = primaryKey(table) as string[];
  if (
    !key ||
    typeof key !== 'object' ||
    Array.isArray(key) ||
    !keyColumns.length ||
    Object.keys(key).length !== keyColumns.length ||
    keyColumns.some((column) => !Object.hasOwn(key as object, column)) ||
    Object.values(key).some((value) => typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value)))
  )
    return { status: 400, error: 'A file is named by its record key.' };
  const thumb = variant === 'thumb' && rule.thumbnail ? rule.thumbnail : undefined;
  const listed = (column: string | undefined) =>
    column && table.columns.some((candidate) => candidate.name === column) ? column : undefined;
  // The server's own read: the only kind that may name the object and hash.
  const read = await reader.query(
    serverRequest({
      table: table.id,
      columns: [
        rule.content,
        rule.name,
        /* The object and hash are the server's, which only a request marked as its own may name
           (serverRequests.ts); the size is read for a range only where this reader's catalog has it. */
        ...[rule.type, thumb, rule.object, rule.hash, rule.object && listed(rule.size)].filter((column): column is string =>
          Boolean(column),
        ),
      ],
      filter: {
        groups: [Object.entries(key as Record<string, string | number>).map(([column, value]) => ({ column, op: '=' as const, value }))],
      },
      limit: 2,
      offset: 0,
      binary: true,
    }),
  );
  const row = read.rows.length === 1 ? read.rows[0] : undefined;
  if (!row) return { status: 404, error: 'No file here.' };
  const named = {
    name: String(row[rule.name] ?? '').trim() || 'file',
    claimed: rule.type ? String(row[rule.type] ?? '') : '',
    ...(rule.hash && typeof row[rule.hash] === 'string' ? { hash: row[rule.hash] as string } : {}),
  };
  const small = thumb ? row[thumb] : undefined;
  if (small instanceof Uint8Array && small.byteLength) return { ...named, bytes: small };
  const object = rule.object ? row[rule.object] : undefined;
  if (typeof object === 'string' && object) {
    if (!objectBelongs(rule, scope, object)) return { status: 404, error: 'No file here.' };
    const size = listed(rule.size) ? Number(row[rule.size!]) : NaN;
    return { ...named, object, bucket: bucketOf(rule), ...(Number.isSafeInteger(size) && size >= 0 ? { size } : {}) };
  }
  const stored = row[rule.content];
  const bytes = stored instanceof Uint8Array ? stored : typeof stored === 'string' ? Buffer.from(stored, 'utf8') : undefined;
  return bytes ? { ...named, bytes } : { status: 404, error: 'No file here.' };
}

/** One file's bytes by its record key, wherever they are kept (readFileRow, then the bucket when the row names an object). */
export async function readStoredFile(
  reader: Pick<Adapter, 'query'>,
  table: TableMeta,
  rule: AppFileRule,
  key: unknown,
  variant: unknown,
  scope: FileScope,
): Promise<StoredFile | { status: number; error: string }> {
  const found = await readFileRow(reader, table, rule, key, variant, scope);
  if ('error' in found || 'bytes' in found) return found;
  const bytes = await found.bucket.bytes(found.object);
  return bytes ? { bytes, name: found.name, claimed: found.claimed } : { status: 404, error: 'No file here.' };
}

/**
 * A written row as its writer is shown it: a file resource's object and hash
 * are the server's (appAccess.ts withFileColumns), written for the writer and
 * never sent back, and the file's bytes are a label, never the bytes. Anything that is not a record passes as it is.
 */
export function shownWrite<T>(app: AppDef, table: unknown, record: T): T {
  return bytesLabelled(withoutServerColumns(app, table, record));
}
function withoutServerColumns<T>(app: AppDef, table: unknown, record: T): T {
  const file = typeof table === 'string' && Object.hasOwn(app.resources ?? {}, table) ? app.resources![table].file : undefined;
  const internal = [file?.object, file?.hash].filter(Boolean);
  if (!internal.length || !record || typeof record !== 'object' || Array.isArray(record)) return record;
  return Object.fromEntries(Object.entries(record).filter(([column]) => !internal.includes(column))) as T;
}
