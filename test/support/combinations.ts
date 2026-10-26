/**
 * The combinations fixture: minimal Apps that each pair two features which are
 * independently covered elsewhere.
 *
 * Every defect found in 0.5.0 and 0.5.1 was invisible until two features met,
 * and every one of them passed its own feature's tests — an ordered workflow
 * strip under tenancy, a platform-only source under `--jobs`, command
 * references with no registry, invitations over HTTP, `api.commands` composed
 * through a feature, an `api` block loaded by the tenant runtime, a platform
 * command over a platform-only source. Each was found by building a sample App
 * days later, not by the suite.
 *
 * So the unit here is the *pair*, not the feature. A part below contributes an
 * App fact — a resource, a view, an `api` exposure, a command registry — and a
 * case composes two of them into one App, starts it, and proves both parts'
 * end-to-end behaviour still holds together. A part proved alone would prove
 * nothing this suite does not already prove.
 *
 * It is deliberately not a sample App. There is no seeded scenario and no UI:
 * one table, opaque ids, and the smallest declaration each seam needs. If a
 * case starts needing a story to explain it, it belongs in examples/, and if
 * this file grows a page or a theme it has gone wrong.
 */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { migrateSqliteCommandJournal } from '../../packages/mistri/src/adapters/commands/commandJournal.js';
import { ROOT } from '../appApiCli.js';

/** One table, and a tenant column so a case can pair tenancy with anything
    without a second schema. `version` is the revision every targeted
    command checks. */
export const ITEM_TABLE =
  'CREATE TABLE item(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, ' +
  "name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', version INTEGER NOT NULL DEFAULT 0)";
export const ITEM_ROWS =
  "INSERT INTO item(id, tenant_id, name) VALUES ('north-1','north','North one')," +
  "('north-2','north','North two'),('south-1','south','South one')";
/** One row per tenant, owned by the platform: the profile `auth.tenancy`
    names, and the one platform resource a tenant row may reference. */
export const PROFILE_TABLE = 'CREATE TABLE tenant_profile(id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL)';
export const PROFILE_ROWS = "INSERT INTO tenant_profile VALUES ('north','North'),('south','South')";
/** The platform-owned table a platform-only source reads: no tenant column,
    which is the whole reason such a table exists. */
export const RATE_TABLE = 'CREATE TABLE rate(id TEXT PRIMARY KEY NOT NULL, label TEXT NOT NULL, basis_points INTEGER NOT NULL)';
export const RATE_ROWS = "INSERT INTO rate(id, label, basis_points) VALUES ('standard','Standard',450),('preferred','Preferred',325)";

/** This checkout's own modules, so a generated registry and the server it is
    loaded into share one instance of each. Apps resolve `@mistriwork/mistri/app`
    through a node_modules symlink instead, the way an authored App does. */
export const source = (path: string): string => pathToFileURL(join(ROOT, path)).href;

/** What a part contributes. Everything is optional: a part says only the App
    facts its own seam needs, and `merge` puts two of them together. */
export interface Part {
  /** Merged into the App root, or into a feature by `inFeature`. */
  readonly root?: Record<string, unknown>;
  /** Files written beside the App, by name, with the flag each one needs. */
  readonly files?: Readonly<Record<string, string>>;
  /** Startup flags, `{file}` replaced by the written file's path. */
  readonly flags?: readonly string[];
  /** Extra DDL and rows the part's resources need. */
  readonly ddl?: readonly string[];
  /** The part runs commands, so its database needs the command journal. */
  readonly journal?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Deep merge, refusing a collision rather than letting one part silently win:
    a case that declares the same fact twice is a fixture bug, and a silent
    overwrite is exactly the failure this fixture exists to catch. */
export function mergeRoots(left: Record<string, unknown>, right: Record<string, unknown>, at = ''): Record<string, unknown> {
  const out: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const here = at ? `${at}.${key}` : key;
    const existing = out[key];
    if (existing === undefined) {
      out[key] = value;
      continue;
    }
    // Lists concatenate, an equal repeat kept once — the same rule the
    // framework's own feature merge states, and what lets two parts each name
    // the role they are exposed to without declaring it twice.
    if (Array.isArray(existing) && Array.isArray(value)) {
      const seen = existing.map((entry) => JSON.stringify(entry));
      out[key] = [...existing, ...value.filter((entry) => !seen.includes(JSON.stringify(entry)))];
      continue;
    }
    if (isRecord(existing) && isRecord(value)) {
      out[key] = mergeRoots(existing, value, here);
      continue;
    }
    if (JSON.stringify(existing) === JSON.stringify(value)) continue;
    throw new Error(`Two parts of one combination declare "${here}" differently.`);
  }
  return out;
}

export const merge = (...parts: readonly Part[]): Part =>
  parts.reduce(
    (left, right) => ({
      root: mergeRoots(left.root ?? {}, right.root ?? {}),
      files: { ...left.files, ...right.files },
      flags: [...(left.flags ?? []), ...(right.flags ?? [])],
      ddl: [...(left.ddl ?? []), ...(right.ddl ?? [])],
      journal: left.journal === true || right.journal === true,
    }),
    {},
  );

/* ---- the parts, one per feature this fixture pairs ---- */

/** The App every case starts from: one source, one resource, one list. */
export const base = (options: { write?: boolean } = {}): Part => ({
  root: {
    id: 'combo',
    name: 'Combination',
    sources: { business: { connection: 'data', default: true } },
    resources: { item: options.write ? { access: 'write' } : {} },
    views: { items: { kind: 'list', from: 'item', label: 'Items' } },
    home: 'items',
    nav: ['items'],
  },
  ddl: [ITEM_TABLE, ITEM_ROWS],
});

/** Native sign-in and one role. Every case has auth: a seam that only shows
    itself to an authorized reader is still a seam. */
export const auth = (store: string, grants: Record<string, unknown> = { read: true }): Part => ({
  root: { auth: { providers: ['email'], store, roles: { operator: { ...grants } } } },
});

/** The `api` block: the App's own versioned read exposure. */
export const apiReads = (): Part => ({
  root: { api: { version: 1, roles: ['operator'], resources: { item: { fields: ['id', 'name', 'status', 'version'], sorts: ['id'] } } } },
});

/** A targeted command and its registry, loaded by `--commands`. */
export const touchCommand = (): Part => ({
  root: { resources: { item: { access: 'write' } }, auth: { roles: { operator: { commands: ['touch'] } } } },
  files: {
    // .mts: a temporary directory has no package.json, so .ts would load as CommonJS.
    'commands.mts': `import { defineCommand, defineCommands } from '${source('packages/mistri/src/server/commands/businessCommands.ts')}';
import { shape, bool } from '${source('packages/mistri/src/server/commands/commandShapes.ts')}';
export default defineCommands({ touch: defineCommand({ source: 'business', target: 'item',
  input: {}, output: shape({ ok: bool() }), async handle(context) {
    await context.tx.update({ table: 'item', key: { id: String(context.record.id) }, values: { version: Number(context.record.version) + 1 } });
    return { ok: true };
  } }) });
`,
  },
  flags: ['--commands', '{commands.mts}'],
  journal: true,
});

/** The registered command exposed by name through the `api` block: the seam
    `api.commands` × composition broke on. */
export const apiTouchCommand = (): Part => ({
  root: { api: { version: 1, roles: ['operator'], commands: ['touch'] } },
});

/** The command as the App refers to it: a named action on the record, the
    half a reader sees. It is
    deliberately separable from `touchCommand`, because an App that refers to
    a command with no registry behind it is one of the pairs that broke. */
export const touchAction = (): Part => ({
  root: { resources: { item: { access: 'write', actions: { touch: { label: 'Touch', command: 'touch' } } } } },
});

/** The same contribution, declared through a feature instead of at the root.
    Composition is a feature in its own right, so a case pairs it with another
    part by moving that part's content here. */
export const inFeature = (id: string, part: Part): Part => {
  const FEATURE_KEYS = ['resources', 'auth', 'views', 'pages', 'nav', 'home', 'api'];
  const root = part.root ?? {};
  const inside = Object.fromEntries(Object.entries(root).filter(([key]) => FEATURE_KEYS.includes(key)));
  const outside = Object.fromEntries(Object.entries(root).filter(([key]) => !FEATURE_KEYS.includes(key)));
  // A feature exposes through the App's `api`; it never opens one. So the
  // version and the roles stay at the root and only the exposure moves,
  // which is the shape the loader requires and the shape the defect had.
  const api = inside.api as { version?: number; roles?: string[] } | undefined;
  if (api) {
    const { version, roles, ...exposure } = api;
    inside.api = exposure;
    outside.api = mergeRoots((outside.api as Record<string, unknown>) ?? {}, {
      ...(version === undefined ? {} : { version }),
      ...(roles === undefined ? {} : { roles }),
    });
  }
  return { ...part, root: { ...outside, features: [{ id, ...inside }] } };
};

/** The store a tenant combination provisions; one per fixture run is enough,
    because each case builds its own database. */
export const COMBO_STORE = 'combination-store';

/** Tenancy: the App's rows belong to a tenant, and a server-only policy says
    how. The one part every tenant defect involved — a workflow strip, an
    `api` block, a platform-only source and a platform command each worked
    until they met this. */
/** `commands`: the deployment also loads a registry, so the policy says what
    a command's result may reference. A policy that declares it without one is
    refused at startup — correctly, and a combination has to mean what it
    declares. */
export const tenancy = (options: { commands?: boolean } = {}): Part => ({
  root: {
    auth: { rows: 'tenant' },
    resources: { item: { owner: 'tenant' } },
  },
  files: {
    // .mjs: the policy loader takes .ts, .mjs or .js, and a .ts file in a
    // directory with no package.json would load as CommonJS.
    'policy.mjs': `import { defineAppTenantPolicy } from '${source('packages/mistri/src/server/policy/appTenantPolicy.ts')}';
export default defineAppTenantPolicy({ kind: 'tenant', appId: 'combo', storeId: '${COMBO_STORE}',
  ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
  resolveMembershipRows: () => ({ item: true }), resolveRows: () => ({ item: true })${options.commands ? ',\n  resultReferences: { touch: () => [] }' : ''} });
`,
  },
  flags: ['--policy', '{policy.mjs}'],
});

/** A platform-only source: a second connection the platform realm alone
    reads, over a table with no tenant column — which is the reason such a
    table exists. Pairs with `--jobs` and with a platform command, both of
    which were refused the first time they met one. */
export const platformSource = (): Part => ({
  root: {
    sources: { platform: { connection: 'platform', realm: 'platform' } },
    resources: { 'platform.rate': {} },
  },
  ddl: [RATE_TABLE, RATE_ROWS],
});

/** An ordered workflow strip derived from a resource machine: its state path
    makes the steps before the current one draw as passed. It was
    refused under tenancy while working everywhere else, which is why it is a
    part here rather than a line in another App. */
export const workflowPage = (): Part => ({
  root: {
    resources: {
      item: {
        access: 'write',
        machine: {
          column: 'status',
          states: {
            new: { on: { start: 'working' } },
            working: { on: { finish: 'done' } },
            done: { final: true },
          },
        },
      },
    },
    pages: {
      item: {
        base: 'item',
        sections: [
          {
            kind: 'fields',
            show: ['name', 'status'],
          },
        ],
      },
    },
  },
});

/** A dashboard placed on a layout, beside a dated table so a section can carry windows of its own and the dashboard
    pick filters: its own seam, since an area is read by the parser, the catalog check and the client alike, and each
    of windows, filters and a first run is read from the section list that an area is also a key of. */
export const layoutDashboard = (extra: { sections?: readonly object[]; areas?: readonly string[] } = {}): Part => ({
  root: {
    resources: { visit: {} },
    views: {
      board: {
        kind: 'dashboard',
        label: 'Board',
        windows: ['last 30 days', 'last 90 days'],
        filters: ['status'],
        sections: extra.sections ?? [
          { kind: 'metric', title: 'Visits', from: 'visit', over: 'seen_on', area: 'kpis' },
          { kind: 'metric', title: 'Items', from: 'item', area: 'kpis' },
          {
            kind: 'chart',
            title: 'Visits by day',
            from: 'visit',
            by: 'day seen_on',
            over: 'seen_on',
            windows: ['last 7 days', 'last 30 days'],
            area: 'trend',
          },
          { kind: 'breakdown', title: 'By status', from: 'visit', by: 'status', area: 'mix' },
        ],
        areas: extra.areas ?? ['kpis kpis', 'trend mix'],
      },
    },
    nav: ['board'],
  },
  ddl: [
    'CREATE TABLE visit(id TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL, seen_on DATE NOT NULL)',
    "INSERT INTO visit VALUES ('v1','new','2026-10-01'),('v2','done','2026-10-02')",
  ],
});

/** A job: a committed fact, and a second command that starts on it.
 *
 * `--jobs` needs `--commands` and exactly one `--app`, so this part is only
 * ever half of a pair. The other half is what the defect was about — a job
 * binding beside something else the deployment declares — and what a
 * deployment says at startup is the proof: it names the job, the fact it
 * starts on, and the principal it runs as.
 */
export const settleJob = (): Part => ({
  root: {
    resources: { item: { access: 'write' } },
    auth: { roles: { operator: { commands: ['touch'] }, automation: { read: true, write: false, commands: ['settle'] } } },
  },
  files: {
    'events.mts': `import { defineEvent } from '${source('packages/mistri/src/server/commands/businessEvents.ts')}';
import { shape, text } from '${source('packages/mistri/src/server/commands/commandShapes.ts')}';
export const itemTouched = defineEvent('item.touched', shape({ id: text() }));
`,
    'jobs-commands.mts': `import { defineCommand, defineCommands } from '${source('packages/mistri/src/server/commands/businessCommands.ts')}';
import { defineEventProjection } from '${source('packages/mistri/src/server/commands/businessEvents.ts')}';
import { shape, bool, text } from '${source('packages/mistri/src/server/commands/commandShapes.ts')}';
import { itemTouched } from './events.mts';
export default defineCommands({
  touch: defineCommand({ source: 'business', target: 'item',
    input: {}, output: shape({ ok: bool(), id: text({ max: 64 }) }),
    events: { touched: defineEventProjection(itemTouched, ({ id }) => ({ id })) },
    async handle(context) {
      await context.tx.update({ table: 'item', key: { id: String(context.record.id) }, values: { version: Number(context.record.version) + 1 } });
      return { ok: true, id: String(context.record.id) };
    } }),
  // What the fact starts. It is a command like any other: the job is the only
  // thing that says when it runs and who it runs as.
  settle: defineCommand({ source: 'business', target: 'item',
    input: {}, output: shape({ ok: bool() }),
    async handle(context) {
      await context.tx.update({ table: 'item', key: { id: String(context.record.id) }, values: { status: 'done' } });
      return { ok: true };
    } }),
});
`,
    'jobs.mts': `import { defineJob, defineJobs } from '${source('packages/mistri/src/server/jobs/jobModule.ts')}';
import { itemTouched } from './events.mts';
export default defineJobs({
  settleTouched: defineJob({ on: { event: itemTouched, command: 'touch' },
    runAs: 'settler', command: 'settle',
    schedule: event => ({ runAt: Date.now() + 60_000, key: { id: event.id }, input: {} }) }),
}, { principals: { settler: { roles: ['automation'] } } });
`,
  },
  flags: ['--commands', '{jobs-commands.mts}', '--jobs', '{jobs.mts}'],
  journal: true,
});

/** The platform realm: a tenant App with a realm above its tenants, a
 * platform-only source only that realm reads, and a command that runs in it.
 *
 * This part is a whole App rather than a contribution, because a platform
 * realm is not something an App has a little of: every role, room and home
 * rule has to say whose context it serves, and merging that into a flat
 * App's `home` and `nav` would be inventing an answer the author has to give.
 * Two of the seven defects lived exactly here — a platform-only source that
 * would not bind, and a platform command refused — and both were startup
 * failures, so what this pair proves is a deployment that starts.
 *
 * `rates` is the platform-only source. Its table is named `rates.rate`,
 * qualified, because a platform-only source's resources always are.
 */
export const platformRealm = (): Part => ({
  root: {
    id: 'combo',
    name: 'Combination',
    sources: { business: { connection: 'data', default: true }, rates: { connection: 'rates', realm: 'platform' } },
    auth: {
      providers: ['email'],
      store: 'AUTH-STORE',
      rows: 'tenant',
      tenancy: { label: 'Depot', profile: 'tenant_profile', platform: { label: 'Head office' } },
      roles: {
        member: { realm: 'tenant', read: true, write: false },
        // The platform realm holds no generic write: it acts through commands.
        staff: { realm: 'platform', read: true, write: false, commands: ['approve'] },
      },
    },
    resources: {
      item: { access: 'write', owner: 'tenant' },
      tenant_profile: { owner: 'platform' },
      'rates.rate': { owner: 'platform' },
    },
    views: {
      items: { kind: 'list', from: 'item', label: 'Items', realm: 'tenant' },
      rates: { kind: 'list', from: 'rates.rate', label: 'Rates', realm: 'platform' },
    },
    nav: ['items', 'rates'],
    home: [{ view: 'rates', roles: ['staff'] }, { view: 'items' }],
  },
  ddl: [ITEM_TABLE, ITEM_ROWS, PROFILE_TABLE, PROFILE_ROWS],
  journal: true,
  files: {
    'platform-commands.mts': `import { defineCommand, defineCommands } from '${source('packages/mistri/src/server/commands/businessCommands.ts')}';
import { shape, bool } from '${source('packages/mistri/src/server/commands/commandShapes.ts')}';
export default defineCommands({ approve: defineCommand({ realm: 'platform', source: 'business',
  target: 'item', input: {}, output: shape({ ok: bool() }),
  async handle(context) {
    await context.tx.update({ table: 'item', key: { id: String(context.record.id) }, values: { status: 'done' } });
    return { ok: true };
  } }) });
`,
    'platform-policy.mjs': `import { defineAppTenantPolicy } from '${source('packages/mistri/src/server/policy/appTenantPolicy.ts')}';
export default defineAppTenantPolicy({ kind: 'tenant', appId: 'combo', storeId: '${COMBO_STORE}',
  ownership: { item: { kind: 'tenant', column: 'tenant_id' }, tenant_profile: { kind: 'platform' } },
  resolveMembershipRows: () => ({ item: true }), resolveRows: () => ({ item: true }),
  // What the platform realm reads, each by its qualified name.
  resolvePlatformRows: () => ({ 'rates.rate': true, tenant_profile: true }),
  resultReferences: { approve: () => [] } });
`,
  },
  flags: ['--policy', '{platform-policy.mjs}', '--commands', '{platform-commands.mts}'],
});

/** Writes one combination's App directory, config and files, and returns what
    the CLI needs to serve it. `business` is the SQLite file the parts' DDL has
    already been applied to. */
export function writeCombination(directory: string, part: Part, options: { business: string }) {
  const appDir = join(directory, 'app');
  mkdirSync(appDir, { recursive: true });
  // The symlink an authored App has, so `@mistriwork/mistri/app` resolves to this
  // checkout — packages/mistri/schema/app.mjs is shipped source, so nothing has to be built.
  const modules = join(directory, 'node_modules');
  mkdirSync(modules, { recursive: true });
  try {
    symlinkSync(ROOT, join(modules, 'tablewalk'), 'dir');
  } catch {
    /* a re-run keeps the first link */
  }
  writeFileSync(join(appDir, 'app.json'), JSON.stringify(part.root ?? {}, null, 1));
  const written: Record<string, string> = {};
  for (const [name, contents] of Object.entries(part.files ?? {})) {
    written[name] = join(directory, name);
    writeFileSync(written[name], contents);
  }
  const config = join(directory, 'mistri.json');
  writeFileSync(config, JSON.stringify({ connections: [{ id: 'data', name: 'data', url: options.business, writable: true }] }));
  const flags = (part.flags ?? []).map((flag) =>
    flag.replace(/^\{(.+)\}$/, (_, name: string) => {
      const path = written[name];
      if (!path) throw new Error(`A part asked for the file "${name}", which no part writes.`);
      return path;
    }),
  );
  return { appDir, config, flags };
}

/** Applies a combination's DDL to a fresh SQLite database. */
export function seedCombination(business: string, part: Part): void {
  const db = new DatabaseSync(business);
  try {
    for (const statement of part.ddl ?? []) db.exec(statement);
  } finally {
    db.close();
  }
  // The journal is an explicit operator step, never implicit at startup, so a
  // combination that runs commands migrates it exactly as a deployment does.
  if (part.journal) migrateSqliteCommandJournal(business);
}
