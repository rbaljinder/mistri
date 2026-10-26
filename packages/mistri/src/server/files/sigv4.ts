/**
 * AWS Signature Version 4, as S3 and every S3-compatible store (R2, MinIO,
 * B2, Tigris) checks it: a request signed in its headers, or a GET signed in
 * its query string (a presigned URL) for a browser to follow.
 *
 * Written here rather than taken from the AWS SDK because it is about a
 * hundred lines over node:crypto, and the SDK is several megabytes of
 * dependency for the five calls a file store makes (put, get, delete, list,
 * presign). It is checked against AWS's published examples in
 * test/s3-sigv4.test.ts, so a mistake in the canonical form is a red test,
 * not a 403 in production.
 *
 * The path is encoded once, as S3 wants (the other AWS services encode it
 * twice); every other rule is the general one.
 */
import { createHash, createHmac } from 'node:crypto';

export interface SigningCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Present for temporary credentials (STS, an instance role): sent as X-Amz-Security-Token. */
  readonly sessionToken?: string;
}

interface SigningPlace {
  readonly credentials: SigningCredentials;
  readonly region: string;
  /** `s3` for a bucket; the signing tests also use AWS's generic `service`. */
  readonly service: string;
  readonly now: Date;
}

/** The hash S3 is told it may skip for a presigned URL, whose body the signer never sees. */
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 percent-encoding, which `encodeURIComponent` almost is: it leaves !'()* alone, and SigV4 does not. */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** An S3 object path: each segment encoded, the slashes between them kept. */
export function encodePath(path: string): string {
  return path.split('/').map(encodeRfc3986).join('/');
}

/** `20130524T000000Z`, and the day it falls on. */
function stamps(now: Date): { amzDate: string; day: string } {
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return { amzDate, day: amzDate.slice(0, 8) };
}

/** The query string in canonical order: by encoded name, then encoded value. */
function canonicalQuery(params: URLSearchParams): string {
  return [...params]
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

function signature(place: SigningPlace, amzDate: string, day: string, canonicalRequest: string): { scope: string; signature: string } {
  const scope = `${day}/${place.region}/${place.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${place.credentials.secretAccessKey}`, day), place.region), place.service), 'aws4_request');
  return { scope, signature: createHmac('sha256', key).update(toSign, 'utf8').digest('hex') };
}

/**
 * The headers that carry a request's signature: the ones given (each signed),
 * plus `x-amz-date`, `x-amz-security-token` for temporary credentials, and
 * `authorization`. `host` is taken from the URL when not given. The payload
 * hash is the caller's: the body's SHA-256.
 */
export function signRequest(
  request: { readonly method: string; readonly url: URL; readonly headers?: Record<string, string>; readonly payloadHash: string },
  place: SigningPlace,
): Record<string, string> {
  const { amzDate, day } = stamps(place.now);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers ?? {})) headers[name.toLowerCase()] = value;
  headers.host ??= request.url.host;
  headers['x-amz-date'] = amzDate;
  if (place.credentials.sessionToken) headers['x-amz-security-token'] = place.credentials.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalRequest = [
    request.method,
    encodePath(decodeURIComponent(request.url.pathname)),
    canonicalQuery(request.url.searchParams),
    names.map((name) => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}\n`).join(''),
    names.join(';'),
    request.payloadHash,
  ].join('\n');
  const signed = signature(place, amzDate, day, canonicalRequest);
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${place.credentials.accessKeyId}/${signed.scope},` +
    `SignedHeaders=${names.join(';')},Signature=${signed.signature}`;
  return headers;
}

/**
 * A URL anyone holding it may GET until it expires, signed over its query
 * string and the host alone. Whatever the URL already asks (an S3
 * `response-content-disposition`) is signed with it, so it cannot be changed.
 */
export function presignUrl(
  request: { readonly method: string; readonly url: URL; readonly expiresSeconds: number },
  place: SigningPlace,
): URL {
  const { amzDate, day } = stamps(place.now);
  const url = new URL(request.url);
  const scope = `${day}/${place.region}/${place.service}/aws4_request`;
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set('X-Amz-Credential', `${place.credentials.accessKeyId}/${scope}`);
  url.searchParams.set('X-Amz-Date', amzDate);
  url.searchParams.set('X-Amz-Expires', String(request.expiresSeconds));
  if (place.credentials.sessionToken) url.searchParams.set('X-Amz-Security-Token', place.credentials.sessionToken);
  url.searchParams.set('X-Amz-SignedHeaders', 'host');
  const canonicalRequest = [
    request.method,
    encodePath(decodeURIComponent(url.pathname)),
    canonicalQuery(url.searchParams),
    `host:${url.host}\n`,
    'host',
    UNSIGNED_PAYLOAD,
  ].join('\n');
  url.searchParams.set('X-Amz-Signature', signature(place, amzDate, day, canonicalRequest).signature);
  /* URLSearchParams writes a space as `+`, which S3 reads back as a plus:
     the signed form (%20) is the one the query must carry. */
  url.search = canonicalQuery(url.searchParams);
  return url;
}
