/**
 * One S3-compatible bucket, spoken to over fetch with the requests signed
 * here (sigv4.ts): put an object, get it (whole or a range), delete it, list
 * a prefix, and presign a GET. That is all a file store needs, and each is
 * the same request on AWS S3, Cloudflare R2, MinIO, Backblaze B2 and Tigris;
 * they differ only in the endpoint, the region and whether the bucket is in
 * the host name or the path.
 */
import { encodePath, presignUrl, sha256Hex, signRequest, type SigningCredentials } from './sigv4.js';

/** Fixed keys, or a source that answers with the current ones (a task or instance role's, which expire). */
export type BucketCredentials = SigningCredentials | (() => Promise<SigningCredentials>);

/** Where a bucket is: what `resources.*.file.bucket` says. */
interface BucketLocation {
  readonly name: string;
  /** AWS's region, or what the provider asks for (R2: `auto`). Default `us-east-1`. */
  readonly region?: string;
  /** The provider's S3 endpoint; AWS S3 when unsaid. */
  readonly endpoint?: string;
  /** The bucket in the path (`endpoint/bucket/key`) rather than the host; MinIO and most self-hosted stores want it. */
  readonly pathStyle?: boolean;
}

export class BucketError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'BucketError';
  }
}

/** One listed object. */
interface BucketObject {
  readonly key: string;
  readonly size: number;
  readonly lastModified: Date;
}

/** An object's bytes as the bucket answered: whole (200) or the range asked for (206). */
interface BucketRead {
  readonly status: 200 | 206;
  readonly body: ReadableStream<Uint8Array>;
  readonly length?: number;
  readonly contentRange?: string;
  readonly etag?: string;
}

const TIMEOUT_MS = 60_000;

const xmlText = (value: string) =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
const tag = (xml: string, name: string) => {
  const found = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return found ? xmlText(found[1]) : undefined;
};

export class Bucket {
  private readonly base: URL;
  private readonly region: string;

  constructor(
    readonly location: BucketLocation,
    private readonly credentials: BucketCredentials,
    private readonly fetcher: typeof fetch = fetch,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.region = location.region ?? 'us-east-1';
    const endpoint = new URL(location.endpoint ?? `https://s3.${this.region}.amazonaws.com`);
    if (location.pathStyle) {
      endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/${encodePath(location.name)}/`;
    } else {
      endpoint.host = `${location.name}.${endpoint.host}`;
      endpoint.pathname = endpoint.pathname.replace(/\/?$/, '/');
    }
    this.base = endpoint;
  }

  private url(key: string): URL {
    return new URL(`${this.base.pathname}${encodePath(key)}`, this.base);
  }

  private async place() {
    const credentials = typeof this.credentials === 'function' ? await this.credentials() : this.credentials;
    return { credentials, region: this.region, service: 's3', now: this.clock() };
  }

  private async send(method: string, url: URL, headers: Record<string, string>, body?: Uint8Array): Promise<Response> {
    const payloadHash = body ? sha256Hex(body) : sha256Hex('');
    let signed: Record<string, string>;
    try {
      signed = signRequest({ method, url, headers: { ...headers, 'x-amz-content-sha256': payloadHash }, payloadHash }, await this.place());
    } catch (error) {
      throw new BucketError(`The bucket "${this.location.name}" has no credentials to sign with: ${(error as Error).message}`, 503);
    }
    /* fetch sets host itself; a second one is refused. */
    delete signed.host;
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers: signed,
        // A Buffer over a shared ArrayBuffer is still bytes to fetch; only the DOM's types say otherwise.
        ...(body ? { body: body as Uint8Array<ArrayBuffer> } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new BucketError(`The bucket "${this.location.name}" could not be reached: ${(error as Error).message}`, 503);
    }
    return response;
  }

  private async refused(response: Response, doing: string): Promise<never> {
    const text = await response.text().catch(() => '');
    const code = tag(text, 'Code');
    const message = tag(text, 'Message');
    throw new BucketError(
      `The bucket "${this.location.name}" refused to ${doing}: ${response.status}${code ? ` ${code}` : ''}${message ? ` (${message})` : ''}.`,
      response.status,
      code,
    );
  }

  /** Store the bytes under the key, replacing whatever was there. */
  async put(key: string, bytes: Uint8Array, type = 'application/octet-stream'): Promise<void> {
    const response = await this.send('PUT', this.url(key), { 'content-type': type }, bytes);
    if (!response.ok) await this.refused(response, `store ${key}`);
    await response.body?.cancel();
  }

  /** The object, or the range of it asked for (`bytes=0-99`); undefined when there is none. */
  async get(key: string, range?: string): Promise<BucketRead | undefined> {
    const response = await this.send('GET', this.url(key), range ? { range } : {});
    if (response.status === 404) {
      await response.body?.cancel();
      return undefined;
    }
    if ((response.status !== 200 && response.status !== 206) || !response.body) await this.refused(response, `read ${key}`);
    const length = Number(response.headers.get('content-length'));
    return {
      status: response.status as 200 | 206,
      body: response.body!,
      ...(Number.isSafeInteger(length) && length >= 0 && response.headers.has('content-length') ? { length } : {}),
      ...(response.headers.get('content-range') ? { contentRange: response.headers.get('content-range')! } : {}),
      ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}),
    };
  }

  /** The whole object's bytes, or undefined when there is none. */
  async bytes(key: string): Promise<Uint8Array | undefined> {
    const read = await this.get(key);
    return read ? new Uint8Array(await new Response(read.body).arrayBuffer()) : undefined;
  }

  /** Remove the object; one already gone is not an error. */
  async delete(key: string): Promise<void> {
    const response = await this.send('DELETE', this.url(key), {});
    if (!response.ok && response.status !== 404) await this.refused(response, `delete ${key}`);
    await response.body?.cancel();
  }

  /** One page of the objects under a prefix (ListObjectsV2), at most `most` of them, and the token for the next. */
  async list(prefix: string, continuation?: string, most?: number): Promise<{ objects: BucketObject[]; next?: string }> {
    const url = new URL(this.base);
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', prefix);
    if (continuation) url.searchParams.set('continuation-token', continuation);
    if (most !== undefined) url.searchParams.set('max-keys', String(most));
    const response = await this.send('GET', url, {});
    if (!response.ok) await this.refused(response, `list ${prefix}`);
    const xml = await response.text();
    const objects: BucketObject[] = [];
    for (const [, entry] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = tag(entry, 'Key');
      if (key === undefined) continue;
      objects.push({ key, size: Number(tag(entry, 'Size') ?? 0), lastModified: new Date(tag(entry, 'LastModified') ?? 0) });
    }
    const next = tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextContinuationToken') : undefined;
    return { objects, ...(next ? { next } : {}) };
  }

  /**
   * A GET of the object anyone may follow for `seconds`, its reply's type and
   * disposition fixed by the signature (`response-content-type`,
   * `response-content-disposition`), so the bucket answers as the server would.
   */
  async presign(key: string, seconds: number, reply: { type?: string; disposition?: string } = {}): Promise<string> {
    const url = this.url(key);
    if (reply.type) url.searchParams.set('response-content-type', reply.type);
    if (reply.disposition) url.searchParams.set('response-content-disposition', reply.disposition);
    url.searchParams.set('response-cache-control', 'private, no-store');
    return presignUrl({ method: 'GET', url, expiresSeconds: seconds }, await this.place()).href;
  }
}
