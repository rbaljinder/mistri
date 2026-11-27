/**
 * Programmable TCP fault-injection proxy between Mistri and PostgreSQL.
 *
 * Extends the delay-proxy concept (`scripts/delay-proxy.mjs`) with Jepsen
 * nemesis primitives:
 *  - symmetric/asymmetric latency + jitter
 *  - network partition (blackhole or refuse connections)
 *  - immediate TCP RST of active sockets
 *  - PostgreSQL v3 wire-protocol `COMMIT` interception: forwards `COMMIT` to
 *    PostgreSQL, waits for PostgreSQL to emit the reply bytes (`CommandComplete`),
 *    and destroys the client socket *before* those bytes reach Mistri —
 *    deterministically exercising `TransactionOutcomeUnknown` and receipt recovery.
 */
import { connect, createServer, type Server, type Socket } from 'node:net';

export interface FaultProxyStats {
  readonly totalConnections: number;
  readonly activeConnections: number;
  readonly resets: number;
  readonly commitCuts: number;
  readonly partitionDrops: number;
}

interface Link {
  readonly client: Socket;
  readonly upstream: Socket;
  cutOnNextUpstreamReply: boolean;
}

/**
 * Inspect a PostgreSQL v3 frontend TCP chunk for a `COMMIT` command.
 *
 * Covers both Simple Query (`'Q'`, 0x51) and Extended Parse (`'P'`, 0x50)
 * messages; scans conservatively so coalesced frames (e.g. pipelined batches)
 * still trigger reliably.
 */
export function containsPostgresCommit(chunk: Buffer): boolean {
  // Fast ASCII scan for COMMIT inside a Q (0x51) or P (0x50) message payload.
  const text = chunk.toString('latin1');
  if (!/\bCOMMIT\b/i.test(text)) return false;
  // Confirm a valid Postgres frontend Simple Query ('Q') or Parse ('P') header precedes COMMIT,
  // or accept a standalone COMMIT query frame when framed cleanly.
  for (let i = 0; i + 5 <= chunk.length; i++) {
    const tag = chunk[i];
    if (tag !== 0x51 && tag !== 0x50) continue;
    const len = chunk.readInt32BE(i + 1);
    if (len < 5 || len > 1024 * 1024) continue;
    const end = Math.min(chunk.length, i + 1 + len);
    const body = chunk.subarray(i + 5, end).toString('latin1');
    if (/\bCOMMIT\b/i.test(body)) return true;
  }
  return false;
}

export class FaultProxy {
  private targetHost: string;
  private targetPort: number;
  private server: Server | undefined;
  private listenPort = 0;
  private readonly links = new Set<Link>();

  private latencyMs = 0;
  private jitterMs = 0;
  private partitioned = false;
  private armedCommitCuts = 0;

  private totalConnections = 0;
  private resets = 0;
  private commitCuts = 0;
  private partitionDrops = 0;

  constructor(targetHost: string, targetPort: number) {
    this.targetHost = targetHost;
    this.targetPort = targetPort;
  }

  get port(): number {
    return this.listenPort;
  }

  get host(): string {
    return '127.0.0.1';
  }

  stats(): FaultProxyStats {
    return {
      totalConnections: this.totalConnections,
      activeConnections: this.links.size,
      resets: this.resets,
      commitCuts: this.commitCuts,
      partitionDrops: this.partitionDrops,
    };
  }

  /** Rewrite a PostgreSQL connection URL to route through this proxy. */
  proxiedUrl(originalUrl: string): string {
    const parsed = new URL(originalUrl);
    parsed.hostname = this.host;
    parsed.port = String(this.port);
    return parsed.href;
  }

  /** Switch the upstream target (simulating DNS/VIP failover) and optionally reset existing sockets. */
  setUpstream(targetHost: string, targetPort: number, resetExisting = true): void {
    this.targetHost = targetHost;
    this.targetPort = targetPort;
    if (resetExisting) this.resetConnections();
  }

  setLatency(ms: number, jitterMs = 0): void {
    this.latencyMs = Math.max(0, ms);
    this.jitterMs = Math.max(0, jitterMs);
  }

  /**
   * Toggle a network partition. While partitioned, new connections are rejected
   * and existing links are severed immediately.
   */
  setPartition(on: boolean): void {
    this.partitioned = on;
    if (on) this.resetConnections();
  }

  /** Arm `count` deterministic post-COMMIT reply cuts (each fires once on the next COMMIT). */
  armCommitCut(count = 1): void {
    this.armedCommitCuts += Math.max(0, count);
  }

  /** Restore clean, zero-latency forwarding and disarm pending faults. */
  heal(): void {
    this.partitioned = false;
    this.latencyMs = 0;
    this.jitterMs = 0;
    this.armedCommitCuts = 0;
  }

  /** Send TCP RST to every currently active proxied connection. */
  resetConnections(): number {
    let count = 0;
    for (const link of [...this.links]) {
      count++;
      this.resets++;
      link.client.destroy();
      link.upstream.destroy();
      this.links.delete(link);
    }
    return count;
  }

  async start(port = 0): Promise<number> {
    if (this.server) return this.listenPort;
    const server = createServer((client) => this.handleClient(client));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('FaultProxy failed to bind TCP port');
    this.listenPort = addr.port;
    return this.listenPort;
  }

  async close(): Promise<void> {
    this.heal();
    for (const link of [...this.links]) {
      link.client.destroy();
      link.upstream.destroy();
      this.links.delete(link);
    }
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private sampleDelay(): number {
    if (this.latencyMs <= 0 && this.jitterMs <= 0) return 0;
    const delta = this.jitterMs > 0 ? Math.floor((Math.random() * 2 - 1) * this.jitterMs) : 0;
    return Math.max(0, this.latencyMs + delta);
  }

  private handleClient(client: Socket): void {
    this.totalConnections++;
    client.setNoDelay(true);
    if (this.partitioned) {
      this.partitionDrops++;
      client.destroy();
      return;
    }

    const upstream = connect({ host: this.targetHost, port: this.targetPort });
    upstream.setNoDelay(true);

    const link: Link = { client, upstream, cutOnNextUpstreamReply: false };
    this.links.add(link);

    const cleanup = () => {
      this.links.delete(link);
      if (!client.destroyed) client.destroy();
      if (!upstream.destroyed) upstream.destroy();
    };

    // Preserve strict per-direction TCP FIFO ordering even when latency transitions from > 0 back to 0.
    let c2sQueue = Promise.resolve();
    let s2cQueue = Promise.resolve();
    let c2sPending = 0;
    let s2cPending = 0;

    client.on('data', (chunk) => {
      if (this.partitioned) {
        this.partitionDrops++;
        cleanup();
        return;
      }
      if (this.armedCommitCuts > 0 && containsPostgresCommit(chunk)) {
        this.armedCommitCuts--;
        link.cutOnNextUpstreamReply = true;
      }
      const delay = this.sampleDelay();
      if (delay === 0 && c2sPending === 0) {
        if (!upstream.destroyed) upstream.write(chunk);
      } else {
        c2sPending++;
        c2sQueue = c2sQueue.then(
          () =>
            new Promise<void>((resolve) => {
              const send = () => {
                c2sPending--;
                if (!upstream.destroyed && !this.partitioned) upstream.write(chunk);
                resolve();
              };
              if (delay === 0) send();
              else setTimeout(send, delay);
            }),
        );
      }
    });

    upstream.on('data', (chunk) => {
      if (this.partitioned) {
        this.partitionDrops++;
        cleanup();
        return;
      }
      // Postgres replied after we forwarded COMMIT — cut the client socket before delivering the ack!
      if (link.cutOnNextUpstreamReply) {
        link.cutOnNextUpstreamReply = false;
        this.commitCuts++;
        cleanup();
        return;
      }
      const delay = this.sampleDelay();
      if (delay === 0 && s2cPending === 0) {
        if (!client.destroyed) client.write(chunk);
      } else {
        s2cPending++;
        s2cQueue = s2cQueue.then(
          () =>
            new Promise<void>((resolve) => {
              const send = () => {
                s2cPending--;
                if (!client.destroyed && !this.partitioned) client.write(chunk);
                resolve();
              };
              if (delay === 0) send();
              else setTimeout(send, delay);
            }),
        );
      }
    });

    client.on('end', () => {
      c2sQueue.finally(() => {
        if (!upstream.destroyed) upstream.end();
      });
    });
    upstream.on('end', () => {
      s2cQueue.finally(() => {
        if (!client.destroyed) client.end();
      });
    });
    client.on('error', cleanup);
    upstream.on('error', cleanup);
    client.on('close', () => {
      this.links.delete(link);
      if (!upstream.destroyed) upstream.destroy();
    });
    upstream.on('close', () => {
      this.links.delete(link);
      if (!client.destroyed) client.destroy();
    });
  }
}
