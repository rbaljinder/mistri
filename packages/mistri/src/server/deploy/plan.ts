/**
 * The plan: everything `mistri deploy` will do, read before anything changes, and the reasons it would refuse.
 *
 * It reuses what `check --deploy` already judges (stores, secrets, connection math) and the migration-safety lint
 * over the migrations not yet applied. A secret is compared by name through `wrangler secret list`: its value is
 * never read. A contract migration (one marked `-- mistri: contract`) is a forward-only step of its own, so it
 * refuses unless the operator says `--allow-contract`.
 */
import { migrationFindings } from '../build/migrationSafety.js';
import { readConfig, readWorker, type WorkerFacts } from './config.js';
import type { CheckFinding, DeployConfig, DeployFlags, DeployRunner } from './types.js';

export interface Plan {
  worker: WorkerFacts;
  config: DeployConfig;
  git: { sha: string | null; dirty: boolean };
  findings: CheckFinding[];
  secrets: { present: string[]; missing: string[]; optionalUnset: string[] };
  /** The connection math `check --deploy` printed, one line a database. */
  connections: string[];
  migrations: { pending: string[]; contract: string[]; breaking: string[] };
  backup: string | undefined;
  refusals: string[];
  warnings: string[];
}

/** The migration-safety lint is judged here over the pending files only, so check's own copy of it is set aside. */
const SAFETY = 'migration-breaks-running-code';

/** Only "1" turns Server-Timing on; "0" (or anything else) is off, as the server reads it. */
const serverTimingOn = (worker: WorkerFacts) => worker.vars.MISTRI_SERVER_TIMING === '1';

/** How many warnings the plan prints without --verbose. */
const WARNINGS_SHOWN = 3;

export async function makePlan(runner: DeployRunner, flags: DeployFlags, request: Partial<DeployConfig> = {}): Promise<Plan> {
  const worker = readWorker(flags.dir);
  const stored = readConfig(flags.dir);
  const config: DeployConfig = { ...stored, ...request, ...(flags.backupCheck !== undefined ? { backupCheck: flags.backupCheck } : {}) };
  if (flags.smoke !== undefined) config.smoke = flags.smoke;
  const refusals: string[] = [];
  const warnings: string[] = [];

  const git = await runner.git();
  if (git.dirty && !flags.allowDirty)
    refusals.push(
      'the working tree has uncommitted changes, so the deploy would not be the commit it records. Commit them, or pass --allow-dirty.',
    );

  const { problems: all, connections } = await runner.check();
  const findings = all.filter((found) => found.code !== SAFETY);
  for (const found of findings.filter((each) => each.severity === 'error'))
    refusals.push(`check --deploy: ${found.message}${found.fix ? ` Fix: ${found.fix}` : ''}`);
  for (const found of findings.filter((each) => each.severity === 'warning')) warnings.push(`check --deploy: ${found.message}`);

  const migrations: Plan['migrations'] = { pending: [], contract: [], breaking: [] };
  try {
    const { files: pending, problems } = await runner.migrations.pending();
    /* A history that does not match the directory (a recorded file gone from it, a changed checksum) makes "pending" a
       guess: a run would apply nothing and say so. Each problem is a refusal, whatever the rest of the plan says. */
    for (const problem of problems) refusals.push(`migrations: ${problem}`);
    migrations.pending = pending.map((file) => file.script);
    for (const file of pending) {
      const found = migrationFindings(file.script, file.sql);
      if (found.some((each) => each.severity === 'info')) migrations.contract.push(file.script);
      for (const each of found.filter((one) => one.severity !== 'info')) {
        migrations.breaking.push(file.script);
        const text = `${each.message} Fix: ${each.fix}`;
        (each.severity === 'error' ? refusals : warnings).push(`migration: ${text}`);
      }
    }
    if (migrations.contract.length && !flags.allowContract)
      refusals.push(
        `${migrations.contract.join(', ')} is a contract step (marked "-- mistri: contract"): it removes what the code still running uses, and cannot be rolled back past. ` +
          'Deploy the code that stopped using it first, then run this with --allow-contract.',
      );
  } catch (error) {
    refusals.push(
      `the migration history could not be read over ${flags.migrateUrl ? '--migrate-url' : 'the App connection'}: ${(error as Error).message}`,
    );
  }

  const required = [...new Set([...config.secrets, flags.restartTokenEnv])];
  const secrets: Plan['secrets'] = { present: [], missing: [], optionalUnset: [] };
  const listed = await runner.wrangler(['secret', 'list', '--format', 'json'], { cwd: flags.dir });
  if (listed.code !== 0)
    refusals.push(
      `wrangler secret list failed, so the secrets cannot be compared: ${listed.stderr.trim().split('\n')[0] || `exit ${listed.code}`}`,
    );
  else {
    let held: Set<string>;
    try {
      held = new Set((JSON.parse(listed.stdout) as Array<{ name: string }>).map((secret) => secret.name));
    } catch {
      held = new Set();
      refusals.push('wrangler secret list did not answer JSON, so the secrets cannot be compared.');
    }
    for (const name of required) (held.has(name) ? secrets.present : secrets.missing).push(name);
    for (const name of config.optionalSecrets ?? []) if (!held.has(name) && !required.includes(name)) secrets.optionalUnset.push(name);
    for (const name of secrets.missing)
      refusals.push(`the secret ${name} is not set on the Worker: npx wrangler secret put ${name} (in ${flags.dir}).`);
    if (serverTimingOn(worker) && !held.has('MISTRI_SERVER_TIMING_TOKEN'))
      warnings.push('Server-Timing is on with no MISTRI_SERVER_TIMING_TOKEN secret, so its process entry is public.');
  }

  const token = runner.env(flags.restartTokenEnv);
  if (!token || token.length < 32)
    refusals.push(
      `${flags.restartTokenEnv} must be set here to the Worker's restart token (32 characters or more): the roll restarts the container with it.`,
    );

  if (config.backupCheck === undefined)
    warnings.push(
      'no backup check is configured: pass --backup-check <cmd> (a non-zero exit refuses) so a deploy proves a recent backup first.',
    );

  return { worker, config, git, findings, connections, secrets, migrations, backup: config.backupCheck, refusals, warnings };
}

/** Every warning with --verbose; else a count and the first few, since a real App's check names dozens of the same kind. */
function shownWarnings(warnings: readonly string[], verbose: boolean): string[] {
  if (verbose || warnings.length <= WARNINGS_SHOWN) return warnings.map((line) => `  warning: ${line}`);
  return [
    `  warnings      ${warnings.length} (the first ${WARNINGS_SHOWN} below; --verbose for all)`,
    ...warnings.slice(0, WARNINGS_SHOWN).map((line) => `  warning: ${line}`),
  ];
}

export function planLines(plan: Plan, flags: DeployFlags): string[] {
  const { worker } = plan;
  return [
    `Deploy ${worker.name} to ${worker.url}`,
    `  instance      ${worker.instanceType ?? 'unpinned'} x ${worker.maxInstances ?? 1}`,
    `  commit        ${plan.git.sha?.slice(0, 9) ?? 'none'}${plan.git.dirty ? ' (uncommitted changes)' : ''}`,
    `  check         ${plan.findings.filter((found) => found.severity === 'error').length} errors, ${plan.findings.filter((found) => found.severity === 'warning').length} warnings`,
    ...plan.connections.map((each) => `  connections   ${each}`),
    `  secrets       ${plan.secrets.present.length} set${plan.secrets.missing.length ? `, MISSING ${plan.secrets.missing.join(', ')}` : ''}${plan.secrets.optionalUnset.length ? ` (optional, not set: ${plan.secrets.optionalUnset.join(', ')})` : ''}`,
    `  migrations    ${plan.migrations.pending.length ? plan.migrations.pending.join(', ') : 'none pending'}${plan.migrations.contract.length ? ` (contract: ${plan.migrations.contract.join(', ')})` : ''}`,
    `  migrate over  ${flags.migrateUrl ? 'the --migrate-url database' : 'the App connection'}`,
    `  backup check  ${plan.backup ?? 'not configured'}`,
    `  server timing ${serverTimingOn(worker) ? 'on' : 'off'}`,
    ...shownWarnings(plan.warnings, flags.verbose),
    ...plan.refusals.map((line) => `  REFUSED: ${line}`),
  ];
}
