/**
 * `mistri dev` on a tenant App: a thin parent that runs the host as a child process.
 *
 * A tenant host captures its App, policy and pages by value at startup, so what a save changed cannot be swapped into
 * it without skipping the checks startup makes (tenant/tenantLook.ts says why). Under dev the way to wear a save is to
 * start again, and starting again must not need a person at the terminal: the child retires cleanly and exits with
 * DEV_CHANGED_EXIT where the watcher already notices the save (cli/tenant.ts), and this parent starts it again once it
 * has gone, so the port is free. A save of only the look never gets here: the host wears it in place.
 *
 * A child that fails to start (a page that does not load, a policy that refuses) printed why; this parent keeps
 * watching the App's files and starts it again on the next save instead of leaving the terminal.
 * Sessions live in the auth store and the cookies, which the dev folder keeps (cli/devMode.ts), so a restart signs
 * nobody out.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

/** Marks the child: it retires with DEV_CHANGED_EXIT instead of leaving the terminal to restart. Not a flag, not documented. */
export const DEV_SUPERVISED_ENV = 'MISTRI_DEV_SUPERVISED';
/** The child's "a save changed what I serve" (EX_TEMPFAIL): the parent starts it again. */
export const DEV_CHANGED_EXIT = 75;

const SKIPPED = new Set(['.mistri', 'node_modules', '.git']);

/** Calls `changed` (debounced) when anything under `root` or one of `files` is saved; returns what stops watching. */
export function watchForSave(root: string, files: readonly (string | undefined)[], changed: () => void, debounceMs = 200): () => void {
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ping = () => {
    clearTimeout(timer);
    timer = setTimeout(changed, debounceMs);
  };
  try {
    watchers.push(
      watch(resolve(root), { recursive: true }, (_event, filename) => {
        if (filename !== null && SKIPPED.has(filename.split(/[\\/]/)[0])) return;
        ping();
      }),
    );
  } catch {
    /* A directory that cannot be watched is one the child will say so about. */
  }
  for (const file of files) {
    if (!file) continue;
    const path = resolve(file);
    try {
      watchers.push(watch(dirname(path), (_event, filename) => (filename === null || filename === basename(path) ? ping() : undefined)));
    } catch {
      /* As above. */
    }
  }
  for (const watcher of watchers) watcher.on('error', () => {});
  return () => {
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}

interface DevSupervision {
  /** The arguments and environment the person's own command had, before dev settled anything: the child settles it again. */
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  /** Starts watching; calls back on a save; returns the stop. */
  readonly watch: (changed: () => void) => () => void;
  /** An ordinary App's dev (not a tenant's): the child retires only for the one change a reload cannot wear, and any other exit is the person's to see, as it was before there was a parent. */
  readonly onlyOnChange?: boolean;
}

/** Runs the child until the person stops it; resolves to the exit code the parent should leave with. */
export async function superviseDev(options: DevSupervision): Promise<number> {
  let child: ChildProcess | undefined;
  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = () => {
    stopping = true;
    child?.kill('SIGTERM');
    wake?.();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    for (let start = 0; ; start++) {
      const env = { ...options.env, [DEV_SUPERVISED_ENV]: '1', ...(start ? { MISTRI_OPEN: '0' } : {}) };
      const running = spawn(process.execPath, [...process.execArgv, process.argv[1], ...options.argv], { env, stdio: 'inherit' });
      child = running;
      if (stopping) running.kill('SIGTERM');
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
        running.once('error', () => done({ code: 1, signal: null }));
        running.once('exit', (code, signal) => done({ code, signal }));
      });
      child = undefined;
      if (stopping) return exit.code ?? 0;
      if (exit.code === 0) return 0;
      if (exit.code === DEV_CHANGED_EXIT) {
        console.error('mistri dev: the App changed; starting it again…');
        continue;
      }
      if (options.onlyOnChange) return exit.code ?? 1;
      console.error(
        `mistri dev: the host ${exit.signal ? `was stopped by ${exit.signal}` : `exited with code ${exit.code}`}; waiting for the next save to start it again.`,
      );
      await new Promise<void>((done) => {
        let off: (() => void) | undefined;
        wake = () => {
          off?.();
          wake = undefined;
          done();
        };
        off = options.watch(wake);
        if (stopping) wake();
      });
      if (stopping) return 0;
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
