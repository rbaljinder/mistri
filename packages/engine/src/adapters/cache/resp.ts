/**
 * A small RESP2 client for a Valkey (or Redis) cache.
 *
 * Built in rather than a dependency for one reason: the socket has to go
 * where the operator's config said and nowhere else, so its host resolves
 * through the shared network policy (networkPolicy.ts) — the address checked
 * is the address connected — and a client library opens its own sockets. It
 * speaks only what the cache needs: AUTH, SELECT, GET, SET … PX, DEL, EVAL,
 * PING. Commands pipeline over one connection in order.
 *
 * A cache is never a source of truth, so every failure is one kind of
 * error, `CacheUnavailable`, and its message never carries the credential.
 * After a failure the client stays quiet for a moment (`retryAfterMs`) and
 * answers at once with the same error, so an outage costs a miss, not a
 * connect timeout on every request.
 */
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { checkedLookup, refusedLiteral, type NetworkPolicy } from '../net/networkPolicy.js';

export class CacheUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CacheUnavailable';
  }
}

type RespValue = string | number | null | RespValue[];

interface RespOptions {
  host: string;
  port: number;
  tls: boolean;
  username?: string;
  password?: string;
  db?: number;
  policy: NetworkPolicy;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  retryAfterMs?: number;
}

interface Waiting {
  resolve: (value: RespValue) => void;
  reject: (error: Error) => void;
}

const CRLF = Buffer.from('\r\n');

/** One command as RESP: an array of bulk strings. */
export function encodeCommand(args: ReadonlyArray<string | number>): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const bytes = Buffer.from(String(arg), 'utf8');
    parts.push(Buffer.from(`$${bytes.byteLength}\r\n`), bytes, CRLF);
  }
  return Buffer.concat(parts);
}

/** A server's error reply (`-ERR …`), kept apart from the transport's. */
export class RespReplyError extends Error {}

/**
 * One reply from the front of `buffer`: the value and where it ended, or
 * undefined when the reply has not fully arrived. An error reply is returned
 * as a RespReplyError value for the caller to reject with.
 */
export function decodeReply(buffer: Buffer, start = 0): { value: RespValue | RespReplyError; end: number } | undefined {
  if (start >= buffer.length) return undefined;
  const line = buffer.indexOf(CRLF, start);
  if (line < 0) return undefined;
  const type = String.fromCharCode(buffer[start]);
  const head = buffer.toString('utf8', start + 1, line);
  const next = line + 2;
  switch (type) {
    case '+':
      return { value: head, end: next };
    case '-':
      return { value: new RespReplyError(head), end: next };
    case ':':
      return { value: Number(head), end: next };
    case '$': {
      const size = Number(head);
      if (size < 0) return { value: null, end: next };
      if (buffer.length < next + size + 2) return undefined;
      return { value: buffer.toString('utf8', next, next + size), end: next + size + 2 };
    }
    case '*': {
      const count = Number(head);
      if (count < 0) return { value: null, end: next };
      const items: RespValue[] = [];
      let at = next;
      for (let i = 0; i < count; i++) {
        const item = decodeReply(buffer, at);
        if (!item) return undefined;
        if (item.value instanceof RespReplyError) return { value: item.value, end: item.end };
        items.push(item.value);
        at = item.end;
      }
      return { value: items, end: at };
    }
    default:
      throw new CacheUnavailable(`the cache answered something that is not RESP ("${type}").`);
  }
}

const MAX_WAITING = 1024;

interface RespConnection {
  readonly socket: Socket;
  chunks: Buffer[];
  buffered: number;
  readonly waiting: Waiting[];
  dead: boolean;
}

export class RespClient {
  private connection?: RespConnection;
  private connecting?: RespConnection;
  private opening?: Promise<RespConnection>;
  private quietUntil = 0;
  private lastFailure = '';
  private closed = false;

  constructor(private readonly options: RespOptions) {}

  private get where(): string {
    return `${this.options.host}:${this.options.port}`;
  }

  /** Send one command and wait for its reply. Rejects with CacheUnavailable, or RespReplyError for the server's own refusal. */
  async command(...args: Array<string | number>): Promise<RespValue> {
    if (this.closed) throw new CacheUnavailable('the cache connection is closed.');
    if (Date.now() < this.quietUntil) throw new CacheUnavailable(this.lastFailure);
    if ((this.connection?.waiting.length ?? 0) >= MAX_WAITING) {
      throw new CacheUnavailable(`${this.where}: too many commands waiting for a reply.`);
    }
    const conn = await this.connected();
    return this.write(conn, args);
  }

  async close(): Promise<void> {
    this.closed = true;
    const connecting = this.connecting;
    this.connecting = undefined;
    if (connecting) this.fail(connecting, 'the cache connection is closed.');
    const conn = this.connection;
    this.connection = undefined;
    if (conn) {
      if (!conn.dead) {
        try {
          await this.write(conn, ['QUIT']);
        } catch {
          /* already gone */
        }
      }
      this.fail(conn, 'the cache connection is closed.');
    }
  }

  private write(conn: RespConnection, args: Array<string | number>): Promise<RespValue> {
    if (conn.dead || (conn !== this.connection && conn !== this.connecting) || conn.socket.destroyed || !conn.socket.writable) {
      return Promise.reject(new CacheUnavailable(this.lastFailure || `${this.where} closed the connection.`));
    }
    if (conn.waiting.length >= MAX_WAITING) {
      return Promise.reject(new CacheUnavailable(`${this.where}: too many commands waiting for a reply.`));
    }
    return new Promise<RespValue>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(conn, `${this.where} did not answer within ${(this.options.commandTimeoutMs ?? 1_000) / 1000} s.`),
        this.options.commandTimeoutMs ?? 1_000,
      );
      conn.waiting.push({
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      conn.socket.write(encodeCommand(args));
    });
  }

  /* Every waiting command on `conn` fails with the transport's reason, the
     socket is dropped, and the client stays quiet for a moment before dialing
     again. Scoped to `conn` so a late event on a retired socket can never
     disturb a newer connection or its queued replies. */
  private fail(conn: RespConnection, message: string): void {
    if (conn.dead) return;
    conn.dead = true;
    const isCurrent = this.connection === conn || this.connecting === conn;
    if (this.connection === conn) this.connection = undefined;
    if (this.connecting === conn) this.connecting = undefined;
    if (isCurrent && !this.closed) {
      this.lastFailure = message;
      this.quietUntil = Date.now() + (this.options.retryAfterMs ?? 2_000);
    }
    conn.chunks = [];
    conn.buffered = 0;
    conn.socket.destroy();
    for (const waiting of conn.waiting.splice(0)) waiting.reject(new CacheUnavailable(message));
  }

  private connected(): Promise<RespConnection> {
    if (this.connection && !this.connection.dead) return Promise.resolve(this.connection);
    return (this.opening ??= this.open().finally(() => {
      this.opening = undefined;
    }));
  }

  private async open(): Promise<RespConnection> {
    const { host, port, tls, policy } = this.options;
    const literal = refusedLiteral(host, policy);
    if (literal) {
      this.lastFailure = `${this.where}: the address ${literal} is one this connection may not reach.`;
      this.quietUntil = Date.now() + (this.options.retryAfterMs ?? 2_000);
      throw new CacheUnavailable(this.lastFailure);
    }
    const lookup = checkedLookup(
      policy,
      (name, addresses) =>
        new CacheUnavailable(`${name} resolves only to addresses this connection may not reach (${addresses.join(', ')}).`),
    ) as never;
    const socket = await new Promise<Socket>((resolve, reject) => {
      const timeoutMs = this.options.connectTimeoutMs ?? 2_000;
      const opened = tls ? tlsConnect({ host, port, servername: host, lookup }) : netConnect({ host, port, lookup });
      const timer = setTimeout(() => {
        opened.destroy();
        reject(new CacheUnavailable(`${this.where} did not accept a connection within ${timeoutMs / 1000} s.`));
      }, timeoutMs);
      opened.once(tls ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        resolve(opened);
      });
      opened.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          error instanceof CacheUnavailable ? error : new CacheUnavailable(`${this.where}: ${error.code ?? 'the connection failed'}.`),
        );
      });
    }).catch((error: CacheUnavailable) => {
      this.lastFailure = error.message;
      this.quietUntil = Date.now() + (this.options.retryAfterMs ?? 2_000);
      throw error;
    });
    if (this.closed) {
      socket.destroy();
      throw new CacheUnavailable('the cache connection is closed.');
    }
    socket.setNoDelay(true);
    const conn: RespConnection = { socket, chunks: [], buffered: 0, waiting: [], dead: false };
    socket.on('data', (chunk: Buffer) => this.read(conn, chunk));
    socket.on('error', (error: NodeJS.ErrnoException) => this.fail(conn, `${this.where}: ${error.code ?? 'the connection failed'}.`));
    socket.on('close', () => {
      this.fail(conn, `${this.where} closed the connection.`);
    });
    /* Hold the socket privately until AUTH and SELECT finish so concurrent callers
       await `this.opening` and can never pipeline commands before authentication. */
    this.connecting = conn;
    try {
      if (this.options.password !== undefined) {
        await this.write(
          conn,
          this.options.username ? ['AUTH', this.options.username, this.options.password] : ['AUTH', this.options.password],
        );
      }
      if (this.options.db) await this.write(conn, ['SELECT', this.options.db]);
    } catch (error) {
      /* The server's own words for a bad password name the password's
         owner at most; still, only the fact is kept. */
      const message =
        error instanceof RespReplyError ? `${this.where} refused the connection's credential or database.` : (error as Error).message;
      this.fail(conn, message);
      throw new CacheUnavailable(message);
    }
    if (this.connecting === conn) this.connecting = undefined;
    if (this.closed || conn.dead) {
      this.fail(conn, this.closed ? 'the cache connection is closed.' : this.lastFailure || `${this.where} closed the connection.`);
      throw new CacheUnavailable(
        this.closed ? 'the cache connection is closed.' : this.lastFailure || `${this.where} closed the connection.`,
      );
    }
    this.connection = conn;
    return conn;
  }

  private read(conn: RespConnection, chunk: Buffer): void {
    if (conn.dead) return;
    conn.chunks.push(chunk);
    conn.buffered += chunk.length;
    const buffer = conn.chunks.length === 1 ? conn.chunks[0] : Buffer.concat(conn.chunks, conn.buffered);
    let offset = 0;
    for (;;) {
      let reply;
      try {
        reply = decodeReply(buffer, offset);
      } catch (error) {
        return this.fail(conn, (error as Error).message);
      }
      if (!reply) {
        if (offset > 0) {
          const rest = buffer.subarray(offset);
          conn.chunks = rest.length ? [rest] : [];
          conn.buffered = rest.length;
        } else if (conn.chunks.length > 1) {
          conn.chunks = [buffer];
        }
        return;
      }
      offset = reply.end;
      const waiting = conn.waiting.shift();
      if (!waiting) continue;
      if (reply.value instanceof RespReplyError) waiting.reject(reply.value);
      else waiting.resolve(reply.value);
    }
  }
}
