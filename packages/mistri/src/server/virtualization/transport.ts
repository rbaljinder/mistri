/** Bounded HTTP decoding and reply encoding for the virtual-service listener. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { VirtualReply } from './definition.js';

export async function readVirtualBody(req: IncomingMessage, limit: number): Promise<{ body: unknown; rawBody: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error(`Request body exceeds ${limit} bytes.`);
    chunks.push(Buffer.from(chunk));
  }
  if (size === 0) return { body: undefined, rawBody: '' };
  const text = Buffer.concat(chunks).toString('utf8');
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'application/json' || type.endsWith('+json')) {
    try {
      return { body: JSON.parse(text), rawBody: text };
    } catch {
      throw new Error('Request body is not valid JSON.');
    }
  }
  if (type === 'application/x-www-form-urlencoded') {
    const form = new URLSearchParams(text);
    return {
      body: Object.fromEntries(
        [...new Set(form.keys())].map((key) => [key, form.getAll(key).length > 1 ? form.getAll(key) : form.get(key)]),
      ),
      rawBody: text,
    };
  }
  return { body: text, rawBody: text };
}

export function encodeVirtualReply(reply: VirtualReply) {
  const status = reply.status ?? 200;
  if (!Number.isInteger(status) || status < 200 || status > 599) throw new Error('Reply status must be 200–599.');
  if (reply.fault !== undefined && reply.fault !== 'disconnect' && reply.fault !== 'timeout') throw new Error('Unknown transport fault.');
  const delayMs = reply.delayMs ?? 0;
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 300000) throw new Error('Transport delay must be 0–300000 milliseconds.');
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(reply.headers ?? {})) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof value !== 'string' || /[\r\n]/.test(value))
      throw new Error('Invalid reply header.');
    headers[name.toLowerCase()] = value;
  }
  // Node owns framing; a fixture cannot accidentally hang the caller with a
  // stale content-length or ambiguous transfer encoding.
  if ('content-length' in headers || 'transfer-encoding' in headers || 'connection' in headers)
    throw new Error('Reply framing headers are managed by the service.');
  let body = '';
  if (reply.body !== undefined) {
    body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    if (body === undefined) throw new Error('Reply body must be JSON serializable or text.');
    headers['content-type'] ??= typeof reply.body === 'string' ? 'text/plain; charset=utf-8' : 'application/json';
  }
  if ((status === 204 || status === 304) && body) throw new Error('This reply status cannot carry a body.');
  return { status, headers, body, delayMs, fault: reply.fault };
}

export async function sendVirtualReply(res: ServerResponse, reply: ReturnType<typeof encodeVirtualReply>, signal: AbortSignal) {
  if (reply.delayMs) await delay(reply.delayMs, undefined, { signal });
  signal.throwIfAborted();
  if (reply.fault === 'disconnect') {
    res.destroy();
    return;
  }
  if (reply.fault === 'timeout') {
    await new Promise<void>((resolve) => {
      const done = () => {
        res.off('close', done);
        signal.removeEventListener('abort', done);
        resolve();
      };
      res.once('close', done);
      signal.addEventListener('abort', done, { once: true });
    });
    res.destroy();
    return;
  }
  res.writeHead(reply.status, reply.headers);
  res.end(reply.body);
}
