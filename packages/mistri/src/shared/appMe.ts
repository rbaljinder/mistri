/**
 * `me` in an App's conditions: the signed-in person, as the server's session
 * says, in a tab, a view's query, a dashboard section's, a page's `when` and
 * an action's `when`:
 *
 *   segments: { mine: 'owner_id = me', filed_by_me: 'filed_by = me' },  tabs: ['mine', 'filed_by_me']
 *
 * Beside a text column `me` is the account's email — the name a stamp
 * writes (appStamps) and the change history records. Beside a reference to
 * the table people are rows of, it is that person's row, which `auth.me`
 * declares by the column holding the email:
 *
 *   auth: { me: { from: 'employee', column: 'email' }, roles: { … } }
 *
 * `me.<table>.<column>` in a value list is the person's memberships: the
 * values of `column` in the rows of `table` that point at their row, read for
 * the request through its own reader:
 *
 *   segments: { my_groups: 'assignment_group_id in (me.group_member.group_id)' },  tabs: ['my_groups']
 *
 * In a tenant App (`auth.rows: 'tenant'`) a person is a row per membership:
 * `auth.me.column` holds the account's id, and `me` is the row of the tenant
 * the request's lease is in — never another tenant's, and nobody where that
 * tenant has no row for them (server appMe.ts `lookupTenantPerson`).
 *
 * The browser sends the word and the server resolves it in the parse it runs
 * for the request (query.ts `QueryPerson`), so a tab never means someone the
 * page chose. Where there is nobody to mean — an App without sign-in, a form's
 * own conditions, which the browser evaluates as someone types — the word is
 * refused as the App loads rather than compared as the text "me".
 *
 * Pure: the refusals need only the App; the catalog checks take one schema.
 */
import type { QueryPerson } from '@mistriwork/engine/shared/query.js';
import type { MeSet } from '@mistriwork/engine/shared/queryOperands.js';
import { maskQuoted } from '@mistriwork/engine/shared/maskQuoted.js';
import { columnKind, primaryKey, tableNamed, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { isTenantApp, type AppDef } from './appModel.js';
import { autoKey, isRequired } from '@mistriwork/engine/shared/form.js';
import type { PageDef } from '@mistriwork/engine/shared/pageModel.js';

/** `me` in a value position: after a comparison, or as an item of an `in (…)` list, alone or as `me.<table>.<column>`. Quoted text is never it. */
const VALUE_ME = /(?:!=|<=|>=|=|<|>|\bin\s*[([]|\bin\s+(?=me\.)|,)\s*me(?=$|[\s),\]]|\.[A-Za-z_]\w*\.[A-Za-z_]\w*(?![\w.]))/i;
/** Each `me.<table>.<column>` a text says, outside quotes. */
const SET_WORD = /(?<![\w.$])me\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)(?![\w.$])/gi;

/** The memberships a condition reads (`me.group_member.group_id` is `group_member.group_id`), each once. */
export function meSetsIn(...texts: unknown[]): string[] {
  const names = new Set<string>();
  for (const text of texts) {
    if (typeof text !== 'string' || !/\bme\./i.test(text)) continue;
    for (const match of maskQuoted(text).matchAll(SET_WORD)) names.add(`${match[1]}.${match[2]}`);
  }
  return [...names];
}

/**
 * Where `me.<table>.<column>` reads, in one catalog: the table, the one column
 * of it that points at the table people are rows of, and the column whose
 * values it is — or why it cannot be read there.
 */
export function meSetShape(
  schema: DatabaseSchema,
  person: QueryPerson['person'],
  name: string,
): { table: TableMeta; link: string; column: string; set: MeSet } | { set: MeSet } {
  const [tableName, columnName] = name.split('.');
  const word = `me.${name}`;
  const refused = (error: string) => ({ set: { error } });
  if (!person)
    return refused(
      `${word} reads the rows that point at the signed-in person, and the App does not say which table people are rows of (auth.me).`,
    );
  const table = tableNamed(schema, tableName);
  if (!table) return refused(`${word}: "${tableName}" is not a resource this reader reads.`);
  const column = table.columns.find((candidate) => candidate.name === columnName);
  if (!column) return refused(`${word}: "${columnName}" is not a column of ${table.name} this reader reads.`);
  const links = table.columns.filter((candidate) => candidate.references?.table === person.table);
  if (!links.length)
    return refused(`${word}: no column of ${table.name} points at ${person.table}, so none of its rows is the signed-in person's.`);
  if (links.length > 1)
    return refused(
      `${word}: ${links.map((link) => `"${link.name}"`).join(' and ')} of ${table.name} each point at ${person.table}, so which rows are the person's is not one answer.`,
    );
  return { table, link: links[0].name, column: column.name, set: { values: [], kind: columnKind(column.type) } };
}

/** Whether a condition compares something with `me` rather than with the text "me". */
export function mentionsMe(text: string | undefined): boolean {
  return typeof text === 'string' && /\bme\b/i.test(text) && VALUE_ME.test(maskQuoted(text));
}

interface Mention {
  where: string;
  text: string | undefined;
}

function listMentions(app: AppDef): Mention[] {
  const found: Mention[] = [];
  for (const [key, view] of Object.entries(app.views)) {
    const v = view as { query?: string; tabs?: ReadonlyArray<{ label: string; query?: string }>; sections?: unknown[]; aside?: unknown[] };
    found.push({ where: `view "${key}"`, text: v.query });
    for (const tab of v.tabs ?? []) found.push({ where: `view "${key}", tab "${tab.label}"`, text: tab.query });
    for (const section of [...(v.sections ?? []), ...(v.aside ?? [])] as Array<{
      title?: string;
      kind?: string;
      query?: string;
      compare?: string;
    }>) {
      const where = `view "${key}", section "${section.title ?? section.kind}"`;
      found.push({ where, text: section.query }, { where, text: section.compare });
    }
  }
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    for (const action of resource.actions ?? []) found.push({ where: `resources "${name}", action "${action.id}"`, text: action.when });
    // A segment is spelled out wherever its name stands, so `me` in one is `me` in every tab and metric naming it.
    for (const [key, segment] of Object.entries(resource.segments ?? {}))
      found.push({ where: `resources "${name}", segments "${key}"`, text: segment.query });
  }
  return found;
}

function pageMentions(pages: readonly PageDef[]): Mention[] {
  return pages.flatMap((page) =>
    page.sections.map((section, i) => ({
      where: `page "${page.name}", ${(section as { title?: string }).title ? `section "${(section as { title?: string }).title}"` : `section ${i + 1}`}`,
      text: (section as { when?: string }).when,
    })),
  );
}

/**
 * The places `me` can never mean anyone, refused as the App is read: with no
 * sign-in there is nobody, and a form's conditions and a page section's filter are judged where the session
 * is not (the browser, and the page's own plan of the record).
 */
export function checkMe(app: AppDef, pages: readonly PageDef[], where: string): void {
  const said = [...listMentions(app), ...pageMentions(pages)].find((m) => mentionsMe(m.text));
  if (said && !app.auth) {
    throw new Error(
      `${where}: ${said.where} compares with me, the signed-in person, and this App has no sign-in. Add "auth", or compare with a value.`,
    );
  }
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    const form = resource.form as { when?: Record<string, string> } | undefined;
    for (const [field, condition] of Object.entries(form?.when ?? {})) {
      if (mentionsMe(condition)) {
        throw new Error(
          `${where}: resources "${name}", form when "${field}" compares with me. A form's conditions are judged in the browser as someone types, ` +
            "against the record's own values, where the session is not; show the field always, or narrow who may write it with roles.",
        );
      }
    }
    for (const rule of resource.validation ?? []) {
      if (mentionsMe(rule.when) || mentionsMe(rule.must)) {
        throw new Error(
          `${where}: resources "${name}", validation "${rule.message}" compares with me. A validation's conditions read the record's own values only.`,
        );
      }
    }
  }
  for (const page of pages) {
    for (const [i, section] of page.sections.entries()) {
      const filter = (section as { filter?: string }).filter;
      if (mentionsMe(filter)) {
        const title = (section as { title?: string }).title;
        throw new Error(
          `${where}: page "${page.name}", ${title ? `section "${title}"` : `section ${i + 1}`} filters by me. A page section lists what belongs to its record; ` +
            'to list what belongs to the signed-in person, use a list view with a tab (query: "owner_id = me").',
        );
      }
    }
  }
}

/**
 * `auth.me` against one catalog: the table people are rows of, with one key and a text column holding the
 * email — or, in a tenant App, the account's id, which is what a membership names (one account, a row in each
 * of its tenants).
 */
export function personTable(app: AppDef, schema: DatabaseSchema): { table?: TableMeta; column?: string; problem?: string } {
  const me = app.auth?.me;
  if (!me) return {};
  const table = tableNamed(schema, me.from);
  if (!table) return { problem: `auth.me names "${me.from}", which this connection does not have.` };
  const column = table.columns.find((c) => c.name === me.column);
  if (!column) return { problem: `auth.me names "${me.column}", which is not a column of ${table.name}.` };
  if (columnKind(column.type) !== 'text') {
    const held = isTenantApp(app) ? "account's id" : "account's email";
    return {
      problem: `auth.me: "${me.column}" is ${column.type || 'untyped'}, and it is compared with the signed-in ${held}, which only a text column holds.`,
    };
  }
  if (primaryKey(table).length !== 1) {
    return { problem: `auth.me: ${table.name} needs a one-column primary key, which is what a reference to a person holds.` };
  }
  if (me.create) {
    const problem = personCreateProblem(table, column.name, me.create);
    if (problem) return { problem };
  }
  return { table, column: column.name };
}

/**
 * Why `auth.me.create` cannot make a new account's row in this table, or
 * undefined. The email must be unique, so a second sign-up finds the row the
 * first made rather than making another (two rows with one email name nobody:
 * lookupPerson); the name column must hold text; and every other column the
 * row needs must fill itself — a default, or a key the database assigns.
 */
function personCreateProblem(table: TableMeta, email: string, create: { name?: string }): string | undefined {
  if (!table.unique?.includes(email) && !table.columns.some((c) => c.name === email && c.primaryKey && primaryKey(table).length === 1)) {
    return (
      `auth.me.create makes one ${table.name} row per account, found again by "${email}", which nothing makes unique. ` +
      `Add a unique constraint on ${table.name}(${email}).`
    );
  }
  if (create.name !== undefined) {
    const name = table.columns.find((c) => c.name === create.name);
    if (!name) return `auth.me.create names "${create.name}" for the account's name, which is not a column of ${table.name}.`;
    if (columnKind(name.type) !== 'text')
      return `auth.me.create: "${create.name}" is ${name.type || 'untyped'}; an account's name goes in a text column.`;
  }
  const filled = new Set([email, ...(create.name ? [create.name] : [])]);
  const assigned = autoKey(table);
  const unfilled = table.columns.filter((c) => !filled.has(c.name) && isRequired(c, assigned));
  if (unfilled.length) {
    return (
      `auth.me.create cannot make a ${table.name} row: ${unfilled.map((c) => `"${c.name}"`).join(', ')} must be filled and has no default. ` +
      'Give it a default, or let it be empty.'
    );
  }
  return undefined;
}

/**
 * A stand-in person for judging conditions as the App loads: the same checks
 * a request's parse makes, on a value no row carries. Undefined where the
 * App has no sign-in, so `me` there stays text for the refusal above to name.
 */
export function checkedPerson(app: AppDef, schema: DatabaseSchema): QueryPerson | undefined {
  if (!app.auth) return undefined;
  /* A catalog that keeps people's emails from its reader still has people:
     the server finds the reader's own row by their email (server appMe.ts),
     so `owner_id = me` is still a condition this reader can ask. */
  const { table } = personTable(app, schema);
  const people = table ?? (app.auth.me ? tableNamed(schema, app.auth.me.from) : undefined);
  const person = people && primaryKey(people).length === 1 ? { table: people.id, key: 0 } : undefined;
  /* Each membership the App's conditions read, judged on this catalog with no values: what a request reads has
     the same shape (server appMe.ts readMeSets). */
  const names = meSetsIn(...textsOf(app));
  const sets = Object.fromEntries(names.map((name) => [name, meSetShape(schema, person, name).set]));
  return { email: 'someone@example.invalid', ...(person ? { person } : {}), ...(names.length ? { sets } : {}) };
}

/* Every text an App holds, wherever a condition may sit in it: the memberships it reads are found by their words. */
function textsOf(value: unknown, found: string[] = [], depth = 0): string[] {
  if (typeof value === 'string') {
    if (/\bme\./i.test(value)) found.push(value);
  } else if (value && typeof value === 'object' && depth < 32) {
    for (const item of Array.isArray(value) ? value : Object.values(value)) textsOf(item, found, depth + 1);
  }
  return found;
}
