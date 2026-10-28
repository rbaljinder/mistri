/**
 * The cross-process half of commandEventSignal.ts: a command that writes
 * facts to PostgreSQL also sends `NOTIFY` on one channel, and a `--jobs` host
 * in any process holds a connection that `LISTEN`s on it, so a fact written
 * by the web server is seen by a jobs host elsewhere at once rather than at
 * the end of its idle wait, which backs off to half a minute.
 *
 * The notification is sent inside the writing transaction, and PostgreSQL
 * delivers it only when that transaction commits — never for one that rolls
 * back — so, unlike the in-process signal, the first look finds the fact. It
 * carries nothing (an empty payload: no receipt, tenant or event) and grants
 * nothing: a woken host reads only what its stores attest, as a polling one
 * does. It is per database, which is the unit a host's stores live in; a
 * wake from another App in the same database costs one idle cycle.
 *
 * Behind a transaction-mode pooler a session never holds a server connection
 * between statements, so `LISTEN` cannot work there; the host keeps polling,
 * unless the connection names a direct `"listen"` URL, which skips the pooler
 * (the writers' `NOTIFY` still goes through it: PostgreSQL delivers it to any
 * listener on the database at commit).
 * A job enqueued or redriven on PostgreSQL sends the same notification, so a
 * host waits for work rather than polling for it (jobHost.ts).
 * A listener that loses its connection reconnects after a pause, and while
 * it is down (`hearing()` false) the host polls again, up to its idle ceiling.
 */

import { pgConnectionOptions } from '@mistriwork/engine/adapters/postgresValues.js';

/** The one channel command facts are announced on. */
export const COMMAND_EVENT_CHANNEL = 'mistri_command_events';

/** The statement an appending transaction runs: delivered at its commit. */
export const NOTIFY_COMMAND_EVENTS = `SELECT pg_notify('${COMMAND_EVENT_CHANNEL}', '')`;

/**
 * Where a jobs host should hold its `LISTEN`: the connection's `"listen"` URL
 * when it names one, else the connection's own URL on a session-mode pooler
 * (or none), else nowhere — a transaction-mode pooler cannot keep a listening
 * session, and the host polls.
 */
export function wakeListenUrl(url: string, pooler: 'session' | 'transaction', listen?: string): string | undefined {
  return listen ?? (pooler === 'session' ? url : undefined);
}

/** How long a lost listener waits before connecting again. */
const RECONNECT_MS = 5_000;

interface ListenClient {
  connect(): Promise<void>;
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: 'notification', listener: (message: { channel: string }) => void): unknown;
  on(event: 'error' | 'end', listener: (error?: Error) => void): unknown;
}
type ListenClientClass = new (options: {
  connectionString: string;
  ssl?: { rejectUnauthorized: true };
  connectionTimeoutMillis: number;
}) => ListenClient;

export interface CommandEventListener {
  /** A LISTEN is in place now: false while a lost connection waits to reconnect, when a fact may go unheard. */
  hearing(): boolean;
  close(): Promise<void>;
}

const loadPg = async (): Promise<unknown> => {
  const specifier = 'pg';
  return import(specifier);
};

/**
 * Listen for command facts on `connectionString`, calling `wake` for each
 * notification. Resolves once the first `LISTEN` is in place, so a fact
 * committed after it is heard; a first connection that fails rejects, and
 * the caller polls instead.
 */
export function listenForCommandEvents(
  connectionString: string,
  wake: () => void,
  load: () => Promise<unknown> = loadPg,
): Promise<CommandEventListener> {
  return listenForWake(connectionString, COMMAND_EVENT_CHANNEL, wake, load);
}

/**
 * The same listener on another of mistri's own channels (live sync's,
 * adapters/live/liveChange.ts). `channel` is a constant of ours, never a
 * caller's text: it is written into the LISTEN statement.
 */
export async function listenForWake(
  connectionString: string,
  channel: string,
  wake: () => void,
  load: () => Promise<unknown> = loadPg,
): Promise<CommandEventListener> {
  if (!/^[a-z_][a-z0-9_]*$/.test(channel)) throw new Error('A wake channel is a plain lower-case name.');
  const module = (await load()) as { Client?: ListenClientClass; default?: { Client?: ListenClientClass } };
  const Client = module.Client ?? module.default?.Client;
  if (!Client) throw new Error('Could not find a Client export in the "pg" package.');
  let closed = false;
  let client: ListenClient | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const again = (): void => {
    if (closed || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      void open().catch(again);
    }, RECONNECT_MS);
    retry.unref?.();
  };
  const open = async (): Promise<void> => {
    const next = new Client({ ...pgConnectionOptions(connectionString), connectionTimeoutMillis: 10_000 });
    let lost = false;
    const reconnect = () => {
      if (lost) return;
      lost = true;
      if (client === next) client = undefined;
      void next.end().catch(() => {});
      if (closed) return;
      /* A fact may have been written while no one listened: look once. */
      wake();
      again();
    };
    next.on('error', reconnect);
    next.on('end', reconnect);
    next.on('notification', (message) => {
      if (message.channel === channel) wake();
    });
    try {
      await next.connect();
      await next.query(`LISTEN ${channel}`);
    } catch (error) {
      lost = true;
      await next.end().catch(() => {});
      throw error;
    }
    if (closed) {
      await next.end().catch(() => {});
      return;
    }
    client = next;
  };

  await open();
  return Object.freeze({
    hearing: () => !closed && client !== undefined,
    async close(): Promise<void> {
      closed = true;
      if (retry) clearTimeout(retry);
      const current = client;
      client = undefined;
      await current?.end().catch(() => {});
    },
  });
}
