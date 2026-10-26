/**
 * A reply held in memory: what a route sends when it answers a request made
 * inside another (recordCompose.ts). The route is the same code an HTTP
 * request reaches — the same grants, row scope and hidden columns — and
 * writes through `send` as ever; only the bytes stop here instead of on a
 * socket. Just enough of ServerResponse for the reply helpers (reply.ts) and
 * the routes that set a header on the way.
 */
import { EventEmitter } from 'node:events';
import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';

export class CapturedReply extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  /** No request: nothing is compressed, and the whole reply is one JSON body. */
  readonly req = undefined;
  private readonly headers = new Map<string, number | string | readonly string[]>();
  private chunks: Buffer[] = [];

  setHeader(name: string, value: number | string | readonly string[]): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }
  getHeader(name: string) {
    return this.headers.get(name.toLowerCase());
  }
  hasHeader(name: string) {
    return this.headers.has(name.toLowerCase());
  }
  removeHeader(name: string) {
    this.headers.delete(name.toLowerCase());
  }
  writeHead(status: number, headers?: OutgoingHttpHeaders): this {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers ?? {})) if (value !== undefined) this.setHeader(name, value as string);
    this.headersSent = true;
    return this;
  }
  write(chunk: Buffer | string): boolean {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  }
  end(chunk?: Buffer | string): this {
    if (chunk !== undefined) this.write(chunk);
    this.headersSent = true;
    this.writableEnded = true;
    this.emit('finish');
    return this;
  }
  destroy(): this {
    this.destroyed = true;
    this.emit('close');
    return this;
  }

  /** As the route answered: its status and its JSON, or undefined when it sent nothing. */
  answer(): { status: number; body: unknown } | undefined {
    if (!this.writableEnded) return undefined;
    const text = Buffer.concat(this.chunks).toString('utf8');
    try {
      return { status: this.statusCode, body: text ? JSON.parse(text) : null };
    } catch {
      return undefined;
    }
  }

  /** Typed as the response the routes take. */
  asResponse(): ServerResponse {
    return this as unknown as ServerResponse;
  }
}
