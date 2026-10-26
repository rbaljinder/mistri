/**
 * authority.lock: an App's effective authority, committed beside its
 * manifest so that widening what a role may do is a reviewable diff.
 *
 * The loader reads the lock and reports what the App grants now
 * (appAuthority.ts). Three gates hold the line, and none of them ever
 * writes: the server refuses to start an App whose effective authority is
 * not its lock's; a reload that would change what a running server grants,
 * lock or no lock, closes the App's requests until a restart, serving
 * neither the old authority nor the new; and mistri check refuses a lock
 * that is stale in any line, contributors included. The only writer is
 * `mistri check --write-authority`, which a person runs on purpose.
 * An App without a lock is not checked against one: committing it is what
 * opts an App in.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { authorityDiff, authorityReport, type AppEnvName } from '../../shared/appAuthority.js';
import type { AppOrigins } from '../../shared/appFeatures.js';
import type { AppDef } from '../../shared/appModel.js';

export const AUTHORITY_LOCK = 'authority.lock';

export interface AppAuthority {
  /** What the App and its features grant now, as authority.lock would hold it. */
  report: string;
  /** authority.lock in the App's directory (beside the manifest, unless --app-entry names one elsewhere). */
  lockPath: string;
  /** What the lock held when the App loaded; absent when there is none. */
  lock?: string;
}

/** `home` is the App's directory; a file target's is the manifest's own. */
export async function readAuthority(
  app: AppDef,
  origins: AppOrigins,
  home: string,
  env: readonly AppEnvName[] = [],
): Promise<AppAuthority> {
  const lockPath = join(home, AUTHORITY_LOCK);
  let lock: string | undefined;
  try {
    lock = await readFile(lockPath, 'utf8');
  } catch (err) {
    /* No lock is the opt-out; a lock that cannot be read is a lock nobody checked. */
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${lockPath}: ${(err as Error).message}`);
  }
  return { report: authorityReport(app, origins, env), lockPath, ...(lock === undefined ? {} : { lock }) };
}

const indent = (diff: string[]) => diff.map((line) => `    ${line}`).join('\n');

/**
 * Why the lock refuses this App, or undefined when there is no lock or it
 * agrees. The server compares `facts`; mistri check compares `lines`, so a
 * lock that names stale contributors fails the check but not the start.
 */
export function authorityLockProblem(authority: AppAuthority, compare: 'facts' | 'lines' = 'facts'): string | undefined {
  if (authority.lock === undefined) return undefined;
  const diff = authorityDiff(authority.lock, authority.report, compare);
  if (!diff.length) return undefined;
  const widened = authorityDiff(authority.lock, authority.report, 'facts').length > 0;
  return (
    `${authority.lockPath}: ${
      widened
        ? 'the effective authority differs from the lock'
        : 'the lock names different contributors; the effective authority is the same'
    }. ` + `Review the change, then accept it with mistri check --write-authority.\n${indent(diff)}`
  );
}

/** The loader's gate: an App whose effective authority is not its lock's does not load. */
export function assertAuthorityLock(authority: AppAuthority): void {
  const problem = authorityLockProblem(authority);
  if (problem) throw new Error(problem);
}

/**
 * What every App request answers while a reload's authority change waits for
 * a restart. It names no grant: the difference is the operator's, in the log.
 */
export const AUTHORITY_CHANGED =
  "The application's authority changed. Its requests are unavailable until the server restarts: " +
  'stop the server and restart it to apply the change.';

/**
 * The reload's gate: what a running server grants is what it started with.
 * The change as the operator's message, with the difference, or undefined
 * when the effective authority is the same. A host assembled by hand, with no
 * report, is judged by its App's own.
 */
export function authorityChange(
  running: { app: AppDef; authority?: AppAuthority },
  next: { app: AppDef; authority?: AppAuthority },
): string | undefined {
  const diff = authorityDiff(
    running.authority?.report ?? authorityReport(running.app),
    next.authority?.report ?? authorityReport(next.app),
    'facts',
  );
  return diff.length ? `${AUTHORITY_CHANGED}\n${indent(diff)}` : undefined;
}

/**
 * mistri check's half: with `write`, the lock rewritten from the report when
 * they differ (`wrote` names it); without, the problem a stale lock is,
 * contributors included. A lock is only ever written here, on purpose.
 */
export async function checkAuthorityLock(
  authority: AppAuthority | undefined,
  write: boolean | undefined,
): Promise<{ problem?: string; wrote?: string }> {
  if (!authority) return {};
  if (!write) {
    const problem = authorityLockProblem(authority, 'lines');
    return problem ? { problem } : {};
  }
  if (authority.lock === authority.report) return {};
  await writeFile(authority.lockPath, authority.report);
  return { wrote: authority.lockPath };
}
