/**
 * The running chain's time zone, as any server code below a command or a loader reads it: `currentZone()` from
 * `@mistriwork/mistri/commands`. A handler and a loader were told it (`ctx.timezone`), and the helpers they call, a
 * lookup and a tenant's row policy were not, so each read the App's one zone and counted another chain's day. It is
 * the zone `ctx.timezone` says — the tenant's own where `ui.timezone` names a column of it, else the App's, else UTC —
 * held for the run in an AsyncLocalStorage the platform enters where it starts each one (the executor's lookup and
 * transaction, a loader's load, a tenant request's row policy), so nothing an author writes has to pass it down.
 *
 * Outside any run (a module's top level, a test calling a helper by hand) it is UTC: the server's own zone is where
 * it happens to run, which is nobody's calendar.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import type { CommandJournal } from '../../adapters/commands/commandJournal.js';

export { zoneDay } from '../app/appStamps.js';

/* `zone` is what currentZone() says; `own` is set only where the chain has a zone of its own, apart from the App's (a
   tenant's, from `ui.timezone: { column }`): a channel message that names none is held through that zone's night. */
const running = new AsyncLocalStorage<{ readonly zone?: string; readonly own?: string }>();

/** The zone of the command, loader or request this code runs under: an IANA name, `UTC` outside any. */
export function currentZone(): string {
  return running.getStore()?.zone ?? 'UTC';
}

/** The running chain's own zone, where it has one apart from the App's: what a channel message that names none takes. */
export const chainZone = (): string | undefined => running.getStore()?.own;

/** `run` under `zone` (absent: the App names none, and it reads as UTC); `own` where it is the chain's own. */
export function inZone<T>(zone: string | undefined, run: () => T, own?: string): T {
  return running.run(Object.freeze({ ...(zone === undefined ? {} : { zone }), ...(own === undefined ? {} : { own }) }), run);
}

/** `call`, called under `zone`: for a call site that hands its arguments on unchanged. */
export const zoned =
  <A extends unknown[], R>(zone: string | undefined, call: (...args: A) => R) =>
  (...args: A): R =>
    inZone(zone, () => call(...args));

/** A command's transaction, opened under its zone (`authorized.timezone`): the handler and all it calls read it, and a
    tenant's own zone (`authorized.ownZone`) holds its channel messages. */
export const zonedTransaction =
  (authorized: {
    readonly timezone?: string;
    readonly ownZone?: string;
    readonly commandTransaction?: <T>(run: (tx: WriteTransaction, journal: CommandJournal) => Promise<T>) => Promise<T>;
  }) =>
  <T>(run: (tx: WriteTransaction, journal: CommandJournal) => Promise<T>): Promise<T> =>
    inZone(authorized.timezone, () => authorized.commandTransaction!(run), authorized.ownZone);
