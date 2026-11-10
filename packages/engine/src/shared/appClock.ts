/**
 * How far App logic's clock stands from the real one, in milliseconds: 0 unless a development or test process was
 * started "as of" another moment (`mistri dev --as-of`, server/http/clock.ts configureAsOf). Kept here, with no
 * imports, so the chrome an App is served (appPayload.ts servedUi) can carry it to the browser without reaching for
 * server code; only the server's startup sets it, and in a browser it stays 0.
 */
let offset = 0;

/** The as-of offset in milliseconds; 0 is the real clock. */
export const appClockOffset = (): number => offset;

/** Set the offset: startup's configureAsOf, and tests. */
export function setAppClockOffset(ms: number): void {
  offset = Number.isFinite(ms) ? ms : 0;
}

/** Now as App logic reads it on the server: the default of a shared rule (a dashboard's trend window) the server applies. */
export const appClockNow = (): Date => new Date(Date.now() + offset);
