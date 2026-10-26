/**
 * A Fetch `Request` answered by a Node request listener, and its answer read
 * back as a `Response`: what `createHandler(...).fetch` is, for hosts
 * whose routes speak Fetch (a Next route handler, a TanStack Start server
 * route, Hono's `c.req.raw`).
 *
 * The listener gets a real `IncomingMessage` and a real `ServerResponse`, over
 * a socket that is a stream rather than a connection, so everything the
 * server does to them — `writeHead`, `pipe`, the assistant's event stream,
 * `destroy` — behaves as it does on a port. The response is written to that
 * socket as HTTP/1.1 without chunking, so its first bytes are the status
 * line and headers, read once, and every byte after them is the body, passed
 * on as it is written. Nothing is buffered beyond what the reader has not
 * yet pulled: a write waits for the `Response` body to be read.
 *
 * About 150 lines owned rather than a dependency (fetch-to-node does the same
 * job), because each dependency is a line in
 * test/repo/server-dependencies.test.ts and this is the one place it is needed.
 */
import { IncomingMessage, ServerResponse, type IncomingHttpHeaders } from 'node:http';
import { Duplex } from 'node:stream';

/** Statuses a `Response` may not carry a body with. */
const NO_BODY = new Set([101, 204, 205, 304]);
/** Framing between this bridge and the listener, never the host's business. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding']);
/** What a socket's peer is called when the host vouched for nobody (§8.1 of the embed design: never loopback). */
export const EMBEDDED_PEER = 'embedded';
const LOOPBACK = /^(127\.|::1$|::ffff:127\.|localhost$)/i;

/** The socket under a bridged request: its writes are the response, its reads are never asked for. */
class BridgeSocket extends Duplex {
  readonly remoteAddress: string;
  readonly remotePort = 0;
  readonly localAddress = EMBEDDED_PEER;
  readonly localPort = 0;
  readonly encrypted: boolean;
  constructor(
    peer: string,
    secure: boolean,
    private readonly sink: (chunk: Buffer, done: () => void) => void,
  ) {
    super({ allowHalfOpen: true });
    this.remoteAddress = peer;
    this.encrypted = secure;
  }
  override _read(): void {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.sink(chunk, () => done());
  }
  setTimeout(): this {
    return this;
  }
  setNoDelay(): this {
    return this;
  }
  setKeepAlive(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

/** The client's address as the host vouches for it, never loopback: a mounted handler is never "this machine". */
function peerOf(clientAddress: string | undefined): string {
  const address = clientAddress?.trim();
  return address && !LOOPBACK.test(address) ? address : EMBEDDED_PEER;
}

/** Headers as Node's parser would have put them: lower-cased, `set-cookie` a list, `cookie` joined by `; `, the rest by `, `. */
function nodeHeaders(headers: Headers): { headers: IncomingHttpHeaders; raw: string[] } {
  const out: Record<string, string | string[]> = {};
  const raw: string[] = [];
  for (const [name, value] of headers) {
    if (name === 'set-cookie') continue;
    out[name] = value;
    raw.push(name, value);
  }
  const cookies = headers.getSetCookie();
  if (cookies.length) {
    out['set-cookie'] = cookies;
    for (const cookie of cookies) raw.push('set-cookie', cookie);
  }
  return { headers: out as IncomingHttpHeaders, raw };
}

/** The status line and headers a `ServerResponse` wrote, read back. */
function readHead(head: string): { status: number; statusText: string; headers: Headers } {
  const [line, ...fields] = head.split('\r\n');
  const status = /^HTTP\/1\.[01] (\d{3}) ?(.*)$/.exec(line);
  if (!status) throw new Error('mistri: the response did not begin with a status line.');
  const headers = new Headers();
  for (const field of fields) {
    const colon = field.indexOf(':');
    if (colon <= 0) continue;
    const name = field.slice(0, colon).trim().toLowerCase();
    if (!HOP_BY_HOP.has(name)) headers.append(name, field.slice(colon + 1).trim());
  }
  return { status: Number(status[1]), statusText: status[2], headers };
}

/**
 * Answer `request` with `listener`. Resolves once the status and headers are
 * written, with the body streaming behind them, as a Node client sees it.
 * The request's own `signal`, or the body's reader cancelling, is the client
 * leaving: the request is destroyed and the server sees it go, as it would a
 * dropped connection.
 */
export function bridgeFetch(
  request: Request,
  listener: (req: IncomingMessage, res: ServerResponse) => void,
  options: { clientAddress?: string } = {},
): Promise<Response> {
  const url = new URL(request.url);
  let head: Buffer | undefined = Buffer.alloc(0);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let waiting: (() => void) | undefined;
  let answer!: (response: Response) => void;
  let fail!: (error: unknown) => void;
  const answered = new Promise<Response>((resolve, reject) => {
    answer = resolve;
    fail = reject;
  });
  let settled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      start: (own) => {
        controller = own;
      },
      pull: () => {
        const resume = waiting;
        waiting = undefined;
        resume?.();
      },
      cancel: () => leave(),
    },
    { highWaterMark: 1 },
  );
  const pass = (chunk: Buffer, done: () => void) => {
    if (!chunk.length) return done();
    controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    if ((controller.desiredSize ?? 1) > 0) done();
    else waiting = done;
  };
  const socket = new BridgeSocket(peerOf(options.clientAddress), url.protocol === 'https:', (chunk, done) => {
    if (head === undefined) return pass(chunk, done);
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf('\r\n\r\n');
    if (end < 0) return done();
    const parsed = readHead(head.subarray(0, end).toString('latin1'));
    const rest = head.subarray(end + 4);
    head = undefined;
    settled = true;
    const empty = request.method === 'HEAD' || NO_BODY.has(parsed.status);
    answer(new Response(empty ? null : body, { status: parsed.status, statusText: parsed.statusText, headers: parsed.headers }));
    if (empty) {
      controller.close();
      return done();
    }
    pass(rest, done);
  });

  const req = new IncomingMessage(socket as never);
  const { headers, raw } = nodeHeaders(request.headers);
  // A Fetch Request may carry no Host (undici drops it); its URL says which host it was for.
  if (headers.host === undefined) {
    headers.host = url.host;
    raw.push('host', url.host);
  }
  /* A body with no length is framed as HTTP/1.1 frames a streamed one, so a
     reader that asks whether there is a body (Better Auth's does) is told. */
  if (request.body && headers['content-length'] === undefined && headers['transfer-encoding'] === undefined) {
    headers['transfer-encoding'] = 'chunked';
    raw.push('transfer-encoding', 'chunked');
  }
  req.method = request.method;
  req.url = url.pathname + url.search;
  req.headers = headers;
  req.rawHeaders = raw;
  req.httpVersion = '1.1';
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;
  const reader = request.body?.getReader();
  let pumping = false;
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const read = reader ? await reader.read() : { done: true as const, value: undefined };
        if (read.done) {
          req.complete = true;
          req.push(null);
          return;
        }
        if (!req.push(Buffer.from(read.value.buffer, read.value.byteOffset, read.value.byteLength))) return;
      }
    } catch (error) {
      req.destroy(error as Error);
    } finally {
      pumping = false;
    }
  };
  req._read = () => void pump();

  const res = new ServerResponse(req);
  /* Unchunked and not kept alive, so the bytes after the head are the body
     exactly: this socket carries one response and ends with it. */
  res.useChunkedEncodingByDefault = false;
  res.shouldKeepAlive = false;
  res.assignSocket(socket as never);
  res.once('finish', () => {
    try {
      controller.close();
    } catch {
      /* already cancelled by the reader */
    }
    /* The connection's end, as a server's socket would close after a
       response that is not kept alive: the request and response say 'close'. */
    setImmediate(() => {
      req.destroy();
      socket.destroy();
    });
  });
  res.once('close', () => {
    if (!settled) {
      settled = true;
      fail(new Error('mistri: the request was closed before it was answered.'));
    } else if (!res.writableFinished) {
      try {
        controller.error(new Error('mistri: the response was cut off.'));
      } catch {
        /* already closed */
      }
    }
  });

  let gone = false;
  function leave() {
    if (gone) return;
    gone = true;
    void reader?.cancel().catch(() => {});
    if (!req.complete) req.emit('aborted');
    req.destroy();
    socket.destroy();
  }
  if (request.signal.aborted) leave();
  else request.signal.addEventListener('abort', leave, { once: true });

  try {
    listener(req, res);
  } catch (error) {
    leave();
    return Promise.reject(error);
  }
  return answered;
}
