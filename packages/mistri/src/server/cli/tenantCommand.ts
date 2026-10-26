/**
 * `mistri tenant init|grant|clone|import|clock`: a tenant App's first boot
 * and its sandboxes, from the operator's shell or a
 * deployment's one-off job, with no TypeScript runner. The deployment is validated as a start
 * validates it (tenantStartup.ts), which also judges the App's clone marks,
 * and each step is one journaled maintenance transaction under
 * `maintenance:<operator>` (tenantMaintenance.ts). No server is started.
 *
 * `import` only reads: it prints what an import would change and what
 * conflicts. Applying it is the live tenant's owner's decision, made in
 * Manage tenants through that tenant's own membership, never here.
 */
import { refusalHeadline } from '@mistriwork/engine/shared/refusal.js';
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';

const TENANT_USAGE = `mistri tenant init [<tenant>...] --app <dir> --policy <file>
       mistri tenant grant <email> --roles <role,...> [--tenant <id>] [--name <name>] [--days <n>]
                 --app <dir> --policy <file>
       mistri tenant clone <source> <sandbox> --app <dir> --policy <file> [--samples]
       mistri tenant import <sandbox> --app <dir> --policy <file>
       mistri tenant clock <sandbox> --app <dir> --policy <file> --ahead <duration> [--rate <n>]
                 [--operator <name>] [--commands <file>] [<db> | --db <target> | --config <path>]`;

const HELP = `${TENANT_USAGE}

  init    A first boot: opens the platform realm (when the App declares
          one) and puts each named tenant, active. One already there is
          left as it is, so init runs again after a stop part-way.
  grant   Grants <email> a membership: of the platform realm, or with
          --tenant of that tenant, with --roles of that realm's roles, for
          --days days (default 180, at most 366). An address with no
          account yet gets one in the App's auth store, with the password
          in MISTRI_ACCOUNT_PASSWORD (never on the command line) and
          --name (default: the address before its @).
  clone   Makes <sandbox>, a new tenant, from a copy of <source>: the rows of
          every resource the App marks clone: 'config', and with --samples
          those marked clone: 'sample' too. Ids are rewritten so the copy
          names only its own rows; the sandbox is marked as one to its
          members. Grant its members as for any tenant.
  import  Prints what importing <sandbox> into the tenant it was cloned
          from would change, and each row that conflicts. Nothing is
          written: the live tenant's owner approves an import in Manage
          tenants.
  clock   Sets <sandbox>'s dev clock: it reads --ahead (30m, 12h, 3d, or
          milliseconds) ahead of real time, and runs --rate times as fast
          from now (default 1). Its machine timers fall due on it. Only a
          sandbox has one; --ahead 0 sets it back to real time.
  --operator <name>  who ran the step, for the receipt (default: your login)
Exit codes: 1 could not run.`;

const TENANT = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const COMMANDS = new Set(['init', 'grant', 'clone', 'import', 'clock']);
const FLAGS = ['--app', '--policy', '--operator', '--ahead', '--rate', '--roles', '--tenant', '--name', '--days'];
const DURATION = /^(\d+)(ms|s|m|h|d)?$/;
const UNIT: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export async function runTenantCommand(
  argv: readonly string[],
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<number> {
  const fail = (why: string) => {
    console.error(`mistri tenant: ${why}`);
    return 1;
  };
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    write(HELP);
    return argv.length ? 0 : 1;
  }
  const command = argv[0];
  if (!COMMANDS.has(command)) return fail(`"${command}" is not a tenant command.\n${TENANT_USAGE}`);
  // init names any number of tenants, grant one address, clone two tenants, the others one.
  let wanted = command === 'clone' ? 2 : 1;
  if (command === 'init') {
    wanted = 0;
    while (1 + wanted < argv.length && !argv[1 + wanted].startsWith('-')) wanted++;
  }
  const tenants = argv.slice(1, 1 + wanted);
  const email = command === 'grant' ? tenants[0] : undefined;
  if (command === 'grant') {
    if (email === undefined || !/^[^\s@]+@[^\s@]+$/.test(email)) return fail(`grant names an email address.\n${TENANT_USAGE}`);
  } else if (tenants.length !== wanted || tenants.some((id) => !TENANT.test(id)))
    return fail(
      `${command} names ${command === 'clone' ? 'the source tenant and the new sandbox' : command === 'init' ? 'its tenants' : 'a sandbox'} by id: a–z, 0–9, "_" and "-".\n${TENANT_USAGE}`,
    );
  const flags: Record<string, string> = {};
  let samples = false;
  const rest: string[] = [];
  for (let i = 1 + wanted; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--samples') {
      samples = true;
      continue;
    }
    if (FLAGS.includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return fail(`${arg} needs a value.\n${TENANT_USAGE}`);
      if (Object.hasOwn(flags, arg)) return fail(`${arg} may be supplied only once.`);
      flags[arg] = value;
      i++;
      continue;
    }
    rest.push(arg);
  }
  if (samples && command !== 'clone') return fail('--samples is for clone.');
  if (command !== 'grant' && ['--roles', '--tenant', '--name', '--days'].some((flag) => flags[flag] !== undefined))
    return fail(`--roles, --tenant, --name and --days are grant's.\n${TENANT_USAGE}`);
  if (command === 'grant' && !flags['--roles']) return fail(`grant needs --roles.\n${TENANT_USAGE}`);
  if (flags['--tenant'] !== undefined && !TENANT.test(flags['--tenant']))
    return fail('--tenant names a tenant by id: a–z, 0–9, "_" and "-".');
  const days = flags['--days'] === undefined ? 180 : /^[1-9][0-9]{0,2}$/.test(flags['--days']) ? Number(flags['--days']) : NaN;
  if (!(days <= 366)) return fail('--days is a whole number of days, 1 to 366.');
  if (
    (flags['--ahead'] !== undefined || flags['--rate'] !== undefined) !== (command === 'clock') ||
    (command === 'clock' && !flags['--ahead'])
  )
    return fail(`--ahead and --rate are clock's, and clock needs --ahead.\n${TENANT_USAGE}`);
  const appDir = flags['--app'] !== undefined ? resolve(flags['--app']) : undefined;
  if (appDir === undefined || flags['--policy'] === undefined)
    return fail(`name the App with --app <dir> and its policy with --policy <file>.\n${TENANT_USAGE}`);
  if (!existsSync(appDir)) return fail(`${flags['--app']} is not a directory.`);
  const operator = flags['--operator'] ?? userInfo().username.replace(/[^A-Za-z0-9._@-]/g, '-');
  let ahead = 0,
    rate = 1;
  if (command === 'clock') {
    const duration = DURATION.exec(flags['--ahead']);
    if (!duration) return fail('--ahead is a duration: 30m, 12h, 3d, or milliseconds.');
    ahead = Number(duration[1]) * UNIT[duration[2] ?? 'ms'];
    if (flags['--rate'] !== undefined) {
      if (!/^[1-9][0-9]*$/.test(flags['--rate'])) return fail('--rate is a whole number, 1 or more.');
      rate = Number(flags['--rate']);
    }
  }

  const [{ parseArgs }, { readStartupConfig }, { Registry, redact }] = await Promise.all([
    import('@mistriwork/engine/server/cli/args.js'),
    import('@mistriwork/engine/server/cli/config.js'),
    import('@mistriwork/engine/server/connections.js'),
  ]);
  const opts = parseArgs(rest);
  if (opts.retired) return fail(opts.retired);
  if (opts.unknown) return fail(`unknown option "${opts.unknown}".\n${TENANT_USAGE}`);
  const registry = new Registry();
  // The deployment is validated the way a start validates it; its narration is not this command's to print.
  const log = console.log;
  console.log = () => {};
  try {
    const { CONFIG_SECTIONS } = await import('../serviceConnections.js');
    const config = await readStartupConfig(opts, registry, CONFIG_SECTIONS);
    if (opts.target) registry.add({ name: redact(opts.target), url: opts.target, schemas: opts.schemas, source: 'argument' });
    const [{ loadApp }, { prepareTenantStartup }] = await Promise.all([import('../app/apps.js'), import('../tenant/tenantStartup.js')]);
    // Awaited on its own, so the names read from it are ones knip can follow.
    const maintenance = await import('../tenant/tenantMaintenance.js');
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
    if (loaded.app.auth?.rows !== 'tenant') return fail(`${loaded.app.id} is not a tenant App (auth.rows: 'tenant').`);
    const prepared = await prepareTenantStartup({
      loaded,
      connections: registry.configs(),
      policyFile: flags['--policy'],
      ...(opts.commands ? { commandsFile: opts.commands } : {}),
    });
    const { source, policy } = prepared.enrollment;
    const where = 'url' in source && source.url ? { postgres: source.url } : { sqlite: (source as { existingPath: string }).existingPath };
    const binding = { appId: loaded.app.id, source: { id: source.id, connection: source.connection }, storeId: policy.storeId };
    const { cloneTenantSandbox, readSandboxImport, setSandboxClock } = maintenance;
    if (command === 'init') {
      // A row already there is left as it is: a new row's step refuses one that exists (STALE), and nothing is written.
      const put = async (label: string, step: () => Promise<{ receiptId: string }>) => {
        try {
          write(`${label}: opened. Receipt ${(await step()).receiptId}.`);
        } catch (error) {
          if (!(error instanceof maintenance.TenantMaintenanceRefusal) || error.message !== maintenance.STALE) throw error;
          write(`${label}: already there, left as it is.`);
        }
      };
      if (loaded.app.auth?.tenancy?.platform)
        await put('the platform realm', () =>
          maintenance.setPlatformStatus(where, binding, { status: 'active', expectedVersion: null, operator }),
        );
      for (const tenantId of tenants)
        await put(tenantId, () => maintenance.putTenant(where, binding, { tenantId, status: 'active', expectedVersion: null, operator }));
      if (!tenants.length && !loaded.app.auth?.tenancy?.platform)
        write(`${loaded.app.id} declares no platform realm, and no tenant was named: nothing to open.`);
      return 0;
    }
    if (command === 'grant') {
      const app = appDir;
      let accountId = await maintenance.findAppAccount(app, email!);
      if (accountId === null) {
        // A password on the command line would be in the shell's history and the process list.
        const password = process.env.MISTRI_ACCOUNT_PASSWORD;
        if (!password) return fail(`${email} has no account yet: set MISTRI_ACCOUNT_PASSWORD to the password it is made with.`);
        [accountId] = await maintenance.createAppAccounts(app, [
          { email: email!, name: flags['--name'] ?? email!.split('@')[0], password },
        ]);
        write(`${email}: an account was made in ${loaded.app.id}'s auth store.`);
      }
      const roles = flags['--roles']
        .split(',')
        .map((role) => role.trim())
        .filter(Boolean);
      const validUntil = Date.now() + days * 86_400_000;
      const tenantId = flags['--tenant'];
      const granted = tenantId
        ? await maintenance.grantTenantMembership(where, binding, { app, tenantId, accountId, roles, validUntil, operator })
        : await maintenance.grantPlatformMembership(where, binding, { app, accountId, roles, validUntil, operator });
      write(
        `${email}: ${roles.join(', ')} of ${tenantId ?? 'the platform realm'} until ${new Date(validUntil).toISOString().slice(0, 10)}. Receipt ${granted.receiptId}.`,
      );
      return 0;
    }
    if (command !== 'clock' && !prepared.clone)
      return fail(`${loaded.app.id} marks no resource clone: there is nothing a clone would copy.`);
    if (command === 'clone') {
      const [from, to] = tenants;
      const result = await cloneTenantSandbox(where, binding, {
        plan: prepared.clone!,
        sourceTenantId: from,
        tenantId: to,
        samples,
        operator,
      });
      const total = Object.values(result.rows).reduce((sum, n) => sum + n, 0);
      write(`${to}: a sandbox of ${from}, ${total} row${total === 1 ? '' : 's'} copied${samples ? ', samples included' : ''}.`);
      for (const [resource, n] of Object.entries(result.rows)) write(`  ${resource}: ${n}`);
      write(`Receipt ${result.receiptId}. Grant its members as for any tenant.`);
    } else if (command === 'import') {
      const plan = await readSandboxImport(where, binding, { plan: prepared.clone!, sandboxTenantId: tenants[0] });
      write(
        `Importing ${tenants[0]} into ${plan.tenantId} would add ${plan.inserted}, change ${plan.updated} and remove ${plan.deleted} row(s).`,
      );
      for (const [resource, counts] of Object.entries(plan.resources))
        write(`  ${resource}: +${counts.inserted} ~${counts.updated} -${counts.deleted}`);
      if (plan.conflicts.length) {
        write(`${plan.conflicts.length}${plan.truncated ? '+' : ''} conflict(s); the import would apply nothing:`);
        for (const conflict of plan.conflicts) write(`  ${conflict.resource} ${conflict.key}: ${conflict.reason}`);
      }
      write(`${plan.tenantId}'s owner approves the import in Manage tenants.`);
    } else {
      const result = await setSandboxClock(where, binding, { tenantId: tenants[0], skewMs: ahead, rate, operator });
      write(
        ahead === 0 && rate === 1
          ? `${tenants[0]} reads real time again.`
          : `${tenants[0]} reads ${flags['--ahead']} ahead of real time${rate > 1 ? `, running ${rate} times as fast` : ''}. Receipt ${result.receiptId}.`,
      );
    }
    return 0;
  } catch (error) {
    /* The fixed sentence with the reason a refusal recorded (a tenant denial's own), on the operator's terminal, with
       the lines that say what to change: a first boot is run by someone who has to act on them. */
    return fail(refusalHeadline(error));
  } finally {
    console.log = log;
    await registry.closeAll().catch(() => {});
  }
}
