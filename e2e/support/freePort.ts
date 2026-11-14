import { createServer } from 'node:net';

/**
 * Runs `launch` with a loopback port nobody is listening on, and runs it again (up to three
 * times) when the child it started lost that port.
 *
 * A server that is told its port on the command line cannot keep the reservation: the port is
 * freed before the child binds it, and in the parallel lane another worker's own reservation can
 * take it in that gap. The child then exits with "port N is already in use" or EADDRINUSE. That
 * loss is the only failure retried, and it is read off the error's message, so `launch` must
 * reject with the child's output in it. A `launch` that provisions state per attempt, or writes
 * the port into it, does that inside the callback so a retry starts clean.
 */
export async function withFreePort<T>(launch: (port: number) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => {
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', resolve);
    });
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
    try {
      return await launch(port);
    } catch (error) {
      if (attempt >= 3 || !/EADDRINUSE|port .*already in use/.test(String((error as Error)?.message ?? error))) throw error;
    }
  }
}
