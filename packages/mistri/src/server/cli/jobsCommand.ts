/**
 * `mistri jobs run <name>`: an operator runs one of an App's jobs at times now, rather than waiting for its slot
 * or writing a test to do it (OP9). The run is enqueued in the App's job store as a manual run (jobManualRun.ts) and
 * run by the server started with --jobs, through the runner, principal, grants and journal its slots use; the store
 * runs a job at times one at a time, so it never overlaps the schedule's own run of the job. The command waits for
 * the run's first attempt to end and says how it ended. No server is loaded here: the App is read for its commands
 * and sources, the jobs module for the job and its store.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const JOBS_USAGE = `mistri jobs run <name> --app <dir> --jobs <file> [--wait <seconds>]
                    [<db> | --db <target> | --config <path>]`;

const HELP = `${JOBS_USAGE}

  Runs one of the App's jobs at times now, once: enqueued in its job store as
  a manual run, beside the slots the schedule enqueues, and run by the server
  started with --jobs, as the job's principal, journaled as a slot's run is.
  A job at times runs one at a time: while the schedule's run of it holds its
  lease, this one waits for it, and the next slot waits for this one. A name
  that is not one of the App's jobs at times is refused with the names that
  are. A tenant App's jobs run per tenant and are not run by hand.

  --wait <seconds> how long to wait for the run to end (default 60; 0: enqueue
                   and return)
Exit codes: 1 could not run, 2 still waiting when --wait ran out (the server
started with --jobs runs it), 3 the run did not succeed.`;

/** Exit codes, as the help says them. */
const EXIT = { ok: 0, couldNot: 1, waiting: 2, failed: 3 } as const;

export async function runJobsCommand(
  argv: readonly string[],
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<number> {
  const fail = (why: string) => {
    console.error(`mistri jobs: ${why}`);
    return EXIT.couldNot;
  };
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    write(HELP);
    return argv.length ? EXIT.ok : EXIT.couldNot;
  }
  if (argv[0] !== 'run') return fail(`"${argv[0]}" is not a jobs command.\n${JOBS_USAGE}`);
  const name = argv[1];
  if (name === undefined || name.startsWith('-')) return fail(`name the job to run: mistri jobs run <name> …\n${JOBS_USAGE}`);
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (['--app', '--jobs', '--wait'].includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return fail(`${arg} needs a value.\n${JOBS_USAGE}`);
      if (Object.hasOwn(flags, arg)) return fail(`${arg} may be supplied only once.`);
      flags[arg] = value;
      i++;
      continue;
    }
    rest.push(arg);
  }
  const appDir = flags['--app'] !== undefined ? resolve(flags['--app']) : undefined;
  if (appDir === undefined) return fail(`name the App with --app <dir>.\n${JOBS_USAGE}`);
  if (!existsSync(appDir)) return fail(`${flags['--app']} is not a directory.`);
  const jobsFile = flags['--jobs'];
  if (jobsFile === undefined) return fail(`name the jobs module that declares the job with --jobs <file>.\n${JOBS_USAGE}`);
  const waitText = flags['--wait'] ?? '60';
  if (!/^\d{1,5}$/.test(waitText)) return fail('--wait is a number of seconds, 0 to 99999.');
  const waitMs = Number(waitText) * 1000;

  const [{ parseArgs }, { readStartupConfig }, { Registry, redact }] = await Promise.all([
    import('@mistriwork/engine/server/cli/args.js'),
    import('@mistriwork/engine/server/cli/config.js'),
    import('@mistriwork/engine/server/connections.js'),
  ]);
  const opts = parseArgs(rest);
  if (opts.unknown) return fail(`unknown option "${opts.unknown}".\n${JOBS_USAGE}`);
  const registry = new Registry();
  const closing: Array<() => Promise<unknown>> = [];
  // The database is read the way a start reads it; its narration is not this command's to print.
  const log = console.log;
  console.log = () => {};
  try {
    const { CONFIG_SECTIONS } = await import('../serviceConnections.js');
    const config = await readStartupConfig(opts, registry, CONFIG_SECTIONS);
    if (opts.target) registry.add({ name: redact(opts.target), url: opts.target, schemas: opts.schemas, source: 'argument' });
    const [
      { loadApp },
      { isTenantApp },
      { servedJobModule, jobDeployment },
      { jobToRun, enqueueManualRun, findRun, attemptEnded },
      { loadBusinessCommands },
      { withCommandVersions },
      { lockedVersion },
      { storeTargetOf },
      { resolveConnection },
    ] = await Promise.all([
      import('../app/apps.js'),
      import('../../shared/app.js'),
      import('../jobs/jobLoader.js'),
      import('../jobs/jobManualRun.js'),
      import('../commands/businessCommandLoader.js'),
      import('../commands/businessCommands.js'),
      import('../commands/commandContracts.js'),
      import('../commands/appCommandEvents.js'),
      import('@mistriwork/engine/server/auth/credentials.js'),
    ]);
    let loaded: Awaited<ReturnType<typeof loadApp>>;
    try {
      loaded = await loadApp(appDir, {
        ...(opts.appEntry !== undefined ? { entry: opts.appEntry } : {}),
        ...(config.appEnv[appDir] ? { env: config.appEnv[appDir] } : {}),
        ...(opts.commands !== undefined ? { commands: opts.commands } : {}),
      });
    } catch (error) {
      return fail(`the App in ${flags['--app']} did not load: ${(error as Error).message.split('\n')[0]}`);
    }
    const app = loaded.app;
    if (isTenantApp(app)) return fail(`${app.id} is a tenant App: its jobs at times run per tenant, on their schedule.`);
    const commands =
      loaded.commands?.registry ??
      (opts.commands !== undefined
        ? withCommandVersions(await loadBusinessCommands(opts.commands), lockedVersion(loaded.authority?.lock))
        : undefined);
    if (!commands)
      return fail(`a job runs one of the App's commands, and ${app.id} has none: keep commands.ts beside it or pass --commands.`);
    const module = await servedJobModule(jobsFile, app, commands);
    const job = jobToRun(module, name);
    if (typeof job === 'string') return fail(job);

    // The job store sits beside the commands its jobs run, as a start finds it (jobLoader.ts prepareJobs).
    const deployment = jobDeployment(module, { appId: app.id, commands });
    const connectionName = app.sources?.[deployment.sourceId]?.connection ?? app.connection;
    const connection = registry.configs().find((each) => each.id === connectionName || each.name === connectionName);
    if (!connection)
      return fail(`no connection "${connectionName ?? deployment.sourceId}" holds ${app.id}'s job store: name it with --config.`);
    const { url } = await resolveConnection(connection.name, connection.url, { secrets: true });
    const target = storeTargetOf(url);
    if (!target) return fail(`the job store is kept on SQLite or PostgreSQL; source "${deployment.sourceId}" is neither.`);
    let jobs: import('../../adapters/jobs/jobStoreContract.js').JobStore;
    let wake = async () => {};
    if ('postgres' in target) {
      const [{ PgConnectionManager }, { openPostgresJobStore }, { NOTIFY_COMMAND_EVENTS }] = await Promise.all([
        import('@mistriwork/engine/adapters/postgresPool.js'),
        import('../../adapters/jobs/postgresJobStore.js'),
        import('../../adapters/events/postgresCommandEventWake.js'),
      ]);
      const pg = new PgConnectionManager(target.postgres);
      closing.push(() => pg.close());
      jobs = await openPostgresJobStore(pg, deployment.store);
      /* A server listening on the database looks now rather than at its next idle look. */
      wake = () => pg.withWriteClient((client) => client.query(NOTIFY_COMMAND_EVENTS)).then(() => {});
    } else {
      const { openSqliteJobStore } = await import('../../adapters/jobs/jobStore.js');
      jobs = openSqliteJobStore(target.sqlite, deployment.store);
    }
    closing.unshift(() => jobs.close());

    const { id } = await enqueueManualRun(jobs, app.id, job, Date.now());
    await wake().catch(() => {});
    write(`${job.id}: a manual run enqueued in ${app.id}'s job store.`);
    if (waitMs === 0) {
      write('A server started with --jobs runs it, after any run of the job that holds its lease.');
      return EXIT.ok;
    }
    const deadline = Date.now() + waitMs;
    for (;;) {
      /* The server is writing the same store while this looks: on SQLite a look can meet its write and fail. A look
         that fails is a look that saw nothing yet, until the deadline, which then says what the last one met. */
      let ended: ReturnType<typeof attemptEnded>;
      try {
        ended = attemptEnded(await findRun(jobs, job.id, id));
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((done) => setTimeout(done, 250));
        continue;
      }
      if (ended) {
        if (ended.state === 'succeeded') {
          write(`${job.id}: succeeded.`);
          return EXIT.ok;
        }
        write(`${job.id}: ${ended.state}${ended.lastCode ? ` (${ended.lastCode})` : ''}. The server's log says why.`);
        return EXIT.failed;
      }
      if (Date.now() > deadline) {
        write(
          `${job.id}: still waiting after ${waitText}s. A server started with --jobs runs it (after any run of the job ` +
            'that holds its lease); none has yet.',
        );
        return EXIT.waiting;
      }
      await new Promise((done) => setTimeout(done, 250));
    }
  } catch (error) {
    return fail((error as Error).message.split('\n')[0]);
  } finally {
    console.log = log;
    for (const close of closing) await close().catch(() => {});
    await registry.closeAll().catch(() => {});
  }
}
