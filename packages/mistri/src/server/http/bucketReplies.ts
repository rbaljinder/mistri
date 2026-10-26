/**
 * The file route's answers for bytes kept in a bucket (files/fileStorage.ts),
 * after the route has read the file's row the way it reads every file — the
 * App's grants, field projection and row policy — and so decided the reader
 * may have it. Nothing here decides who may.
 *
 * A download passes through the server by default: the bucket's answer
 * (whole, or the one range asked for) streamed on with the route's own
 * headers. With `presign: true` it is a redirect instead, to a URL signed
 * for a minute whose reply's type and disposition the signature fixes, so a
 * large file leaves the bucket without crossing the server. Only a download
 * is redirected: a picture drawn in place is sniffed, sized and tagged by
 * the route, which a bucket cannot do.
 */
import type { RequestContext } from '@mistriwork/engine/server/http/context.js';
import { send, sendBytes, sendStream } from '@mistriwork/engine/server/http/reply.js';
import { BucketError } from '../files/bucket.js';
import { fileStoreTrouble, storedTag } from '../files/fileStorage.js';
import type { FileRow } from './fileRows.js';

/** How long a presigned download stays good: long enough to follow the redirect, not to pass the link on. */
const PRESIGNED_SECONDS = 60;

/**
 * One range of a file of `size` bytes, from a `Range` header: the bytes
 * asked for, `unsatisfiable` for a range past the end, or undefined for
 * none (or several, or one this route does not read), which is the whole file.
 */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | undefined {
  const asked = header === undefined ? undefined : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!asked || (asked[1] === '' && asked[2] === '')) return undefined;
  if (asked[1] === '') {
    const suffix = Number(asked[2]);
    if (!suffix) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(asked[1]);
  const end = asked[2] === '' ? size - 1 : Math.min(Number(asked[2]), size - 1);
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}

/** A download of an object: a presigned redirect, or the bucket's bytes passed on with the route's headers. */
export async function bucketDownload(
  ctx: RequestContext,
  found: Extract<FileRow, { object: string }>,
  reply: { type: string; disposition: string; guarded: Record<string, string>; presign: boolean },
): Promise<true> {
  const { req, res } = ctx;
  const head = req.method === 'HEAD';
  if (reply.presign && !head) {
    // A role's credentials that cannot be fetched fall through to the proxied read below, which reports it as any bucket failure.
    const location = await found.bucket
      .presign(found.object, PRESIGNED_SECONDS, { type: reply.type, disposition: reply.disposition })
      .catch(() => undefined);
    if (location) {
      sendBytes(res, 302, new Uint8Array(0), { location, 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' }, true);
      return true;
    }
  }
  const etag = storedTag(found.hash);
  const asked = req.headers['if-none-match'];
  if (etag && asked && asked.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)) {
    sendBytes(res, 304, new Uint8Array(0), { etag, 'cache-control': 'private, no-store' }, true);
    return true;
  }
  /* A range is checked here when the row says the size, and otherwise left to the bucket, which answers 416 itself. */
  const range = req.headers.range && /^bytes=\d*-\d*$/.test(req.headers.range.trim()) ? req.headers.range.trim() : undefined;
  if (range && found.size !== undefined && byteRange(range, found.size) === 'unsatisfiable') {
    sendBytes(res, 416, new Uint8Array(0), { 'content-range': `bytes */${found.size}` }, true);
    return true;
  }
  let read: Awaited<ReturnType<typeof found.bucket.get>>;
  try {
    read = await found.bucket.get(found.object, range);
  } catch (error) {
    if (error instanceof BucketError && error.status === 416) {
      sendBytes(res, 416, new Uint8Array(0), found.size === undefined ? {} : { 'content-range': `bytes */${found.size}` }, true);
      return true;
    }
    throw error;
  }
  if (!read) {
    send(res, 404, { error: 'No file here.' });
    return true;
  }
  await sendStream(
    res,
    read.status,
    read.body,
    {
      'content-type': reply.type,
      ...(read.length === undefined ? {} : { 'content-length': read.length }),
      'content-disposition': reply.disposition,
      ...reply.guarded,
      'cache-control': 'private, no-store',
      'accept-ranges': 'bytes',
      ...(read.contentRange ? { 'content-range': read.contentRange } : {}),
      ...(etag ? { etag } : {}),
    },
    head,
  );
  return true;
}

/** A bucket that could not answer (fileStoreTrouble): 503 with the reader's words; any other error is not this route's to hide. */
export function bucketFailure(ctx: RequestContext, error: unknown): true {
  const trouble = fileStoreTrouble(error, 'read');
  if (!trouble) throw error;
  send(ctx.res, 503, { error: trouble });
  return true;
}
