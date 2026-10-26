/**
 * One file's bytes, from an App resource whose rows are files (`file` on the
 * resource): the read route's `ReadHooks.file` (readRoutes.ts), which has
 * already refused a file asked for as a script.
 */
import { findTable } from '@mistriwork/engine/shared/schema.js';
import { appFileRules } from '../../shared/app.js';
import { appForConnection } from '../app/apps.js';
import { fileTag } from '../files/fileStorage.js';
import { sniffImage } from './imageSniff.js';
import {
  IMAGE_FORMAT_REFUSAL,
  IMAGE_WIDTH_REFUSAL,
  imageFormat,
  imageHash,
  imageVariant,
  imageWidth,
  placeholderOf,
} from './imageVariants.js';
import { readFileRow, sharedVariantsOf } from './fileRows.js';
import { bucketDownload, bucketFailure, byteRange } from './bucketReplies.js';
import { send, sendBytes } from '@mistriwork/engine/server/http/reply.js';
import type { RequestContext, ResolvedSource } from '@mistriwork/engine/server/http/context.js';

/** False where the resource holds no files: the read route says so. */
export async function appFileRoute(ctx: RequestContext, source: ResolvedSource): Promise<boolean> {
  const { res, url, registry } = ctx;
  const { adapter, schema, connectionId } = source;
  const host =
    source.selectedHost ?? appForConnection(ctx.appHosts ?? [], connectionId, registry.list().find((c) => c.id === connectionId)?.name);
  const table = findTable(schema!, url.searchParams.get('table') ?? '');
  const rule = host && table ? appFileRules(host.app.app, schema!).rules.get(table.id) : undefined;
  if (!table || !rule) return false;
  /* A width is one of the fixed set, refused before anything is read (imageVariants.ts). */
  const width = imageWidth(url.searchParams.get('w'));
  if (width === 'refused') {
    send(res, 400, { error: IMAGE_WIDTH_REFUSAL });
    return true;
  }
  const asked = imageFormat(url.searchParams.get('f'));
  if (asked === 'refused') {
    send(res, 400, { error: IMAGE_FORMAT_REFUSAL });
    return true;
  }
  let key: unknown;
  try {
    key = JSON.parse(url.searchParams.get('key') ?? '');
  } catch {
    key = undefined;
  }
  // A width is made from the original, never from the smaller copy.
  let found: Awaited<ReturnType<typeof readFileRow>>;
  try {
    found = await readFileRow(adapter, table, rule, key, width ? null : url.searchParams.get('variant'), { app: host!.app.app.id });
  } catch (error) {
    return bucketFailure(ctx, error);
  }
  if ('error' in found) {
    send(res, found.status, { error: found.error });
    return true;
  }
  const { name } = found;
  const inline = url.searchParams.get('inline') === '1';
  const disposition = (kind: 'inline' | 'attachment') =>
    `${kind}; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
  /* The type an uploader claimed is never sent: a file named .html and
       claimed text/html, opened from a link, would be a page of the App's
       origin. A download is bytes; a picture is the type its bytes say (below). */
  const downloadType = 'application/octet-stream';
  const guarded = { 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'" };
  let bytes: Uint8Array;
  if ('object' in found) {
    try {
      if (!inline)
        return await bucketDownload(ctx, found, {
          type: downloadType,
          disposition: disposition('attachment'),
          guarded,
          presign: rule.bucket?.presign === true,
        });
      /* A picture is sniffed, sized and tagged here as one from the database is, so its bytes come through. */
      const read = await found.bucket.bytes(found.object);
      if (!read) {
        send(res, 404, { error: 'No file here.' });
        return true;
      }
      bytes = read;
    } catch (error) {
      return bucketFailure(ctx, error);
    }
  } else bytes = found.bytes;
  /* Drawn in place only when asked to be, and only when the bytes
       themselves are a raster image: the type then is the one the bytes
       say, never the stored claim. Everything else stays a download. A
       photo is read again and again as a list scrolls, so it may be kept
       for an hour — by this browser only — and is then asked about by its
       content's tag: the read above runs as always, grants and all, and an
       unchanged photo is a 304 rather than its bytes once more. Where what
       a reader may see depends on who they are — anyone signed in, or a
       policy context — it is asked about every time it is used, so a grant
       withdrawn a minute ago, a sign-out or the next account on a shared
       browser holds at once, and only for the session it was read in
       (`Vary: Cookie`); what it saves is the bytes, never the check. An
       hour's keeping is for a reader who is nobody in particular: an App
       without sign-in, or a signed-out visitor to a public one. */
  const sniffed = inline ? sniffImage(bytes) : undefined;
  /* At a width, the picture made for it (imageVariants.ts): in the format the address names (`f`), else the one the
     browser takes, and then the reply varies by Accept. Where the App keeps files in a bucket, the copies are shared there. */
  const shared = host ? sharedVariantsOf(rule) : undefined;
  const format = asked === 'fallback' ? (sniffed === 'image/png' || sniffed === 'image/gif' ? 'image/png' : 'image/jpeg') : asked;
  const variant =
    sniffed && width
      ? await imageVariant(bytes, sniffed, width, ctx.req.headers.accept, { ...(format ? { format } : {}), ...(shared ? { shared } : {}) })
      : undefined;
  const image = variant?.type ?? sniffed;
  const sent = variant?.bytes ?? bytes;
  const fileHeaders: Record<string, string> = {};
  if (image) {
    const etag = variant?.etag ?? fileTag(bytes);
    /* Anyone the server knows (a session, a proxy's header) or that a deployment asks to know (`--auth-proxy-header`:
       a person is behind every request, signed in or not) makes the reply theirs, whatever the App's rules say. */
    const personal =
      Boolean(ctx.policyContext) ||
      Boolean(ctx.bound.identityHeader) ||
      Boolean(ctx.identity.who?.trim()) ||
      (typeof ctx.identity.id === 'string' && Boolean(ctx.identity.id.trim()));
    const vary = [...(personal ? ['Cookie'] : []), ...(width && !format ? ['Accept'] : [])].join(', ');
    /* Who may share a copy: only a picture whose reader is nobody in particular (no sign-in, or a signed-out visitor to
       a resource the App lists as public) — and never one read as a person or under a policy, whatever the address says.
       Its address may name the bytes (`h`, checked against the bytes just read), and then it never changes. */
    const named = url.searchParams.get('h');
    const hashed = Boolean(variant) && named !== null && named === variant!.hash;
    /* A picture at a width with no format in its address is answered by `Accept`, which a CDN does not key on: it
       would keep the first visitor's AVIF for every browser. Only an address that names its bytes is shared. */
    const open = !personal && rule.public === true && (!width || Boolean(format));
    const kept = {
      etag,
      'cache-control': personal
        ? 'private, no-cache'
        : open
          ? hashed
            ? 'public, max-age=31536000, immutable'
            : 'public, max-age=86400, stale-while-revalidate=604800'
          : 'private, max-age=3600',
      ...(vary ? { vary } : {}),
    };
    /* `meta=1`: the picture's room before it arrives — true size, average colour and the hash an address may name —
       read under the same grants and kept by the same rules as the picture. */
    if (url.searchParams.get('meta') === '1') {
      const room = await placeholderOf(bytes, shared);
      const body = Buffer.from(JSON.stringify({ ...room, hash: imageHash(bytes) }));
      sendBytes(
        res,
        200,
        body,
        {
          'content-type': 'application/json; charset=utf-8',
          'content-length': body.byteLength,
          'cache-control': kept['cache-control'],
          ...(vary ? { vary } : {}),
          'x-content-type-options': 'nosniff',
        },
        ctx.req.method === 'HEAD',
      );
      return true;
    }
    const asked = ctx.req.headers['if-none-match'];
    if (asked && asked.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)) {
      sendBytes(res, 304, new Uint8Array(0), kept, true);
      return true;
    }
    Object.assign(fileHeaders, kept);
  }
  /* A download may be asked for in part (a resumed transfer, a player
       seeking): one range, as the bucket answers it too. A picture drawn in
       place is always whole, since its bytes may be a resized copy. */
  const range = image ? undefined : byteRange(ctx.req.headers.range, sent.byteLength);
  if (range === 'unsatisfiable') {
    sendBytes(res, 416, new Uint8Array(0), { 'content-range': `bytes */${sent.byteLength}` }, true);
    return true;
  }
  const body = range ? sent.subarray(range.start, range.end + 1) : sent;
  sendBytes(
    res,
    range ? 206 : 200,
    body,
    {
      'content-type': image ?? downloadType,
      'content-length': body.byteLength,
      'content-disposition': disposition(image ? 'inline' : 'attachment'),
      ...guarded,
      'cache-control': 'private, no-store',
      ...(image ? {} : { 'accept-ranges': 'bytes' }),
      ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${sent.byteLength}` } : {}),
      ...fileHeaders,
    },
    ctx.req.method === 'HEAD',
  );
  return true;
}
