/**
 * `mistri audit reads`: the read audit of an App whose resources say
 * `audit: { reads: true }`, newest first, one JSON object a line, so it
 * pipes into jq or a file as it is. Read straight from the database the
 * audited resources sit on (readAuditStore.ts): no server is started, and
 * the store is never made here (`mistri migrate stores up` makes it).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const AUDIT_USAGE = `mistri audit reads [--app <dir>] [--resource <name>] [--record <id>] [--actor <who>]
                   [--tenant <id>] [--since <instant | 30m | 24h | 7d>] [--limit <n>]
                   [<db> | --db <target> | --config <path>]`;

const HELP = `${AUDIT_USAGE}

  Prints the reads recorded for the App's audited resources, newest first,
  one JSON object a line: when, who (actor, and a support visit's id), the
  roles it read under and, on a tenant App, its membership, the
  tenant, the resource, the route it came by (a command's own reads: route
  "command" and the command's id), and the one record read or the query with
  the count and ids of the rows it returned. Field values are never recorded.

  --resource <name>  only this resource
  --record <id>      only reads of this one record, by its key: read alone,
                     or among the rows a list read returned
  --actor <who>      only this reader: an account id, service:<principal>,
                     support:<operator>, api-token:<id> or assistant:<account>
  --tenant <id>      only this tenant's rows, on a tenant App
  --since <when>     only rows written since: an ISO instant, or an age
                     (30m, 24h, 7d)
  --limit <n>        at most n rows (1 to 10000; default 1000)
Exit codes: 1 could not run.`;

const AGE = /^(\d{1,6})([mhd])$/;
const UNIT = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** `--since` as an ISO instant: one given, or an age counted back from `now`. */
export function sinceInstant(value: string, now: number): string | undefined {
  const age = AGE.exec(value);
  if (age) return new Date(now - Number(age[1]) * UNIT[age[2] as keyof typeof UNIT]).toISOString();
  return /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}

export async function runAuditCommand(
  argv: readonly string[],
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  now: () => number = Date.now,
): Promise<number> {
  const fail = (why: string) => {
    console.error(`mistri audit: ${why}`);
    return 1;
  };
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    write(HELP);
    return argv.length ? 0 : 1;
  }
  if (argv[0] !== 'reads') return fail(`"${argv[0]}" is not an audit command.\n${AUDIT_USAGE}`);
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (['--app', '--resource', '--record', '--actor', '--tenant', '--since', '--limit'].includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return fail(`${arg} needs a value.\n${AUDIT_USAGE}`);
      if (Object.hasOwn(flags, arg)) return fail(`${arg} may be supplied only once.`);
      flags[arg] = value;
      i++;
      continue;
    }
    rest.push(arg);
  }
  const appDir = resolve(flags['--app'] ?? '.');
  if (!existsSync(appDir)) return fail(`${flags['--app']} is not a directory.`);
  let since: string | undefined;
  if (flags['--since'] !== undefined) {
    since = sinceInstant(flags['--since'], now());
    if (since === undefined)
      return fail(`--since takes an ISO instant or an age such as 30m, 24h or 7d; "${flags['--since']}" is neither.`);
  }
  let limit = 1000;
  if (flags['--limit'] !== undefined) {
    limit = Number(flags['--limit']);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) return fail('--limit is a whole number from 1 to 10000.');
  }

  const [{ parseArgs }, { readStartupConfig }, { Registry, redact }] = await Promise.all([
    import('@mistriwork/engine/server/cli/args.js'),
    import('@mistriwork/engine/server/cli/config.js'),
    import('@mistriwork/engine/server/connections.js'),
  ]);
  const opts = parseArgs(rest);
  if (opts.unknown) return fail(`unknown option "${opts.unknown}".\n${AUDIT_USAGE}`);
  const registry = new Registry();
  // The database is read the way a start reads it; its narration is not this command's to print.
  const log = console.log;
  console.log = () => {};
  try {
    const { CONFIG_SECTIONS } = await import('../serviceConnections.js');
    const config = await readStartupConfig(opts, registry, CONFIG_SECTIONS);
    if (opts.target) registry.add({ name: redact(opts.target), url: opts.target, schemas: opts.schemas, source: 'argument' });
    const [{ loadApp }, { appEntrypoint }, { auditedResources, readAppReadAudit }] = await Promise.all([
      import('../app/apps.js'),
      import('../app/appEntrypoint.js'),
      import('../readAuditStore.js'),
    ]);
    let loaded: Awaited<ReturnType<typeof loadApp>>;
    try {
      loaded = await loadApp(appDir, {
        ...(opts.appEntry !== undefined ? { entry: opts.appEntry } : {}),
        ...(config.appEnv[appDir] ? { env: config.appEnv[appDir] } : {}),
        ...(opts.commands !== undefined ? { commands: opts.commands } : {}),
      });
    } catch (error) {
      return fail(`the App in ${flags['--app'] ?? appDir} did not load: ${(error as Error).message.split('\n')[0]}`);
    }
    const app = loaded.app;
    const audited = auditedResources(app);
    if (!audited.length) return fail(`${app.id} audits the reads of no resource: give one \`audit: { reads: true }\`.`);
    const resource = flags['--resource'];
    if (resource !== undefined && !audited.includes(resource))
      return fail(`${app.id} does not audit reads of "${resource}"; it audits ${audited.join(', ')}.`);
    const host = { app: loaded, pages: [] };
    if (!appEntrypoint(host, registry)) return fail(`no connection serves ${app.id}: name one with --config, --db or <db>.`);
    const rows = await readAppReadAudit(registry, host, {
      ...(resource !== undefined ? { resource } : {}),
      ...(flags['--record'] !== undefined ? { record: flags['--record'] } : {}),
      ...(flags['--actor'] !== undefined ? { actor: flags['--actor'] } : {}),
      ...(flags['--tenant'] !== undefined ? { tenant: flags['--tenant'] } : {}),
      ...(since !== undefined ? { since } : {}),
      limit,
    });
    // The query and its ids are kept as JSON text; printed as JSON, so a line reads as one object.
    for (const row of rows)
      write(JSON.stringify({ ...row, ...(row.query !== undefined ? { query: JSON.parse(row.query), ids: JSON.parse(row.ids!) } : {}) }));
    return 0;
  } catch (error) {
    return fail((error as Error).message.split('\n')[0]);
  } finally {
    console.log = log;
    await registry.closeAll().catch(() => {});
  }
}
