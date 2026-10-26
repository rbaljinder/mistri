/**
 * What one write costs in database round trips, measured through a latency
 * relay (e2e/support/latencyProxy.ts) against a real PostgreSQL: the App served
 * over its own HTTP routes, one request sent, and the flights its transaction
 * took counted off the wire. A flight is what a client sent together before
 * hearing the server ready again, so it is the round trip, however many
 * statements rode in it.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { migratePostgresCommandJournal } from '../../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { provisionPostgresSchemaEpoch } from '../../packages/engine/src/adapters/postgresSchemaEpoch.js';
import { provisionStores } from '../../packages/mistri/src/server/maintenance.js';
import { loadApp, type AppHost } from '../../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../../packages/mistri/src/server/auth/auth.js';
import { loadBusinessCommands } from '../../packages/mistri/src/server/commands/businessCommandLoader.js';
import { hostAppCommands } from '../../packages/mistri/src/server/cli/commandHost.js';
import { loadHttpAppPolicy, type HttpAppPolicy } from '../../packages/mistri/src/server/policy/appPolicyHttp.js';
import { Registry } from '../../packages/engine/src/server/connections.js';
import { startLatencyProxy, type LatencyProxy, type Statement } from '../../e2e/support/latencyProxy.js';
import { createApp } from './createApp.js';

/** What the adapter reports of a transaction under MISTRI_AHEAD_REPORT (postgres.ts reportWriteAhead). */
export interface Ahead {
  committed: boolean;
  sent: number;
  taken: number;
  answered: number;
  missed: number;
  left: string[];
  redone: number;
}

/** The write-ahead reports `work` writes, caught as postgres-write-ahead.test.ts catches them. */
async function reported<T>(work: () => Promise<T>): Promise<{ out: T; reports: Ahead[] }> {
  const reports: Ahead[] = [];
  const write = process.stderr.write.bind(process.stderr);
  const previous = process.env.MISTRI_AHEAD_REPORT;
  process.env.MISTRI_AHEAD_REPORT = '1';
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = String(chunk);
    if (text.startsWith('mistri-ahead ')) {
      reports.push(JSON.parse(text.slice('mistri-ahead '.length)) as Ahead);
      return true;
    }
    return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    return { out: await work(), reports };
  } finally {
    process.stderr.write = write;
    if (previous === undefined) delete process.env.MISTRI_AHEAD_REPORT;
    else process.env.MISTRI_AHEAD_REPORT = previous;
  }
}

export interface Measured {
  status: number;
  body: any;
  /** Round trips the request's own transaction took: the connection that sent BEGIN in its window. */
  flights: number;
  /** That transaction's statements, in order, each with the flight it left in. */
  statements: Statement[];
  ahead: Ahead[];
}

/**
 * The request's own transaction: of the connections that sent a BEGIN inside
 * its window, the busiest. The background pollers never begin one. A request
 * that read outside a transaction (a prepare under a row policy) has none, and
 * its own connection is the busiest one in the window.
 */
export function ownTransaction(sent: Statement[], from: number, to: number): Statement[] {
  const inside = sent.filter((statement) => statement.at >= from && statement.at <= to);
  const begun = new Map<number, number>();
  for (const statement of inside)
    if (/^\s*BEGIN/i.test(statement.text))
      begun.set(statement.connection, inside.filter((s) => s.connection === statement.connection).length);
  const busy = new Map<number, number>();
  for (const statement of inside) busy.set(statement.connection, (busy.get(statement.connection) ?? 0) + 1);
  const connection = [...(begun.size ? begun : busy).entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return connection === undefined ? [] : inside.filter((statement) => statement.connection === connection);
}

export const flightsOf = (statements: Statement[]): number => new Set(statements.map((statement) => statement.flight)).size;

/** The statements grouped by flight, each cut to its first `width` characters. */
export function byFlight(statements: Statement[], width = 110): string {
  const flights = new Map<number, string[]>();
  for (const statement of statements) {
    const list = flights.get(statement.flight) ?? [];
    list.push(statement.text.replace(/\s+/g, ' ').slice(0, width));
    flights.set(statement.flight, list);
  }
  return [...flights.values()].map((list, index) => `  flight ${index + 1}\n${list.map((text) => `    ${text}`).join('\n')}`).join('\n');
}

export interface Rig {
  base: string;
  /** A POST as the signed-in person, measured. */
  post(path: string, body: unknown): Promise<Measured>;
  /** The same POST, unmeasured, to warm the caches the budget assumes. */
  warm(path: string, body: unknown): Promise<{ status: number; body: any }>;
  close(): Promise<void>;
}

export interface RigOptions {
  /** The App's directory, and the id of the connection its sources name. */
  appDir: string;
  connection: string;
  /** The database, not the relay: stores are provisioned straight. */
  url: string;
  /** The signed-in person; omitted for an App with no auth. */
  identity?: Identity;
  /** Whether the App has a commands module (beside its manifest). */
  commands?: boolean;
  /** The App's row policy module, for an App whose auth says `rows: 'policy'`: its commands then run under it. */
  policy?: string;
  /** Stores the App's commands write to beside its tables (maintenance.ts provisionStores `only`). */
  stores?: string[];
  latency?: number;
}

/** An App served over HTTP with its database behind the latency relay. */
export async function startRig(options: RigOptions): Promise<Rig> {
  const proxy: LatencyProxy = await startLatencyProxy(options.url, options.latency ?? 10);
  if (options.commands) await migratePostgresCommandJournal(options.url);
  if (options.stores?.length) await provisionStores({ postgres: options.url }, { only: options.stores });
  await provisionPostgresSchemaEpoch(options.url);
  const registry = new Registry();
  registry.add({ id: options.connection, name: options.connection, url: proxy.route(options.url), writable: true, source: 'config' });
  const appDir = resolve(options.appDir);
  const loaded = await loadApp(appDir);
  const registryOfCommands = options.commands
    ? (loaded.commands?.registry ?? (await loadBusinessCommands(resolve(appDir, 'commands.ts'))))
    : undefined;
  /* Hosted as `mistri serve` hosts them (commandHost.ts): the event store, effects and attestation an App's commands stand on. */
  const hosted = registryOfCommands
    ? await hostAppCommands({
        app: loaded.app,
        commands: registryOfCommands,
        registry,
        owner: options.connection,
        ...(options.policy ? { policy: () => undefined } : {}),
        environment: process.env,
        locate: (id) => registry.configOf(id)?.url,
        current: () => loaded.app,
      })
    : undefined;
  const host: AppHost = {
    app: loaded,
    pages: loaded.pages,
    ...(options.identity
      ? {
          auth: {
            spec: loaded.app.auth!,
            store: '',
            close() {},
            handler: async () => {},
            session: async () => options.identity!,
          },
        }
      : {}),
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const policy: HttpAppPolicy | undefined = options.policy
    ? await loadHttpAppPolicy({
        app: loaded.app,
        registry,
        file: resolve(options.policy),
        verifySession: async () => options.identity ?? null,
        ...(registryOfCommands ? { commands: registryOfCommands } : {}),
        ...(hosted?.commandHosting?.events ? { events: hosted.commandHosting.events } : {}),
      })
    : undefined;
  const server = createApp({
    registry,
    bound,
    apps: [host],
    ...(policy
      ? { policy }
      : {
          pages: loaded.pages,
          ...(hosted?.commandHosting ? { commands: hosted.commandHosting } : {}),
        }),
  });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const base = `http://${bound.host}:${address.port}`;
  const send = async (path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: base,
        ...(options.identity ? { 'x-mistri-account': options.identity.id } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, body: await response.json().catch(() => undefined) };
  };
  return {
    base,
    warm: send,
    async post(path, body) {
      /* Let the relay's reads of the previous request finish arriving, so the window holds only this one's. */
      await new Promise((done) => setTimeout(done, 200));
      const from = Date.now();
      const { out, reports } = await reported(() => send(path, body));
      const to = Date.now();
      const statements = ownTransaction(proxy.statements(from), from, to);
      return { ...out, flights: flightsOf(statements), statements, ahead: reports };
    },
    async close() {
      const closed = new Promise<void>((done) => server.close(() => done()));
      server.closeAllConnections();
      await closed;
      await policy?.retire();
      await registry.closeAll();
      await proxy.close();
    },
  };
}
