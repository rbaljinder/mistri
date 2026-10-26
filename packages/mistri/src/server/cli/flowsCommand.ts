/**
 * `mistri flows start`: start a resource's `created` flows on records that
 * were there before the flows were. The records are read here
 * and each is enqueued for the App's flows runner (workflows/flowStarts.ts);
 * the server started with `--jobs` runs them. No server is loaded: the App
 * is read for its resource and source, and the jobs module for its runner
 * and store.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const FLOWS_USAGE = `mistri flows start <resource> --app <dir> --jobs <file>
                     [--where <query>] [--flow <id>] [--tenant <id> --policy <file>] [--dry-run]
                     [<db> | --db <target> | --config <path>]`;

const HELP = `${FLOWS_USAGE}

  Starts the resource's flows that start when a record is created, on the
  records already there, as though each had just been created: one dispatch
  per record, enqueued in the App's job store for its flowRunner, and run by
  the server started with --jobs. Each flow's own condition still decides.
  Running it again starts nothing new.

  --where <query>  only these records, in the query language over the
                   record's own columns: 'status = open and priority = high'
  --flow <id>      only this flow (a row of the flows table that starts on
                   created)
  --tenant <id>    on a tenant App, that tenant's records, under its service;
                   one tenant a run. --policy names the App's tenant policy,
                   whose ownership says which column holds the tenant.
  --dry-run        count the records; enqueue nothing
Exit codes: 1 could not run.`;

/* A tenant's id, as the tenant store spells one (flowChanges.ts): never the platform's. */
const TENANT = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const FLOW = /^[A-Za-z0-9_-]{1,64}$/;

export async function runFlowsCommand(
  argv: readonly string[],
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<number> {
  const fail = (why: string) => {
    console.error(`mistri flows: ${why}`);
    return 1;
  };
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    write(HELP);
    return argv.length ? 0 : 1;
  }
  if (argv[0] !== 'start') return fail(`"${argv[0]}" is not a flows command.\n${FLOWS_USAGE}`);
  const resource = argv[1];
  if (resource === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(resource))
    return fail(`name the resource whose flows start: mistri flows start <resource> …\n${FLOWS_USAGE}`);
  const flags: Record<string, string> = {};
  let dryRun = false;
  const rest: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (['--app', '--jobs', '--where', '--flow', '--tenant', '--policy'].includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return fail(`${arg} needs a value.\n${FLOWS_USAGE}`);
      if (Object.hasOwn(flags, arg)) return fail(`${arg} may be supplied only once.`);
      flags[arg] = value;
      i++;
      continue;
    }
    rest.push(arg);
  }
  const appDir = flags['--app'] !== undefined ? resolve(flags['--app']) : undefined;
  if (appDir === undefined) return fail(`name the App with --app <dir>.\n${FLOWS_USAGE}`);
  if (!existsSync(appDir)) return fail(`${flags['--app']} is not a directory.`);
  const jobsFile = flags['--jobs'];
  if (jobsFile === undefined) return fail(`name the jobs module that declares the flowRunner with --jobs <file>.\n${FLOWS_USAGE}`);
  const flow = flags['--flow'];
  if (flow !== undefined && !FLOW.test(flow)) return fail('--flow names a flow by its id: letters, digits, "_" and "-".');
  const tenant = flags['--tenant'];
  if (tenant !== undefined && !TENANT.test(tenant)) return fail(`--tenant names a tenant by its id; "${tenant}" is not one.`);

  const [{ parseArgs }, { readStartupConfig }, { Registry, redact }] = await Promise.all([
    import('@mistriwork/engine/server/cli/args.js'),
    import('@mistriwork/engine/server/cli/config.js'),
    import('@mistriwork/engine/server/connections.js'),
  ]);
  const opts = parseArgs(rest);
  if (opts.unknown) return fail(`unknown option "${opts.unknown}".\n${FLOWS_USAGE}`);
  const registry = new Registry();
  const releases: Array<() => void> = [];
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
      { loadJobModule, jobStorePolicy },
      { flowRunnersOf },
      { appEntrypoint },
      { loadAppRuntimeResources },
      { tableNamed },
      { parseQuery },
      { storeTargetOf },
      { startFlows },
    ] = await Promise.all([
      import('../app/apps.js'),
      import('../../shared/app.js'),
      import('../jobs/jobLoader.js'),
      import('../workflows/flowChanges.js'),
      import('../app/appEntrypoint.js'),
      import('../app/appRuntimeResources.js'),
      import('@mistriwork/engine/shared/schema.js'),
      import('@mistriwork/engine/shared/query.js'),
      import('../commands/appCommandEvents.js'),
      import('../workflows/flowStarts.js'),
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
    const def = Object.hasOwn(app.resources ?? {}, resource) ? app.resources![resource] : undefined;
    if (!def?.flows) return fail(`${app.id} has no resource "${resource}" with flows.`);
    const module = await loadJobModule(jobsFile);
    const runner = flowRunnersOf(module.workflows).find((each) => each.resource === resource);
    if (!runner) return fail(`${jobsFile} declares no flowRunner('${resource}', …): nothing would run the flows.`);

    // A tenant App's records are started one tenant at a time, the run its record's tenant's (flowChanges.ts).
    let owner: { column: string; tenant: string } | undefined;
    let flowOwner: string | undefined;
    if (isTenantApp(app)) {
      if (tenant === undefined || flags['--policy'] === undefined)
        return fail(`${app.id} is a tenant App: name one tenant with --tenant <id>, and its policy with --policy <file>.`);
      const { tenantColumns } = await import('../files/filesCli.js');
      const columns = await tenantColumns(flags['--policy']);
      const column = columns.get(resource);
      flowOwner = columns.get(def.flows.from);
      if (!column || !flowOwner) return fail(`the policy's ownership must make "${resource}" and "${def.flows.from}" tenant-owned.`);
      owner = { column, tenant };
    } else if (tenant !== undefined || flags['--policy'] !== undefined) {
      return fail(`--tenant and --policy are for a tenant App; ${app.id} is not one.`);
    }

    const home = appEntrypoint({ app: loaded, pages: [] }, registry);
    if (!home) return fail(`no connection serves ${app.id}: name one with --config, --db or <db>.`);
    const resources = await loadAppRuntimeResources(registry, app, home, (id) => releases.push(registry.lease(id)));
    const table = tableNamed(resources.schema, resource);
    const keys = table?.columns.filter((column) => column.primaryKey) ?? [];
    if (!table || keys.length !== 1) return fail(`"${resource}" needs one key column for its flows to run on a record.`);
    const keyColumn = keys[0].name;
    const adapter = resources.forConnection(resources.connectionFor(resource));

    // `--where`, held to what a flow's own condition may say: the record's stored columns, by name (flowRecord.ts).
    let filter: import('@mistriwork/engine/shared/filter.js').Filter | undefined;
    const where = flags['--where']?.trim();
    if (where) {
      const derived = new Set([...Object.keys(def.rollups ?? {}), ...Object.keys(def.computed ?? {})]);
      const narrowed = {
        ...resources.schema,
        tables: [{ ...table, columns: table.columns.filter((column) => !derived.has(column.name)) }],
      };
      const parsed = parseQuery(`${table.id} ${where}`, { schema: narrowed });
      const query = parsed.query;
      if (parsed.errors.length || !query) return fail(`--where: ${parsed.errors[0]?.message ?? 'not a condition'}`);
      if (query.orderBy.length || query.columns.length || query.limit !== undefined || !query.filter.groups.length)
        return fail('--where is a condition only: no sort, columns or limit.');
      if (query.filter.groups.flat().some((condition) => condition.column.includes('.') || condition.other !== undefined))
        return fail("--where reads the record's own columns, compared with values.");
      filter = query.filter;
    }

    if (flow !== undefined) {
      const from = resources.forConnection(resources.connectionFor(def.flows.from));
      const found = await from.query({
        table: resources.toPhysical(def.flows.from),
        columns: ['id', 'start'],
        filter: {
          groups: [
            [
              { column: 'id', op: '=', value: flow },
              ...(flowOwner && owner ? [{ column: flowOwner, op: '=' as const, value: owner.tenant }] : []),
            ],
          ],
        },
        limit: 1,
        offset: 0,
      });
      const row = found.rows[0];
      if (!row) return fail(`there is no flow ${flow} in ${def.flows.from}${owner ? ` of ${owner.tenant}` : ''}.`);
      if (row.start !== 'created')
        return fail(`flow ${flow} starts ${String(row.start)}; flows start runs the flows that start on created.`);
    }

    const target = storeTargetOf(registry.configOf(resources.connectionFor(resource))?.url);
    if (!target) return fail(`the job store is kept on SQLite or PostgreSQL; ${resource}'s source is neither.`);
    const policy = jobStorePolicy(module, app.id);
    let jobs: import('../../adapters/jobs/jobStoreContract.js').JobStore;
    if ('postgres' in target) {
      const [{ PgConnectionManager }, { openPostgresJobStore }] = await Promise.all([
        import('@mistriwork/engine/adapters/postgresPool.js'),
        import('../../adapters/jobs/postgresJobStore.js'),
      ]);
      const pg = new PgConnectionManager(target.postgres);
      closing.push(() => pg.close());
      jobs = await openPostgresJobStore(pg, policy);
    } else {
      const { openSqliteJobStore } = await import('../../adapters/jobs/jobStore.js');
      jobs = openSqliteJobStore(target.sqlite, policy);
    }
    closing.unshift(() => jobs.close());

    const result = await startFlows({
      adapter,
      table: resources.toPhysical(resource),
      keyColumn,
      ...(owner ? { owner } : {}),
      ...(filter ? { filter } : {}),
      jobs,
      appId: app.id,
      runner,
      ...(flow !== undefined ? { flow } : {}),
      now: Date.now,
      dryRun,
    });
    const which = flow !== undefined ? `flow ${flow}` : `the created flows`;
    const whose = owner ? ` of ${owner.tenant}` : '';
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
    if (dryRun) write(`${plural(result.records, `${resource} record`)}${whose} would start ${which}; nothing was enqueued.`);
    else {
      write(
        `${plural(result.records, `${resource} record`)}${whose}: ${result.enqueued} enqueued for ${which}` +
          `${result.already ? `, ${result.already} already enqueued by an earlier run` : ''}.`,
      );
      write('A server started with --jobs runs them; each flow starts where its condition holds.');
    }
    if (result.skipped) write(`${plural(result.skipped, 'record')} skipped: a key no history can keep.`);
    return 0;
  } catch (error) {
    return fail((error as Error).message.split('\n')[0]);
  } finally {
    console.log = log;
    for (const close of closing) await close().catch(() => {});
    for (const release of releases.reverse()) release();
    await registry.closeAll().catch(() => {});
  }
}
