/**
 * A PostgreSQL connection whose server has stopped answering, noticed by this process instead of by the kernel.
 *
 * TCP keepalive (postgresValues.ts) finds a dead peer on a socket that is quiet. It does nothing for one that still
 * has bytes of its own unacknowledged: the statement just sent to a peer the network dropped without a reset is
 * retransmitted until the operating system gives up, about 16 minutes on Linux, and the command that sent it waits
 * the whole of it (a field report: two such stalls in one seed, which cancelled a deploy). Node cannot set the
 * socket's own limit (TCP_USER_TIMEOUT), so the wait is watched here.
 *
 * What is watched is silence, not a statement's age: with a statement outstanding, nothing read from the server and
 * nothing new written to it for `silenceMs`. A server that is running a statement answers within the statement cap
 * the pool set on it, and a pipelined batch is answered statement by statement, so a live server is never silent
 * past the cap however long the batch; a statement's own time is the server's to cap (statement_timeout), which
 * says what happened to it. Past the silence the socket is destroyed with the error the kernel would have raised
 * much later (ETIMEDOUT): every statement on it fails as a lost connection does, a write among them with its
 * outcome unknown, and the pool dials another.
 */
import type { PgQuery } from './postgresPool.js';

/** What of a node-postgres client this reads: its socket, and whether a statement is waiting on the server. */
interface Watched {
  connection?: {
    stream?: {
      bytesWritten?: number;
      destroyed?: boolean;
      on?(event: 'data' | 'close', listener: () => void): unknown;
      destroy?(error?: Error): unknown;
    };
  };
  _getActiveQuery?(): unknown;
  _activeQuery?: unknown;
}

/**
 * Watch `client` for a server gone silent. Nothing is installed on a client that does not show its socket and its
 * active statement as node-postgres does (a test's fake, another driver): it keeps the kernel's wait, as before.
 * Returns whether the watch was installed.
 */
export function watchSilence(client: PgQuery, silenceMs: number, now: () => number = () => performance.now()): boolean {
  const watched = client as unknown as Watched;
  const stream = watched.connection?.stream;
  const asks = typeof watched._getActiveQuery === 'function' || '_activeQuery' in watched;
  if (!stream || typeof stream.on !== 'function' || typeof stream.destroy !== 'function' || !asks) return false;
  const waiting = () => Boolean(typeof watched._getActiveQuery === 'function' ? watched._getActiveQuery() : watched._activeQuery);
  let heard = now();
  let written = stream.bytesWritten ?? 0;
  stream.on('data', () => {
    heard = now();
  });
  /* Checked a few times within the window, so the connection goes within a quarter of it past the limit. The timer
     never holds the process open, and ends with the socket. */
  const timer = setInterval(
    () => {
      if (stream.destroyed) return clearInterval(timer);
      const sent = stream.bytesWritten ?? 0;
      if (sent !== written || !waiting()) {
        written = sent;
        heard = now();
        return;
      }
      if (now() - heard < silenceMs) return;
      clearInterval(timer);
      stream.destroy!(
        Object.assign(
          new Error(`Connection terminated: the server said nothing for ${Math.round(silenceMs)} ms with a statement waiting on it.`),
          { code: 'ETIMEDOUT' },
        ),
      );
    },
    Math.max(50, Math.min(5_000, Math.floor(silenceMs / 4))),
  );
  timer.unref?.();
  stream.on('close', () => clearInterval(timer));
  return true;
}
