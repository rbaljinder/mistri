/**
 * A TCP relay that holds every chunk for a fixed delay each way: a database as
 * far away as a remote one, for a spec that counts what a page's round trips
 * cost. A field report came from a PostgreSQL about 25 ms away, where
 * every statement a request ran one after another, and every wave of requests
 * the page sent after a write, was paid for in those milliseconds.
 *
 * It reads the PostgreSQL protocol as it passes, enough to say what crossed:
 * each statement a connection sent, and each wait inside an open transaction
 * that was the server's own client thinking rather than the wire (the time
 * between the server saying it was ready, in a transaction, and the next
 * statement arriving, less the two trips). A transaction held open across
 * anything but its own statements is what left a tenant App's backends "idle in
 * transaction" until the cluster ran out of connections.
 *
 * And it numbers each connection's flights: the statements a client sent
 * together before hearing the server ready again. A pipelined writer's
 * statements leave in one flight; awaited one after another, each is its own,
 * and each flight costs a round trip however short its statements are.
 */
import { createConnection, createServer, type Socket } from 'node:net';
import { once } from 'node:events';

export interface Statement {
  readonly connection: number;
  readonly at: number;
  readonly text: string;
  /** The connection's flight it left in: a new one once the server had said it was ready since the client last sent. */
  readonly flight: number;
  /** The values it was bound to, as text, when it had any. */
  params?: string[];
}
export interface HeldOpen {
  readonly connection: number;
  /** When the server said it was ready inside the transaction. */
  readonly at: number;
  /** How long the client took to send its next message, the two trips taken out. */
  readonly waited: number;
  /** The statement the server had just answered, and the one that came after the wait. */
  readonly after: string;
  readonly next: string;
}

export interface LatencyProxy {
  /** `url` with its host and port replaced by the relay's. */
  route(url: string): string;
  /** Every statement sent from `since` on. */
  statements(since?: number): Statement[];
  /** Every wait inside an open transaction longer than `over` ms, from `since` on. */
  heldOpen(since?: number, over?: number): HeldOpen[];
  close(): Promise<void>;
}

/** Relay to `target`'s host and port, holding each chunk `delay` ms in each direction, in order. */
export async function startLatencyProxy(target: string, delay: number): Promise<LatencyProxy> {
  const { hostname, port } = new URL(target);
  const sockets = new Set<Socket>();
  const statements: Statement[] = [];
  const held: HeldOpen[] = [];
  let connections = 0;

  const server = createServer((client) => {
    const id = ++connections;
    const upstream = createConnection({ host: hostname, port: Number(port || 5432) });
    sockets.add(client).add(upstream);
    client.on('close', () => sockets.delete(client));
    upstream.on('close', () => sockets.delete(upstream));
    let last = '';
    let ready: { at: number; after: string } | undefined;
    let flight = 0;
    let answered = true;
    /* The client's side: an untyped startup (and perhaps an SSL request before it), then typed messages. */
    let untyped = true;
    let fromClient = Buffer.alloc(0);
    const readClient = (chunk: Buffer, at: number) => {
      fromClient = Buffer.concat([fromClient, chunk]);
      for (;;) {
        if (untyped) {
          if (fromClient.length < 8) return;
          const length = fromClient.readInt32BE(0);
          if (fromClient.length < length) return;
          const code = fromClient.readInt32BE(4);
          if (code !== 80877103) untyped = false;
          fromClient = fromClient.subarray(length);
          continue;
        }
        if (fromClient.length < 5) return;
        const type = String.fromCharCode(fromClient[0]);
        const length = fromClient.readInt32BE(1);
        if (fromClient.length < length + 1) return;
        const body = fromClient.subarray(5, length + 1);
        fromClient = fromClient.subarray(length + 1);
        let text: string | undefined;
        if (type === 'Q') text = body.subarray(0, body.indexOf(0)).toString();
        else if (type === 'P') {
          const name = body.indexOf(0);
          text = body.subarray(name + 1, body.indexOf(0, name + 1)).toString();
        }
        if (type !== 'X' && answered) {
          flight += 1;
          answered = false;
        }
        if (ready && type !== 'X') {
          const waited = at - ready.at - 2 * delay;
          held.push({ connection: id, at: ready.at, waited, after: ready.after, next: text ?? `(${type})` });
          ready = undefined;
        }
        if (text !== undefined) {
          statements.push({ connection: id, at, text, flight });
          last = text;
        } else if (type === 'B') {
          // Portal and statement names, the parameter formats, then each value: enough to tell one store's catalog read from another's.
          let at2 = body.indexOf(0) + 1;
          at2 = body.indexOf(0, at2) + 1;
          at2 += 2 + 2 * body.readInt16BE(at2);
          const count = body.readInt16BE(at2);
          at2 += 2;
          const params: string[] = [];
          for (let i = 0; i < count; i++) {
            const size = body.readInt32BE(at2);
            at2 += 4;
            params.push(size < 0 ? 'NULL' : body.subarray(at2, at2 + size).toString());
            if (size > 0) at2 += size;
          }
          const statement = statements.findLast((entry) => entry.connection === id);
          if (statement && !statement.params) statement.params = params;
        }
      }
    };
    let fromServer = Buffer.alloc(0);
    let serverTyped = false;
    const readServer = (chunk: Buffer, at: number) => {
      fromServer = Buffer.concat([fromServer, chunk]);
      for (;;) {
        /* An answer to an SSL request is one byte. */
        if (!serverTyped && fromServer.length && (fromServer[0] === 0x4e || fromServer[0] === 0x53) && fromServer.length < 5) {
          fromServer = fromServer.subarray(1);
          continue;
        }
        if (fromServer.length < 5) return;
        serverTyped = true;
        const type = String.fromCharCode(fromServer[0]);
        const length = fromServer.readInt32BE(1);
        if (fromServer.length < length + 1) return;
        if (type === 'Z') answered = true;
        if (type === 'Z') ready = fromServer[5] === 0x54 ? { at, after: last } : undefined;
        fromServer = fromServer.subarray(length + 1);
      }
    };
    const relay = (from: Socket, to: Socket, read: (chunk: Buffer, at: number) => void) => {
      from.on('data', (chunk: Buffer) => {
        try {
          read(chunk, Date.now());
        } catch {
          /* The trace is a reading of the wire, never a condition of relaying it. */
        }
        setTimeout(() => {
          if (!to.destroyed) to.write(chunk);
        }, delay);
      });
      from.on('end', () => setTimeout(() => to.end(), delay));
      from.on('error', () => to.destroy());
      from.on('close', () => setTimeout(() => to.destroy(), delay));
    };
    relay(client, upstream, readClient);
    relay(upstream, client, readServer);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port: local } = server.address() as { port: number };
  return {
    route(url: string) {
      const routed = new URL(url);
      routed.hostname = '127.0.0.1';
      routed.port = String(local);
      return routed.href;
    },
    statements: (since = 0) => statements.filter((statement) => statement.at >= since),
    heldOpen: (since = 0, over = 0) => held.filter((wait) => wait.at >= since && wait.waited > over),
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
