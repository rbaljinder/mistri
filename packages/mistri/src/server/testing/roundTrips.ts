/**
 * `roundTrips(response)`: the database round trips the request behind a response made, read from its `Server-Timing`
 * header, so an App's own tests can hold a budget: `expect(roundTrips(res)).toBeLessThanOrEqual(3)`.
 *
 * A round trip is a flight, one message sent to the database and awaited; a pipelined batch counts once. The header
 * says it per database (`db-app;dur=12;desc="flights=2 max=1"`, and `db-auth` for the sign-in store), and this is
 * their sum. A test host sends the header (testing/host.ts); a server started some other way needs
 * `MISTRI_SERVER_TIMING=1`, with `MISTRI_SERVER_TIMING_TOKEN` set so the process entry stays out of its responses.
 *
 * @preview
 */
export function roundTrips(response: { headers: { get(name: string): string | null } } | string): number {
  const header = typeof response === 'string' ? response : response.headers.get('server-timing');
  if (!header)
    throw new Error(
      'roundTrips needs the Server-Timing header, and this response has none. A test host (startTestApp) sends it; ' +
        'a server started some other way needs MISTRI_SERVER_TIMING=1 (with MISTRI_SERVER_TIMING_TOKEN set).',
    );
  let flights = 0;
  for (const entry of header.split(/,(?=\s*[a-z])/i)) {
    if (!/^\s*db-[\w-]+\s*(;|$)/.test(entry)) continue;
    flights += Number(/flights=(\d+)/.exec(entry)?.[1] ?? 0);
  }
  return flights;
}
