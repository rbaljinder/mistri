/**
 * How long an App, page or component module may take to load in its worker before the load is given up. Ten seconds
 * is plenty for a module that answers, and was too little for a first compile on a machine busy with a test run: the
 * one slow load stopped the host, and every request after it failed (a field report). `MISTRI_MODULE_LOAD_TIMEOUT`
 * names the seconds; a value that cannot be one is refused, not clamped, as the other timing settings are.
 */
import { envName, productEnv } from '@mistriwork/engine/server/product.js';

const DEFAULT_SECONDS = 10;
const LEAST_SECONDS = 1;
const MOST_SECONDS = 600;

/** The load timeout in milliseconds, or an Error saying what the environment named instead. */
export function moduleLoadTimeout(env: NodeJS.ProcessEnv = process.env): { ms: number; seconds: number } {
  const given = productEnv('MODULE_LOAD_TIMEOUT', env);
  if (given === undefined || given.trim() === '') return { ms: DEFAULT_SECONDS * 1000, seconds: DEFAULT_SECONDS };
  const seconds = /^\d+(\.\d+)?$/.test(given.trim()) ? Number(given) : Number.NaN;
  if (!(seconds >= LEAST_SECONDS && seconds <= MOST_SECONDS))
    throw new Error(`${envName('MODULE_LOAD_TIMEOUT')} takes seconds from ${LEAST_SECONDS} to ${MOST_SECONDS}; "${given}" is not one.`);
  return { ms: Math.round(seconds * 1000), seconds };
}

/** The sentence for a module that did not load in time, with the setting that gives it longer. */
export const moduleLoadTimedOut = (what: string, seconds: number): string =>
  `the ${what} did not finish loading within ${seconds}s (${envName('MODULE_LOAD_TIMEOUT')} gives a slow machine longer)`;
