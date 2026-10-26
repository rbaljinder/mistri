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

export class RespClient {
  private socket?: Socket;
  private opening?: Promise<Socket>;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly waiting: Waiting[] = [];
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
    const socket = await this.connected();
    return this.write(socket, args);
  }

  async close(): Promise<void> {
    this.closed = true;
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      try {
        await this.write(socket, ['QUIT']);
      } catch {
        /* already gone */
      }
      socket.destroy();
    }
  }

  private write(socket: Socket, args: Array<string | number>): Promise<RespValue> {
    return new Promise<RespValue>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(`${this.where} did not answer within ${(this.options.commandTimeoutMs ?? 1_000) / 1000} s.`),
        this.options.commandTimeoutMs ?? 1_000,
      );
      this.waiting.push({
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.write(encodeCommand(args));
    });
  }

  /* Every waiting command fails with the transport's reason, the socket is
     dropped, and the client stays quiet for a moment before dialing again. */
  private fail(message: string): void {
    this.lastFailure = message;
    this.quietUntil = Date.now() + (this.options.retryAfterMs ?? 2_000);
    const socket = this.socket;
    this.socket = undefined;
    this.buffer = Buffer.alloc(0);
    socket?.destroy();
    for (const waiting of this.waiting.splice(0)) waiting.reject(new CacheUnavailable(message));
  }

  private connected(): Promise<Socket> {
    if (this.socket) return Promise.resolve(this.socket);
    return (this.opening ??= this.open().finally(() => {
      this.opening = undefined;
    }));
  }

  private async open(): Promise<Socket> {
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
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.read(chunk));
    socket.on('error', (error: NodeJS.ErrnoException) => this.fail(`${this.where}: ${error.code ?? 'the connection failed'}.`));
    socket.on('close', () => {
      if (this.socket === socket) this.fail(`${this.where} closed the connection.`);
    });
    this.socket = socket;
    try {
      if (this.options.password !== undefined) {
        await this.write(
          socket,
          this.options.username ? ['AUTH', this.options.username, this.options.password] : ['AUTH', this.options.password],
        );
      }
      if (this.options.db) await this.write(socket, ['SELECT', this.options.db]);
    } catch (error) {
      /* The server's own words for a bad password name the password's
         owner at most; still, only the fact is kept. */
      const message =
        error instanceof RespReplyError ? `${this.where} refused the connection's credential or database.` : (error as Error).message;
      this.fail(message);
      throw new CacheUnavailable(message);
    }
    return socket;
  }

  private read(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      let reply;
      try {
        reply = decodeReply(this.buffer);
      } catch (error) {
        return this.fail((error as Error).message);
      }
      if (!reply) return;
      this.buffer = this.buffer.subarray(reply.end);
      const waiting = this.waiting.shift();
      if (!waiting) continue;
      if (reply.value instanceof RespReplyError) waiting.reject(reply.value);
      else waiting.resolve(reply.value);
    }
  }
}
