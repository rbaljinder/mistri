/**
 * `spawn`, with every child it starts killed when this worker exits.
 *
 * A spec starts its server in `beforeAll` and stops it in `afterAll`, but a
 * hook that times out (or throws between the spawn and the assignment that
 * `afterAll` reads) leaves the child running with nobody holding its handle:
 * `app?.stop()` is a no-op on undefined. The start helpers stop their own
 * child when they throw; they cannot when Playwright abandons the hook
 * mid-await. The worker's exit is the one point that always runs, so the
 * child is reaped there. A child that already exited is skipped, so a
 * normal `stop()` costs nothing extra.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

const children = new Set<ChildProcess>();
let armed = false;

function reap(): void {
  for (const child of children) {
    // `exitCode`/`signalCode` are null while it still runs.
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone between the check and the kill.
      }
    }
  }
  children.clear();
}

export const spawn: typeof nodeSpawn = ((...args: Parameters<typeof nodeSpawn>) => {
  const child = nodeSpawn(...args);
  if (!armed) {
    armed = true;
    // Synchronous on purpose: nothing async runs after 'exit'.
    process.once('exit', reap);
  }
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}) as typeof nodeSpawn;
