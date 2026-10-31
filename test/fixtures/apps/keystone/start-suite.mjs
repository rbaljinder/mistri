/** Source-checkout launcher: one identity, explicit grants, six Apps, one listener.
 * Setup is deliberately one-shot. A failed setup needs a new runtime and database. */
import { spawn } from 'node:child_process';
import { Console } from 'node:console';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  closeSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertPlacementEnrollment,
  enrollPlacement,
  inspectPlacementSource,
  placementOrigin,
  placementSecretEnv,
} from './placement-launcher.mjs';

const here = dirname(fileURLToPath(import.meta.url)),
  root = resolve(here, '../../../..');
const ids = ['lender', 'leads', 'dealer', 'site', 'marketplace', 'customer'];
const usage =
  'Usage: node --import tsx test/fixtures/apps/keystone/start-suite.mjs --runtime <directory> [--setup --database <empty-postgres-url> | --upgrade-placement] [--public-origin https://<staff-host> --site-host <dealer-host>] [--port 4880] [--photos featured|all|none]\nSetup and additive --upgrade-placement require explicit HTTPS origin and Site host (TLS proxy to the loopback listener). Upgrade provisions only placement and exits; resume uses the persisted enrollment.';
const options = {},
  args = process.argv.slice(2);
const print = console.log.bind(console),
  report = console.error.bind(console);
const secret = () => randomBytes(32).toString('base64url');
const json = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Cannot read runtime JSON file: ${path}`);
  } // Parse errors can quote secrets.
};
const save = (path, value) => {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
};
let suite,
  seed,
  log,
  stopping = false;
function running() {
  if (stopping) throw new Error('Startup was stopped.');
}
async function stop(code = 0) {
  stopping = true;
  process.exitCode = Math.max(process.exitCode ?? 0, code);
  if (seed && seed.exitCode === null && seed.signalCode === null) {
    const child = seed,
      exited = once(child, 'close');
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 8000);
    try {
      await exited;
    } finally {
      clearTimeout(force);
    }
  }
  await suite?.close();
}
function privateTree(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
    throw new Error('Runtime must contain only regular files and directories.');
  chmodSync(path, stat.isDirectory() ? 0o700 : 0o600);
  if (stat.isDirectory()) for (const name of readdirSync(path)) privateTree(join(path, name));
}

async function main() {
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (['--setup', '--upgrade-placement', '--help'].includes(flag)) options[flag.slice(2)] = true;
    else if (
      ['--runtime', '--database', '--port', '--photos', '--public-origin', '--site-host'].includes(flag) &&
      args[i + 1] &&
      !args[i + 1].startsWith('--')
    )
      options[flag.slice(2)] = args[++i];
    else throw new Error('Unknown or incomplete option. Use --help.');
  }
  if (options.help) {
    print(usage);
    return;
  }
  if (!options.runtime) throw new Error(usage);
  if (options.setup && options['upgrade-placement']) throw new Error('--setup and --upgrade-placement are mutually exclusive.');
  const enrolling = options.setup || options['upgrade-placement'];
  if (enrolling && (!options['public-origin'] || !options['site-host']))
    throw new Error('Setup/upgrade requires --public-origin and --site-host. Use --help.');
  if (!enrolling && (options['public-origin'] || options['site-host']))
    throw new Error('Placement origins are enrolled only by --setup or --upgrade-placement.');
  if (enrolling) placementOrigin(options['public-origin'], options['site-host']);
  const port = Number(options.port ?? 4880),
    photos = options.photos ?? 'featured';
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port must be an integer from 1024 to 65535.');
  if (!['featured', 'all', 'none'].includes(photos)) throw new Error('--photos must be featured, all, or none.');
  if (options.database && !options.setup) throw new Error('--database is only accepted with --setup.');
  const runtime = resolve(options.runtime),
    stateFile = join(runtime, 'runtime.json');
  const suiteFile = join(runtime, 'suite.json'),
    connectionsFile = join(runtime, 'connections.json');
  const credentialsFile = join(runtime, 'credentials.json'),
    logFile = join(runtime, 'logs', 'suite.log');
  // Also covers SQLite sidecars and files written by the seed or library APIs.
  process.umask(0o077);
  let state;
  if (options.setup) {
    if (existsSync(runtime)) throw new Error('Setup needs a new runtime directory and an empty dedicated database.');
    let database;
    try {
      database = new URL(options.database);
    } catch {
      throw new Error('Setup requires --database <empty-postgres-url>.');
    }
    if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname || database.pathname.length < 2)
      throw new Error('Setup requires an explicit PostgreSQL database URL.');
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    state = { version: 1, ready: false, database: options.database, identitySecret: secret(), auditSecret: secret() };
    save(stateFile, state); // A seed failure must never become a restartable runtime.
  } else {
    state = json(stateFile);
    if (state.version !== 1 || state.ready !== true || !existsSync(suiteFile))
      throw new Error('Runtime is not ready at version 1. Use a fresh runtime and database after failed setup.');
    if (typeof state.database !== 'string' || typeof state.identitySecret !== 'string' || typeof state.auditSecret !== 'string')
      throw new Error('Runtime state is incomplete.');
    for (const path of [connectionsFile, credentialsFile])
      if (!existsSync(path)) throw new Error('Runtime files are incomplete; refusing to reprovision.');
    if (!enrolling && !state.publicPlacement)
      throw new Error(
        'Legacy runtime requires explicit --upgrade-placement --public-origin https://<staff-host> --site-host <dealer-host> before resume.',
      );
    privateTree(runtime);
  }
  mkdirSync(join(runtime, 'logs'), { recursive: true, mode: 0o700 });
  log = createWriteStream(logFile, { flags: 'a', mode: 0o600 });
  await once(log, 'open');
  // Library diagnostics and seed output stay in private logs, never on the terminal.
  const logger = new Console(log);
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = logger[method].bind(logger);
  log.on('error', () => {
    report('Keystone log write failed.');
    void stop(1).catch(() => {});
  });
  print(`Log: ${logFile}`);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      void stop().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    });
  if (options.setup) {
    const fd = openSync(join(runtime, 'logs', 'seed.log'), 'wx', 0o600);
    try {
      seed = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          join(root, 'test/fixtures/databases/keystone/seed-postgres.mjs'),
          state.database,
          connectionsFile,
          '--photos',
          photos,
        ],
        { cwd: root, env: { ...process.env }, stdio: ['ignore', fd, fd] },
      );
      const [code] = await once(seed, 'close');
      if (code !== 0) throw new Error('Seed failed. See seed.log; use a fresh runtime and database.');
    } finally {
      closeSync(fd);
      seed = undefined;
    }
    running();
    save(connectionsFile, { connections: [{ name: 'keystone', url: '${KEYSTONE_DATABASE_URL}', writable: true }] });
    save(suiteFile, {
      port,
      identity: {
        id: 'keystone',
        name: 'Keystone',
        store: './identity.db',
        grants: './grants.db',
        environment: { BETTER_AUTH_SECRET: 'SECRET' },
        // Where each account lands from the suite's address: lender staff at Lender,
        // dealership staff with a Leads membership at the lead desk, managers at Dealer.
        landing: [
          { app: 'lender', roles: ['credit_manager', 'underwriter', 'funder', 'servicing', 'relationship_manager', 'admin'] },
          { app: 'leads', member: true },
          { app: 'dealer', roles: ['manager'] },
          { app: 'customer', roles: ['borrower'] },
        ],
      },
      apps: ids.map((id) => ({
        id,
        directory: join(here, id),
        mount: id === 'lender' ? '/' : `/${id}`,
        config: './connections.json',
        ...(['dealer', 'customer', 'marketplace', 'site'].includes(id) ? { policy: join(here, id, 'policy.ts') } : {}),
        ...(id === 'leads' ? { policy: join(here, id, 'server/tenant-policy.ts'), jobs: join(here, id, 'server/jobs.ts') } : {}),
        environment: { KEYSTONE_DATABASE_URL: 'DATABASE', ...(id === 'leads' ? { MISTRI_AUDIT_KEY: 'AUDIT' } : {}) },
      })),
    });
  }
  let deployment = json(suiteFile);
  if (options.port !== undefined) deployment = { ...deployment, port };
  const sourceIdentity = await inspectPlacementSource(state.database, !enrolling);
  if (enrolling) {
    const { DEALER } = await import('./site/dealer.ts');
    const enrolled = enrollPlacement(state, deployment, {
      publicOrigin: options['public-origin'],
      siteHost: options['site-host'],
      policy: join(here, 'site/policy.ts'),
      tenant: DEALER.id,
      sourceIdentity,
    });
    state = enrolled.state;
    deployment = enrolled.deployment;
  } else assertPlacementEnrollment(state, deployment, sourceIdentity);
  const environment = Object.freeze({
    DATABASE: state.database,
    SECRET: state.identitySecret,
    AUDIT: state.auditSecret,
    [placementSecretEnv]: state.publicPlacement.secret,
  });
  // Pin Site's logical source to the same physical database inspected/provisioned
  // above. Do not silently enroll a hand-edited connection file under that identity.
  const site = deployment.apps.find((app) => app.id === 'site');
  const connections = json(resolve(runtime, site.config)).connections;
  if (
    site.environment?.KEYSTONE_DATABASE_URL !== 'DATABASE' ||
    !connections?.some(
      (connection) => connection.name === 'keystone' && connection.url === '${KEYSTONE_DATABASE_URL}' && connection.writable === true,
    )
  ) {
    throw new Error('Site placement requires the launcher-owned writable keystone connection.');
  }
  const { readSuiteConfiguration } = await import('../../../../packages/mistri/src/server/cli/suiteConfig.ts');
  const checkFile = join(runtime, `.suite-check-${randomBytes(8).toString('hex')}.json`);
  let config;
  try {
    save(checkFile, deployment);
    config = await readSuiteConfiguration(checkFile, environment);
  } finally {
    rmSync(checkFile, { force: true });
  }
  if (!config.identity) throw new Error('Runtime has no shared identity.');
  if (!options.setup)
    for (const path of [config.identity.store, config.identity.grants]) {
      if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).size === 0)
        throw new Error('Identity stores are missing; refusing to reprovision.');
    }
  if (enrolling) {
    save(stateFile, state); // Persist the dedicated key before journal/config publication; retries reuse it.
    const { provisionPostgresPublicPlacementJournal } =
      await import('../../../../packages/mistri/src/adapters/commands/publicPlacementSchema.ts');
    await provisionPostgresPublicPlacementJournal(state.database);
  }
  if (options.setup) await provision(config, environment, credentialsFile);
  if (enrolling || options.port !== undefined) save(suiteFile, deployment);
  running();
  privateTree(runtime);
  if (options['upgrade-placement']) {
    print(
      `Placement enrolled. Credentials preserved: ${credentialsFile}\nResume: node --import tsx test/fixtures/apps/keystone/start-suite.mjs --runtime ${JSON.stringify(runtime)}`,
    );
    log.end();
    return;
  }
  const { startConfiguredSuite } = await import('../../../../packages/mistri/src/server/cli/suiteCommand.ts');
  suite = await startConfiguredSuite(suiteFile, environment);
  suite.server.on('error', (error) => {
    console.error(error);
    void stop(1).catch((failure) => console.error(failure));
  });
  running(); // A signal during asynchronous startup must close the newly returned suite.
  if (options.setup) {
    state.ready = true;
    save(stateFile, state);
  }
  const siteOrigin = new URL(suite.publicURL);
  siteOrigin.hostname = deployment.hosts.find((host) => host.app === 'site').host;
  print(
    `Suite: ${suite.publicURL}/\nSite: ${siteOrigin.origin}/site/\nLoopback upstream: http://127.0.0.1:${deployment.port}\nChooser: ${suite.publicURL}/_mistri/apps\nCredentials: ${credentialsFile}`,
  );
}

async function provision(config, environment, credentialsFile) {
  // Under --import tsx, the checkout's tsconfig maps these public entrypoints
  // to the same source modules (and capabilities) used by suite startup.
  const {
    migratePostgresTenantStore,
    migratePostgresTenantAdministrationJournal,
    migratePostgresTenantInvitations,
    migratePostgresSupportAudit,
    provisionStores,
  } = await import('@mistriwork/mistri/maintenance');
  const { supportAuditKey } = await import('../../../../packages/mistri/src/server/tenant/tenantSupportAuditContract.ts');
  const { createPostgresTenantAdministration } = await import('../../../../packages/mistri/src/server/tenant/tenantStorePostgres.ts');
  const { TransactionOperations } = await import('../../../../packages/engine/src/adapters/adapter.ts');
  const { loadApp } = await import('../../../../packages/mistri/src/server/app/apps.ts');
  const { loadConfig } = await import('../../../../packages/engine/src/server/connections.ts');
  const { CONFIG_SECTIONS } = await import('../../../../packages/mistri/src/server/serviceConnections.ts');
  const { openSuiteIdentity } = await import('../../../../packages/mistri/src/server/auth/suiteIdentity.ts');
  const { createNativeAccount } = await import('../../../../packages/mistri/src/server/auth/authAccounts.ts');
  const { assignableRoles } = await import('../../../../packages/mistri/src/shared/accountAdministration.ts');
  const { DEALER } = await import('./site/dealer.ts');
  const { default: jobs } = await import('./leads/server/jobs.ts');
  const { default: pg } = await import('pg');
  const deployments = await Promise.all(
    config.apps.map(async (deployment) => ({
      app: await loadApp(deployment.directory, { lock: 'enforce' }),
      basePath: deployment.mount,
      environment: deployment.environment,
      connections: (await loadConfig(deployment.config, CONFIG_SECTIONS)).connections,
    })),
  );
  const leads = deployments.find((item) => item.app.app.id === 'leads').app;
  const binding = { appId: 'leads', source: { id: 'keystone', connection: 'keystone' }, storeId: 'keystone-dealers' };
  // Seed already provisioned command journal, history and inbox. No hosts open yet.
  await migratePostgresTenantStore(environment.DATABASE, binding);
  await migratePostgresTenantAdministrationJournal(environment.DATABASE, binding);
  await migratePostgresTenantInvitations(environment.DATABASE, binding);
  await provisionStores({ postgres: environment.DATABASE }, { app: { tenant: binding } });
  await provisionStores({ postgres: environment.DATABASE }, { app: { tenant: binding, commands: leads.commands.registry }, jobs });
  await migratePostgresSupportAudit(environment.DATABASE, binding, supportAuditKey(environment.AUDIT));
  running();
  const db = new pg.Client({ connectionString: environment.DATABASE });
  try {
    await db.connect();
    const first = async (sql, values = []) => {
      const row = (await db.query(sql, values)).rows[0];
      if (!row) throw new Error('Seed is missing a required demo persona.');
      return row;
    };
    const lender = await first("SELECT id, name, email FROM lender_user WHERE active AND role = 'admin' ORDER BY id LIMIT 1");
    const owner = await first(
      "SELECT id, name, email, dealer_id FROM dealer_user WHERE dealer_id = $1 AND status = 'active' AND role = 'owner' ORDER BY id LIMIT 1",
      [DEALER.id],
    );
    const support = await first(
      "SELECT id, name, email FROM lender_user WHERE active AND role = 'relationship_manager' ORDER BY id LIMIT 1",
    );
    const borrower = await first(
      "SELECT c.id, c.first_name || ' ' || c.last_name AS name, c.email FROM customer c WHERE EXISTS (SELECT 1 FROM loan l WHERE l.customer_id = c.id) ORDER BY c.id LIMIT 1",
    );
    const personas = [
      { persona: 'lender', ...lender, grants: { lender: ['admin'], customer: ['admin'] } },
      { persona: 'owner', ...owner, grants: { leads: ['admin', 'owner'], dealer: ['admin', 'manager'], site: ['admin', 'web_admin'] } },
      { persona: 'support', ...support, grants: { leads: ['dealer_support'], lender: ['relationship_manager'] } },
      { persona: 'borrower', ...borrower, grants: { customer: ['borrower'] } },
      {
        persona: 'shopper',
        name: 'Keystone Demo Shopper',
        email: 'shopper@suite.example.test',
        grants: { marketplace: ['admin', 'customer'] },
      },
    ];
    // Deliberate five-person bootstrap, never an email-based merge or a seed-wide import.
    if (new Set(personas.map((person) => person.email.toLowerCase())).size !== 5)
      throw new Error('Demo personas must have distinct emails.');
    const identity = await openSuiteIdentity(config, deployments);
    try {
      for (const person of personas) {
        running();
        person.password = secret();
        person.accountId = await createNativeAccount(
          identity.native,
          { name: person.name, email: person.email, password: person.password },
          { by: 'maintenance' },
        );
        for (const [appId, roles] of Object.entries(person.grants))
          identity.grants.change({
            subjectId: person.accountId,
            appId,
            roles,
            expectedRevision: 0,
            actorId: 'keystone-suite-setup',
            declaredRoles: assignableRoles(deployments.find((item) => item.app.app.id === appId).app.app.auth),
          });
      }
    } finally {
      identity.close();
    }
    const accounts = Object.fromEntries(personas.map((person) => [person.persona, person.accountId]));
    const dealers = (await db.query('SELECT id, name, status FROM dealer ORDER BY id')).rows;
    const intakeLinks = [],
      validUntil = Date.now() + 365 * 24 * 60 * 60 * 1000;
    const operations = new TransactionOperations();
    await db.query('BEGIN');
    try {
      // Trusted fixture-style operator setup: shared accounts must not be passed to
      // standalone maintenance grants, which would open a different auth store.
      const admin = createPostgresTenantAdministration(db, operations, binding);
      await admin.putPlatform({ status: 'active', expectedVersion: null });
      for (const dealer of dealers) {
        await admin.putTenant({ tenantId: dealer.id, status: 'active', expectedVersion: null });
        if (dealer.status !== 'active') await admin.putTenant({ tenantId: dealer.id, status: 'suspended', expectedVersion: '1' });
        else {
          const address = randomBytes(16).toString('hex');
          await db.query('UPDATE dealer SET intake_address = $1, version = version + 1 WHERE id = $2', [address, dealer.id]);
          intakeLinks.push({ dealer: dealer.name, path: `/leads/form/apply?via=${address}` });
        }
      }
      await admin.putMembership({
        tenantId: owner.dealer_id,
        accountId: accounts.owner,
        membershipId: 'suite-owner',
        roles: ['owner'],
        status: 'active',
        expectedVersion: null,
        validUntil,
      });
      await admin.putPlatformMembership({
        accountId: accounts.support,
        membershipId: 'suite-support',
        roles: ['dealer_support'],
        status: 'active',
        expectedVersion: null,
        validUntil,
      });
      await db.query('UPDATE dealer_user SET account_id = $1, dealer_account_id = $1, version = version + 1 WHERE id = $2', [
        accounts.owner,
        owner.id,
      ]);
      await db.query('UPDATE customer SET account_id = $1, version = version + 1 WHERE id = $2', [accounts.borrower, borrower.id]);
      // schema.sql explicitly declares lender_user.account_id (and no version column).
      await db.query('UPDATE lender_user SET account_id = $1 WHERE id = $2', [accounts.lender, lender.id]);
      await db.query('UPDATE lender_user SET account_id = $1 WHERE id = $2', [accounts.support, support.id]);
      running();
      await operations.finish();
      await db.query('COMMIT');
    } catch (error) {
      await operations.finish().catch(() => {});
      await db.query('ROLLBACK');
      throw error;
    }
    save(credentialsFile, { accounts: personas, membershipValidUntil: new Date(validUntil).toISOString(), intakeLinks });
  } finally {
    await db.end();
  }
}

try {
  await main();
} catch (error) {
  if (log) {
    console.error(error);
    report(
      options.setup
        ? 'Keystone stopped; see the private suite/seed logs. Failed setup requires a fresh runtime and database.'
        : 'Keystone stopped; see the private suite log. A failed placement upgrade can be retried explicitly.',
    );
  } else report(error.message);
  try {
    await stop(1);
  } catch (failure) {
    console.error(failure);
  }
  log?.end();
}
