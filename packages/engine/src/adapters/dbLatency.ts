/**
 * A remote database's distance, felt on a laptop: `--db-latency <ms>` (or
 * `MISTRI_DEV_DB_LATENCY`) makes every round trip wait that long before it is
 * sent, so an App that asks the database eleven questions in a row feels it in
 * development, where the database is a millisecond away, rather than in
 * production, where it is twenty.
 *
 * A round trip is a flight: on PostgreSQL the message a client writes to its
 * socket, so a pipelined batch leaves in one write and pays once, the way a
 * remote database charges. On SQLite it is the statement call, which has no
 * network to be pipelined on.
 *
 * Development only. Production would pay the wait for nothing, so it is
 * refused there (NODE_ENV=production), and by the serve of a build
 * (`refuseForBuild`): a build is what is deployed.
 */

let ms = 0;

/** The wait before each flight, in milliseconds; 0 is none. */
export const dbLatency = (): number => ms;

/** Set the wait: read once at start by `configureDbLatency`; tests set it directly. */
export function setDbLatency(value: number): void {
  ms = value;
}

/**
 * The wait the flag or the environment asks for, validated and set. The flag wins over the variable. Throws a
 * message fit for the terminal when the value is not a number of milliseconds, or the process is a production one.
 */
export function configureDbLatency(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): number {
  const given = flag ?? env.MISTRI_DEV_DB_LATENCY;
  if (given === undefined || (flag === undefined && given.trim() === '')) return ms;
  const source = flag !== undefined ? '--db-latency' : 'MISTRI_DEV_DB_LATENCY';
  if (!/^\d{1,4}(\.\d+)?$/.test(given.trim()) || Number(given) > 5000)
    throw new Error(`${source} takes the milliseconds each database round trip should wait, like 20 (0 to 5000); it got "${given}".`);
  if (env.NODE_ENV === 'production')
    throw new Error(
      `${source} slows every database round trip on purpose to feel a remote database in development, and NODE_ENV is production.`,
    );
  ms = Number(given);
  return ms;
}

/** A build is what is deployed: the wait is refused with it, and cleared. */
export function refuseForBuild(): void {
  if (ms === 0) return;
  ms = 0;
  throw new Error(
    '--db-latency (or MISTRI_DEV_DB_LATENCY) is for development and is refused when serving a build, which is what is deployed.',
  );
}

/** Wait one round trip, for an engine with no network of its own (SQLite's statement call). Nothing when off. */
export async function roundTrip(): Promise<void> {
  if (ms > 0) await new Promise<void>((done) => setTimeout(done, ms));
}

type Write = (chunk: unknown, ...rest: unknown[]) => boolean;
const delayed = new WeakSet<object>();

/**
 * Hold each message `client` writes to its socket for the wait before it leaves. Timers of one duration fire in
 * the order they were set, so the messages still leave in order; two written in the same tick leave together, which
 * is what a pipeline is. A no-op when the wait is off, for a client without a socket, and for one already held.
 */
export function delayFlights(client: object): void {
  if (ms <= 0 || delayed.has(client)) return;
  const stream = (client as { connection?: { stream?: { write?: Write } } }).connection?.stream;
  if (!stream?.write) return;
  delayed.add(client);
  const write = stream.write.bind(stream) as Write;
  stream.write = (chunk, ...rest) => {
    if (ms <= 0) return write(chunk, ...rest);
    setTimeout(() => {
      try {
        write(chunk, ...rest);
      } catch {
        // The socket went away while the message waited: the client hears it close.
      }
    }, ms);
    return true;
  };
}
