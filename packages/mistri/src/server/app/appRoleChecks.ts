/**
 * What each role meets only at runtime, said by `mistri check`.
 *
 * Every signed-in request is served a catalog cut to its roles' grants
 * (accessibleSchema), and what that catalog cannot draw is quietly left out
 * for them: a rollup over a column they cannot read is not served, so a list
 * showing it loses its presentation or is dropped; a page naming one is
 * dropped, and the record opens on the default anatomy; a record name naming
 * one is not said, and the record reads "(row)"; a command whose footprint
 * they cannot read loses its buttons and its form; a write grant whose
 * columns cannot make a row offers no New. Each is right at runtime — nothing
 * a role may not see is drawn — and each was a mistake the author found only
 * by signing in as the role. So the check reads the App once per role, over
 * the catalog that role is served, and names the role, the thing and the
 * column.
 *
 * What a role cannot be served is appRoleReach's; grants that do less than
 * they say are appRoleWarnings'. Only check reads these: the payload's
 * problems are judged over a reader's already-pruned catalog, where another
 * role's reach is not known.
 */
import { dirname, relative } from 'node:path';
import { appRollupRules, withRollups } from '../../shared/appRollups.js';
import { appCommandGrants, grantsByRole, logicalResource, resolveAppAccess, resolveViews, type AppDef } from '../../shared/app.js';
import { labelTemplateProblem } from '../../shared/appRecordLabels.js';
import { isTenantApp, NAMED_PROVIDER } from '../../shared/appModel.js';
import { assertNever, humanName } from '@mistriwork/engine/shared/model.js';
import { ADMIN_ROLE } from '../../shared/accountAdministration.js';
import { isLabelTemplate, parseLabelTemplate } from '@mistriwork/engine/shared/recordLabel.js';
import { locateProblem } from '../../shared/appProvenance.js';
import { timelineMarkColumns, validatePage, type PageSection } from '@mistriwork/engine/shared/page.js';
import { ANYONE, parseQuery } from '@mistriwork/engine/shared/query.js';
import { unformedColumns } from '@mistriwork/engine/shared/form.js';
import { findTable, tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { tryResolvePath } from '@mistriwork/engine/shared/viewPaths.js';
import { callerRead, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import { opensTo } from '../../shared/appViewRoles.js';
import { accessibleSchema } from './appAccess.js';
import { fieldAccessibleApp, fieldAccessiblePage, readablePage, readableSection } from './appFieldProjection.js';
import type { LoadedApp } from './apps.js';

/** A role and the catalog it is served: its tables, their columns, the rollups that resolve in them. */
interface RoleView {
  role: string;
  /** Before rollups: what appRollupRules judges a role's rollups against. */
  plain: DatabaseSchema;
  served: DatabaseSchema;
  reads: ReadonlySet<string>;
}

function roleViews(app: AppDef, schema: DatabaseSchema): RoleView[] {
  if (!grantsByRole(app)) return [];
  return Object.keys(app.auth?.roles ?? {}).flatMap((role) => {
    try {
      const access = resolveAppAccess(app, schema, [role]);
      const plain = accessibleSchema(schema, access);
      return [{ role, plain, served: withRollups(app, plain), reads: access.readable }];
    } catch {
      return []; // An invalid grant is refused on its own, with its own reason.
    }
  });
}

/**
 * The roles only a client or a job holds: declared `service: true`, or named
 * by the API's `roles` or a jobs module's principal and by nothing a person
 * signs in through (the default role, a home rule, a claim rule). No one
 * opens a list or a page under them, so what those would not draw for them
 * is no finding.
 */
function serviceRoles(app: AppDef, jobRoles: ReadonlySet<string>): Set<string> {
  const declared = Object.entries(app.auth?.roles ?? {}).flatMap(([role, grant]) => (grant.service ? [role] : []));
  const held = new Set<string>([...(app.api?.roles ?? []), ...jobRoles, ...declared]);
  const person = new Set<string>([
    ...(app.auth?.defaultRole ? [app.auth.defaultRole] : []),
    ...app.home.flatMap((rule) => rule.roles ?? []),
  ]);
  for (const [role, grant] of Object.entries(app.auth?.roles ?? {})) if (grant.claims !== undefined) person.add(role);
  return new Set([...held].filter((role) => !person.has(role)));
}

/** What a role cannot read on the way along `path` from `base`: a table, a column, or a rollup it is not served. */
function unreadable(whole: DatabaseSchema, view: RoleView, base: string, path: string): string | undefined {
  const segments = path.split('.');
  for (let length = 1; length <= segments.length; length++) {
    const prefix = segments.slice(0, length).join('.');
    const there = tryResolvePath(whole, base, prefix).resolved;
    if (!there) return undefined; // Not the App's to draw at all: validation names it.
    if (!view.reads.has(there.table.id)) return `"${there.table.id}"`;
    if (tryResolvePath(view.served, base, prefix).resolved) continue;
    return there.rollup ? `the rollup "${there.table.id}.${there.column.name}"` : `"${there.table.id}.${there.column.name}"`;
  }
  return undefined;
}

/** The roles, as a sentence names them: role "a", roles "a" and "b". */
const whose = (roles: readonly string[]) =>
  roles.length === 1
    ? `role "${roles[0]}"`
    : `roles ${roles
        .slice(0, -1)
        .map((role) => `"${role}"`)
        .join(', ')} and "${roles[roles.length - 1]}"`;

/** The sentence that gives the roles what they lack: a table to read, or a column within one. */
function grantFix(roles: readonly string[], what: string): string {
  if (what.startsWith('the rollup')) return 'Give the role what that rollup reads (said with the rollup)';
  const [table, column] = what.slice(1, -1).split(/\.(?=[^.]+$)/);
  const where = column === undefined ? 'read' : `fields.${table}.read`;
  return `Add "${column ?? table}" to ${roles.length === 1 ? `roles.${roles[0]}.${where}` : `${where} in each role's grant`}`;
}

/** Every column a filter in the query language names, as written: judged against the table it runs over. */
function queryColumns(schema: DatabaseSchema, table: string, query: string | undefined): string[] {
  if (!query) return [];
  // `me` as anyone's: a condition about the reader still names the columns it reads.
  const parsed = parseQuery(`${table} ${query}`, { schema, me: ANYONE });
  return parsed.query
    ? parsed.query.filter.groups.flat().flatMap((condition) => [condition.column, ...(condition.other ? [condition.other] : [])])
    : [];
}

/** The paths one page section reads, each from the table it reads it on. Every kind has its case: a kind
    without one would name nothing for a role that cannot read it. Exported for its test. */
export function sectionReads(schema: DatabaseSchema, base: string, section: PageSection): Array<{ from: string; path: string }> {
  const on = (from: string, paths: ReadonlyArray<string | undefined>) => paths.flatMap((path) => (path ? [{ from, path }] : []));
  // A breakdown's `by` may lead with its bucket ("month funded_on"): the path is its last word.
  const lastWord = (text: string | undefined) => text?.trim().split(/\s+/).pop();
  switch (section.kind) {
    case 'fields':
      return on(base, [
        ...(section.paths ?? []),
        section.status,
        section.subfigure,
        section.was,
        ...queryColumns(schema, base, section.when),
      ]);
    case 'custom':
      return on(base, section.record ?? []);
    case 'list':
      return on(section.from, [
        section.path,
        ...(section.columns ?? []),
        ...(section.orderBy ?? []).map((order) => order.column),
        ...queryColumns(schema, section.from, section.filter),
      ]);
    case 'metric':
      return on(section.from, [section.path, section.column, ...queryColumns(schema, section.from, section.filter)]);
    case 'breakdown':
    case 'chart':
      return on(section.from, [section.path, section.column, lastWord(section.by), ...queryColumns(schema, section.from, section.filter)]);
    case 'timeline':
      return section.streams.flatMap((stream) =>
        on(stream.from, [
          stream.path,
          stream.at,
          stream.show,
          stream.detail,
          stream.by,
          ...timelineMarkColumns(section, stream, findTable(schema, stream.from)),
          ...queryColumns(schema, stream.from, stream.filter),
        ]),
      );
    /* A note reads nothing of its own; a history and flow runs are the record's own, read by their own routes;
       a diagram's steps are read as the reader's rows. */
    case 'note':
    case 'history':
    case 'flows':
    case 'diagram':
      return [];
    default:
      return assertNever(section, 'page section kind');
  }
}

const CODE = 'role-cannot-read';

/** Every word in a view that could be a column or a path: its show, its presentation's fields, its sort and filters, its tabs' queries. */
function mentioned(view: unknown): string[] {
  const words = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === 'string') for (const word of value.match(/[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*/g) ?? []) words.add(word);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object')
      for (const [key, inner] of Object.entries(value)) if (!['label', 'title', 'empty', 'icon', 'description'].includes(key)) walk(inner);
  };
  walk(view);
  return [...words];
}

/** One thing some roles cannot be served, said once for all of them. */
interface Finding {
  file: string;
  head: string;
  missing: string;
  roles: string[];
  tail: (roles: string[]) => string;
}

/**
 * What some role cannot be served because it names a table or a column that
 * role's grants leave out. A record name is a problem: its records read
 * "(row)" for that role, and a name of the columns every role reads is always
 * there to write. A list or a page is a warning: the role is served less —
 * the list without its presentation or not at all, the default page — which
 * is sometimes the point (a credit file whose bureau only the deciders read,
 * a moderators' room), and there is no other way yet to make a room one
 * role's and not another's. A rollup is said where it is shown, with the
 * column under it that the role cannot read.
 */
export function appRoleReach(
  loaded: LoadedApp,
  schema: DatabaseSchema,
  jobRoles: ReadonlySet<string> = new Set(),
): { problems: string[]; warnings: string[] } {
  const app = loaded.app;
  const service = serviceRoles(app, jobRoles);
  const views = roleViews(app, schema).filter((view) => !service.has(view.role));
  if (!views.length) return { problems: [], warnings: [] };
  const home = loaded.dir ?? dirname(loaded.path);
  const manifest = relative(home, loaded.path) || loaded.path;
  const whole = withRollups(app, schema);
  const fullRules = appRollupRules(app, schema).rules;
  const exact = (name: string) => schema.tables.find((table) => table.id === name) ?? tableNamed(schema, name);
  const problems = new Map<string, Finding>();
  const warnings = new Map<string, Finding>();
  const note = (into: Map<string, Finding>, finding: Omit<Finding, 'roles'>, role: string) => {
    const key = `${finding.file}\n${finding.head}\n${finding.missing}`;
    const held = into.get(key);
    if (held) held.roles.push(role);
    else into.set(key, { ...finding, roles: [role] });
  };

  for (const view of views) {
    const { role } = view;
    /* Rollups this role is not served, and why: named with a list or a page that shows one. */
    const served = appRollupRules(app, view.plain).rules;
    const rollupWhy = new Map<string, string>();
    for (const [name, resource] of Object.entries(app.resources ?? {})) {
      const table = exact(name);
      if (!table || !resource.rollups || !view.reads.has(table.id)) continue;
      for (const [key, rollup] of Object.entries(resource.rollups)) {
        if (!fullRules.get(table.id)?.[key] || served.get(table.id)?.[key]) continue;
        const child = exact(rollup.from)!;
        /* The reference it counts through: the one it names, or the one it found. */
        const via = fullRules.get(table.id)![key].via;
        const through = rollup.whose ? [rollup.whose] : via.slice(via.lastIndexOf('.') + 1).split('+');
        // A computed column it sums is read through the columns under it.
        const reads = [
          ...through,
          ...(rollup.fn !== 'count' && rollup.column
            ? ((fullRules.get(table.id)![key].expression ?? fullRules.get(table.id)![key].of?.expression)?.reads ?? [rollup.column])
            : []),
          ...(fullRules.get(table.id)![key].by === undefined ? [] : [fullRules.get(table.id)![key].by!]),
          ...queryColumns(schema, child.id, rollup.query),
        ];
        rollupWhy.set(
          `${table.id}.${key}`,
          !view.reads.has(child.id)
            ? `"${child.id}"`
            : (reads.map((path) => unreadable(whole, view, child.id, path)).find(Boolean) ?? `a column of "${child.id}"`),
        );
      }
    }
    /* What a rollup stands for in a sentence and in its fix: the column under it. */
    const explain = (missing: string) => {
      const rollup = /^the rollup "(.+)"$/.exec(missing)?.[1];
      const under = rollup ? rollupWhy.get(rollup) : undefined;
      return { said: under ? `${missing}, which reads ${under}` : missing, fix: under ?? missing };
    };
    /* Lists: one over a table this role reads that its catalog cannot draw,
       or draws without its presentation — as a request projects the App. */
    const projected = fieldAccessibleApp(app, view.served);
    const drawn = resolveViews(projected, view.served);
    for (const [key, raw] of Object.entries(app.views)) {
      // A view that names its roles is not this role's to be served less of.
      if (!('table' in raw) || 'command' in raw || !opensTo(raw, [role], app.auth)) continue;
      const table = exact((raw as { table: string }).table);
      const mine = drawn[key] as { error?: string; errors?: string[] } | undefined;
      if (!table || !view.reads.has(table.id) || !mine) continue;
      const dropped = Boolean(mine.error || mine.errors?.length);
      const plain =
        !dropped &&
        (raw as { presentation?: unknown }).presentation !== undefined &&
        (projected.views[key] as { presentation?: unknown }).presentation === undefined;
      if (!dropped && !plain) continue;
      const missing = mentioned(raw)
        .map((path) => unreadable(whole, view, table.id, path))
        .find(Boolean);
      if (!missing) continue;
      const { said, fix } = explain(missing);
      note(
        warnings,
        {
          file: manifest,
          head: locateProblem(loaded.origins, `view "${key}" [${CODE}]: ${dropped ? 'it' : 'its presentation'} names`),
          missing: said,
          tail: (roles) =>
            `so ${dropped ? 'the view is not served to' : 'the view is drawn as a plain grid for'} ${roles.length === 1 ? 'that role' : 'them'}. ` +
            `${grantFix(roles, fix)}, or leave it out of the view.`,
        },
        role,
      );
    }
    // Record names: a template or path this role cannot resolve reads "(row)".
    for (const [name, resource] of Object.entries(app.resources ?? {})) {
      const label = resource.recordLabel;
      const table = exact(name);
      if (typeof label !== 'string' || !table || !view.reads.has(table.id)) continue;
      const fine = (catalog: DatabaseSchema) => {
        const meta = catalog.tables.find((candidate) => candidate.id === table.id);
        return (
          Boolean(meta) &&
          (isLabelTemplate(label)
            ? !labelTemplateProblem(catalog, meta!, label)
            : Boolean(tryResolvePath(catalog, table.id, label).resolved))
        );
      };
      if (!fine(whole) || fine(view.served)) continue;
      const parsed = isLabelTemplate(label) ? parseLabelTemplate(label) : { paths: [label] };
      const paths = 'paths' in parsed ? parsed.paths : [];
      const missing = paths.map((path) => unreadable(whole, view, table.id, path)).find(Boolean) ?? 'one of its columns';
      note(
        problems,
        {
          file: manifest,
          head: locateProblem(loaded.origins, `resources "${name}", recordLabel [${CODE}]`),
          missing,
          tail: (roles) =>
            `so its records have no name there and read "(row)". ${grantFix(roles, missing)}, or name the record by columns every role reads.`,
        },
        role,
      );
    }
    // Pages: one the whole catalog draws and this role's drops for the default anatomy.
    for (const page of loaded.pages) {
      if (!opensTo(page, [role], app.auth)) continue;
      const checked = validatePage(whole, page);
      if (checked.error) continue; // Validation names it for everyone.
      const base = tableNamed(view.served, checked.base);
      if (!base || fieldAccessiblePage(view.served, page)) continue;
      // Left out for this role, section by section (readablePage), or the whole page when nothing of it reads.
      const kept = readablePage(view.served, page);
      /* A related list the role reads but does not write into is drawn without its New, which is what a create
         for some roles means: no finding. Nor is a headline whose earlier figure the role does not read. A fields
         section drawn without some of its fields is a finding, as one left out is. */
      const leavesOut = (section: (typeof checked.sections)[number]) => {
        const drawn = readableSection(view.served, page, section);
        return !drawn || (drawn.kind === 'fields' && section.kind === 'fields' && drawn.paths?.length !== section.paths?.length);
      };
      if (kept && !checked.sections.some(leavesOut)) continue;
      const culprits = checked.sections.flatMap((section) => {
        if (!leavesOut(section)) return [];
        const found = sectionReads(schema, base.id, section)
          .map(({ from, path }) => {
            const fromId = exact(from)?.id ?? from;
            return !view.reads.has(fromId) ? `"${fromId}"` : unreadable(whole, view, fromId, path);
          })
          .find(Boolean);
        const title = (section as { title?: string }).title;
        const where =
          section.kind === 'fields' && section.presentation === 'header'
            ? 'its header'
            : title
              ? `its section "${title}"`
              : `a ${section.kind} section`;
        return [{ where, what: found }];
      });
      const first = culprits.find((culprit) => culprit.what) ?? culprits[0];
      const feature = loaded.origins?.pages[page.id];
      const { said: missing, fix } = explain(first?.what ?? 'something');
      note(
        warnings,
        {
          file: relative(home, loaded.sources[page.id] ?? loaded.path) || loaded.path,
          head: `${feature ? `features "${feature}", ` : ''}page "${page.name}" [${CODE}]: ${first ? first.where : 'it'} names`,
          missing,
          tail: (roles) =>
            (kept
              ? `so the page leaves it out for ${roles.length === 1 ? 'that role' : 'them'}. `
              : `so ${roles.length === 1 ? 'that role opens' : 'they open'} its records on the default page instead. `) +
            `${first?.what ? grantFix(roles, fix) : 'Give the role what it names'}, or leave it out of the page.`,
        },
        role,
      );
    }
  }
  const say = (finding: Finding) =>
    finding.head.endsWith(' names')
      ? `${finding.file}: ${finding.head} ${finding.missing}, which ${whose(finding.roles)} cannot read, ${finding.tail(finding.roles)}`
      : `${finding.file}: ${finding.head}: ${whose(finding.roles)} cannot read ${finding.missing}, ${finding.tail(finding.roles)}`;
  return { problems: [...problems.values()].map(say), warnings: [...warnings.values()].map(say) };
}

/* Where the App plainly means rows to be made by hand: a New form it dresses,
   a quick add over the table, or a related list's create into it. A write
   grant with none of these is often an edit-only grant on purpose (a
   borrower's own profile), and New is simply not offered for it. */
function asksForNew(loaded: LoadedApp, schema: DatabaseSchema, tableId: string): boolean {
  const app = loaded.app;
  const is = (name: string | undefined) =>
    name !== undefined && (schema.tables.find((table) => table.id === name) ?? tableNamed(schema, name))?.id === tableId;
  if (Object.entries(app.resources ?? {}).some(([name, resource]) => is(name) && resource.form)) return true;
  if (
    Object.values(app.views).some(
      (view) => 'table' in view && (view as { quickAdd?: unknown }).quickAdd && is((view as { table: string }).table),
    )
  )
    return true;
  return loaded.pages.some((page) => page.sections.some((section) => section.kind === 'list' && section.create && is(section.from)));
}

/**
 * Grants that do less than they say: a command granted to a role that cannot
 * read its footprint (its buttons and form are never offered to that role),
 * a write grant whose columns cannot make a row (New is never offered).
 */
export function appRoleWarnings(loaded: LoadedApp, schema: DatabaseSchema, commands?: BusinessCommandRegistry): string[] {
  const app = loaded.app;
  if (!grantsByRole(app)) return [];
  const manifest = relative(loaded.dir ?? dirname(loaded.path), loaded.path) || loaded.path;
  const say = (text: string) => `${manifest}: ${locateProblem(loaded.origins, text)}`;
  const warnings: string[] = [];
  const roles = Object.keys(app.auth?.roles ?? {});
  /* Every role of an App that signs people in is named to people: on the
     accounts screen, a suite's grants, a tenant's members and invitations.
     Without a label they read its id made words, which is rarely what the
     business calls it. Words only, so a warning. */
  for (const role of roles) {
    if (app.auth?.roles?.[role]?.label !== undefined) continue;
    warnings.push(
      say(
        `role "${role}" [role-label]: it has no "label", so the screens that name it to people say "${humanName(role)}". ` +
          `Give it the name people know it by: roles.${role}.label.`,
      ),
    );
  }
  /* The account a first start makes (MISTRI_AUTH_ADMIN_EMAIL) holds `admin`, and `admin` reads and writes what its
     entry here grants: none, and the App's owner signs in to an App with nothing in it. A tenant App's members are
     its own administration's. */
  if (!isTenantApp(app) && !roles.includes(ADMIN_ROLE))
    warnings.push(
      say(
        `role "${ADMIN_ROLE}" [admin-grants-nothing]: auth.roles declares no "${ADMIN_ROLE}", the role the first account ` +
          `(MISTRI_AUTH_ADMIN_EMAIL) and every administrator holds, so it signs in to an App that shows it nothing. ` +
          `Grant it what an administrator reads and writes: roles.${ADMIN_ROLE}, for example { read: true, write: true }.`,
      ),
    );
  /* A claim rule without `provider` is read from every named provider's sign-in. With one provider that is the
     same thing; with several, a claim of the same name from another identity provider (a contractors' IdP that
     also says `groups`) would give the role (0.8.5 I1). Allowed, since an App may trust them all alike, and said. */
  const named = (app.auth?.providers ?? []).filter((provider) => NAMED_PROVIDER.test(provider));
  if (named.length > 1)
    for (const role of roles) {
      const claims = app.auth?.roles?.[role]?.claims;
      if (!claims || claims.provider !== undefined) continue;
      warnings.push(
        say(
          `role "${role}" [claim-any-provider]: its claims are read from a sign-in through any of ${named.join(', ')}, ` +
            `so a claim of the same name from another of them gives it too. Say whose claims these are: ` +
            `roles.${role}.claims.provider, for example ${named[0].replace(/^(oidc|saml):(.*)$/, "$1('$2')")}.`,
        ),
      );
    }
  for (const role of roles) {
    let access: ReturnType<typeof resolveAppAccess>;
    try {
      access = resolveAppAccess(app, schema, [role]);
    } catch {
      return warnings;
    }
    for (const id of appCommandGrants(app, [role])) {
      const command = commands?.[id];
      if (!command) continue;
      const blind = callerRead(command)
        .map((local) => logicalResource(app, command.source, local))
        .filter((table) => !access.readable.has(table));
      if (!blind.length) continue;
      warnings.push(
        say(
          `role "${role}" [command-unreadable]: it is granted command "${id}", which reads ${blind.map((table) => `"${table}"`).join(', ')}; ` +
            `the role does not read ${blind.length === 1 ? 'it' : 'them'}, so the command's actions and form are never offered to it. ` +
            `Add ${blind.length === 1 ? 'it' : 'them'} to roles.${role}.read, or take the command from the role.`,
        ),
      );
    }
    /* A column the role writes that references a table it does not read:
       every write that sets it is refused (a write may point a row only at
       a parent the principal reads), while the rest of the row edits. Said
       here, where the grant is, and not first at a Save. */
    for (const tableId of access.writable) {
      const writes = access.fields?.get(tableId)?.write;
      for (const fk of schema.foreignKeys.filter((fk) => fk.from.table === tableId && !fk.declared)) {
        const set = fk.from.columns.filter((column) => writes?.has(column) ?? true);
        if (!set.length) continue;
        const reads = access.readable.has(fk.to.table) ? access.fields?.get(fk.to.table)?.read : undefined;
        if (access.readable.has(fk.to.table) && fk.to.columns.every((column) => reads?.has(column) ?? true)) continue;
        warnings.push(
          say(
            `role "${role}" [write-unreadable-parent]: it writes ${set.map((column) => `"${tableId}".${column}`).join(', ')}, which references ` +
              `"${fk.to.table}", and the role does not read ${access.readable.has(fk.to.table) ? 'its key' : 'it'}: a write that sets ` +
              `${set.length === 1 ? 'it' : 'them'} is refused, while the rest of the row edits. Let the role read "${fk.to.table}", ` +
              `or leave ${set.length === 1 ? 'the column' : 'the columns'} out of roles.${role}.fields.${tableId}.write.`,
          ),
        );
      }
    }
    /* A column the database computes (a generated column) is read and never written: a write grant that names it
       grants nothing, and a write that sets it is refused. Said where the grant is, not first at a Save. */
    for (const tableId of access.writable) {
      const table = schema.tables.find((candidate) => candidate.id === tableId);
      const named = new Set([
        ...(app.auth?.roles?.[role]?.fields?.[tableId]?.write ?? []),
        ...(app.resources?.[tableId]?.fields?.write ?? []),
      ]);
      const computed = (table?.columns ?? [])
        .filter((column) => column.writable === false && named.has(column.name))
        .map((column) => column.name);
      if (!computed.length) continue;
      warnings.push(
        say(
          `role "${role}" [write-generated]: it writes ${computed.map((column) => `"${tableId}".${column}`).join(', ')}, which the ` +
            `database computes, so nothing writes ${computed.length === 1 ? 'it' : 'them'} and a write that sets ` +
            `${computed.length === 1 ? 'it' : 'them'} is refused; ${computed.length === 1 ? 'it is' : 'they are'} read like any other column. ` +
            `Leave ${computed.length === 1 ? 'the column' : 'the columns'} out of fields.write.`,
        ),
      );
    }
    for (const tableId of access.writable) {
      const table = schema.tables.find((candidate) => candidate.id === tableId);
      const fields = access.fields?.get(tableId);
      if (!table || table.isView || !fields || !asksForNew(loaded, schema, tableId)) continue;
      // The role says it edits and never creates here (`create`): no New is the point.
      if (access.creatable && !access.creatable.has(tableId)) continue;
      const missing = unformedColumns(table, (column) => fields.write.has(column));
      if (!missing.length) continue;
      /* A machine's column is never the role's to write, so the fixes left
         are a command that makes the rows, or saying so. */
      const owned = missing.some((column) => app.resources?.[tableId]?.machine?.column === column);
      warnings.push(
        say(
          `role "${role}" [new-cannot-form]: it writes "${tableId}" but not ${missing.map((column) => `"${column}"`).join(', ')}, ` +
            `which a new row needs, so it can edit ${tableId} rows and New is never offered to it. ` +
            (owned ? '' : `Add ${missing.length === 1 ? 'it' : 'them'} to roles.${role}.fields.${tableId}.write, `) +
            `make the rows with a command, or say the role edits and never creates them (roles.${role}.create).`,
        ),
      );
    }
  }
  return warnings;
}
