/**
 * Which migrations `mistri check --deploy` judges for running-code safety (migrationSafety.ts).
 *
 * Only the ones that have not run yet matter: an applied migration already changed the schema the running code
 * sees. The check opens the App's database read-only, the way `mistri migrate status` does, and takes the plan's
 * pending files. When it cannot (no connection in this environment, an unset `${NAME}`, a database that does not
 * answer in a few seconds, or a `--pending` scratch copy that already holds them), it judges every versioned
 * migration file instead and says so: noisier, never silent. A repeatable (`R__`) migration is re-run whenever it
 * changes and is written to be re-run, so it is not judged.
 */
import { readMigrations, type MigrationFile } from '@mistriwork/engine/server/migrate/files.js';
import { migrationStatus } from '@mistriwork/engine/server/migrate/runner.js';
import { resolveTarget } from '@mistriwork/engine/server/migrate/target.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { StartupConfig } from '@mistriwork/engine/server/cli/config.js';
import type { MigrationFinding } from './migrationSafety.js';
import type { DeployFinding } from './checkDeploy.js';
import { appBinding } from '../cli/appBinding.js';
import type { AppDef } from '../../shared/app.js';

const READ_MS = 5_000;

export const asDeployFinding = (finding: MigrationFinding): DeployFinding => ({
  code: finding.code,
  severity: finding.severity,
  message: finding.message,
  fix: finding.fix,
});

export async function migrationsToJudge(
  registry: Registry,
  config: StartupConfig,
  opts: { schemas: string[]; target?: string },
  appDir: string,
  app: AppDef,
  flags: { dir?: string; table?: string; scratch: boolean },
): Promise<{ files: readonly Pick<MigrationFile, 'script' | 'sql'>[]; said?: string }> {
  let target;
  try {
    target = await resolveTarget(
      registry,
      config,
      {
        ...(opts.target ? { argument: registry.active ?? undefined } : {}),
        schemas: opts.schemas,
        ...(flags.dir !== undefined ? { migrations: flags.dir } : {}),
        ...(flags.table !== undefined ? { table: flags.table } : {}),
      },
      appDir,
      appBinding(app),
    );
  } catch (error) {
    return { files: [], said: `not judged: ${error instanceof Error ? error.message.split('\n')[0] : 'no database to read them for'}` };
  }
  const versioned = readMigrations(target.dir).files.filter((file) => file.kind === 'versioned');
  if (!versioned.length) return { files: [] };
  const all = (why: string) => ({
    files: versioned,
    said: `${why}, so every versioned file in ${target.dir} was judged, applied ones too`,
  });
  if (flags.scratch) return all('--pending already applied them to its copy');
  try {
    let timer: NodeJS.Timeout | undefined;
    const status = await Promise.race([
      migrationStatus(target),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), READ_MS);
        timer.unref();
      }),
    ]).finally(() => clearTimeout(timer));
    const pending = status.plan.pending.filter((file) => file.kind === 'versioned');
    return { files: pending, said: `${pending.length} pending of ${versioned.length} judged for the running code` };
  } catch (error) {
    return all(`the database's history could not be read (${error instanceof Error ? error.message.split('\n')[0] : 'failed'})`);
  }
}
