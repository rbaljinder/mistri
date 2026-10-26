/**
 * An S3-compatible bucket in memory on 127.0.0.1, for the file-storage tests:
 * path-style PUT, GET (with a range), DELETE, ListObjectsV2 and presigned
 * GET. Every request's SigV4 signature is checked against the headers (or
 * query) it actually arrived with, so a header fetch changes or drops after
 * signing is a 403 here as it would be at AWS; a request is refused, never
 * served, without one. It keeps what it saw, so a test can assert what the
 * server asked the bucket.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { presignUrl, signRequest } from '../../packages/mistri/src/server/files/sigv4.js';

export const FAKE_S3_CREDENTIALS = { accessKeyId: 'AKIDFAKES3', secretAccessKey: 'fake-s3-secret-key/for+tests' };

export interface FakeObject {
  bytes: Buffer;
  lastModified: Date;
  type: string;
}

export interface FakeS3 {
  readonly endpoint: string;
  readonly bucket: string;
  readonly objects: Map<string, FakeObject>;
  readonly seen: { method: string; key: string; range?: string; presigned: boolean }[];
  /** The next requests answer 500, as a bucket that is down does. */
  failing: boolean;
  /** Answer 500 to the requests this says, as a bucket that fails part way through does. */
  refuse?: (method: string, key: string) => boolean;
  close(): Promise<void>;
}

const amzTime = (value: string) =>
  new Date(
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`,
  );
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function signedRight(req: IncomingMessage, url: URL, region: string): boolean {
  const presigned = url.searchParams.get('X-Amz-Signature');
  if (presigned) {
    const unsigned = new URL(url);
    for (const name of [...unsigned.searchParams.keys()]) if (name.startsWith('X-Amz-')) unsigned.searchParams.delete(name);
    const date = amzTime(url.searchParams.get('X-Amz-Date') ?? '');
    const expires = Number(url.searchParams.get('X-Amz-Expires'));
    if (Date.now() > date.getTime() + expires * 1000) return false;
    const again = presignUrl(
      { method: req.method!, url: unsigned, expiresSeconds: expires },
      { credentials: FAKE_S3_CREDENTIALS, region, service: 's3', now: date },
    );
    return again.searchParams.get('X-Amz-Signature') === presigned;
  }
  const authorization = req.headers.authorization ?? '';
  const parts = /SignedHeaders=([^,]+),Signature=([0-9a-f]{64})$/.exec(authorization);
  if (!parts || !authorization.includes(`Credential=${FAKE_S3_CREDENTIALS.accessKeyId}/`)) return false;
  const headers: Record<string, string> = {};
  for (const name of parts[1].split(';')) {
    if (name === 'x-amz-date') continue;
    const value = req.headers[name];
    if (typeof value !== 'string') return false;
    headers[name] = value;
  }
  const again = signRequest(
    { method: req.method!, url, headers, payloadHash: String(req.headers['x-amz-content-sha256']) },
    { credentials: FAKE_S3_CREDENTIALS, region, service: 's3', now: amzTime(String(req.headers['x-amz-date'])) },
  );
  return again.authorization === authorization;
}

export async function startFakeS3(bucket = 'tw-files', region = 'us-east-1', pageSize = 2): Promise<FakeS3> {
  const objects = new Map<string, FakeObject>();
  const seen: FakeS3['seen'] = [];
  const state: { failing: boolean; refuse?: FakeS3['refuse'] } = { failing: false };
  const fail = (res: ServerResponse, status: number, code: string) => {
    res.writeHead(status, { 'content-type': 'application/xml' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`);
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const [, name, ...rest] = url.pathname.split('/');
    const key = rest.map(decodeURIComponent).join('/');
    const presigned = url.searchParams.has('X-Amz-Signature');
    seen.push({ method: req.method!, key, ...(req.headers.range ? { range: req.headers.range } : {}), presigned });
    if (state.failing || state.refuse?.(req.method!, key)) return fail(res, 500, 'InternalError');
    if (name !== bucket) return fail(res, 404, 'NoSuchBucket');
    if (!signedRight(req, url, region)) return fail(res, 403, 'SignatureDoesNotMatch');
    if (!presigned && req.headers['x-amz-content-sha256'] !== createHash('sha256').update(body).digest('hex'))
      return fail(res, 400, 'XAmzContentSHA256Mismatch');
    if (req.method === 'PUT' && key) {
      objects.set(key, { bytes: body, lastModified: new Date(), type: String(req.headers['content-type'] ?? '') });
      res.writeHead(200, { etag: `"${createHash('md5').update(body).digest('hex')}"` });
      return res.end();
    }
    if (req.method === 'DELETE' && key) {
      objects.delete(key);
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'GET' && !key && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const after = url.searchParams.get('continuation-token') ?? '';
      const keys = [...objects.keys()].filter((each) => each.startsWith(prefix) && each > after).sort();
      const page = keys.slice(0, pageSize);
      const truncated = keys.length > pageSize;
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${escape(prefix)}</Prefix>` +
          `<IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${escape(page.at(-1)!)}</NextContinuationToken>` : ''}` +
          page
            .map(
              (each) =>
                `<Contents><Key>${escape(each)}</Key><LastModified>${objects.get(each)!.lastModified.toISOString()}</LastModified>` +
                `<Size>${objects.get(each)!.bytes.byteLength}</Size></Contents>`,
            )
            .join('') +
          '</ListBucketResult>',
      );
    }
    if (req.method === 'GET' && key) {
      const object = objects.get(key);
      if (!object) return fail(res, 404, 'NoSuchKey');
      const headers: Record<string, string | number> = {
        etag: `"${createHash('md5').update(object.bytes).digest('hex')}"`,
        'content-type': url.searchParams.get('response-content-type') ?? (object.type || 'application/octet-stream'),
        ...(url.searchParams.get('response-content-disposition')
          ? { 'content-disposition': url.searchParams.get('response-content-disposition')! }
          : {}),
      };
      const range = req.headers.range ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range) : null;
      if (range) {
        const size = object.bytes.byteLength;
        const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
        const end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
        if (start >= size || end < start) return fail(res, 416, 'InvalidRange');
        const part = object.bytes.subarray(start, end + 1);
        res.writeHead(206, { ...headers, 'content-length': part.byteLength, 'content-range': `bytes ${start}-${end}/${size}` });
        return res.end(part);
      }
      res.writeHead(200, { ...headers, 'content-length': object.bytes.byteLength });
      return res.end(object.bytes);
    }
    fail(res, 400, 'InvalidRequest');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    bucket,
    objects,
    seen,
    get failing() {
      return state.failing;
    },
    set failing(value: boolean) {
      state.failing = value;
    },
    get refuse() {
      return state.refuse;
    },
    set refuse(value) {
      state.refuse = value;
    },
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close').catch(() => {});
    },
  };
}
