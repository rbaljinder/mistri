#!/usr/bin/env node
/**
 * A large App, generated: the typecheck a big deployment sees, without one.
 *
 * The sample Apps are small (Compass has 12 tables, Ignition 20), and the
 * cost of the schema-typed layer grows with the schema, so a budget measured
 * on them says nothing about the App an outside reviewer worried about: a
 * hundred and fifty tables, tenancy, row policies, forty rooms, commands with
 * inputs. This writes that App — deterministic, so its type and instantiation
 * counts are the same on every machine — with the generated
 * `mistri-schema.d.ts` the real generator (packages/mistri/src/server/typegen.ts) writes
 * for its schema, and the server modules (commands, a tenant policy) a
 * deployment keeps beside it.
 *
 * Its shape, per domain of about a dozen tables: a root with a tenant, an
 * owner and a version, children that reference it (some through a composite
 * `tenant_id+…` key, as a tenant App's do), a cross-domain reference, list
 * views with two-hop label paths, a queue or cards, a dashboard, record pages
 * with related lists, a current row, a chart and rollups, and two commands
 * with reference, choice and text inputs. The App's own file holds the
 * ceilings, the roles and the tenancy; each domain is a feature.
 *
 *   node scripts/synthetic-app.mjs <dir> [--tables 150]   write the App into <dir>
 *
 * scripts/type-budget.mjs is its reader.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DOMAINS = [
  'sales',
  'billing',
  'support',
  'catalog',
  'stock',
  'shipping',
  'buying',
  'people',
  'projects',
  'service',
  'finance',
  'audit',
];
const NOUNS = ['record', 'line', 'note', 'task', 'event', 'file', 'review', 'assignment', 'rate', 'plan', 'entry', 'hold'];
/* Every table's own columns, beyond its keys: what a real business table carries. */
const COMMON = [
  ['reference', 'text', false],
  ['name', 'text', false],
  ['status', 'text', false],
  ['category', 'text', true],
  ['created_on', 'date', false],
  ['due_on', 'date', true],
  ['amount', 'numeric', true],
  ['quantity', 'integer', true],
  ['priority', 'integer', true],
  ['is_active', 'boolean', false],
  ['notes', 'text', true],
];

/** A small seeded generator: the same App, byte for byte, on every run. */
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The schema: a tenant profile, the platform's staff, then each domain's tables. */
export function syntheticSchema(tableCount = 150) {
  const rand = random(150);
  const tables = [];
  const foreignKeys = [];
  const column = (name, type, nullable = false, primaryKey = false) => ({ name, type, nullable, primaryKey });
  const fk = (from, columns, to, toColumns = ['id']) =>
    foreignKeys.push({
      name: `${from}_${columns.join('_')}_fkey`,
      from: { table: from, columns },
      to: { table: to, columns: toColumns },
    });
  tables.push({
    id: 'tenant',
    name: 'tenant',
    schema: '',
    columns: [
      column('id', 'bigint', false, true),
      column('code', 'text'),
      column('name', 'text'),
      column('region', 'text'),
      column('status', 'text'),
      column('joined_on', 'date'),
      column('version', 'integer'),
    ],
  });
  tables.push({
    id: 'staff',
    name: 'staff',
    schema: '',
    columns: [
      column('id', 'bigint', false, true),
      column('name', 'text'),
      column('email', 'text'),
      column('role', 'text'),
      column('active', 'boolean'),
      column('desk', 'text', true),
    ],
  });
  const domains = [];
  const perDomain = Math.ceil((tableCount - 2) / DOMAINS.length);
  for (let d = 0; d < DOMAINS.length && tables.length < tableCount; d++) {
    const domain = DOMAINS[d];
    /* Most domains are a tenant's own rows; a few are the platform's, one is shared reference data. */
    const owner = d < 8 ? 'tenant' : d < 11 ? 'platform' : 'global';
    const names = [];
    for (let n = 0; n < perDomain && tables.length < tableCount; n++) {
      const id = `${domain}_${NOUNS[n % NOUNS.length]}${n >= NOUNS.length ? n : ''}`;
      const columns = [column('id', 'bigint', false, true)];
      if (owner === 'tenant') columns.push(column('tenant_id', 'bigint'));
      for (const [name, type, nullable] of COMMON) columns.push(column(name, type, nullable));
      for (let extra = 0, count = Math.floor(rand() * 7); extra < count; extra++)
        columns.push(column(`${NOUNS[n % NOUNS.length]}_attr_${extra}`, extra % 2 ? 'text' : 'integer', true));
      columns.push(column('owner_id', 'bigint', true));
      fk(id, ['owner_id'], 'staff');
      if (owner === 'tenant') fk(id, ['tenant_id'], 'tenant');
      if (n > 0) {
        /* A child points at its domain's root, and a third of them at their elder sibling too. */
        const root = names[0];
        columns.push(column(`${root}_id`, 'bigint'));
        fk(id, [`${root}_id`], root);
        if (owner === 'tenant' && n % 3 === 1) fk(id, ['tenant_id', `${root}_id`], root, ['tenant_id', 'id']);
        if (n % 3 === 2) {
          const sibling = names[n - 1];
          columns.push(column(`${sibling}_id`, 'bigint', true));
          fk(id, [`${sibling}_id`], sibling);
        }
      } else if (d > 0) {
        /* A root refers across domains, to the one before it: a shipment's order, an invoice's deal. */
        const other = domains[d - 1].tables[0];
        columns.push(column(`${other}_id`, 'bigint', true));
        fk(id, [`${other}_id`], other);
      }
      columns.push(column('version', 'integer'));
      tables.push({ id, name: id, schema: '', columns });
      names.push(id);
    }
    domains.push({ domain, owner, tables: names });
  }
  return { schema: { label: 'synthetic', dialect: 'postgres', tables, foreignKeys, readAt: '2026-01-01T00:00:00.000Z' }, domains };
}

const HELPERS = [
  'action',
  'board',
  'cards',
  'chart',
  'count',
  'current',
  'dashboard',
  'defineFeature',
  'fields',
  'header',
  'listView',
  'metric',
  'navGroup',
  'page',
  'queue',
  'related',
  'rows',
  'sum',
  'machine',
];
const q = JSON.stringify;
const title = (id) => id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const camel = (id) => id.replace(/_(.)/g, (_, c) => c.toUpperCase());

/** One domain as a feature: its resources' presentation, views, pages, commands and menu. */
function featureModule({ domain, owner, tables }, { schema }) {
  const [root, ...children] = tables;
  const realm = owner === 'platform' ? 'platform' : 'tenant';
  const columnsOf = (id) => schema.tables.find((t) => t.id === id).columns.map((c) => c.name);
  const commandsHere = owner === 'global' ? [] : [`approve_${root}`, `reassign_${root}`];
  const lines = [];
  const tone = `{ tone: { open: 'info', approved: 'good', declined: 'bad', held: 'warn', '*': 'neutral' } }`;
  lines.push(`export const ${camel(domain)} = defineFeature({`);
  lines.push(`  id: ${q(domain)},`);
  lines.push('  resources: {');
  for (const id of tables) {
    const cols = columnsOf(id);
    const parts = [
      `recordLabel: 'name'`,
      `display: { status: ${tone}, amount: { format: 'money' }, priority: { format: 'number' } }`,
      `labels: { name: 'Name', status: 'Status', 'owner_id.name': 'Owner'${id !== root ? `, '${root}_id.name': ${q(title(root))}` : ''} }`,
    ];
    if (id === root) {
      // The tabs' conditions are the resource's; a machine's states are taken words, so the segments say "items".
      parts.push(
        `segments: { open_items: { query: 'status = open', label: 'Open' }, approved_items: { query: 'status = approved', label: 'Approved' } }`,
      );
      parts.push(
        commandsHere.length
          ? `machine: machine('status', { open: { on: { approve: ['approved', 'declined', 'held'] } }, approved: { final: true }, declined: { final: true }, held: {} })`
          : `machine: machine('status', { open: { on: { close: 'closed' } }, closed: { final: true } })`,
      );
      parts.push(
        `rollups: { ${children
          .slice(0, 3)
          .map((child, i) =>
            i === 1
              ? `${child}_total: sum(${q(child)}, 'amount', { whose: '${root}_id' })`
              : `${child}_count: count(${q(child)}, { whose: '${root}_id' })`,
          )
          .join(', ')} }`,
      );
      if (commandsHere.length)
        parts.push(
          `actions: {\n        approve: action('Approve', { command: ${q(commandsHere[0])} }),\n        reassign: action('Reassign', { command: ${q(commandsHere[1])} }),\n      }`,
        );
      else parts.push(`actions: { close: action('Close', { set: { status: 'closed' }, when: 'status = open' }) }`);
    }
    if (cols.includes('notes'))
      parts.push(`validation: [{ must: 'notes is not empty', when: 'status = held', message: 'A hold says why.' }]`);
    lines.push(`    ${id}: {\n      ${parts.join(',\n      ')},\n    },`);
  }
  lines.push('  },');
  if (commandsHere.length) {
    lines.push('  auth: {\n    roles: {');
    const roles = realm === 'platform' ? ['platform_admin', 'manager'] : ['tenant_admin', 'tenant_staff'];
    lines.push(`      ${roles[0]}: { realm: ${q(realm)}, commands: [${commandsHere.map(q).join(', ')}] },`);
    lines.push(`      ${roles[1]}: { realm: ${q(realm)}, commands: [${q(commandsHere[1])}] },`);
    lines.push('    },\n  },');
  }
  /* About forty rooms over the App: each domain's root list, a child list, a queue or cards, and a dashboard. */
  const [first, second, third] = children;
  const views = [];
  views.push(`    ${q(`${domain}-home`)}: { ...dashboard(${q(title(domain))}, [
      metric('Open', ${q(root)}, { query: 'status = open', width: 'third', over: 'created_on' }),
      metric('Value', ${q(root)}, { measure: 'sum amount as value', width: 'third', compare: 'previous period', over: 'created_on' }),
      metric(${q(title(first))}, ${q(first)}, { query: 'status = open', width: 'third' }),
      chart('By month', ${q(root)}, 'month created_on', { measure: 'sum amount as value' }),
      rows('Due soon', ${q(root)}, { query: 'due_on = next 30 days', show: ['reference', 'name', 'owner_id.name', 'due_on'], sort: 'due_on', limit: 8, width: 'half' }),
      rows(${q(title(second))}, ${q(second)}, { show: ['reference', 'name', '${root}_id.name', '${root}_id.owner_id.name'], sort: 'created_on desc', limit: 8, width: 'half' }),
      board('By status', ${q(first)}, 'status', { primary: 'name', lines: ['owner_id.name', '${root}_id.reference'] }),
    ], { icon: 'gauge', windows: ['last 30 days', 'this year'] }), realm: ${q(realm)} },`);
  views.push(`    ${q(`${domain}-${root.split('_')[1]}s`)}: listView(${q(title(root) + 's')}, ${q(root)}, {
      icon: 'list', realm: ${q(realm)},
      show: ['reference', 'name', 'status', 'amount', 'owner_id.name', 'owner_id.email', 'created_on', 'due_on'],
      filters: ['status', 'category', 'created_on', 'owner_id'],
      sort: 'created_on desc', totals: ['amount'],
      tabs: ['open_items', 'approved_items', { label: 'All' }],
    }),`);
  views.push(`    ${q(`${domain}-${first.split('_').slice(1).join('-')}s`)}: listView(${q(title(first) + 's')}, ${q(first)}, {
      icon: 'list', realm: ${q(realm)},
      show: ['reference', 'name', '${root}_id.name', '${root}_id.owner_id.name', 'status', 'amount', 'created_on'],
      filters: ['status', 'created_on'], sort: 'due_on, name',
    }),`);
  views.push(`    ${q(`${domain}-queue`)}: listView(${q(title(second) + ' queue')}, ${q(second)}, {
      icon: 'tray', realm: ${q(realm)}, query: 'status = open',
      presentation: queue('name', { lines: ['${root}_id.name', 'owner_id.name'], facts: ['amount', 'due_on'] }),
    }),`);
  if (third) {
    views.push(`    ${q(`${domain}-cards`)}: listView(${q(title(third) + ' cards')}, ${q(third)}, {
      icon: 'list', realm: ${q(realm)},
      presentation: cards('name', { lines: ['${root}_id.name', 'status'], facts: ['amount', 'owner_id.name'] }),
    }),`);
  }
  lines.push('  views: {');
  lines.push(...views);
  lines.push('  },');
  /* Two record pages per domain: the root's, with its children around it, and its first child's. */
  const relatedOf = children
    .slice(0, 5)
    .map(
      (child, i) =>
        `      related(${q(title(child) + 's')}, ${q(child)}, '${root}_id', { show: ['reference', 'name', 'status', 'amount', 'owner_id.name'], sort: 'created_on desc'${i === 0 ? ", query: 'status = open'" : ''} }),`,
    );
  lines.push('  pages: {');
  lines.push(`    ${q(`${domain}-${root.split('_')[1]}`)}: page(${q(root)}, [
      header({ status: 'status', facts: ['reference', 'owner_id', 'owner_id.email', 'due_on'], primary: ${commandsHere.length ? "'approve'" : "'close'"} }),
      fields(['amount', 'quantity', 'priority'], { presentation: 'summary' }),
      fields(['category', 'created_on', 'notes'], { title: 'Details', columns: 2 }),
      metric('Open ${title(first).toLowerCase()}s', ${q(first)}, { whose: '${root}_id', query: 'status = open' }),
      chart('${title(first)}s by month', ${q(first)}, 'month created_on', { whose: '${root}_id', measure: 'sum amount as value', height: 180 }),
${relatedOf.join('\n')}
      current('Latest ${title(second).toLowerCase()}', ${q(second)}, '${root}_id', { sort: 'created_on desc', show: ['reference', 'status', 'amount'], region: 'aside' }),
    ]),`);
  lines.push(`    ${q(`${domain}-${first.split('_').slice(1).join('-')}`)}: page(${q(first)}, [
      header({ status: 'status', facts: ['reference', '${root}_id', '${root}_id.owner_id.name', 'due_on'] }),
      fields(['amount', 'quantity', 'priority', 'category'], { presentation: 'summary' }),
      fields(['${root}_id.reference', '${root}_id.status', '${root}_id.amount', '${root}_id.owner_id.email'], { title: ${q(title(root))}, presentation: 'properties', region: 'aside' }),
    ]),`);
  lines.push('  },');
  const navIds = [
    `${domain}-home`,
    `${domain}-${root.split('_')[1]}s`,
    `${domain}-${first.split('_').slice(1).join('-')}s`,
    `${domain}-queue`,
    ...(third ? [`${domain}-cards`] : []),
  ];
  lines.push(`  nav: [navGroup(${q(`${domain}-work`)}, ${q(title(domain))}, [${navIds.map(q).join(', ')}], { realm: ${q(realm)} })],`);
  lines.push('} satisfies Feature);');
  lines.push('');
  const body = lines.join('\n');
  /* Only the helpers this domain used: the App compiles under noUnusedLocals. */
  const helpers = HELPERS.filter((name) => new RegExp(`\\b${name}[(.]`).test(body));
  const source = `import { ${helpers.join(', ')} } from '@mistriwork/mistri/app';\nimport type { Feature } from '../mistri-schema.d.ts';\n\n${body}`;
  return { source, commands: commandsHere, root, realm, owner };
}

/** The App's own module: sources, ceilings, tenancy, roles, the features in order, home and nav. */
function appModule(domains, features, { schema }) {
  const lines = [];
  lines.push(`import { defineApp } from '@mistriwork/mistri/app';`);
  lines.push(`import type { App } from './mistri-schema.d.ts';`);
  for (const { domain } of domains) lines.push(`import { ${camel(domain)} } from './features/${domain}.ts';`);
  lines.push('');
  const tenantTables = domains.filter((d) => d.owner === 'tenant').flatMap((d) => d.tables);
  lines.push(`const tenantTables = [${tenantTables.map(q).join(', ')}] as const;`);
  lines.push('');
  lines.push('export default defineApp({');
  lines.push(`  id: 'synthetic', name: 'Synthetic',`);
  lines.push(`  sources: { main: { connection: 'main', default: true } },`);
  lines.push('  resources: {');
  lines.push(`    tenant: { access: 'write', owner: 'platform', recordLabel: 'name' },`);
  lines.push(`    staff: { owner: 'platform', recordLabel: 'name', hidden: ['desk'] },`);
  for (const { owner, tables } of domains) {
    for (const id of tables) {
      const audit = owner === 'tenant' ? `, audit: { redact: ['name', 'notes'] }` : '';
      lines.push(`    ${id}: { ${owner === 'global' ? '' : "access: 'write', "}owner: ${q(owner)}${audit} },`);
    }
  }
  lines.push('  },');
  lines.push(`  auth: {
    providers: ['email'], signUp: 'invite', rows: 'tenant',
    tenancy: { label: 'Tenant', profile: 'tenant', platform: { label: 'Operator' } },
    roles: {
      tenant_admin: { realm: 'tenant', read: tenantTables, write: false },
      tenant_staff: { realm: 'tenant', read: tenantTables, write: false, fields: { ${tenantTables
        .slice(0, 6)
        .map((id) => `${id}: { read: ['id', 'reference', 'name', 'status', 'amount', 'created_on'] }`)
        .join(', ')} } },
      tenant_viewer: { realm: 'tenant', read: tenantTables, write: false },
      platform_admin: { realm: 'platform', read: true, operations: ['readiness'] },
      manager: { realm: 'platform', read: true },
    },
  },`);
  lines.push(`  features: [${domains.map((d) => camel(d.domain)).join(', ')}],`);
  const tenantHome = `${domains.find((d) => d.owner === 'tenant').domain}-home`;
  const platformHome = `${domains.find((d) => d.owner === 'platform').domain}-home`;
  lines.push(`  home: [{ view: ${q(platformHome)}, roles: ['platform_admin', 'manager'] }, { view: ${q(tenantHome)} }],`);
  lines.push(`  nav: [${domains.map((d) => `{ feature: ${q(d.domain)} }`).join(', ')}],`);
  lines.push(`  ui: { shell: { placement: 'side', rail: true }, currency: 'USD', locale: 'en-US' },`);
  lines.push('} satisfies App);');
  lines.push('');
  return lines.join('\n');
}

/** The server modules: each command whole — its target, input and handler — over the typed source, and the tenant policy. */
function serverModules(domains, features) {
  const commands = [];
  commands.push(`import { defineCommand, defineSource, field, int, literal, shape, text } from '@mistriwork/mistri/commands';`);
  commands.push(`import type { Rows } from './mistri-schema.d.ts';`);
  commands.push('');
  commands.push(`const main = defineSource<Rows>('main');`);
  commands.push(`const done = shape({ id: text({ max: 200 }), version: int({ min: 1 }), message: literal('Done.') });`);
  commands.push('');
  commands.push('export default {');
  for (const f of features) {
    if (!f.commands.length) continue;
    const realm = f.realm === 'platform' ? ", realm: 'platform'" : '';
    commands.push(`  ${f.commands[0]}: defineCommand({
    source: main, target: ${q(f.root)}${realm}, when: 'status = open', output: done,
    input: {
      outcome: field.choice(['approved', 'declined', 'held'], { label: 'Outcome' }),
      note: field.textarea({ max: 2000, optional: true }),
      effective_on: field.date({ label: 'Effective' }),
    },
    async handle({ db, record }, { outcome, note }) {
      const row = await db.${f.root}.update(record, { status: outcome, notes: note ?? null });
      return { id: String(row.id), version: Number(row.version), message: 'Done.' };
    },
  }),`);
    commands.push(`  ${f.commands[1]}: defineCommand({
    source: main, target: ${q(f.root)}, targets: 'many'${realm}, output: done,
    input: {
      owner: field.reference('staff', { by: 'id', labelColumn: 'name', query: 'active = true' }),
      reason: field.textarea({ max: 500 }),
      budget: field.group({ amount: field.money({ max: 1000000 }), quantity: field.number({ integer: true, min: 0 }) }, { label: 'Budget' }),
    },
    async handle({ db, records }, { owner, budget }) {
      let last = records[0];
      for (const record of records) last = await db.${f.root}.update(record, { owner_id: String(owner), amount: String(budget.amount), quantity: budget.quantity });
      return { id: String(last.id), version: Number(last.version), message: 'Done.' };
    },
  }),`);
  }
  commands.push('};');
  commands.push('');
  const ownership = [`    tenant: { kind: 'platform' },`, `    staff: { kind: 'platform' },`];
  for (const { owner, tables } of domains)
    for (const id of tables) {
      ownership.push(
        owner === 'tenant'
          ? `    ${id}: { kind: 'tenant', column: 'tenant_id' },`
          : owner === 'global'
            ? `    ${id}: { kind: 'global', access: 'read-only' },`
            : `    ${id}: { kind: 'platform' },`,
      );
    }
  const tenantRows = domains.filter((d) => d.owner !== 'platform').flatMap((d) => d.tables);
  const policy = `import { defineAppTenantPolicy } from '@mistriwork/mistri/policy';

const tenantRows = Object.freeze({ ${tenantRows.map((id) => `${id}: true`).join(', ')} });
const platformRows = Object.freeze({ tenant: true, staff: true, ${domains
    .flatMap((d) => d.tables)
    .map((id) => `${id}: true`)
    .join(', ')} });

export default defineAppTenantPolicy({
  kind: 'tenant',
  appId: 'synthetic',
  storeId: 'synthetic-tenants',
  ownership: {
${ownership.join('\n')}
  },
  resolveRows: () => tenantRows,
  resolveMembershipRows: () => tenantRows,
  resolvePlatformRows: () => platformRows,
  resultReferences: { ${features
    .flatMap((f) => f.commands)
    .map((id) => `${id}: () => []`)
    .join(', ')} },
});
`;
  return { commands: commands.join('\n'), policy };
}

const TSCONFIG = {
  compilerOptions: {
    target: 'ES2023',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    lib: ['ES2023'],
    allowImportingTsExtensions: true,
    verbatimModuleSyntax: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
  },
  include: ['**/*.ts'],
};

/** The generated mistri-commands.d.ts: what `mistri check` writes from the commands module. */
function commandTypesOf(features, commandTypes) {
  const commands = {};
  for (const f of features) {
    if (!f.commands.length) continue;
    commands[f.commands[0]] = { target: f.root, targets: 'one', input: ['outcome', 'note', 'effective_on'] };
    commands[f.commands[1]] = { target: f.root, targets: 'many', input: ['owner', 'reason', 'budget'] };
  }
  return commandTypes(commands, 'Synthetic');
}

/**
 * Write the App into `dir`. `typegen` is the generator's own
 * (packages/mistri/src/server/typegen.ts, or its build) — `typesForSchema` and
 * `commandTypes` — passed in so this module needs no TypeScript loader.
 */
export function writeSyntheticApp(dir, { typesForSchema, commandTypes }, { tables = 150 } = {}) {
  const model = syntheticSchema(tables);
  const features = model.domains.map((d) => ({ ...featureModule(d, model), domain: d.domain }));
  mkdirSync(join(dir, 'features'), { recursive: true });
  writeFileSync(join(dir, 'mistri-schema.d.ts'), typesForSchema(model.schema, 'Synthetic', ['main'], { staff: ['desk'] }));
  for (const f of features) writeFileSync(join(dir, 'features', `${f.domain}.ts`), f.source);
  writeFileSync(join(dir, 'app.ts'), appModule(model.domains, features, model));
  const server = serverModules(model.domains, features);
  writeFileSync(join(dir, 'commands.ts'), server.commands);
  writeFileSync(join(dir, 'mistri-commands.d.ts'), commandTypesOf(features, commandTypes));
  writeFileSync(join(dir, 'tenant-policy.ts'), server.policy);
  writeFileSync(join(dir, 'tsconfig.json'), `${JSON.stringify(TSCONFIG, null, 2)}\n`);
  return { tables: model.schema.tables.length, features: features.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [dir, ...rest] = process.argv.slice(2);
  if (!dir) {
    console.error('usage: node scripts/synthetic-app.mjs <dir> [--tables 150]');
    process.exit(2);
  }
  const at = rest.indexOf('--tables');
  const typegen = await import(new URL('../packages/mistri/dist/server/typegen.js', import.meta.url).href);
  const made = writeSyntheticApp(resolve(dir), typegen, { tables: at >= 0 ? Number(rest[at + 1]) : 150 });
  console.log(`synthetic App: ${made.tables} tables, ${made.features} features, in ${resolve(dir)}`);
}
