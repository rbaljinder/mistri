/**
 * The run: build, backup check, migrations, `wrangler deploy`, a restart until the new container answers, a smoke.
 *
 * Migrations go first because the compatibility lint guarantees an expand-only migration works with the code still
 * running; a contract step is its own later deploy (--allow-contract). Verification is by fingerprint, not liveness:
 * `/readyz` answers `{ deploy, build }`, where `deploy` is the id this run put in the Worker's environment (so the
 * new configuration reached the container) and `build` is the new image's build id. A code update resets the
 * Durable Object but leaves a running container as it is, so a restart goes in until both match.
 */
import { planLines, type Plan } from './plan.js';
import { RESTART_HEADER, type DeployFlags, type DeployRow, type DeployRunner, type HttpAnswer } from './types.js';

const POLL_MS = 5_000;
/** The least between two restarts, and the most: a container still starting must not be restarted under itself. */
const RESTART_GAP_MS = 60_000;
const RESTART_GAP_MAX_MS = 300_000;

interface Fingerprint {
  deployId: string;
  buildId: string;
}

const isAnswer = (answer: HttpAnswer | { error: string }): answer is HttpAnswer => 'status' in answer;

export function seen(answer: HttpAnswer | { error: string }): { saw: string; match?: { deploy: unknown; build: unknown } } {
  if (!isAnswer(answer)) return { saw: `no answer (${answer.error})` };
  if (answer.status !== 200) return { saw: `/readyz ${answer.status}` };
  try {
    const body = JSON.parse(answer.body) as { deploy?: unknown; build?: unknown };
    return {
      saw: `deploy ${String(body.deploy ?? 'null')}, build ${String(body.build ?? 'null')}`,
      match: { deploy: body.deploy, build: body.build },
    };
  } catch {
    return { saw: '/readyz 200 with a body that is not JSON' };
  }
}

/** What the Worker's restart answer means when it is not a 200, for the person reading the roll. */
function restartAnswer(answer: HttpAnswer | { error: string }): string {
  if (!isAnswer(answer)) return `failed (${answer.error})`;
  if (answer.status === 200) return 'sent';
  if (answer.status === 404 || answer.status === 405)
    return `the Worker answered ${answer.status} (the serving Worker does not take the ${RESTART_HEADER} header yet: an older Worker version still rolling out, or a Worker not on @mistriwork/cloudflare)`;
  return `the Worker answered ${answer.status}`;
}

const minutes = (ms: number) => `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;

/**
 * Restart the container until `/readyz` reports the expected fingerprint, or `timeoutMs` passes. A starting
 * container (no answer, 503) is waited for; one that answers with the old fingerprint is restarted, at most once
 * per growing gap, since the image rollout can take longer than the first restart waits for. `restart: false` only
 * waits (`deploy verify` without --roll).
 */
export async function rollTo(
  runner: DeployRunner,
  url: string,
  expected: Fingerprint,
  token: string,
  timeoutMs: number,
  restart = true,
): Promise<{ ok: true } | { ok: false; saw: string }> {
  const started = runner.now();
  let lastRestart = Number.NEGATIVE_INFINITY;
  let gap = RESTART_GAP_MS;
  let saw = 'nothing yet';
  let restarts = 0;
  for (;;) {
    const elapsed = runner.now() - started;
    if (elapsed >= timeoutMs) return { ok: false, saw: `${saw} after ${restarts} restart${restarts === 1 ? '' : 's'}` };
    const reading = seen(await runner.http(`${url}/readyz`));
    saw = reading.saw;
    if (reading.match?.deploy === expected.deployId && reading.match.build === expected.buildId) {
      runner.say(
        `  verified: deploy ${expected.deployId.slice(0, 8)} build ${expected.buildId} after ${restarts} restart${restarts === 1 ? '' : 's'}, ${minutes(runner.now() - started)}`,
      );
      return { ok: true };
    }
    /* Only a container that answers with another fingerprint is the old one; a silent one is starting. */
    const stale = reading.match !== undefined;
    if (restart && runner.now() - lastRestart >= gap && (stale || restarts === 0)) {
      const answer = await runner.http(`${url}/`, { method: 'POST', headers: { [RESTART_HEADER]: token } });
      restarts++;
      lastRestart = runner.now();
      if (restarts > 1) gap = Math.min(gap * 2, RESTART_GAP_MAX_MS);
      runner.say(`  restart ${restarts}: ${restartAnswer(answer)}; saw ${saw}`);
    }
    await runner.sleep(POLL_MS);
  }
}

const MAX_REDIRECTS = 5;

/**
 * The page at `url/` after the same-origin redirects it answers with (an App at `/{app}` answers `/` with a 303 to it),
 * or the failure: a redirect to another origin, a loop, or more than five hops, each naming the chain it followed.
 */
async function landing(
  runner: DeployRunner,
  url: string,
): Promise<{ page: HttpAnswer; at: string } | { failure: string } | { error: string; at: string }> {
  const origin = new URL(url).origin;
  const chain = [`${url}/`];
  for (;;) {
    const at = chain[chain.length - 1];
    const page = await runner.http(at);
    if (!isAnswer(page)) return { error: page.error, at };
    const location = page.headers.location;
    if (page.status < 300 || page.status > 399 || !location) return { page, at };
    const next = new URL(location, at).href;
    const said = `${chain.join(' -> ')} -> ${next}`;
    if (new URL(next).origin !== origin) return { failure: `${at} redirected to another origin (${said}).` };
    if (chain.includes(next)) return { failure: `${at} redirects in a loop (${said}).` };
    if (chain.length > MAX_REDIRECTS) return { failure: `${url}/ redirected more than ${MAX_REDIRECTS} times (${said}).` };
    chain.push(next);
  }
}

/** The public address answers, serves the script its page names, and shows no process timing to an anonymous caller. */
export async function smoke(runner: DeployRunner, url: string, command: string | undefined): Promise<string[]> {
  const failures: string[] = [];
  const reached = await landing(runner, url);
  if ('failure' in reached) failures.push(reached.failure);
  else if ('error' in reached) failures.push(`${reached.at} answered ${reached.error}`);
  else if (reached.page.status !== 200) failures.push(`${reached.at} answered ${reached.page.status}`);
  else {
    const { page, at } = reached;
    if (/(^|,)\s*proc\b/.test(page.headers['server-timing'] ?? ''))
      failures.push('the Server-Timing header carries a proc entry without the operator token.');
    const script = /<script[^>]*\ssrc="([^"]+)"/.exec(page.body)?.[1];
    if (script) {
      const asset = await runner.http(new URL(script, at).href);
      if (!isAnswer(asset) || asset.status !== 200)
        failures.push(`the page's script ${script} answered ${isAnswer(asset) ? asset.status : asset.error}`);
    }
  }
  if (command) {
    const code = await runner.hook(command, { MISTRI_DEPLOY_URL: url });
    if (code !== 0) failures.push(`--smoke exited ${code}.`);
  }
  return failures;
}

export async function deploy(runner: DeployRunner, plan: Plan, flags: DeployFlags): Promise<number> {
  for (const line of planLines(plan, flags)) runner.say(line);
  if (plan.refusals.length) return 7;
  if (flags.dryRun) {
    runner.say('Dry run: nothing was changed.');
    return 0;
  }
  if (!flags.yes && !(await runner.confirm('Run this deploy?'))) {
    runner.say('Not deployed.');
    return 1;
  }

  const ledger = await runner.ledger();
  const id = runner.newId();
  const row: DeployRow = {
    id,
    startedAt: new Date(runner.now()).toISOString(),
    finishedAt: null,
    operator: runner.operator(),
    gitSha: plan.git.sha,
    buildId: '',
    workerVersion: null,
    migrations: [],
    contract: plan.migrations.contract.length > 0,
    result: 'running',
    rollbackOf: null,
    note: null,
  };
  const fail = async (note: string): Promise<number> => {
    runner.say(`Deploy ${id} failed: ${note}`);
    await ledger.finish(id, { finishedAt: new Date(runner.now()).toISOString(), result: 'failed', note });
    await ledger.close();
    return 1;
  };
  try {
    await ledger.ensure();
    /* Where a rollback would go if this one fails after the new Worker is live. */
    const previous = (await ledger.recent(50)).find((each) => each.result === 'ok' && !each.rollbackOf);
    await ledger.start(row);

    runner.say('Building...');
    const built = await runner.build();
    row.buildId = built.buildId;
    await ledger.finish(id, { buildId: built.buildId });

    if (plan.backup) {
      runner.say(`Backup check: ${plan.backup}`);
      const code = await runner.hook(plan.backup, {});
      if (code !== 0) return await fail(`the backup check exited ${code}; nothing was changed.`);
    }

    runner.say(`Migrating (${plan.migrations.pending.length} pending)...`);
    let applied: string[] = [];
    try {
      applied = await runner.migrations.up();
    } catch (error) {
      return await fail(`a migration failed (${(error as Error).message}); the code is unchanged and still runs on the schema as it was.`);
    }
    await ledger.finish(id, { migrations: applied });

    runner.say('wrangler deploy...');
    const pushed = await runner.wrangler(['deploy', '--var', `MISTRI_DEPLOY_ID:${id}`], { cwd: flags.dir, stream: true });
    if (pushed.code !== 0)
      return await fail(
        `wrangler deploy exited ${pushed.code}: ${pushed.stderr.trim().split('\n').pop() ?? ''}. Migrations applied: ${applied.join(', ') || 'none'} (expand-only ones work with the code still running).`,
      );
    const version = /Current Version ID:\s*([0-9a-f-]{8,})/i.exec(pushed.stdout)?.[1] ?? null;
    await ledger.finish(id, { workerVersion: version });
    /* From here the new Worker is serving, whatever the roll or the smoke say: a failure must not read as "nothing changed". */
    const serving = (note: string): Promise<number> =>
      fail(
        `${note} The new Worker version ${version ?? '(id not read from wrangler)'} is serving. Once that is fixed, run: mistri deploy verify` +
          `${previous ? `. To go back instead: mistri deploy rollback ${previous.id.slice(0, 8)}` : ''}.`,
      );

    runner.say(
      `Rolling the container until /readyz reports deploy ${id.slice(0, 8)} and build ${built.buildId} (up to ${Math.round(flags.rollTimeoutMs / 60_000)} min)...`,
    );
    const rolled = await rollTo(
      runner,
      plan.worker.url,
      { deployId: id, buildId: built.buildId },
      runner.env(flags.restartTokenEnv)!,
      flags.rollTimeoutMs,
    );
    if (!rolled.ok) return await serving(`the container never reported the new fingerprint: last saw ${rolled.saw}.`);

    const problems = await smoke(runner, plan.worker.url, plan.config.smoke);
    if (problems.length) return await serving(`smoke failed: ${problems.join(' ')}`);

    await ledger.finish(id, { finishedAt: new Date(runner.now()).toISOString(), result: 'ok', note: null });
    runner.say(`Deployed ${id} (${plan.worker.url}).`);
    await ledger.close();
    return 0;
  } catch (error) {
    return await fail((error as Error).message);
  }
}
