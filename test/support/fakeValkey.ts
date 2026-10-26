/**
 * A Valkey stand-in that speaks just enough RESP for the cache: AUTH,
 * SELECT, PING, GET, SET … PX, DEL, QUIT, and the one EVAL script the cache
 * sends (count within a window). It keeps every command it was sent, so a
 * test can assert what reached the server — and that a password never did
 * anything but AUTH.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { once } from 'node:events';
import { decodeReply } from '../../packages/engine/src/adapters/cache/resp.js';

export interface FakeValkey {
  port: number;
  url: string;
  commands: string[][];
  /** Stop answering and drop every connection; `start` brings it back on the same port. */
  stop(): Promise<void>;
  start(): Promise<void>;
  close(): Promise<void>;
}

const encode = (value: unknown): string => {
  if (value === null || value === undefined) return '$-1\r\n';
  if (typeof value === 'number') return `:${value}\r\n`;
  if (Array.isArray(value)) return `*${value.length}\r\n${value.map(encode).join('')}`;
  const text = String(value);
  return `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
};

export async function startFakeValkey(options: { password?: string; port?: number } = {}): Promise<FakeValkey> {
  const store = new Map<string, { value: string; expires: number }>();
  const commands: string[][] = [];
  const sockets = new Set<Socket>();
  const live = (key: string) => {
    const entry = store.get(key);
    if (entry && entry.expires <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };

  const answer = (args: string[], authed: { ok: boolean }): string => {
    const [name, ...rest] = args;
    const command = name.toUpperCase();
    if (command === 'AUTH') {
      const password = rest.at(-1);
      if (options.password !== undefined && password === options.password) {
        authed.ok = true;
        return '+OK\r\n';
      }
      return '-WRONGPASS invalid username-password pair or user is disabled.\r\n';
    }
    if (options.password !== undefined && !authed.ok) return '-NOAUTH Authentication required.\r\n';
    switch (command) {
      case 'PING':
        return '+PONG\r\n';
      case 'SELECT':
      case 'QUIT':
        return '+OK\r\n';
      case 'GET':
        return encode(live(rest[0])?.value ?? null);
      case 'SET': {
        const px = rest.findIndex((part) => part.toUpperCase() === 'PX');
        store.set(rest[0], { value: rest[1], expires: px >= 0 ? Date.now() + Number(rest[px + 1]) : Infinity });
        return '+OK\r\n';
      }
      case 'DEL':
        return encode(rest.filter((key) => store.delete(key)).length);
      case 'EVAL': {
        const [, , key, ttl] = rest;
        const entry = live(key);
        const next = entry
          ? { value: String(Number(entry.value) + 1), expires: entry.expires }
          : { value: '1', expires: Date.now() + Number(ttl) };
        store.set(key, next);
        return encode([Number(next.value), next.expires - Date.now()]);
      }
      default:
        return `-ERR unknown command '${name}'\r\n`;
    }
  };

  const serve = (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const authed = { ok: false };
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const reply = decodeReply(buffer);
        if (!reply) return;
        buffer = buffer.subarray(reply.end);
        const args = (reply.value as unknown[]).map(String);
        commands.push(args);
        socket.write(answer(args, authed));
      }
    });
  };

  let server: Server = createServer(serve);
  server.listen(options.port ?? 0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;

  const shut = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return {
    port,
    url: `valkey://127.0.0.1:${port}`,
    commands,
    stop: shut,
    async start() {
      server = createServer(serve);
      server.listen(port, '127.0.0.1');
      await once(server, 'listening');
    },
    close: shut,
  };
}
