/**
 * `mistri tenant init|grant|brand|clone|import|clock`: a tenant App's first boot
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
import { existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { collapse, rowsFromCsv, rowsFromFlags, type GrantRow } from './tenantGrantPlan.js';
import { resolve } from 'node:path';

const TENANT_USAGE = `mistri tenant init [<tenant>...] [--app <dir>] --policy <file> [--suite <suite.json> [--subdomain <label>]]
       mistri tenant host list [<tenant>] [--app <dir>] --policy <file>
       mistri tenant host add <tenant> (--subdomain <label> --suite <suite.json> | --host <hostname>) [--primary]
                 [--app <dir>] --policy <file>
       mistri tenant host add <tenant> --custom <hostname> --suite <suite.json> [--app <dir>] --policy <file>
       mistri tenant host verify <tenant> <host> --suite <suite.json> [--app <dir>] --policy <file>
       mistri tenant host remove <host> [--suite <suite.json>] [--app <dir>] --policy <file>
       mistri tenant host primary <tenant> <host> [--app <dir>] --policy <file>
       mistri tenant grant <email> --roles <role,...> [--tenant <id>] [--name <name>] [--days <n>]
                 [--app <dir>] --policy <file>
       mistri tenant grant --account <email>... [--tenant <id>...] --roles <role,...> [--days <n>] [--app <dir>] --policy <file>
       mistri tenant grant --from <file.csv> [--days <n>] [--app <dir>] --policy <file>
       mistri tenant brand <tenant> [--name <name>] [--preset <theme>] [--file <branding.json>]
                 [--app <dir>] --policy <file>
       mistri tenant clone <source> <sandbox> [--app <dir>] --policy <file> [--samples]
       mistri tenant import <sandbox> [--app <dir>] --policy <file>
       mistri tenant clock <sandbox> [--app <dir>] --policy <file> --ahead <duration> [--rate <n>]
                 [--operator <name>] [--commands <file>] [--jobs <file>] [<db> | --db <target> | --config <path>]`;

const HELP = `${TENANT_USAGE}

  init    A first boot: opens the platform realm (when the App declares
          one) and puts each named tenant, active. One already there is
          left as it is, so init runs again after a stop part-way.
  host    The addresses a tenant's public pages answer on (a suite with a
          tenantDomain). list prints them; add gives a tenant a subdomain
          under the suite's tenantDomain (--suite names the suite file, or
          init --suite claims one as the tenant is made, --subdomain
          choosing the label, else the tenant's id) or a whole hostname the
          operator vouches for (--host), or with --custom a domain the
          tenant owns (a suite with customDomains): it waits, pending, for
          the two DNS records list prints, and verify checks them as the
          Domains panel's Check now does. remove takes one away (with
          --suite, releasing a custom domain's certificate); primary picks
          the host a tenant's links are written with. Each change writes a
          receipt, and a running suite reads it within 30 seconds. A label
          that is reserved (www, api, app, admin, mail, auth, static,
          assets, status, docs, the suite's own) or taken is refused.
  grant   Grants <email> a membership: of the platform realm, or with
          --tenant of that tenant, with --roles of that realm's roles, for
          --days days (default 180, at most 366). An address with no
          account yet gets one in the App's auth store, with the password
          in MISTRI_ACCOUNT_PASSWORD (never on the command line) and
          --name (default: the address before its @). The store is the
          one the App names, else mistri dev's once dev has started the
          App there, else a plain start's; grant says which.
          Several at once: repeat --account and --tenant (each account in
          each tenant), or --from names a CSV with the header
          account,tenant,role (an empty tenant is the platform realm;
          several roles are written a|b). Every row is checked first, and
          one that is wrong is listed with the others and none is applied;
          then each tenant is granted in one transaction. An account that
          already holds a membership there is left as it is, so the run can
          be repeated. A running server reads grants from the store as it
          serves: nothing is restarted.
  brand   Saves <tenant>'s branding, checked as a tenant admin's save is
          against the App's branding: --file names the whole value (JSON),
          else the saved one is kept; --name and --preset are laid over
          either. The stored logo is kept. A server sharing the cache
          connection reads it on its next page; one with its own cache
          within five minutes.
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
  --jobs <file>      the App's jobs module, read as its server reads it: an
                     App whose commands call an integration needs it. With a
                     mistri.json, --policy, --commands and --jobs come from it.
Exit codes: 1 could not run.`;

const TENANT = /^[a-z0-9][a-z0-9_-]{0,127}$/;
/** The sign-in store grant reads could not be opened: said as one refusal naming the next step, not a stack. */
class GrantStoreRefusal extends Error {}

const COMMANDS = new Set(['init', 'grant', 'brand', 'clone', 'import', 'clock', 'host']);
const HOST_COMMANDS = new Set(['list', 'add', 'verify', 'remove', 'primary']);
const FLAGS = [
  '--app',
  '--policy',
  '--operator',
  '--ahead',
  '--rate',
  '--roles',
  '--tenant',
  '--name',
  '--days',
  '--preset',
  '--file',
  '--suite',
  '--subdomain',
  '--host',
  '--custom',
  '--account',
  '--from',
];
/** Flags that may be given more than once: grant's accounts and tenants. */
const REPEATED = new Set(['--account', '--tenant']);
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
  // init names any number of tenants, grant one address, clone two tenants, the others one; host's word comes first.
  const sub = command === 'host' ? argv[1] : undefined;
  if (command === 'host' && (sub === undefined || !HOST_COMMANDS.has(sub)))
    return fail(`host is list, add, verify, remove or primary.\n${TENANT_USAGE}`);
  const offset = command === 'host' ? 2 : 1;
  let wanted = command === 'clone' ? 2 : sub === 'primary' || sub === 'verify' ? 2 : 1;
  // grant's address may be given by --account (or --from) instead.
  if (command === 'grant' && (argv[1] === undefined || argv[1].startsWith('-'))) wanted = 0;
  if (command === 'init' || sub === 'list') {
    wanted = 0;
    while (offset + wanted < argv.length && !argv[offset + wanted].startsWith('-')) wanted++;
  }
  const tenants = argv.slice(offset, offset + wanted);
  const email = command === 'grant' ? tenants[0] : undefined;
  if (command === 'grant') {
    if (email !== undefined && !/^[^\s@]+@[^\s@]+$/.test(email)) return fail(`grant names an email address.\n${TENANT_USAGE}`);
  } else if (command === 'host') {
    // remove names a host, primary and verify a tenant and then its host; the others a tenant.
    const pair = sub === 'primary' || sub === 'verify';
    const ids = sub === 'remove' ? [] : pair ? [tenants[0]] : tenants;
    if (tenants.length !== wanted || (sub === 'list' && wanted > 1) || ids.some((id) => !TENANT.test(id)))
      return fail(`host ${sub} names ${sub === 'remove' ? 'a host' : pair ? 'a tenant and its host' : 'a tenant'}.\n${TENANT_USAGE}`);
  } else if (tenants.length !== wanted || tenants.some((id) => !TENANT.test(id)))
    return fail(
      `${command} names ${command === 'clone' ? 'the source tenant and the new sandbox' : command === 'init' ? 'its tenants' : command === 'brand' ? 'a tenant' : 'a sandbox'} by id: a–z, 0–9, "_" and "-".\n${TENANT_USAGE}`,
    );
  const flags: Record<string, string> = {};
  const repeated: Record<string, string[]> = {};
  let samples = false,
    primary = false;
  const rest: string[] = [];
  for (let i = offset + wanted; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--samples') {
      samples = true;
      continue;
    }
    if (arg === '--primary') {
      primary = true;
      continue;
    }
    if (FLAGS.includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return fail(`${arg} needs a value.\n${TENANT_USAGE}`);
      if (REPEATED.has(arg)) (repeated[arg] ??= []).push(value);
      else if (Object.hasOwn(flags, arg)) return fail(`${arg} may be supplied only once.`);
      flags[arg] ??= value;
      i++;
      continue;
    }
    rest.push(arg);
  }
  if (samples && command !== 'clone') return fail('--samples is for clone.');
  if (primary && !(command === 'host' && sub === 'add')) return fail('--primary is for host add.');
  if (
    flags['--suite'] !== undefined &&
    !(command === 'init' || (command === 'host' && (sub === 'add' || sub === 'verify' || sub === 'remove')))
  )
    return fail(`--suite is init's and host add's, verify's and remove's.\n${TENANT_USAGE}`);
  if (flags['--subdomain'] !== undefined && !(command === 'init' || (command === 'host' && sub === 'add')))
    return fail(`--subdomain is init's and host add's.\n${TENANT_USAGE}`);
  if (flags['--host'] !== undefined && !(command === 'host' && sub === 'add')) return fail(`--host is host add's.\n${TENANT_USAGE}`);
  if (flags['--custom'] !== undefined && !(command === 'host' && sub === 'add')) return fail(`--custom is host add's.\n${TENANT_USAGE}`);
  // A tenant's own domain is checked against the suite's customDomains, its targets and its certificates: no suite, no check.
  const custom = command === 'host' && (flags['--custom'] !== undefined || sub === 'verify');
  if (custom && flags['--suite'] === undefined)
    return fail(`host ${sub} of a tenant's own domain reads the suite's customDomains: name the suite with --suite.\n${TENANT_USAGE}`);
  if (primary && flags['--custom'] !== undefined)
    return fail('--primary is for a live host: a custom domain becomes primary once it is live.');
  if (flags['--subdomain'] !== undefined && flags['--suite'] === undefined)
    return fail(`--subdomain is a label under the suite's tenantDomain: name the suite with --suite.\n${TENANT_USAGE}`);
  if (flags['--subdomain'] !== undefined && command === 'init' && tenants.length !== 1)
    return fail('--subdomain names one label, so init with it makes one tenant.');
  if (command === 'host' && sub === 'add' && ['--subdomain', '--host', '--custom'].filter((flag) => flags[flag] !== undefined).length !== 1)
    return fail(`host add names its address by --subdomain, --host or --custom.\n${TENANT_USAGE}`);
  let tenantDomain: Awaited<ReturnType<typeof import('./suiteConfig.js').readSuiteTenantDomain>>;
  let suiteDomains: Awaited<ReturnType<typeof import('./suiteConfig.js').readSuiteCustomDomains>> | undefined;
  if (flags['--suite'] !== undefined) {
    try {
      if (custom || (command === 'host' && sub === 'remove'))
        suiteDomains = await (await import('./suiteConfig.js')).readSuiteCustomDomains(resolve(flags['--suite']));
      else tenantDomain = await (await import('./suiteConfig.js')).readSuiteTenantDomain(resolve(flags['--suite']));
    } catch (error) {
      return fail(
        `${flags['--suite']} could not be read for its ${custom ? 'customDomains' : 'tenantDomain'}: ${(error as Error).message.split('\n')[0]}`,
      );
    }
    if (custom && !suiteDomains?.customDomains)
      return fail(`${flags['--suite']} sets no customDomains, so it takes no tenant's own domain.`);
    if (!custom && command === 'host' && sub === 'add' && !tenantDomain)
      return fail(`${flags['--suite']} sets no tenantDomain, so it has no subdomains to give.`);
  }
  if (command !== 'grant' && ['--roles', '--tenant', '--days', '--account', '--from'].some((flag) => flags[flag] !== undefined))
    return fail(`--roles, --tenant, --days, --account and --from are grant's.\n${TENANT_USAGE}`);
  if (command !== 'grant' && command !== 'brand' && flags['--name'] !== undefined)
    return fail(`--name is grant's and brand's.\n${TENANT_USAGE}`);
  if (command !== 'brand' && (flags['--preset'] !== undefined || flags['--file'] !== undefined))
    return fail(`--preset and --file are brand's.\n${TENANT_USAGE}`);
  if (command === 'brand' && [flags['--name'], flags['--preset'], flags['--file']].every((flag) => flag === undefined))
    return fail(`brand needs --name, --preset or --file.\n${TENANT_USAGE}`);
  let brandingFile: unknown;
  if (flags['--file'] !== undefined) {
    try {
      brandingFile = JSON.parse(readFileSync(resolve(flags['--file']), 'utf8'));
    } catch (error) {
      return fail(`${flags['--file']} is not a JSON branding value: ${(error as Error).message}`);
    }
  }
  const accounts = [...tenants, ...(repeated['--account'] ?? [])];
  let plan: GrantRow[] = [];
  if (command === 'grant') {
    if (flags['--from'] !== undefined) {
      if (accounts.length || repeated['--tenant'] || flags['--roles'] !== undefined)
        return fail(
          `--from carries the accounts, tenants and roles itself: it is not given with an email, --account, --tenant or --roles.\n${TENANT_USAGE}`,
        );
    } else if (!accounts.length) return fail(`grant names an email address, or --account, or --from.\n${TENANT_USAGE}`);
    else if (!flags['--roles']) return fail(`grant needs --roles.\n${TENANT_USAGE}`);
    // Every row is read and judged before anything is opened or written: the whole list is said at once.
    let read: { rows: GrantRow[]; problems: string[] };
    if (flags['--from'] !== undefined) {
      let csv: string;
      try {
        csv = readFileSync(resolve(flags['--from']), 'utf8');
      } catch (error) {
        return fail(`${flags['--from']} could not be read: ${(error as Error).message}`);
      }
      read = rowsFromCsv(csv);
    } else
      read = rowsFromFlags(
        accounts,
        repeated['--tenant'] ?? [],
        flags['--roles']
          .split(',')
          .map((role) => role.trim())
          .filter(Boolean),
      );
    const collapsed = collapse(read.rows);
    const problems = [...read.problems, ...collapsed.problems];
    if (problems.length)
      return fail(
        `nothing was granted; ${problems.length === 1 ? 'one row is' : `${problems.length} rows are`} wrong:\n  ${problems.join('\n  ')}`,
      );
    plan = collapsed.rows;
  }
  const days = flags['--days'] === undefined ? 180 : /^[1-9][0-9]{0,2}$/.test(flags['--days']) ? Number(flags['--days']) : NaN;
  if (!(days <= 366)) return fail('--days is a whole number of days, 1 to 366.');
  if (
    (flags['--ahead'] !== undefined || flags['--rate'] !== undefined) !== (command === 'clock') ||
    (command === 'clock' && !flags['--ahead'])
  )
    return fail(`--ahead and --rate are clock's, and clock needs --ahead.\n${TENANT_USAGE}`);
  const appDir = flags['--app'] !== undefined ? resolve(flags['--app']) : undefined;
  if (appDir === undefined || flags['--policy'] === undefined)
    return fail(`name the App with --app <dir> (or run it in the App's directory) and its policy with --policy <file>.\n${TENANT_USAGE}`);
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
      // As a start loads it: a command that calls an integration is wired by the jobs module, and refused without it.
      ...(opts.jobs !== undefined ? { jobsFile: opts.jobs } : {}),
    });
    const { source, policy } = prepared.enrollment;
    const where = 'url' in source && source.url ? { postgres: source.url } : { sqlite: (source as { existingPath: string }).existingPath };
    const binding = { appId: loaded.app.id, source: { id: source.id, connection: source.connection }, storeId: policy.storeId };
    const { cloneTenantSandbox, readSandboxImport, setSandboxClock } = maintenance;
    if (command === 'init') {
      // Refused before anything is opened: a public form placed by an address this column cannot hold would land in triage for good.
      if (prepared.intakeColumnProblem) return fail(prepared.intakeColumnProblem);
      // A row already there is left as it is: a new row's step refuses one that exists (STALE), and nothing is written.
      const put = async (label: string, step: () => Promise<{ receiptId: string; host?: string }>) => {
        try {
          const done = await step();
          write(`${label}: opened. Receipt ${done.receiptId}.${done.host ? ` Its address is ${done.host}.` : ''}`);
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
        await put(tenantId, () =>
          maintenance.putTenant(where, binding, {
            tenantId,
            status: 'active',
            expectedVersion: null,
            operator,
            // A suite with a tenantDomain gives the tenant its subdomain in the step that makes it.
            ...(tenantDomain ? { tenantDomain, ...(flags['--subdomain'] !== undefined ? { subdomain: flags['--subdomain'] } : {}) } : {}),
          }),
        );
      if (!tenants.length && !loaded.app.auth?.tenancy?.platform)
        write(`${loaded.app.id} declares no platform realm, and no tenant was named: nothing to open.`);
      return 0;
    }
    if (command === 'grant') {
      const app = appDir;
      /* The account is made, found and checked in the store mistri dev signs in to, once dev has started the App
         here, else a plain start's (auth.ts localAuthStore): the same rule shot --as reads by. The store follows
         XDG_CONFIG_HOME, so it is set for this step alone, as shot's own grant does (shotTenant.ts). */
      const { localAuthStore } = await import('../auth/auth.js');
      const local = localAuthStore(loaded);
      const id = loaded.app.id;
      const kept =
        local.kept === 'named'
          ? `the store ${id} names (${local.store})`
          : local.kept === 'dev'
            ? `the store mistri dev keeps for ${id} (${local.store})`
            : `the store a start of ${id} keeps (${local.store}); mistri dev keeps its own once it has started the App, so grant again then to sign in there`;
      const saved = process.env.XDG_CONFIG_HOME;
      if (local.env.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = local.env.XDG_CONFIG_HOME;
      try {
        const refuse = (problems: string[]) =>
          fail(
            `nothing was granted; ${problems.length === 1 ? 'one thing is' : `${problems.length} things are`} wrong:\n  ${problems.join('\n  ')}`,
          );
        // Everything the store can say is asked before anything is written: the tenants are active, each role is
        // its realm's, and every account is there or can be made.
        const { membershipRole } = await import('../tenant/tenantFeatureMembershipRoles.js');
        const active = new Set(await maintenance.readActiveTenants(where, binding));
        const problems: string[] = [];
        for (const row of plan) {
          const realm = row.tenant === null ? 'platform' : 'tenant';
          if (row.tenant === null && !loaded.app.auth?.tenancy?.platform)
            problems.push(`${row.where}: the App declares no platform realm.`);
          else if (row.tenant !== null && !active.has(row.tenant)) problems.push(`${row.where}: ${row.tenant} is not an active tenant.`);
          for (const role of row.roles)
            if (!membershipRole(loaded.app, role, realm))
              problems.push(`${row.where}: "${role}" is not a ${realm}-realm role a person holds.`);
        }
        const found = new Map<string, string | null>();
        for (const address of new Set(plan.map((row) => row.account))) {
          const id = await maintenance.findAppAccount(app, address).catch((error: Error) => {
            // The store grant was pointed at could not be opened: where dev has not started the App, the one command that
            // makes dev's store is the way on, rather than the store's own error alone.
            throw new GrantStoreRefusal(
              `the sign-in store could not be opened (${local.store}): ${error.message.split('\n')[0]}` +
                (local.kept === 'dev' ? '' : `\nStart the App's dev server, then grant again: mistri dev --app ${flags['--app']}`),
            );
          });
          found.set(address, id);
          // A password on the command line would be in the shell's history and the process list.
          if (id === null && !process.env.MISTRI_ACCOUNT_PASSWORD)
            problems.push(`${address} has no account yet: set MISTRI_ACCOUNT_PASSWORD to the password it is made with.`);
        }
        if (problems.length) return refuse(problems);
        const madeNow = new Set<string>();
        let pending = [...found.entries()].filter(([, id]) => id === null).map(([address]) => address);
        for (let attempt = 0; pending.length && attempt < 4; attempt++) {
          const batch = pending.slice(0, 256);
          try {
            const ids = await maintenance.createAppAccounts(
              app,
              batch.map((address) => ({
                email: address,
                name: flags['--name'] ?? address.split('@')[0],
                password: process.env.MISTRI_ACCOUNT_PASSWORD!,
              })),
            );
            batch.forEach((address, index) => {
              found.set(address, ids[index]);
              madeNow.add(address);
            });
            pending = pending.slice(batch.length);
            attempt = -1;
          } catch (error) {
            // Another `tenant grant` running beside this one may have just made one of these accounts: adopt what is there now.
            const still: string[] = [];
            for (const address of batch) {
              const existing = await maintenance.findAppAccount(app, address).catch(() => null);
              if (existing !== null) found.set(address, existing);
              else still.push(address);
            }
            if (still.length === batch.length || attempt === 3) throw error;
            pending = [...still, ...pending.slice(batch.length)];
          }
        }
        for (const [address] of found) {
          write(madeNow.has(address) ? `${address}: an account was made in ${kept}.` : `${address}: the account in ${kept}.`);
        }
        const validUntil = Date.now() + days * 86_400_000;
        const until = new Date(validUntil).toISOString().slice(0, 10);
        // One transaction per tenant (the platform realm is one more): a tenant is granted whole or not at all.
        const groups = new Map<string | null, GrantRow[]>();
        for (const row of plan) groups.set(row.tenant, [...(groups.get(row.tenant) ?? []), row]);
        for (const [tenantId, rows] of groups) {
          const label = tenantId ?? 'the platform realm';
          const byAccount = new Map(rows.map((row) => [found.get(row.account)!, row]));
          let done: Awaited<ReturnType<typeof maintenance.grantMemberships>>;
          try {
            done = await maintenance.grantMemberships(where, binding, {
              app,
              tenantId,
              grants: rows.map((row) => ({ accountId: found.get(row.account)!, roles: row.roles })),
              validUntil,
              operator,
            });
          } catch (error) {
            if (plan.length > 1 && error instanceof maintenance.TenantMaintenanceRefusal)
              return fail(
                `${label} was not granted (${error.message}); the tenants before it were. Running the same command again leaves what they hold as it is.`,
              );
            throw error;
          }
          for (const grant of done.granted)
            write(
              `${byAccount.get(grant.accountId)!.account}: ${byAccount.get(grant.accountId)!.roles.join(', ')} of ${label} until ${until}. Receipt ${grant.receiptId}.`,
            );
          for (const held of done.held) write(`${byAccount.get(held)!.account}: already holds a membership of ${label}, left as it is.`);
          if (plan.length > 1) write(`${label}: granted ${done.granted.length}, already held ${done.held.length}.`);
        }
        return 0;
      } catch (error) {
        if (error instanceof GrantStoreRefusal) return fail(error.message);
        throw error;
      } finally {
        if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = saved;
      }
    }
    if (command === 'host') {
      const seams = suiteDomains?.customDomains ? await import('../http/customDomains.js') : undefined;
      const certificates = seams && (await seams.hostCertificatesFor(suiteDomains!.customDomains!.certificates, process.env));
      const domains =
        seams && certificates
          ? seams.createTenantDomains(
              { where, owner: binding },
              {
                config: suiteDomains!.customDomains!,
                certificates,
                resolver: seams.dohResolver(),
                ...(suiteDomains!.staffHost ? { staffHost: suiteDomains!.staffHost } : {}),
                ...(suiteDomains!.tenantDomain ? { tenantDomain: suiteDomains!.tenantDomain } : {}),
                /* This App's table only: a running suite also refuses a name another App's table holds (http/suite.ts),
                   and its router serves neither of two tables that both hold one live. */
                heldBy: async (host) => {
                  const row = (await maintenance.listTenantHosts(where, binding)).find((each) => each.host === host);
                  return row ? { app: row.app, tenant: row.tenantId } : undefined;
                },
              },
            )
          : undefined;
      const recordsOf = (records: { cname: { name: string; value: string }; txt: { name: string; value: string }; apex: boolean }) => {
        write(`  CNAME  ${records.cname.name}  ${records.cname.value}`);
        write(`  TXT    ${records.txt.name}  ${records.txt.value}`);
        if (records.apex)
          write(`  ${records.cname.name} is a zone's apex: most DNS providers take an ALIAS (or flattened CNAME) there, or use www.`);
      };
      if (sub === 'list') {
        const rows = (await maintenance.listTenantHosts(where, binding)).filter((row) => !tenants.length || row.tenantId === tenants[0]);
        if (!rows.length) write(`${loaded.app.id} has no hosts${tenants.length ? ` for ${tenants[0]}` : ''}.`);
        for (const row of rows) {
          write(
            `${row.host}  ${row.tenantId}  ${row.kind}  ${row.status}${row.primary ? '  primary' : ''}${row.source === 'operator' ? '  operator' : ''}`,
          );
          // A pending domain's TXT is what the tenant has yet to add; the operator's terminal may say it.
          if (row.kind === 'custom' && row.status === 'pending' && row.verifyToken)
            write(`  TXT    _mistri-verify.${row.host}  ${row.verifyToken}`);
        }
      } else if (sub === 'add' && flags['--custom'] !== undefined) {
        const added = await domains!.add(tenants[0], flags['--custom'], operator);
        write(`${added.host}: pending for ${tenants[0]}. Add these records at its DNS provider, then run host verify:`);
        if (added.records) recordsOf(added.records);
      } else if (sub === 'verify') {
        const checked = await domains!.check(tenants[0], tenants[1], operator);
        write(
          checked.outcome === 'unavailable'
            ? `${checked.host}: DNS could not be read just now; nothing changed. Try again shortly.`
            : `${checked.host}: ${checked.status}${checked.outcome === 'failed' ? ' (the records were not found as listed)' : ''}.`,
        );
        if (checked.outcome === 'failed' && checked.records) recordsOf(checked.records);
      } else if (sub === 'add') {
        const added = await maintenance.putTenantHost(where, binding, {
          tenantId: tenants[0],
          operator,
          ...(flags['--subdomain'] !== undefined ? { subdomain: flags['--subdomain'], tenantDomain } : { host: flags['--host'] }),
          ...(primary ? { primary } : {}),
        });
        write(`${added.host}: now ${tenants[0]}'s. Receipt ${added.receiptId}.`);
      } else if (sub === 'remove') {
        const removed = await maintenance.removeTenantHost(where, binding, { host: tenants[0], operator });
        write(`${removed.host}: no longer ${removed.tenantId}'s. Receipt ${removed.receiptId}.`);
        // Only a domain that asked for a certificate has one to give up: a pending claim or an operator's host never did.
        if (removed.kind === 'custom' && removed.source === 'claimed' && removed.status !== 'pending') {
          if (seams && certificates)
            await seams.releaseCertificate(certificates, removed.host, removed.tenantId, (line) => console.error(`mistri tenant: ${line}`));
          else write(`${removed.host} was a custom domain: name the suite with --suite to release its certificate too.`);
        }
      } else {
        const made = await maintenance.setPrimaryTenantHost(where, binding, { tenantId: tenants[0], host: tenants[1], operator });
        write(`${made.host}: ${tenants[0]}'s primary. Receipt ${made.receiptId}.`);
      }
      return 0;
    }
    if (command === 'brand') {
      const { BrandingRefused } = await import('../../shared/tenantBranding.js');
      try {
        const saved = await maintenance.saveTenantBranding(where, binding, {
          app: loaded.app,
          tenantId: tenants[0],
          ...(brandingFile !== undefined ? { value: brandingFile } : {}),
          ...(flags['--name'] !== undefined ? { name: flags['--name'] } : {}),
          ...(flags['--preset'] !== undefined ? { preset: flags['--preset'] } : {}),
          operator,
          // The deployment's cache, so a running server sharing it drops its copy now rather than in five minutes.
          cache: registry.cache(),
        });
        write(`${tenants[0]}: branding saved, revision ${saved.revision}.`);
        return 0;
      } catch (error) {
        if (!(error instanceof BrandingRefused)) throw error;
        // Each sentence names its field; a key the App does not allow is filed under name, so the field is not printed.
        return fail(`${tenants[0]}'s branding was not saved:\n${error.refusals.map((refusal) => `  ${refusal.message}`).join('\n')}`);
      }
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

/** `--export openapi` for a tenant App (oneShot.ts): another of the operator's one-offs, its document judged against the
    policy's ownership (tenantApiExport.ts), loaded only when asked for. */
export async function tenantOpenApi(...args: Parameters<typeof import('../tenant/tenantApiExport.js').tenantAppOpenApi>): Promise<string> {
  const { tenantAppOpenApi } = await import('../tenant/tenantApiExport.js');
  return tenantAppOpenApi(...args);
}
