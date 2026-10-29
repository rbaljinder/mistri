/**
 * `mistri decide eval <decision>`: a provider measured on the records whose
 * answer people already settled, before it is trusted to apply (design §6).
 *
 * The records are read as the decision reads them — through its answer
 * command, as its principal — so what is sent here is what the server would
 * send. Where the App keeps a history of the target, each record's inputs are
 * put back as they were just before a person set the answer, so the answer
 * cannot leak into what the model is shown; where it does not, the inputs are
 * as they are now, and the report says how many.
 *
 * It spends the operator's money, so it says how much first: the count and a
 * price that errs high, refused without `--yes` and above `--max-cost`
 * (default $5); `--dry` prints exactly what one record would send and asks
 * nothing. It writes nothing and never applies. `--pin` writes the pin into
 * decisions.lock only when the share it would apply was wrong at most
 * `--max-error` of the time (default 2%).
 */
import { SMALL_STORE_POOL } from '@mistriwork/engine/adapters/connectionBudget.js';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StoredRecordChange } from '../../adapters/history/recordHistory.js';

const USAGE = `mistri decide eval <decision> --app <dir> --jobs <file> [--provider jev|anthropic] [--limit <n>]
                    [--truth "<query>"] [--max-cost <dollars>] [--max-error <share>] [--dry] [--yes]
                    [--pin] [--json <file>] [--policy <file>] [<db> | --db <target> | --config <path>]`;

const HELP = `${USAGE}

  Asks a provider about records whose answer people settled, and reports how
  often it was right and how honest its probabilities were: accuracy, Brier,
  expected calibration error, a reliability table, and what the declared
  thresholds would have applied, suggested and left.

  --truth <query>    which records' answers are settled, in the query language
                     over the target (default: every record with the field set)
  --limit <n>        at most this many records (default 500, at most 5,000)
  --provider <name>  who is asked (default the decision's first provider)
  --max-cost <$>     refuse to start, and stop, past this spend (default 5)
  --max-error <p>    the applied share's error a pin allows (default 0.02)
  --dry              print what one record would send, and ask nothing
  --yes              spend: without it, only the estimate is printed
  --pin              write the provider's model version into decisions.lock
                     when the applied share's error is within --max-error
  --json <file>      write the report as JSON
  --policy <file>    a row-policy App's policy: the decision reads only the
                     rows its service may, as it does when served

The provider's key is read from the environment (JEV_API_KEY,
ANTHROPIC_API_KEY). Nothing is written to the database and nothing applies.
Exit codes: 1 could not run, 2 not spent (no --yes, or over --max-cost),
3 --pin asked and not earned.`;

const EXIT = { ok: 0, couldNot: 1, unspent: 2, unpinned: 3 } as const;
const VALUED = ['--app', '--jobs', '--provider', '--limit', '--truth', '--max-cost', '--max-error', '--json'];
const FLAGS = ['--dry', '--yes', '--pin'];

export async function runDecideCommand(
  argv: readonly string[],
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<number> {
  const fail = (why: string) => {
    console.error(`mistri decide: ${why}`);
    return EXIT.couldNot;
  };
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    write(HELP);
    return argv.length ? EXIT.ok : EXIT.couldNot;
  }
  if (argv[0] !== 'eval') return fail(`"${argv[0]}" is not a decide command.\n${USAGE}`);
  const name = argv[1];
  if (name === undefined || name.startsWith('-')) return fail(`name the decision: mistri decide eval <decision> …\n${USAGE}`);
  const flags: Record<string, string> = {};
  const set = new Set<string>();
  const rest: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (FLAGS.includes(arg)) {
      set.add(arg);
      continue;
    }
    if (VALUED.includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return fail(`${arg} needs a value.\n${USAGE}`);
      if (Object.hasOwn(flags, arg)) return fail(`${arg} may be supplied only once.`);
      flags[arg] = value;
      i++;
      continue;
    }
    rest.push(arg);
  }
  const appDir = flags['--app'] === undefined ? undefined : resolve(flags['--app']);
  if (appDir === undefined) return fail(`name the App with --app <dir>.\n${USAGE}`);
  if (!existsSync(appDir)) return fail(`${flags['--app']} is not a directory.`);
  const jobsFile = flags['--jobs'];
  if (jobsFile === undefined) return fail(`name the jobs module that declares the decision with --jobs <file>.\n${USAGE}`);
  const limit = flags['--limit'] === undefined ? 500 : Number(flags['--limit']);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) return fail('--limit is a whole number of records from 1 to 5,000.');
  const maxCost = flags['--max-cost'] === undefined ? 5 : Number(flags['--max-cost'].replace(/^\$/, ''));
  if (!Number.isFinite(maxCost) || maxCost <= 0 || maxCost > 10_000) return fail('--max-cost is a number of dollars above 0.');
  const maxError = flags['--max-error'] === undefined ? undefined : Number(flags['--max-error']);
  if (maxError !== undefined && (!Number.isFinite(maxError) || maxError < 0 || maxError >= 1))
    return fail('--max-error is a share from 0 to below 1: 0.02 is 2%.');
  if (set.has('--dry') && (set.has('--yes') || set.has('--pin'))) return fail('--dry asks nothing: it goes without --yes and --pin.');

  const [{ parseArgs }, { readStartupConfig }, { Registry, redact }] = await Promise.all([
    import('@mistriwork/engine/server/cli/args.js'),
    import('@mistriwork/engine/server/cli/config.js'),
    import('@mistriwork/engine/server/connections.js'),
  ]);
  const opts = parseArgs(rest);
  if (opts.unknown) return fail(`unknown option "${opts.unknown}".\n${USAGE}`);
  const registry = new Registry();
  const closing: Array<() => unknown> = [];
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
      { servedJobModule },
      { loadBusinessCommands },
      { withCommandVersions },
      { lockedVersion },
      { appEntrypoint },
      { registryJobBinding },
      { serviceActor },
      { loadAppRuntimeResources },
    ] = await Promise.all([
      import('../app/apps.js'),
      import('../../shared/app.js'),
      import('../jobs/jobLoader.js'),
      import('../commands/businessCommandLoader.js'),
      import('../commands/businessCommands.js'),
      import('../commands/commandContracts.js'),
      import('../app/appEntrypoint.js'),
      import('../jobs/jobHost.js'),
      import('../jobs/jobAuthorization.js'),
      import('../app/appRuntimeResources.js'),
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
    if (isTenantApp(app))
      return fail(
        `${app.id} is a tenant App: its records are its customers'. Evaluate on a consented export of one tenant's records, served as an ordinary App.`,
      );
    /* A row-policy App's decision reads as it would serve: its service's rows and no others, so the policy is named
       here as a start names it. Without it the reads would be the database's whole, which the service never sees. */
    const rowPolicy = (await import('../../shared/appModel.js')).isRowPolicyApp(app);
    if (rowPolicy && opts.policy === undefined)
      return fail(
        `${app.id} reads its rows under a policy: name it with --policy <file>, so the decision reads only the rows its service may.`,
      );
    const commands =
      loaded.commands?.registry ??
      (opts.commands !== undefined
        ? withCommandVersions(await loadBusinessCommands(opts.commands), lockedVersion(loaded.authority?.lock))
        : undefined);
    if (!commands)
      return fail(
        `a decision lands through one of the App's commands, and ${app.id} has none: keep commands.ts beside it or pass --commands.`,
      );
    const module = await servedJobModule(jobsFile, app, commands);
    const decision = module.decisions?.get(name);
    if (!decision)
      return fail(
        `"${name}" is not one of the jobs module's decisions${module.decisions?.size ? `: ${[...module.decisions.keys()].join(', ')}` : ''}.`,
      );

    const [
      { answerSpec, decisionReads },
      { readDue, readRecord, isEmpty },
      { askEvaluation, estimateMicros, evaluationText, scoreDecision },
      { decisionDigests, decisionLockDirectory },
      { decisionLockPath, readDecisionLock, readDecisionLockFile, withPin, writeDecisionLock },
      { decisionProviders },
      { logicalResource },
    ] = await Promise.all([
      import('../decide/decisionChecks.js'),
      import('../decide/decideReads.js'),
      import('../decide/decisionEval.js'),
      import('../decide/decisionCheck.js'),
      import('../decide/decisionLock.js'),
      import('../decide/providers/decisionProviders.js'),
      import('../../shared/app.js'),
    ]);
    const providerName = (flags['--provider'] ?? decision.providers[0]) as (typeof decision.providers)[number];
    if (!['jev', 'anthropic'].includes(providerName)) return fail('--provider is jev or anthropic.');

    // Read as the decision reads: its principal, through its answer command.
    const owner = appEntrypoint({ app: loaded, pages: [] }, registry);
    if (!owner) return fail(`no one connection holds ${app.id}: name it with --config.`);
    let policy: import('../policy/appPolicyHttp.js').HttpAppPolicy | undefined;
    if (rowPolicy) {
      const [{ loadHttpAppPolicy }, { policyStartupLines }] = await Promise.all([
        import('../policy/appPolicyHttp.js'),
        import('./policyStartup.js'),
      ]);
      try {
        /* A command that declares events binds to the App's event store under a policy, as a start binds it; the eval
           runs none, but the policy is loaded whole or not at all. */
        const { appCommandEventsFor } = await import('../commands/appCommandEvents.js');
        const held: Array<() => void> = [];
        closing.push(() => held.reverse().forEach((release) => release()));
        const events = await appCommandEventsFor(
          app,
          commands,
          await loadAppRuntimeResources(registry, app, owner, (id) => held.push(registry.lease(id))),
          (id) => registry.configOf(id)?.url,
        );
        policy = await loadHttpAppPolicy({
          registry,
          app,
          file: opts.policy!,
          commands,
          services: module.principals,
          ...(events ? { events } : {}),
          verifySession: async () => null,
        });
      } catch (error) {
        // Said as a start says it: the policy's own refusal, or the App's cause beneath.
        return fail((await policyStartupLines(error, loaded)).join('\n'));
      }
      const retiring = policy;
      closing.push(() => retiring.retire());
    }
    const served = policy;
    const bound = await registryJobBinding({ registry, app: () => app, owner, commands, ...(served ? { policy: () => served } : {}) })(
      undefined,
      decision.runAs,
    );
    closing.push(() => bound.release());
    const roles = module.principals.get(decision.runAs) ?? [];
    const authorized = bound.binding.authorize(decision.answer.command.id, serviceActor(app.id, decision.runAs, roles));
    const releases: Array<() => void> = [];
    closing.push(() => releases.reverse().forEach((release) => release()));
    const schema = (await loadAppRuntimeResources(registry, app, owner, (id) => releases.push(registry.lease(id)))).schema;
    const spec = answerSpec(authorized.command, decision.answer.field);
    if (typeof spec === 'string') return fail(`"${decision.answer.command.id}" ${spec}.`);
    const reads = decisionReads(decision, app, schema);
    if (!reads.reads) return fail(reads.problems.join(' '));
    const planned = { name: decision.name, field: decision.answer.field, reads: reads.reads, spec };
    const local = (logical: string) =>
      Object.keys(authorized.catalog).find((each) => logicalResource(app, authorized.command.source, each) === logical);

    const now = new Date();
    const keys = await readDue(authorized, flags['--truth'], limit, now);
    const history = await historyOf(registry, app, authorized.command.source);
    if (history) closing.push(() => history.close());
    const items: Array<{
      inputs: Record<string, unknown>;
      answer: import('../decide/providers/decisionProvider.js').DecisionAnswerType;
      truth: unknown;
    }> = [];
    let leaked = 0;
    for (const key of keys) {
      const read = await readRecord(authorized, local, [planned], key, now);
      const truth = read?.current.get(decision.name);
      if (!read || isEmpty(truth)) continue;
      const inputs = { ...(read.inputs.get(decision.name) ?? {}) };
      const rebuilt = history ? await asSettled(history, local(decision.target) ?? decision.target, read.key, decision, inputs) : false;
      if (!rebuilt) leaked += 1;
      items.push({ inputs, answer: read.answers.get(decision.name)!, truth });
    }
    if (!items.length)
      return fail(
        `no record of ${decision.target} has "${decision.answer.field}" settled${flags['--truth'] ? ` where ${flags['--truth']}` : ''}: there is nothing to measure against.`,
      );
    if (leaked)
      write(
        `warning: ${leaked} of ${items.length} records are asked about as they are now, not as they were when their answer was settled` +
          `${history ? '' : ` (${app.id} keeps no history of ${decision.target})`}: an answer that changed the record since may flatter the result.`,
      );

    if (set.has('--dry')) {
      const first = items[0];
      write(`One record of ${items.length}, as it would be sent to ${providerName} (nothing is sent):`);
      write(JSON.stringify({ question: decision.question, inputs: first.inputs, answer: first.answer }, null, 2));
      return EXIT.ok;
    }

    const providers = decisionProviders();
    const provider = providers[providerName];
    if (!provider)
      return fail(
        `${providerName} is not reachable: set ${providerName === 'jev' ? 'JEV_API_KEY' : 'ANTHROPIC_API_KEY'} in the environment.`,
      );
    const estimate = estimateMicros(provider, decision, items);
    write(`${items.length} records to ask ${providerName}, about $${(estimate / 1e6).toFixed(2)} at most.`);
    if (estimate > maxCost * 1e6) {
      write(`That is above --max-cost $${maxCost}: nothing was asked. Lower --limit or raise --max-cost.`);
      return EXIT.unspent;
    }
    if (!set.has('--yes')) {
      write('Nothing was asked: run again with --yes to spend it.');
      return EXIT.unspent;
    }
    const asked = await askEvaluation(provider, decision, items, { budgetMicros: maxCost * 1e6 });
    if (asked.stopped) write(`warning: stopped after ${asked.examples.length} records: ${asked.stopped}.`);
    const evaluation = scoreDecision(decision, asked.examples, {
      provider: providerName,
      model: asked.model,
      modelVersion: asked.modelVersion,
      units: asked.units,
      costMicros: asked.costMicros,
      ...(maxError === undefined ? {} : { maxError }),
    });
    write(evaluationText(evaluation));
    if (flags['--json']) writeFileSync(resolve(flags['--json']), `${JSON.stringify(evaluation, null, 2)}\n`);

    if (!set.has('--pin')) return EXIT.ok;
    if (!evaluation.pinnable) {
      write(`Not pinned: ${evaluation.why}.`);
      return EXIT.unpinned;
    }
    const directory = decisionLockDirectory(loaded);
    if (!directory) return fail(`${app.id} has no directory to keep decisions.lock in.`);
    const path = decisionLockPath(directory);
    const before = readDecisionLockFile(path);
    const lock = readDecisionLock(before);
    const digest = decisionDigests(module.decisions!.values(), commands).get(decision.name)!;
    const locked = lock.get(decision.name);
    if (locked && locked.digest !== digest) {
      write(
        `Not pinned: "${decision.name}" changed since decisions.lock was written. Run mistri check --write-authority (with --bump ${decision.name}) first.`,
      );
      return EXIT.unpinned;
    }
    const pinned = withPin(lock, decision.name, digest, {
      provider: providerName,
      modelVersion: evaluation.modelVersion,
      error: evaluation.thresholds.applied.errorRate,
      n: evaluation.thresholds.applied.n,
      at: now.toISOString().slice(0, 10),
    });
    await writeDecisionLock(path, pinned, before);
    write(`Pinned ${providerName} ${evaluation.modelVersion} for "${decision.name}" in ${path}: it applies from the next start.`);
    return EXIT.ok;
  } catch (error) {
    return fail((error as Error).message.split('\n')[0]);
  } finally {
    console.log = log;
    for (const close of closing.reverse()) await Promise.resolve(close()).catch(() => {});
    await registry.closeAll().catch(() => {});
  }
}

interface HistoryReader {
  read(resource: string, key: string): Promise<StoredRecordChange[]>;
  close(): Promise<void>;
}

/** The App's record history on the source the decision's command writes, when it keeps one. */
async function historyOf(
  registry: import('@mistriwork/engine/server/connections.js').Registry,
  app: import('../../shared/app.js').AppDef,
  source: string | undefined,
): Promise<HistoryReader | undefined> {
  const connectionName = (source && app.sources?.[source]?.connection) ?? app.connection;
  const connection = registry.configs().find((each) => !connectionName || each.id === connectionName || each.name === connectionName);
  if (!connection) return undefined;
  const [{ resolveConnection }, { storeTargetOf }] = await Promise.all([
    import('@mistriwork/engine/server/auth/credentials.js'),
    import('../commands/appCommandEvents.js'),
  ]);
  const target = storeTargetOf((await resolveConnection(connection.name, connection.url, { secrets: true })).url);
  if (!target) return undefined;
  const limit = 200;
  if ('postgres' in target) {
    const [{ PgConnectionManager }, { postgresRecordHistoryReady, readPostgresRecordHistory }] = await Promise.all([
      import('@mistriwork/engine/adapters/postgresPool.js'),
      import('../../adapters/history/postgresRecordHistory.js'),
    ]);
    const pg = new PgConnectionManager(target.postgres, undefined, undefined, SMALL_STORE_POOL);
    const ready = await pg.withWriteClient((client) => postgresRecordHistoryReady(client)).catch(() => false);
    if (!ready) {
      await pg.close();
      return undefined;
    }
    return {
      read: (resource, key) => pg.withWriteClient((client) => readPostgresRecordHistory(client, { resource, key, limit }, true)),
      close: () => pg.close(),
    };
  }
  const [{ DatabaseSync }, { sqliteRecordHistoryReady, readSqliteRecordHistory }] = await Promise.all([
    import('node:sqlite'),
    import('../../adapters/history/sqliteRecordHistory.js'),
  ]);
  const db = new DatabaseSync(target.sqlite, { readOnly: true });
  if (!sqliteRecordHistoryReady(db)) {
    db.close();
    return undefined;
  }
  return {
    read: async (resource, key) => readSqliteRecordHistory(db, { resource, key, limit }, true),
    close: async () => db.close(),
  };
}

/**
 * The inputs put back as they were just before a person settled the answer:
 * the earliest write that gave the field a value is the moment, and every
 * input that write or a later one changed is given its value from before.
 * True when every input could be put back (or never changed since); false
 * when the history is silent, cut or redacted for one, or an input is read
 * through a path or a rollup, which its own table's history would have to
 * say.
 */
async function asSettled(
  history: HistoryReader,
  resource: string,
  key: Readonly<Record<string, string | number>>,
  decision: import('../decide/decisionModule.js').CapturedDecision,
  inputs: Record<string, unknown>,
): Promise<boolean> {
  const { historyKey } = await import('../../adapters/history/recordHistory.js');
  let changes: StoredRecordChange[];
  try {
    changes = await history.read(resource, historyKey(key));
  } catch {
    return false;
  }
  // Newest first: the settling write is the oldest one that set the field to something.
  const settled = changes.findLastIndex((change) =>
    change.changes.some((each) => each.c === decision.answer.field && !each.r && each.a !== undefined && each.a !== null && each.a !== ''),
  );
  if (settled < 0) return false;
  let whole = decision.inputs.every((input) => !input.includes('.'));
  const since = changes.slice(0, settled + (changes[settled].kind === 'insert' ? 0 : 1));
  for (const input of decision.inputs) {
    for (const change of since) {
      const found = change.changes.find((each) => each.c === input);
      if (!found) continue;
      if (found.r || found.t || found.b === undefined) {
        whole = false;
        continue;
      }
      inputs[input] = found.b;
    }
  }
  return whole;
}
