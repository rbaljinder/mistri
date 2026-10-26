/**
 * A small SMTP client: one message per connection, EHLO, STARTTLS, AUTH
 * PLAIN, MAIL, RCPT, DATA, QUIT, and nothing else.
 *
 * Built in rather than a dependency for the reason the cache's client is
 * (cache/resp.ts): the socket has to go where the operator's config said and
 * nowhere else, so its host resolves through the shared network policy
 * (networkPolicy.ts) — the address checked is the address connected — and a
 * mail library opens its own sockets. Node has the sockets and the TLS; SMTP
 * on top of them is a few dozen lines of request and reply.
 *
 * TLS is not optional by default: `smtps://` is TLS from the first byte, and
 * `smtp://` must offer STARTTLS or nothing is sent — a credential never
 * crosses in the clear. A plain session is for a relay on a trusted network,
 * and only when the connection says `"insecure": true`.
 *
 * A reply of 5xx is the server refusing this message for good (a mailbox that
 * does not exist, a sender it will not relay for): `permanent`, and asking
 * again sends nothing new. Everything else — 4xx, a timeout, a dropped
 * socket — may pass, and the caller tries again later. The error's message
 * never carries the credential or the message's words.
 */
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import { checkedLookup, refusedLiteral, type NetworkPolicy } from '@mistriwork/engine/adapters/net/networkPolicy.js';

export class SmtpError extends Error {
  constructor(
    message: string,
    readonly permanent = false,
  ) {
    super(message);
    this.name = 'SmtpError';
  }
}

interface SmtpOptions {
  host: string;
  port: number;
  /** TLS from the first byte (`smtps://`, port 465). */
  secure: boolean;
  /** Without TLS from the start: STARTTLS is required unless the connection is `insecure`. */
  insecure?: boolean;
  username?: string;
  password?: string;
  policy: NetworkPolicy;
  /** The name this client gives in EHLO. */
  helo?: string;
  timeoutMs?: number;
  /** Tests: a CA to trust, or none checked. Never read from a config file. */
  tls?: Pick<ConnectionOptions, 'ca' | 'rejectUnauthorized'>;
}

interface Reply {
  code: number;
  lines: string[];
}

/* An address inside angle brackets, and nothing a line could carry. */
const envelopeAddress = (address: string) => {
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(address)) throw new SmtpError('An address in the envelope is not one address.', true);
  return `<${address}>`;
};

/** A message body as DATA carries it: CRLF line ends, a leading dot doubled, the closing dot line after. */
export function dataOf(message: string): string {
  const lines = message.replace(/\r?\n/g, '\r\n').split('\r\n');
  return `${lines.map((line) => (line.startsWith('.') ? `.${line}` : line)).join('\r\n')}\r\n.\r\n`;
}

class Session {
  private buffer = '';
  private waiting?: { resolve: (reply: Reply) => void; reject: (error: Error) => void };
  private lines: string[] = [];
  private failure?: Error;

  constructor(
    private socket: Socket,
    private readonly where: string,
    private readonly timeoutMs: number,
  ) {
    this.listen(socket);
  }

  private listen(socket: Socket): void {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.read(chunk));
    socket.on('error', (error: NodeJS.ErrnoException) =>
      this.fail(new SmtpError(`${this.where}: ${error.code ?? 'the connection failed'}.`)),
    );
    socket.on('close', () => this.fail(new SmtpError(`${this.where} closed the connection.`)));
  }

  private fail(error: Error): void {
    this.failure ??= error;
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.reject(this.failure);
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 64 * 1024) return this.fail(new SmtpError(`${this.where} answered with more than a reply.`));
    let end: number;
    while ((end = this.buffer.indexOf('\r\n')) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      this.lines.push(line.slice(4));
      // `250-…` continues a reply; `250 …` ends it.
      if (line.length >= 3 && line[3] !== '-') {
        const reply = { code: Number(line.slice(0, 3)), lines: this.lines };
        this.lines = [];
        const waiting = this.waiting;
        this.waiting = undefined;
        if (!Number.isInteger(reply.code)) return this.fail(new SmtpError(`${this.where} answered something that is not SMTP.`));
        waiting?.resolve(reply);
      }
    }
  }

  /** The next reply, within the timeout. */
  reply(): Promise<Reply> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new SmtpError(`${this.where} did not answer within ${this.timeoutMs / 1000} s.`)),
        this.timeoutMs,
      );
      this.waiting = {
        resolve: (reply) => {
          clearTimeout(timer);
          resolve(reply);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }

  /** Send a line (or DATA's whole body) and read the reply; one outside `expect` is an error, permanent when 5xx. */
  async ask(text: string, expect: readonly number[], what: string): Promise<Reply> {
    const answer = this.reply();
    this.socket.write(text);
    const reply = await answer;
    if (!expect.includes(reply.code)) {
      throw new SmtpError(`${this.where} refused ${what} (${reply.code}).`, reply.code >= 500 && reply.code < 600);
    }
    return reply;
  }

  /** Swap the plain socket for its TLS upgrade (STARTTLS). */
  upgrade(secured: Socket): void {
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('close');
    this.socket.removeAllListeners('error');
    this.socket = secured;
    this.buffer = '';
    this.listen(secured);
  }

  close(): void {
    this.socket.destroy();
  }
  get raw(): Socket {
    return this.socket;
  }
}

function open(options: SmtpOptions, lookup: never, timeoutMs: number, where: string): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = options.secure
      ? tlsConnect({ host: options.host, port: options.port, servername: options.host, lookup, ...options.tls })
      : netConnect({ host: options.host, port: options.port, lookup });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new SmtpError(`${where} did not accept a connection within ${timeoutMs / 1000} s.`));
    }, timeoutMs);
    socket.once(options.secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(error instanceof SmtpError ? error : new SmtpError(`${where}: ${error.code ?? 'the connection failed'}.`));
    });
  });
}

function startTls(plain: Socket, options: SmtpOptions, timeoutMs: number, where: string): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const secured = tlsConnect({ socket: plain, servername: options.host, ...options.tls });
    const timer = setTimeout(() => {
      secured.destroy();
      reject(new SmtpError(`${where} did not finish TLS within ${timeoutMs / 1000} s.`));
    }, timeoutMs);
    secured.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(secured);
    });
    secured.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new SmtpError(`${where}: TLS failed (${error.code ?? 'handshake'}).`));
    });
  });
}

/**
 * Send one message to its recipients. Resolves when the server has accepted
 * it (250 after DATA); rejects with SmtpError otherwise.
 */
export async function sendSmtp(options: SmtpOptions, envelope: { from: string; to: readonly string[] }, message: string): Promise<void> {
  const where = `${options.host}:${options.port}`;
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!envelope.to.length) throw new SmtpError('A message needs a recipient.', true);
  const literal = refusedLiteral(options.host, options.policy);
  if (literal) throw new SmtpError(`${where}: the address ${literal} is one this connection may not reach.`, true);
  const lookup = checkedLookup(
    options.policy,
    (name, addresses) => new SmtpError(`${name} resolves only to addresses this connection may not reach (${addresses.join(', ')}).`, true),
  ) as never;
  const socket = await open(options, lookup, timeoutMs, where);
  const session = new Session(socket, where, timeoutMs);
  try {
    const greeting = await session.reply();
    if (greeting.code !== 220) throw new SmtpError(`${where} did not greet (${greeting.code}).`, greeting.code >= 500);
    const helo = `EHLO ${options.helo ?? 'mistri.localhost'}\r\n`;
    let hello = await session.ask(helo, [250], 'EHLO');
    const offers = (reply: Reply, word: string) => reply.lines.some((line) => line.toUpperCase().split(' ')[0] === word);
    if (!options.secure) {
      if (offers(hello, 'STARTTLS')) {
        await session.ask('STARTTLS\r\n', [220], 'STARTTLS');
        session.upgrade(await startTls(session.raw, options, timeoutMs, where));
        hello = await session.ask(helo, [250], 'EHLO');
      } else if (!options.insecure) {
        throw new SmtpError(
          `${where} does not offer STARTTLS, and a message is not sent in the clear. Use smtps://, or set "insecure": true for a relay on a trusted network.`,
          true,
        );
      }
    }
    if (options.username !== undefined) {
      if (!offers(hello, 'AUTH')) throw new SmtpError(`${where} offers no sign-in (AUTH), and the connection has a credential.`, true);
      const token = Buffer.from(`\u0000${options.username}\u0000${options.password ?? ''}`, 'utf8').toString('base64');
      await session.ask(`AUTH PLAIN ${token}\r\n`, [235], 'the credential');
    }
    await session.ask(`MAIL FROM:${envelopeAddress(envelope.from)}\r\n`, [250], 'the sender');
    for (const to of envelope.to) await session.ask(`RCPT TO:${envelopeAddress(to)}\r\n`, [250, 251], 'a recipient');
    await session.ask('DATA\r\n', [354], 'DATA');
    await session.ask(dataOf(message), [250], 'the message');
    await session.ask('QUIT\r\n', [221], 'QUIT').catch(() => {
      /* Accepted already; a rude goodbye changes nothing. */
    });
  } finally {
    session.close();
  }
}
