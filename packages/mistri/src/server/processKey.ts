/**
 * Keys this server makes for itself when the deployment names none: the public door's ticket key (forms/publicTicket.ts)
 * and the seal for what it writes and later reads back (forms/formKey.ts).
 *
 * One process makes them at random at start, so a restart forgets them, which those files say is the cost of not naming
 * MISTRI_FORM_KEY. A start with `--workers` (cli/workers.ts) is several processes behind one port, and a ticket signed by
 * one worker is checked by whichever the next request reaches: the primary makes one random secret for the start and
 * hands it to each worker in its environment, and every key here is derived from it, so the workers agree with each
 * other as one process agrees with itself. Read once and taken out of the environment, where App code could see it.
 */
import { hkdfSync, randomBytes } from 'node:crypto';

/** The variable the primary hands its secret down in; never set by a person. */
const WORKER_SECRET_ENV = 'MISTRI_WORKER_SECRET';

const handed = process.env[WORKER_SECRET_ENV];
delete process.env[WORKER_SECRET_ENV];
const secret = handed && handed.length >= 32 ? Buffer.from(handed, 'utf8') : undefined;

const made = new Map<string, Buffer>();

/** This start's own 32-byte key for `purpose`: the same in every worker of one `--workers` start, new at each start. */
export function processKey(purpose: string): Buffer {
  let key = made.get(purpose);
  if (!key) {
    key = secret ? Buffer.from(hkdfSync('sha256', secret, 'mistri.process-key', purpose, 32)) : randomBytes(32);
    made.set(purpose, key);
  }
  return key;
}
