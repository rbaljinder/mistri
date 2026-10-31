/**
 * `mistri test init [<app-dir>]`: a starter suite for an App, runnable
 * with `node --test`, that uses nothing but `@mistriwork/mistri/testing`.
 *
 * An agent that built an App wrote its own test plumbing — request shapes it
 * got wrong, a readiness wait, an account per role — and that cost more than
 * any page. So the plumbing is the kit's (testing/appRequests.ts,
 * testing/permissions.ts), and this writes the suite on top of it from what
 * the App declares:
 *
 * - tests/start.ts: the App from its directory, over a copy of its database,
 *   with the row policy and jobs modules beside app.ts as production serves
 *   them, and a test value for each secret they name;
 * - tests/journeys.test.ts: a journey per role — sign in, open its home, the
 *   views in its menu and a record, run one command it is granted, and each
 *   machine verb it holds on a record in the state the verb leaves from —
 *   and each job at times run now, as its service;
 * - tests/permissions.test.ts: every role × resource and command, allowed or
 *   refused as authority.lock says — or, for an App with no lock, as the
 *   authority it would hold — after seeding a record of each table a row
 *   needs and the database has none of.
 *
 * A tenant App's people are members of a tenant, not role sessions: its suite is tests/tenants.test.ts, the
 * isolation its tenants are promised (testInitTenant.ts).
 *
 * Under a row policy what a person reaches is the policy's, which nothing
 * here can read: the matrix says what every grant allows or refuses on its
 * own (reads, and every refusal), and a person's writes are their journey's
 * verbs, each skipped and said where the policy gives them no record.
 *
 * What it writes is the author's to change. It refuses to overwrite a file
 * that is there unless --force, and prints each file it wrote.
 */
import { startupReport } from '@mistriwork/engine/shared/refusal.js';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { loadApp, type LoadedApp } from '../app/apps.js';
import { authorityReport } from '../../shared/appAuthority.js';
import { grantsByRole, homeSourceOf, isRowPolicyApp, isTenantApp, logicalResource, navViewKeys, viewOrder } from '../../shared/appModel.js';
import { columnKind, findTable, primaryKey, tableNamed } from '@mistriwork/engine/shared/schema.js';
import { Registry } from '@mistriwork/engine/server/connections.js';
import { CONFIG_SECTIONS } from '../serviceConnections.js';
import type { CapturedJobModule } from '../jobs/jobModule.js';
import type { Options } from '@mistriwork/engine/server/cli/args.js';
import { article } from './article.js';

/**
 * The tests import `node:test` and `node:url`, and TypeScript 7 loads no @types package unless the tsconfig names it:
 * a skill run's `tsc` and check's typecheck read about thirty errors after test init ("Cannot find module
 * 'node:test'", a result whose narrowing was lost). A plain-JSON tsconfig.json that names no `types` is given
 * `["node"]`; one that names others, or is not plain JSON, is said instead of edited. Without @types/node installed
 * where the App resolves it, the install is said.
 */
async function nodeTypesFor(dir: string): Promise<string[]> {
  const said: string[] = [];
  const file = join(dir, 'tsconfig.json');
  if (existsSync(file)) {
    let config: { compilerOptions?: { types?: unknown } } | undefined;
    try {
      config = JSON.parse(await readFile(file, 'utf8')) as typeof config;
    } catch {
      config = undefined;
    }
    const types = config?.compilerOptions?.types;
    if (config && types === undefined) {
      config.compilerOptions = { ...config.compilerOptions, types: ['node'] };
      await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
      said.push(`added "types": ["node"] to ${relative(process.cwd(), file) || file}: the tests import node:test`);
    } else if (!Array.isArray(types) || !types.includes('node'))
      said.push(`note: add "node" to compilerOptions.types in ${relative(process.cwd(), file) || file}: the tests import node:test`);
  }
  try {
    createRequire(join(resolve(dir), 'package.json')).resolve('@types/node/package.json');
  } catch {
    said.push('note: npm install --save-dev @types/node — the tests import node:test, and the typecheck reads its types there');
  }
  return said;
}

const USAGE = 'mistri test init [<app-dir>] [--config <mistri.json>] [--force]';

class Refusal extends Error {}

/** What the lock says, as the matrix and the journeys need it: per role, what it reads, writes and runs. */
interface Grants {
  read: Set<string>;
  write: Set<string>;
  commands: Set<string>;
  /** Fixed actions it runs by name, without writing the table: `table verb`. */
  actions: Set<string>;
  /** Columns it may write, where its grant narrows them, by table. */
  fields: Map<string, string[]>;
}
const blank = (): Grants => ({ read: new Set(), write: new Set(), commands: new Set(), actions: new Set(), fields: new Map() });

/** The authority lines, by role. `null` is everyone an App without role grants serves — signed in or not. */
function grantsOf(lines: string[], app: LoadedApp['app']): Map<string | null, Grants> {
  const roles = new Map<string | null, Grants>();
  const role = (name: string | null) => {
    let found = roles.get(name);
    if (!found) roles.set(name, (found = blank()));
    return found;
  };
  if (!grantsByRole(app)) {
    /* The ceilings are the grant: a declared resource reads, and one with access 'write' writes. */
    const everyone = role(app.auth ? 'admin' : null);
    for (const line of lines) {
      const reads = /^resource (\S+) reads$/.exec(line);
      if (reads) everyone.read.add(reads[1]);
      const writes = /^resource (\S+) access write$/.exec(line);
      if (writes) everyone.write.add(writes[1]);
    }
    return roles;
  }
  const people = new Set(
    Object.entries(app.auth?.roles ?? {})
      .filter(([, declared]) => !(declared as { service?: boolean }).service)
      .map(([name]) => name),
  );
  for (const name of people) role(name);
  for (const line of lines) {
    /* A service role (rent_poster) signs no one in: its work is its job's, run now in the journeys (host.runJob). */
    const named = /^role (\S+) /.exec(line)?.[1];
    if (named && named !== 'admin' && !people.has(named)) continue;
    let match = /^role (\S+) (read|write|command) (\S+)$/.exec(line);
    if (match) {
      const grants = role(match[1]);
      (match[2] === 'read' ? grants.read : match[2] === 'write' ? grants.write : grants.commands).add(match[3]);
      continue;
    }
    match = /^role (\S+) action (\S+) "((?:[^"\\]|\\.)*)"$/.exec(line);
    if (match) {
      role(match[1]).actions.add(`${match[2]} ${JSON.parse(`"${match[3]}"`)}`);
      continue;
    }
    match = /^role (\S+) fields (\S+) write (\S+)$/.exec(line);
    if (match) {
      const fields = role(match[1]).fields;
      fields.set(match[2], [...(fields.get(match[2]) ?? []), match[3]]);
    }
  }
  return roles;
}

/** The facts of the lock, or of the authority the App would lock: each line without who contributes it. */
function authorityFacts(loaded: LoadedApp): { lines: string[]; from: 'lock' | 'report' } {
  const text = loaded.authority?.lock ?? loaded.authority?.report ?? authorityReport(loaded.app, loaded.origins);
  const lines = text
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.replace(/ — .*$/, ''));
  return { lines, from: loaded.authority?.lock !== undefined ? 'lock' : 'report' };
}

interface Verb {
  table: string;
  verb: string;
  label: string;
  from: string;
  to: string;
  command?: string;
  reason?: string;
}

/** Every machine verb of every resource, in the graph's order. */
function machineVerbs(app: LoadedApp['app']): Verb[] {
  const verbs: Verb[] = [];
  for (const [table, resource] of Object.entries(app.resources ?? {})) {
    for (const edge of resource.machine?.edges ?? []) {
      verbs.push({
        table,
        verb: edge.verb,
        label: edge.label,
        from: edge.from,
        to: edge.to.join(' or '),
        ...(edge.command ? { command: edge.command } : {}),
        ...(edge.fixed?.reason ? { reason: edge.fixed.reason } : {}),
      });
    }
  }
  return verbs;
}

/** Whether a role holds a verb: a command it is granted, or a fixed move on a table it writes or is granted by name. */
const holds = (grants: Grants, verb: Pick<Verb, 'table' | 'verb' | 'command'>) =>
  verb.command ? grants.commands.has(verb.command) : grants.write.has(verb.table) || grants.actions.has(`${verb.table} ${verb.verb}`);

/** A record action that runs a command, for the journey's "one command": on the table its action is declared on. */
function commandActions(app: LoadedApp['app']): Array<{ table: string; action: string; command: string }> {
  const found: Array<{ table: string; action: string; command: string }> = [];
  for (const [table, resource] of Object.entries(app.resources ?? {}))
    /* The loaded App holds a resource's actions as a list, each carrying the id authored as its key: the list's
       index is not a name `act` can find. */
    for (const action of (resource.actions ?? []) as Array<{ id: string; command?: { id?: string } | string }>) {
      const command = typeof action.command === 'string' ? action.command : action.command?.id;
      if (command) found.push({ table, action: action.id, command });
    }
  for (const verb of machineVerbs(app)) if (verb.command) found.push({ table: verb.table, action: verb.verb, command: verb.command });
  return found;
}

const q = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** A row as an object literal in the suite's own style. */
const literal = (row: Record<string, SeedValue>) =>
  `{ ${Object.entries(row)
    .map(
      ([key, value]) =>
        `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : q(key)}: ${
          typeof value === 'string'
            ? q(value)
            : typeof value === 'object'
              ? `${value.from}${/^[A-Za-z_$][\w$]*$/.test(value.column) ? `.${value.column}` : `[${q(value.column)}]`}`
              : String(value)
        }`,
    )
    .join(', ')} }`;

/** The table a command runs on, as the App names its resources: none for a command that makes its record. */
function commandTarget(loaded: LoadedApp, command: string): string | undefined {
  const declared = loaded.commands?.registry?.[command] as { source?: string; target?: string; targets?: string } | undefined;
  if (!declared?.target || declared.targets === 'none') return undefined;
  return declared.source ? logicalResource(loaded.app, declared.source, declared.target) : declared.target;
}

/** What the generated start serves beside the App, read from its folder as production is told it with flags. */
interface Serving {
  /** `--policy`, `--jobs`: each the module beside app.ts, by its name there. */
  args: string[];
  /** The jobs module, when it loaded: its jobs at times and the secrets its endpoints verify with. */
  jobs?: CapturedJobModule;
  /** Variables the App's config and jobs name, each given a test value where the test does not set it. */
  environment: string[];
}

function startModule(app: LoadedApp['app'], config: string | undefined, serving: Serving): string {
  const environment = serving.environment.length
    ? `
/** What the App's config and jobs read from the environment: yours where you set it, else a value for this run. */
const environment: Record<string, string> = {
${serving.environment.map((name) => `  ${name}: process.env.${name} ?? randomBytes(24).toString('base64url'),`).join('\n')}
};
`
    : '';
  const served = serving.args.length ? `\n    args: [${serving.args.map(q).join(', ')}],` : '';
  return `/**
 * How ${app.name}'s tests start it, written by \`mistri test init\`: the App from this directory, served over
 * a copy of each SQLite file its config names, so a test's writes never reach the database you develop on${
   serving.args.length
     ? `, with
 * the modules production serves beside it (${serving.args.filter((_, i) => i % 2 === 0).join(', ')})`
     : ''
 }. A signed-in session per role is
 * \`host.as(role)\`; a signed-out visitor is \`host.client()\`; \`host.seed(table, rows)\` arranges rows as setup. Yours to change.
 */
${serving.environment.length ? "import { randomBytes } from 'node:crypto';\n" : ''}import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { createTestWorkspace, startTestApp } from '@mistriwork/mistri/testing';

/** The App's directory. */
export const directory = fileURLToPath(new URL('..', import.meta.url));

/** The mistri.json that names the App's database: MISTRI_TEST_CONFIG${config ? `, else ${config.replace(/^\.\.\//, '')}` : ''}. */
const config = process.env.MISTRI_TEST_CONFIG${config ? ` ?? fileURLToPath(new URL(${q(config)}, import.meta.url))` : ''};
${environment}
/** The App on a free port, ready to answer, and closed when the test ends. */
export async function startApp(t: TestContext) {
${config ? '' : "  if (!config) throw new Error('Set MISTRI_TEST_CONFIG to the mistri.json that names the App\\'s database.');\n"}  const workspace = await createTestWorkspace();
  t.after(() => workspace.close());
  return startTestApp({
    workspace,
    directory,
    config: await workspace.copyConfig(config),${served}${serving.environment.length ? '\n    environment,' : ''}
  });
}
`;
}

function journeysModule(loaded: LoadedApp, grants: Map<string | null, Grants>, serving: Serving): string {
  const app = loaded.app;
  const policy = isRowPolicyApp(app);
  const verbs = machineVerbs(app);
  const commands = commandActions(app);
  const order = viewOrder(app);
  const listed = (view: string) => {
    const def = app.views[view] as { table?: string; sections?: unknown; command?: unknown };
    return def && !def.sections && !def.command && typeof def.table === 'string' ? def.table : undefined;
  };
  const menu = [...(typeof app.home === 'string' ? [app.home] : []), ...navViewKeys(app.nav), ...order];
  const blocks: string[] = [];
  for (const [role, held] of grants) {
    const who = role ?? 'signed out';
    const lines: string[] = [];
    lines.push(`test(${q(`${who}: opens its views and a record, and runs what it may`)}, async (t) => {`);
    lines.push('  const host = await startApp(t);');
    lines.push(role === null ? '  const person = host.client();' : `  const person = await host.as(${q(role)});`);
    lines.push('');
    lines.push('  // Its home and every view in its menu, each with the reads its first room asks for.');
    lines.push('  const { home, nav } = await person.views();');
    lines.push('  for (const view of new Set([...(home ? [home] : []), ...nav])) {');
    lines.push('    const page = await person.open(view);');
    lines.push("    assert.ok(page.ok, `${view}: ${page.ok ? '' : page.message}`);");
    lines.push('  }');
    const table = menu.map(listed).find((candidate) => candidate !== undefined && held.read.has(candidate));
    if (table && policy) {
      /* Under a row policy the person may reach none: said, not failed, as a verb with no record in its state is. */
      lines.push('');
      lines.push(`  await t.test(${q(`a record of ${table}, as its page opens`)}, async (t) => {`);
      lines.push(`    const records = await person.rows(${q(table)}, { limit: 1 });`);
      lines.push("    assert.ok(records.ok, records.ok ? '' : records.message);");
      lines.push(`    if (!records.value.length) return t.skip(${q(`the row policy gives this person no ${table} record`)});`);
      lines.push(`    const record = await person.open({ table: ${q(table)}, key: await person.key(${q(table)}, records.value[0]) });`);
      lines.push("    assert.ok(record.ok, record.ok ? '' : record.message);");
      lines.push('  });');
    } else if (table) {
      lines.push('');
      lines.push(`  // A record of ${table}, as its page opens.`);
      lines.push(`  const records = await person.rows(${q(table)}, { limit: 1 });`);
      lines.push(`  assert.ok(records.ok && records.value.length > 0, ${q(`${article(table)} ${table} record to open`)});`);
      lines.push(`  const record = await person.open({ table: ${q(table)}, key: await person.key(${q(table)}, records.value[0]) });`);
      lines.push("  assert.ok(record.ok, record.ok ? '' : record.message);");
    }
    const held_verbs = verbs.filter((verb) => holds(held, verb));
    const command = held_verbs.find((verb) => verb.command) ?? commands.find((candidate) => held.commands.has(candidate.command));
    if (command && !('verb' in command)) {
      lines.push('');
      lines.push(
        `  await t.test(${q(`${command.command}, a command it is granted, on ${article(command.table)} ${command.table} record`)}, async (t) => {`,
      );
      lines.push(`    assertApplied(await person.act(${q(command.table)}, ${q(command.action)}), t);`);
      lines.push('  });');
    } else if (!command) lines.push('', '  // It is granted no command a record offers.');
    const crossed = new Set<string>();
    for (const verb of held_verbs) {
      let what = `${verb.label} (${verb.verb}): ${verb.table} ${verb.from} → ${verb.to}`;
      /* A verb whose command runs on another table's record: its key is that table's, so the step is the action
         there that runs it — run on a record of the machine's own table, it named the wrong record. */
      const target = verb.command ? commandTarget(loaded, verb.command) : undefined;
      if (target && target !== verb.table) {
        /* One step a command, whichever of its edges the record it lands on moves. */
        if (crossed.has(verb.command!)) continue;
        crossed.add(verb.command!);
        what = `${verb.label} (${verb.verb}): moves its ${verb.table}`;
        const there = commands.find((candidate) => candidate.table === target && candidate.command === verb.command);
        lines.push('');
        if (!there) {
          lines.push(`  // ${what}, run on ${article(target)} ${target} record, which offers it as no action: a step to write by hand.`);
          continue;
        }
        lines.push(`  await t.test(${q(`${what}, run on ${article(target)} ${target} record`)}, async (t) => {`);
        lines.push(`    assertApplied(await person.act(${q(target)}, ${q(there.action)}), t);`);
        lines.push('  });');
        continue;
      }
      lines.push('');
      lines.push(`  await t.test(${q(what)}, async (t) => {`);
      lines.push(
        `    assertApplied(await person.act(${q(verb.table)}, ${q(verb.verb)}${verb.reason ? `, { reason: 'Checked by the test suite.' }` : ''}), t);`,
      );
      lines.push('  });');
    }
    lines.push('});');
    blocks.push(lines.join('\n'));
  }
  const timed = [...(serving.jobs?.jobs.values() ?? [])].filter((job) => job.every && job.realm !== 'tenant');
  if (timed.length) {
    const lines = [`test('each job at times runs now, as its service', async (t) => {`, '  const host = await startApp(t);'];
    for (const job of timed) {
      lines.push('');
      lines.push(`  await t.test(${q(`${job.id}: ${job.command.id} as ${job.runAs}`)}, async () => {`);
      lines.push(`    const run = await host.runJob(${q(job.id)});`);
      lines.push(`    assert.equal(run.state, 'succeeded', \`${job.id} ended \${run.state} (\${run.code})\`);`);
      lines.push('  });');
    }
    lines.push('});');
    blocks.push(lines.join('\n'));
  }
  return `/**
 * A journey per role through ${app.name}, written by \`mistri test init\`: each signs in, opens its home, the views
 * in its menu and a record, runs a command it is granted, and each machine verb it holds on a record in the state the
 * verb leaves from. A step with no record in that state is skipped and said. A command's questions are answered for
 * it (the first choice, the first record, a sentence); one only you can answer, such as a pattern, is a skipped step
 * that names it: pass it as \`person.act(table, action, { input: { ... } })\`.${policy ? ' Under the row policy a person reaches only\n * the records it gives them: a step with none of theirs is skipped and said too.' : ''}${timed.length ? '\n * Each job at times then runs once now, as its service would at its next slot.' : ''}
 * Run with \`node --test 'tests/*.test.ts'\`. Yours to extend: these are where the App's own journeys go.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertApplied } from '@mistriwork/mistri/testing';
import { startApp } from './start.ts';

${blocks.join('\n\n')}
`;
}

/** A value a seeded row is given: a literal, or a column of the row seeded before it (`from` is that row's variable). */
type SeedValue = string | number | boolean | { from: string; column: string };

/**
 * A row to seed into a table the database has none of: each column it must be given, given a value that fits. `as`
 * names the row where a later one refers to its key; `byHand` says what could not be arranged (a required cycle).
 */
type Seed = { table: string; row: Record<string, SeedValue>; as?: string; byHand: string[] };

function permissionsModule(loaded: LoadedApp, grants: Map<string | null, Grants>, from: 'lock' | 'report', seeds: Seed[]): string {
  const app = loaded.app;
  const policy = isRowPolicyApp(app);
  const resources = Object.keys(app.resources ?? {}).sort();
  const registry = loaded.commands?.registry ?? {};
  const commandNames = [...new Set([...Object.keys(registry), ...[...grants.values()].flatMap((held) => [...held.commands])])]
    .filter((name) => !registry[name]?.public)
    .sort();
  const rows: string[] = [];
  for (const [role, held] of grants) {
    const who = role === null ? 'null' : q(role);
    for (const table of resources) rows.push(`    { role: ${who}, read: ${q(table)}, allowed: ${held.read.has(table)} },`);
    for (const table of resources) {
      if (policy && held.write.has(table)) continue;
      const column = held.fields.get(table)?.[0];
      rows.push(`    { role: ${who}, write: ${q(table)}${column ? `, column: ${q(column)}` : ''}, allowed: ${held.write.has(table)} },`);
    }
    for (const name of commandNames) {
      if (policy && held.commands.has(name)) continue;
      const target = commandTarget(loaded, name);
      rows.push(`    { role: ${who}, command: ${q(name)}${target ? `, on: ${q(target)}` : ''}, allowed: ${held.commands.has(name)} },`);
    }
  }
  const source =
    from === 'lock'
      ? 'authority.lock, which the server holds the App to'
      : 'the authority the App grants now (it has no authority.lock; `mistri check --app . --write-authority` writes one)';
  const arranged = seeds.length
    ? `
  // No record of ${seeds.map((seed) => seed.table).join(', ')} is in the database the tests start on, and a row below needs one: arranged
  // here, as setup. Change the values to ones your App would hold.
${seeds
  .flatMap((seed) => [
    ...seed.byHand.map((why) => `  // ${why}: seed it by hand.`),
    `  ${seed.as ? `const ${seed.as} = ` : ''}await host.seed(${q(seed.table)}, ${literal(seed.row)});`,
  ])
  .join('\n')}
`
    : '';
  return `/**
 * ${app.name}'s permissions matrix, written by \`mistri test init\` from ${source}:
 * every role × resource and command, allowed or refused as it says. An allowed read answers rows, an allowed write
 * saves a record's own value back, an allowed command prepares, which changes nothing. A refused read is answered as a
 * table that is not there; a refused write or command, 403.${
   policy
     ? `
 * Under the row policy, a write or command a role is granted lands only on a record the policy gives that person,
 * which only the policy knows: those rows are left out here, and each person's journey runs them on their own records.`
     : ''
 }
 * When the lock changes, run \`mistri test init --force\` again and review this file's diff beside it.
 */
import { test } from 'node:test';
import { assertPermissions } from '@mistriwork/mistri/testing';
import { startApp } from './start.ts';

test('each role may do what it is granted, and is refused the rest', async (t) => {
  const host = await startApp(t);${arranged}
  await assertPermissions(host, [
${rows.join('\n')}
  ]);
});
`;
}

/** A module beside app.ts by its usual name, as a flag would name it: relative, the App directory's. */
const beside = (dir: string, name: string) =>
  ['ts', 'mts', 'mjs', 'js'].map((ext) => `${name}.${ext}`).find((file) => existsSync(join(dir, file)));

/** The modules production serves beside the App, and what they read from the environment. */
async function servingOf(dir: string, loaded: LoadedApp, configFile: string | undefined): Promise<Serving> {
  const args: string[] = [];
  const policy = beside(dir, 'policy');
  const named = new Set<string>();
  if (isTenantApp(loaded.app)) {
    const { TENANT_POLICY_NAMES } = await import('./testInitTenant.js');
    const found = TENANT_POLICY_NAMES.map((name) => beside(dir, name)).find(Boolean);
    if (!found)
      throw new Refusal(
        `${loaded.app.name} is a tenant App, served under its --policy, and there is no policy.ts or server/tenant-policy.ts beside its app.ts to serve it with: put the tenant policy there, as the suite's start names it.`,
      );
    args.push('--policy', found);
    const commands = beside(dir, 'commands');
    if (commands) args.push('--commands', commands);
    /* A policy with support keeps an audit chain under this key: the one its stores were provisioned with. */
    named.add('MISTRI_AUDIT_KEY');
  }
  if (isRowPolicyApp(loaded.app)) {
    if (!policy)
      throw new Refusal(
        `${loaded.app.name} is served under a --policy, and there is no policy.ts beside its app.ts to serve it with: put the row policy there, as the suite's start names it.`,
      );
    args.push('--policy', policy);
  }
  const jobsFile = beside(dir, 'jobs');
  let jobs: CapturedJobModule | undefined;
  if (jobsFile) {
    args.push('--jobs', jobsFile);
    jobs = await (await import('../jobs/jobLoader.js')).loadJobModule(join(dir, jobsFile)).catch(() => undefined);
  }
  /* A config's `${NAME}` references, and the secret each inbound endpoint verifies with: the server will not start
     without them. */
  if (configFile)
    for (const match of (await readFile(configFile, 'utf8').catch(() => '')).matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)) named.add(match[1]);
  for (const endpoint of jobs?.inbound.values() ?? []) named.add(endpoint.verify.secretEnv);
  return { args, ...(jobs ? { jobs } : {}), environment: [...named].sort() };
}

/**
 * The tables a matrix row needs a record of — an allowed write's, and an allowed command's — that the database the
 * tests copy has none of, each with a row to seed: what the database asks for and does not fill itself, a reference
 * the first row it names, a constrained column its first allowed value.
 */
async function seedsFor(loaded: LoadedApp, grants: Map<string | null, Grants>, configFile: string | undefined): Promise<Seed[]> {
  if (!configFile || isRowPolicyApp(loaded.app)) return [];
  const needed = new Set<string>();
  for (const held of grants.values()) {
    for (const table of held.write) needed.add(table);
    for (const name of held.commands) {
      const target = commandTarget(loaded, name);
      if (target) needed.add(target);
    }
  }
  if (!needed.size) return [];
  const registry = new Registry();
  const log = console.log;
  try {
    console.log = () => {};
    const { readStartupConfig } = await import('@mistriwork/engine/server/cli/config.js');
    await readStartupConfig({ config: configFile } as Options, registry, CONFIG_SECTIONS);
    const app = loaded.app;
    const bound = app.connection ?? (app.sources ? app.sources[homeSourceOf(app)!]?.connection : undefined);
    const connection = registry.list().find((each) => each.id === bound || each.name === bound) ?? registry.list()[0];
    if (!connection) return [];
    const { adapter, schema } = await registry.open(connection.id);
    const today = new Date().toISOString().slice(0, 10);
    const seeds: Seed[] = [];
    const planned = new Map<string, Seed>();
    const taken = new Set<string>();
    /* A table's seed, after the seeds of the rows it refers to: a required reference to a table with a row is that
       row's key; to one with none, a seed of that table first, whose key this row takes. A table already on the way
       down (a cycle, a table that refers to itself) cannot be arranged in order: said in the file, not left to fail. */
    type Column = NonNullable<ReturnType<typeof tableNamed>>['columns'][number];
    const filler = (column: Column) => {
      const kind = columnKind(column.type);
      return column.allowed?.length
        ? column.allowed[0]
        : column.flag || kind === 'boolean'
          ? true
          : kind === 'number'
            ? 1
            : kind === 'date'
              ? today
              : 'Checked by the test suite';
    };
    /* `referred`: the column a child's reference names, filled even where it may be empty, so the child has a value to take. */
    const plan = async (
      table: NonNullable<ReturnType<typeof tableNamed>>,
      label: string,
      chain: string[],
      referred?: string,
    ): Promise<Seed | undefined> => {
      const done = planned.get(table.id);
      const named = referred === undefined ? undefined : table.columns.find((column) => column.name === referred);
      if (done) {
        if (named && !(named.name in done.row)) done.row[named.name] = filler(named);
        return done;
      }
      if (chain.includes(table.id)) return undefined;
      const row: Seed['row'] = {};
      const byHand: string[] = [];
      for (const column of table.columns) {
        if (column === named && column.nullable && !column.references) {
          row[column.name] = filler(column);
          continue;
        }
        if (column.nullable || column.default !== undefined || column.hasDefault || column.identity) continue;
        if (column.primaryKey && primaryKey(table).length === 1 && columnKind(column.type) === 'number') continue;
        if (column.references) {
          const { table: parentId, column: parentColumn } = column.references;
          /* Several rows, not one: a reference may name a nullable unique column, and a parent whose first row
             leaves it empty gives nothing to refer to. None that does, and the parent is seeded first. */
          const parent = await adapter.query({ table: parentId, columns: [parentColumn], limit: 50, offset: 0 }).catch(() => undefined);
          const value = parent?.rows.map((each) => each[parentColumn]).find((each) => typeof each === 'string' || typeof each === 'number');
          if (typeof value === 'string' || typeof value === 'number') {
            row[column.name] = value;
            continue;
          }
          const parentTable = findTable(schema, parentId);
          const before = parentTable ? await plan(parentTable, parentTable.id, [...chain, table.id], parentColumn) : undefined;
          if (before) {
            before.as ??= uniqueName(parentTable!.name, taken);
            row[column.name] = { from: before.as, column: parentColumn };
          } else
            byHand.push(
              `${table.name}.${column.name} refers to ${parentId}, which has no row to refer to and cannot be seeded first (a required cycle)`,
            );
          continue;
        }
        row[column.name] = filler(column);
      }
      const seed: Seed = { table: label, row, byHand };
      planned.set(table.id, seed);
      seeds.push(seed);
      return seed;
    };
    for (const name of [...needed].sort()) {
      const table = tableNamed(schema, app.resources?.[name]?.physical ?? name);
      if (!table || (await adapter.count(table.id)) > 0) continue;
      await plan(table, name, []);
    }
    return seeds;
  } catch {
    /* Unreadable here: the rows that need a record say "seed one" when the suite runs, as before. */
    return [];
  } finally {
    console.log = log;
    await registry.closeAll().catch(() => {});
  }
}

/** A variable name for a seeded row, from its table's, that no other seeded row has. */
function uniqueName(table: string, taken: Set<string>): string {
  const base = `${table.replace(/\W+/g, '_').replace(/^(\d)/, '_$1')}_row`;
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
  taken.add(name);
  return name;
}

function readFlags(argv: string[]) {
  const [verb, ...rest] = argv;
  if (verb !== 'init') throw new Refusal(verb ? `unknown test command "${verb}"; the one command is init.` : `expected ${USAGE}`);
  let dir: string | undefined, config: string | undefined;
  let force = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--force') force = true;
    else if (arg === '--config') {
      config = rest[++i];
      if (!config || config.startsWith('-')) throw new Refusal("--config needs the mistri.json that names the App's database.");
    } else if (arg.startsWith('-')) throw new Refusal(`unknown option "${arg}". ${USAGE}`);
    else if (dir === undefined) dir = arg;
    else throw new Refusal(`one App directory, not "${dir}" and "${arg}". ${USAGE}`);
  }
  return { dir: resolve(dir ?? '.'), config, force };
}

export async function runTestCommand(argv: string[]): Promise<number> {
  if (argv.some((arg) => arg === '--help' || arg === '-h')) {
    console.log(
      `${USAGE}\n\nWrites tests/start.ts, tests/journeys.test.ts and tests/permissions.test.ts into the App: a journey per role and a permissions matrix from its authority.lock; for a tenant App, tests/start.ts and tests/tenants.test.ts, its tenants' isolation. Run with node --test 'tests/*.test.ts'.`,
    );
    return 0;
  }
  try {
    const { dir, config, force } = readFlags(argv);
    const loaded = await loadApp(dir, { lock: 'enforce' });
    const tenant = isTenantApp(loaded.app);
    const { lines, from } = authorityFacts(loaded);
    const grants = grantsOf(lines, loaded.app);
    const tests = join(dir, 'tests');
    const configFile = config ? resolve(config) : existsSync(join(dir, 'mistri.json')) ? join(dir, 'mistri.json') : undefined;
    const serving = await servingOf(dir, loaded, configFile);
    const start = startModule(loaded.app, configFile ? relative(tests, configFile).split('\\').join('/') : undefined, serving);
    /* A tenant App's people are members, not role sessions: its suite is the isolation its tenants are promised. */
    const files: Record<string, string> = tenant
      ? {
          'start.ts': start,
          'tenants.test.ts': await (
            await import('./testInitTenant.js')
          ).tenantsModule(loaded, grants, await (await import('./testInitTenant.js')).tenantsFor(loaded, configFile)),
        }
      : {
          'start.ts': start,
          'journeys.test.ts': journeysModule(loaded, grants, serving),
          'permissions.test.ts': permissionsModule(loaded, grants, from, await seedsFor(loaded, grants, configFile)),
        };
    const standing = Object.keys(files).filter((name) => existsSync(join(tests, name)));
    if (standing.length && !force)
      throw new Refusal(
        `${standing.map((name) => join(tests, name)).join(', ')} already exist${standing.length === 1 ? 's' : ''}: they are someone's tests. ` +
          'Move them aside, or pass --force to write over them.',
      );
    await mkdir(tests, { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      await writeFile(join(tests, name), text);
      console.log(`wrote ${relative(process.cwd(), join(tests, name)) || join(tests, name)}`);
    }
    for (const line of await nodeTypesFor(dir)) console.log(line);
    const roles = [...grants.keys()].map((role) => role ?? 'signed out');
    console.log(
      tenant
        ? `mistri test init: ${(loaded.app.auth?.tenancy?.label ?? 'tenant').toLowerCase()} isolation for each resource a tenant owns, each command a tenant role runs and each platform role's reads.`
        : `mistri test init: a journey for ${roles.join(', ')} and a permissions matrix from ${from === 'lock' ? 'authority.lock' : 'the authority the App grants (no authority.lock)'}.`,
    );
    console.log(
      configFile
        ? "Run them with: node --test 'tests/*.test.ts'"
        : "Run them with: MISTRI_TEST_CONFIG=<mistri.json naming its database> node --test 'tests/*.test.ts'",
    );
    return 0;
  } catch (error) {
    console.error(`mistri test: ${startupReport(error)}`);
    return error instanceof Refusal ? 2 : 1;
  }
}
