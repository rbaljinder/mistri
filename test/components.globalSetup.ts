/**
 * Vitest 5 leaves a folder in the system temp directory after every run: a
 * 21-character random name holding `client/`, the transformed modules it
 * copied there for the forks pool. A project removes its own when it closes;
 * the run's (`vitest._tmpDir`) is made the same way and never removed, so a
 * developer's machine collected one per run — about 770 of them, 9 MB each.
 * The teardown removes it once the run is over. It is an internal field, so
 * the guard reads it carefully and removes only a folder directly under the
 * temp directory: if a release renames it, nothing is removed and nothing
 * breaks. Remove this when Vitest cleans up after itself.
 */
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { TestProject } from 'vitest/node';

/** The run's own temp folder, if it is one: a direct child of the temp directory. */
function runTempDir(project: Pick<TestProject, 'vitest'>): string | undefined {
  const dir = (project.vitest as unknown as { _tmpDir?: unknown })._tmpDir;
  return typeof dir === 'string' && dirname(resolve(dir)) === resolve(tmpdir()) ? dir : undefined;
}

export default function setup(project: TestProject) {
  return async () => {
    const dir = runTempDir(project);
    if (dir) await rm(dir, { recursive: true, force: true });
  };
}
