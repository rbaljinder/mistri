/**
 * What an App says that parses, resolves and can never happen: a literal the
 * database will never hold, a button no one may press. Each is a warning —
 * the App still starts, and `mistri check` keeps its verdict — printed at
 * startup and beside the verdict, because each was a mistake that passed
 * silently: a tab on `status = resolvd` that is always empty, a Start button
 * that vanished when its resource's writes moved to a command.
 *
 * Pure over the parsed App, its pages and one catalog; a catalog that cannot
 * say a column's values (`allowed` absent) is never guessed at.
 */
import type { QueryPerson } from '@mistriwork/engine/shared/query.js';
import { columnKind, tableNamed, type ColumnMeta, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { parseViewQuery, tryResolvePath } from '@mistriwork/engine/shared/view.js';
import { checkedPerson } from './appMe.js';
import { grantsByRole, isFormView, restatedOf, type AppDef } from './appModel.js';
import { restatedDefaults } from '@mistriwork/engine/shared/displayDefaults.js';
import type { PageDef } from '@mistriwork/engine/shared/pageModel.js';
import { appCommandGrants, resolveAppAccess } from './appAccess.js';
import { appCommandOccurrences } from './appCommandOccurrences.js';

/** A resource name, a view's table or a page's base, as the App's own resolution finds it. */
function tableOf(schema: DatabaseSchema, name: string | undefined): TableMeta | undefined {
  if (!name) return undefined;
  return schema.tables.find((table) => table.id === name) ?? tableNamed(schema, name);
}

/** The values a column holds, when the catalog says (a CHECK IN list, an enum). */
const vocabulary = (table: TableMeta, column: string): readonly string[] | undefined => {
  const allowed = table.columns.find((candidate) => candidate.name === column)?.allowed;
  return allowed?.length ? allowed : undefined;
};

const outside = (table: TableMeta, column: string, value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  const allowed = vocabulary(table, column);
  if (!allowed || allowed.includes(String(value))) return undefined;
  return `"${String(value)}" is not one of ${table.name}.${column} (${allowed.join(', ')}), so it never matches.`;
};

/* A bound date is a day, or a day and a time: what a date phrase becomes, and
   what a written date looks like. */
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * A literal the column's type cannot hold: a word beside a number, a date or
 * a flag. The parser types what it can (`5`, `true`, `last 30 days`), so what
 * reaches here still a string beside one of those was never going to match —
 * `on_hand = none` on an INTEGER is an always-empty tab. Digits past 2^53
 * stay text on purpose (query.ts), and are a number all the same.
 */
const unholdable = (column: ColumnMeta, where: string, value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const kind = columnKind(column.type);
  const said = `"${value}" is not `;
  const tail = `, and ${where} is ${column.type}, so it never matches.`;
  if (kind === 'number' && !/^-?\d+$/.test(value)) return `${said}a number${tail}`;
  if (kind === 'date' && !DATE_TEXT.test(value)) return `${said}a date or a date phrase like today or last 30 days${tail}`;
  if (kind === 'boolean') return `${said}true or false${tail}`;
  return undefined;
};

/**
 * Each literal a condition compares a column with that the column never
 * holds: outside its vocabulary, or not of its type. Read by the view parser,
 * as lists run, so a condition through a reference path is judged against the
 * column it lands on; `me` is read as the App's session will read it.
 */
function literalsIn(schema: DatabaseSchema, table: TableMeta, text: string | undefined, person?: QueryPerson): string[] {
  if (!text?.trim()) return [];
  const parsed = parseViewQuery(schema, table.id, text, undefined, person ? { me: person } : {});
  if (parsed.errors.length) return [];
  const found: string[] = [];
  const say = (problem: string | undefined) => {
    if (problem && !found.includes(problem)) found.push(problem);
  };
  for (const group of parsed.filter.groups) {
    for (const condition of group) {
      if (condition.other !== undefined || condition.op === 'isNull' || condition.op === 'isNotNull') continue;
      const { resolved } = tryResolvePath(schema, table.id, condition.path);
      if (!resolved) continue;
      const where = `${resolved.table.name}.${resolved.column.name}`;
      /* Text operators search text, whatever the column is. */
      const comparison = !['contains', 'startsWith', 'endsWith', 'like'].includes(condition.op);
      for (const value of Array.isArray(condition.value) ? condition.value : [condition.value]) {
        if (condition.op === '=' || condition.op === '!=' || condition.op === 'in')
          say(outside(resolved.table, resolved.column.name, value));
        if (comparison) say(unholdable(resolved.column, where, value));
      }
    }
  }
  return found;
}

/**
 * Literals outside a column's known values, wherever the App writes one: a
 * view's or tab's query, a dashboard section's, an action's `when` and `set`,
 * a form default, a display tone, a board lane, and a page section's `when`,
 * `filter` or workflow step.
 */
export function appLiteralWarnings(app: AppDef, pages: readonly PageDef[], schema: DatabaseSchema): string[] {
  const warnings: string[] = [];
  const person = checkedPerson(app, schema);
  const conditionLiterals = (schema: DatabaseSchema, table: TableMeta, text: string | undefined) => literalsIn(schema, table, text, person);
  const say = (where: string, problems: readonly string[]) => {
    for (const problem of problems) warnings.push(`${where}: ${problem}`);
  };
  for (const [key, view] of Object.entries(app.views)) {
    if (isFormView(view) || 'landing' in view) continue;
    if ('sections' in view) {
      for (const section of [...view.sections, ...(view.aside ?? [])]) {
        const { table: name, query, title, kind } = section as { table?: string; query?: string; title?: string; kind: string };
        const table = tableOf(schema, name);
        if (table) say(`view "${key}", section "${title ?? kind}"`, conditionLiterals(schema, table, query));
      }
      continue;
    }
    const list = view as {
      table: string;
      query?: string;
      tabs?: ReadonlyArray<{ label: string; query?: string }>;
      presentation?: { kind: string; by?: string; lanes?: readonly string[] };
    };
    const table = tableOf(schema, list.table);
    if (!table) continue;
    say(`view "${key}"`, conditionLiterals(schema, table, list.query));
    for (const tab of list.tabs ?? []) say(`view "${key}", tab "${tab.label}"`, conditionLiterals(schema, table, tab.query));
    const board = list.presentation;
    if (board?.kind === 'board' && board.by) {
      say(
        `view "${key}", board`,
        (board.lanes ?? []).flatMap((lane) => outside(table, board.by!, lane) ?? []),
      );
    }
  }
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    const table = tableOf(schema, name);
    if (!table) continue;
    for (const action of resource.actions ?? []) {
      const where = `resources "${name}", action "${action.id}"`;
      say(where, conditionLiterals(schema, table, action.when));
      if (!action.command)
        say(
          where,
          Object.entries(action.set).flatMap(([column, value]) => outside(table, column, value) ?? []),
        );
    }
    say(
      `resources "${name}", form defaults`,
      Object.entries(resource.form?.defaults ?? {}).flatMap(([column, value]) => outside(table, column, value) ?? []),
    );
    for (const [column, rule] of Object.entries(resource.display ?? {})) {
      /* A tone key is a value, a threshold (">= 5") or "*"; only a value can miss. */
      const values = Object.keys(rule.tone ?? {}).filter((value) => value !== '*' && !/^\s*[<>=!]/.test(value));
      say(
        `resources "${name}", display "${column}"`,
        values.flatMap((value) => outside(table, column, value) ?? []),
      );
    }
  }
  for (const page of pages) {
    const base = tableOf(schema, page.base);
    if (!base) continue;
    for (const [i, section] of page.sections.entries()) {
      const { title, when, filter, from, workflow } = section as {
        title?: string;
        when?: string;
        filter?: string;
        from?: string;
        workflow?: { field: string; steps: ReadonlyArray<{ value: string }> };
      };
      const where = `page "${page.name}", ${title ? `section "${title}"` : `section ${i + 1}`}`;
      say(where, conditionLiterals(schema, base, when));
      const listed = tableOf(schema, from);
      if (listed) say(where, conditionLiterals(schema, listed, filter));
      if (workflow)
        say(
          `${where}, workflow`,
          workflow.steps.flatMap((step) => outside(base, workflow.field, step.value) ?? []),
        );
    }
  }
  return warnings;
}

/**
 * Buttons no one can press. A fixed action writes through the ordinary
 * update route, so it is offered only to a role that writes its resource or
 * is granted the action by name (`roles.<role>.actions`); a command action
 * and a signed-in command form only to a role granted the command. Either
 * hidden from everyone is dead UI that `mistri check` used to call ok.
 */
export function appReachWarnings(app: AppDef, schema: DatabaseSchema): string[] {
  const warnings: string[] = [];
  const roles = Object.keys(app.auth?.roles ?? {});
  let writable: ReadonlySet<string>;
  try {
    const access = resolveAppAccess(app, schema, roles);
    writable = access.writable;
  } catch {
    return warnings; // An invalid grant is refused on its own, with its own reason.
  }
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    const table = tableOf(schema, name);
    if (!table || writable.has(table.id)) continue;
    const named = new Set(Object.values(app.auth?.roles ?? {}).flatMap((grant) => grant.actions?.[name] ?? []));
    for (const action of resource.actions ?? []) {
      if (action.command || named.has(action.id)) continue;
      warnings.push(
        `resources "${name}", action "${action.id}" is never offered: ` +
          (grantsByRole(app)
            ? `no role writes "${name}" or is granted the action. Grant it by id (roles.<role>.actions), grant write, or run the change as a command.`
            : `the App does not write "${name}". Give the resource access 'write', or drop the action.`),
      );
    }
  }
  if (!grantsByRole(app)) return warnings;
  const granted = appCommandGrants(app, roles);
  for (const occurrence of appCommandOccurrences(app)) {
    if (granted.has(occurrence.reference.id)) continue;
    if (occurrence.surface === 'action') {
      warnings.push(
        `resources "${occurrence.resource}", action "${occurrence.action.id}" runs command "${occurrence.reference.id}", ` +
          'which no role is granted, so it is never offered. Add it to a role\'s "commands".',
      );
    } else if (occurrence.form.public !== true) {
      warnings.push(
        `view "${occurrence.view}": its form runs command "${occurrence.reference.id}", which no role is granted, ` +
          'so no one can open it. Add it to a role\'s "commands", or make the form public.',
      );
    }
  }
  return warnings;
}

/** The account menu's own items, by what they say (client AccountControl). */
const ACCOUNT_MENU_ITEMS = ['Your profile', 'Manage accounts', 'Manage tenants', 'Manage invitations', 'Accept invitation', 'Sign out'];

/**
 * A settings record named like an item the account menu already holds: the
 * menu showed "Your profile" twice — the borrower's record and the sign-in's
 * own name and password — and which was which was a guess. The menu tells
 * them apart now ("Your account"); this says so where the name is chosen.
 */
export function appMenuWarnings(app: AppDef): string[] {
  if (!app.auth) return [];
  return Object.entries(app.resources ?? {}).flatMap(([name, resource]) => {
    const said = resource.settings?.trim().toLowerCase();
    const clash = said ? ACCOUNT_MENU_ITEMS.find((item) => item.toLowerCase() === said) : undefined;
    if (!clash) return [];
    return [
      `resources "${name}": settings "${resource.settings}" is also an item the account menu holds for every signed-in reader` +
        (clash === 'Your profile' ? ' (their sign-in\'s name, email and password, which it then calls "Your account")' : '') +
        " → name the record by what it holds: settings: 'Contact details', 'Borrower profile'.",
    ];
  });
}

/**
 * Anyone may make an account with a password, and nothing sends the link
 * that proves an address: every account's email stays what was typed, so it
 * names nobody — no `me`, no inbox, no person row — and the App's people
 * features never reach a newcomer, while anyone may hold an account under
 * anyone's address. A problem `mistri check` fails on, not advice: the
 * deployment is one nobody chose. `mail`: the config names an email service.
 */
export function appSignUpProblems(app: AppDef, mail: boolean): string[] {
  if (mail || app.auth?.signUp !== 'open' || !app.auth.providers.includes('email')) return [];
  return [
    'auth: signUp is open and no email connection sends the link that proves an address [open-sign-up-unproven], so anyone ' +
      "may make an account under anyone's email, and it names nobody — no `me`, no inbox — until it is proven. Name an " +
      'email connection in the config ({ "kind": "email", "url": "smtps://…" }, or "log:" in development), or make ' +
      'signUp "invite".',
  ];
}

/**
 * A value the App writes that the platform derives, so deleting it changes
 * nothing: a caption the screens would say anyway, a `number` format beside a
 * `unit` (which already means a number), the App's own currency, a record
 * label that is the table's label column. Each names the deletion. Words,
 * never a refusal: an author (an agent above all) restates what it is unsure
 * the platform knows, and the fix is a deletion.
 */
export function appRestatedWarnings(app: AppDef, schema: DatabaseSchema): string[] {
  /* Each a deletion `check --design --fix` makes (displayDefaults.ts), so the warning and the fix never disagree. */
  return [...restatedOf(app), ...restatedDefaults(app, schema).map((restated) => restated.warning)];
}
