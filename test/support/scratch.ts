import type { TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A case's directory, removed only after everything the case started in it
 * has stopped. Node runs a test's `after` hooks in the order they were
 * registered and stops at the first that throws, so a directory registered
 * before its server was removed while that server still wrote into it (a
 * job's store, a journal's WAL): the removal failed with ENOTEMPTY, the hook
 * that would have stopped the server never ran, and the live child held the
 * test file open until the gate was killed hours later. Here every stop runs,
 * newest first, and the directory goes last.
 */
export function scratch(t: TestContext, prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const stops: Array<() => unknown> = [];
  t.after(async () => {
    const failures: unknown[] = [];
    for (const stop of stops.reverse()) {
      try {
        await stop();
      } catch (error) {
        failures.push(error);
      }
    }
    rmSync(directory, { recursive: true, force: true });
    if (failures.length) throw failures[0];
  });
  return {
    directory,
    stopping: (stop: () => unknown) => {
      stops.push(stop);
    },
  };
}
