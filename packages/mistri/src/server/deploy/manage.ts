/**
 * `mistri deploy status | verify | rollback | logs`.
 *
 * Rollback is `wrangler rollback` to the Worker version a recorded deploy ran, then the same restart-and-verify as
 * a deploy, expecting that deploy's own fingerprint (its MISTRI_DEPLOY_ID is a var of the version rolled back to).
 * Migrations only go forward, so it refuses when a contract migration was applied after the target: the older code
 * would run on a schema that no longer has what it reads.
 */
import { rollTo, seen, smoke } from './run.js';
import { readConfig, readWorker } from './config.js';
import type { DeployFlags, DeployRow, DeployRunner } from './types.js';

const line = (row: DeployRow) =>
  `${row.startedAt.slice(0, 19)}Z  ${row.id.slice(0, 8)}  ${row.result.padEnd(7)}  build ${row.buildId || '-'}  ${row.gitSha?.slice(0, 9) ?? 'no git'}  ${row.operator}` +
  `  version ${row.workerVersion ?? '-'}` +
  `${row.migrations.length ? `  migrations ${row.migrations.join(',')}` : ''}${row.contract ? '  CONTRACT' : ''}${row.rollbackOf ? `  rollback of ${row.rollbackOf.slice(0, 8)}` : ''}${row.note ? `  (${row.note})` : ''}`;

/** A deployment as `wrangler deployments list` reports it. */
interface Deployment {
  created: string;
  source: string;
  versions: string[];
}

const SHOWN_DEPLOYMENTS = 5;

/** Newest first. `--json` is read when wrangler has it; its text (Created / Source / Version(s) blocks) otherwise. */
function deploymentsOf(out: string): Deployment[] {
  let found: Deployment[];
  try {
    const parsed = JSON.parse(out) as Array<{
      created_on?: string;
      source?: string;
      versions?: Array<{ version_id?: string; percentage?: number }>;
    }>;
    found = parsed.map((each) => ({
      created: each.created_on ?? '',
      source: each.source ?? '',
      versions: (each.versions ?? []).map((version) => version.version_id ?? '').filter(Boolean),
    }));
  } catch {
    found = out
      .split(/^(?=Created:)/m)
      .filter((block) => block.startsWith('Created:'))
      .map((block) => ({
        created: /^Created:\s*(.+)$/m.exec(block)?.[1].trim() ?? '',
        source: /^Source:\s*(.+)$/m.exec(block)?.[1].trim() ?? '',
        versions: [...block.matchAll(/\(\d+%\)\s*([0-9a-f-]{8,})/gi)].map((match) => match[1]),
      }));
  }
  return found.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
}

export async function status(runner: DeployRunner, flags: DeployFlags): Promise<number> {
  const worker = readWorker(flags.dir);
  /* Read only: no table is created, and a missing one reads as no deploys recorded. */
  const ledger = await runner.ledger();
  let rows: DeployRow[];
  try {
    rows = await ledger.recent(10);
  } finally {
    await ledger.close();
  }
  const live = seen(await runner.http(`${worker.url}/readyz`));
  runner.say(`Live (${worker.url}/readyz): ${live.saw}`);
  if (live.match) {
    const matched = rows.find((row) => (row.rollbackOf ?? row.id) === live.match!.deploy && row.buildId === live.match!.build);
    runner.say(
      matched
        ? `  matches ${matched.rollbackOf ? 'rollback' : 'deploy'} ${matched.id.slice(0, 8)} (${matched.result})`
        : '  matches no recorded deploy (one older than the newest ten, or made without a record)',
    );
  }
  runner.say('');
  runner.say('Recorded deploys (newest first):');
  for (const row of rows) runner.say(`  ${line(row)}`);
  if (!rows.length) runner.say('  none yet');
  runner.say('');
  runner.say(`Cloudflare (newest ${SHOWN_DEPLOYMENTS} deployments):`);
  let listed = await runner.wrangler(['deployments', 'list', '--json'], { cwd: flags.dir });
  /* An older wrangler without --json says its usage; the text is parsed instead. */
  if (listed.code !== 0) listed = await runner.wrangler(['deployments', 'list'], { cwd: flags.dir });
  if (listed.code !== 0) {
    runner.say(`  could not list: ${listed.stderr.trim().split('\n')[0] || `exit ${listed.code}`}`);
    return 0;
  }
  const deployments = deploymentsOf(listed.stdout);
  if (!deployments.length) runner.say('  none');
  deployments.slice(0, SHOWN_DEPLOYMENTS).forEach((each, index) => {
    runner.say(`  ${each.created}  ${each.source.padEnd(10)}  ${each.versions.join(', ') || '-'}${index === 0 ? '  (active)' : ''}`);
  });
  return 0;
}

/**
 * Verify the newest recorded deploy against what is live, and correct its record: a deploy whose roll or smoke failed
 * after its Worker was already serving is `failed` in the record while the site is up. Without --roll it only reads
 * `/readyz`; with it, the container is restarted until it reports the fingerprint, as the deploy did.
 */
export async function verify(runner: DeployRunner, flags: DeployFlags): Promise<number> {
  const worker = readWorker(flags.dir);
  const token = runner.env(flags.restartTokenEnv);
  if (flags.roll && (!token || token.length < 32)) {
    runner.say(`${flags.restartTokenEnv} must be set here to the Worker's restart token to use --roll.`);
    return 7;
  }
  const ledger = await runner.ledger();
  try {
    const [row] = await ledger.recent(1);
    if (!row) {
      runner.say('No deploy is recorded, so there is nothing to verify.');
      return 1;
    }
    /* A rollback's own row carries its target's fingerprint, as it does when it is rolled to. */
    const expected = { deployId: row.rollbackOf ?? row.id, buildId: row.buildId };
    runner.say(
      `Verify ${row.rollbackOf ? 'rollback' : 'deploy'} ${row.id.slice(0, 8)} (build ${row.buildId}, recorded ${row.result}) at ${worker.url}`,
    );
    const rolled = await rollTo(
      runner,
      worker.url,
      expected,
      token ?? '',
      flags.roll ? flags.rollTimeoutMs : Math.min(flags.rollTimeoutMs, VERIFY_WAIT_MS),
      flags.roll,
    );
    const problems = rolled.ok
      ? await smoke(runner, worker.url, flags.smoke)
      : [
          `the container never reported the fingerprint: last saw ${rolled.saw}.${flags.roll ? '' : ' Pass --roll to restart it until it does.'}`,
        ];
    const finishedAt = row.finishedAt ?? new Date(runner.now()).toISOString();
    if (problems.length) {
      const note = `verify failed: ${problems.join(' ')}`;
      await ledger.finish(row.id, { finishedAt, result: 'failed', note });
      runner.say(`Not verified: ${note}`);
      return 1;
    }
    await ledger.finish(row.id, { finishedAt, result: 'ok', note: null });
    runner.say(`Verified: ${row.id.slice(0, 8)} is recorded ok.`);
    return 0;
  } finally {
    await ledger.close();
  }
}

/** Without --roll nothing restarts the container, so this only waits out one that is still starting. */
const VERIFY_WAIT_MS = 120_000;

export const logs = async (runner: DeployRunner, flags: DeployFlags): Promise<number> =>
  (await runner.wrangler(['tail'], { cwd: flags.dir, inherit: true })).code;

/** The recorded deploy to return to, or why none can be. */
export function rollbackTarget(rows: readonly DeployRow[], wanted: string | undefined): { target: DeployRow } | { refusal: string } {
  /* A rollback's own row carries no fingerprint of its own: its target's is the one the Worker reports. */
  const deploys = rows.filter((row) => !row.rollbackOf);
  const ok = deploys.filter((row) => row.result === 'ok');
  const target = wanted
    ? deploys.find((row) => row.id === wanted || row.id.startsWith(wanted))
    : /* The current one is the newest success; the one before it is where a rollback goes. */ ok[1];
  if (!target)
    return { refusal: wanted ? `no recorded deploy "${wanted}".` : 'there is no earlier successful deploy recorded to roll back to.' };
  if (target.result !== 'ok')
    return { refusal: `deploy ${target.id.slice(0, 8)} did not succeed (${target.result}), so it is not a version to return to.` };
  if (!target.workerVersion)
    return { refusal: `deploy ${target.id.slice(0, 8)} recorded no Worker version, so wrangler cannot return to it.` };
  const later = rows.filter((row) => row.startedAt > target.startedAt && row.contract && row.migrations.length);
  if (later.length)
    return {
      refusal:
        `deploy ${later[0].id.slice(0, 8)} applied a contract migration (${later[0].migrations.join(', ')}) after ${target.id.slice(0, 8)}. ` +
        'Migrations only go forward and the older code reads what that one removed, so rolling back would break it. Roll forward with a fix instead.',
    };
  return { target };
}

export async function rollback(runner: DeployRunner, flags: DeployFlags, wanted: string | undefined): Promise<number> {
  const worker = readWorker(flags.dir);
  readConfig(flags.dir);
  const token = runner.env(flags.restartTokenEnv);
  if (!token || token.length < 32) {
    runner.say(`${flags.restartTokenEnv} must be set here to the Worker's restart token.`);
    return 7;
  }
  const ledger = await runner.ledger();
  try {
    const chosen = rollbackTarget(await ledger.recent(50), wanted);
    if ('refusal' in chosen) {
      runner.say(`Refused: ${chosen.refusal}`);
      return 7;
    }
    const { target } = chosen;
    runner.say(
      `Roll back ${worker.name} to deploy ${target.id.slice(0, 8)} (build ${target.buildId}, Worker version ${target.workerVersion}).`,
    );
    if (flags.dryRun) {
      runner.say('Dry run: nothing was changed.');
      return 0;
    }
    if (!flags.yes && !(await runner.confirm('Roll back?'))) return 1;
    /* Only now, when something will be written: a dry run reads the record and creates nothing. */
    await ledger.ensure();
    const id = runner.newId();
    await ledger.start({
      id,
      startedAt: new Date(runner.now()).toISOString(),
      finishedAt: null,
      operator: runner.operator(),
      gitSha: target.gitSha,
      buildId: target.buildId,
      workerVersion: target.workerVersion,
      migrations: [],
      contract: false,
      result: 'running',
      rollbackOf: target.id,
      note: null,
    });
    const done = async (result: 'ok' | 'failed', note: string | null): Promise<number> => {
      await ledger.finish(id, { finishedAt: new Date(runner.now()).toISOString(), result, note });
      runner.say(result === 'ok' ? `Rolled back (${id.slice(0, 8)}).` : `Rollback failed: ${note}`);
      return result === 'ok' ? 0 : 1;
    };
    const pushed = await runner.wrangler(
      ['rollback', target.workerVersion!, '--message', `mistri deploy rollback to ${target.id}`, '--yes'],
      { cwd: flags.dir },
    );
    if (pushed.code !== 0)
      return await done('failed', `wrangler rollback exited ${pushed.code}: ${pushed.stderr.trim().split('\n').pop() ?? ''}`);
    const rolled = await rollTo(runner, worker.url, { deployId: target.id, buildId: target.buildId }, token, flags.rollTimeoutMs);
    if (!rolled.ok) return await done('failed', `the container never reported the old fingerprint: last saw ${rolled.saw}.`);
    const problems = await smoke(runner, worker.url, flags.smoke);
    return problems.length ? await done('failed', `smoke failed: ${problems.join(' ')}`) : await done('ok', null);
  } finally {
    await ledger.close();
  }
}
