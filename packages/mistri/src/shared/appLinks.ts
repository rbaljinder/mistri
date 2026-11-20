/**
 * Capability links, as a resource declares them (`resources.X.links`): a
 * named way to hand one record to someone who signs in to nothing. Holding
 * the link shows the declared columns of that one record and runs the
 * declared commands on it, and nothing else.
 *
 * ```ts
 * resources: { applications: { links: {
 *   status: { show: ['reference', 'status'], commands: ['withdrawApplication'],
 *             expires: '30 days', confirm: ['zip'], stepUp: 'email' } } } }
 * ```
 *
 * A link is minted by a command that targets the row (`context.link('status')`)
 * and served at `/l/<token>` (server/links/linkRoutes.ts). Its shape is judged
 * here as the App is parsed, each command against the catalog; its columns
 * against the database once the App is whole (appLinkProblems).
 */
import { isRecord, plainRecord, allowKeys } from '@mistriwork/engine/shared/model.js';
import { tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { DURATION_WORDS, parseDuration } from '@mistriwork/engine/shared/duration.js';
import { isTenantApp, type AppDef } from './appModel.js';
import { isRegisteredCommand, registeredCommand } from './command.js';
import { parseLinkStepUp, stepUpAddressProblem, type StepUpTarget } from './appStepUp.js';

/** One declared link: what its holder sees and may run. */
export interface AppLinkDef {
  /** The record's columns the link page shows, in order. */
  show: string[];
  /** Words for a shown column's stored values: `{ status: { review: 'Under review' } }`. */
  says?: Record<string, Record<string, string>>;
  /** Commands the holder may run on the record, each `targets: 'one'` on this resource. */
  commands?: string[];
  /** How long a minted link opens, in milliseconds: 7 days unless said, 90 at most. */
  expires: number;
  /** How many opens it takes before it is spent; absent, it opens until it expires. */
  uses?: number;
  /** Columns the holder must type back before anything is shown, each with the label asked. */
  confirm?: { column: string; label: string }[];
  /**
   * The record's column a one-time code goes to before anything is shown: a
   * bare column is email; `{ sms: 'mobile' }` a channel an integration declares (appStepUp.ts).
   */
  stepUp?: StepUpTarget;
  /**
   * Read-only lists of the rows that point at the record, by the child resource's logical name: one hop, one
   * foreign key, at most `most` rows, no paging. Only beside a `stepUp` or a `confirm`: more data behind one token
   * takes a second factor.
   */
  related?: Record<string, AppLinkRelated>;
}

/** One list a link page shows of the rows that point at its record. */
export interface AppLinkRelated {
  /** The child's foreign key column to the link's resource; absent, its one foreign key there. */
  by?: string;
  /** The child's columns the list shows, in order. */
  show: string[];
  /** The one column the list is ordered by, and which way; absent, the child's key. */
  sort?: { column: string; descending: boolean };
  /** How many rows the list shows at most, 1 to 50. */
  most: number;
  /** Words for a shown column's stored values, as the link's own `says`. */
  says?: Record<string, Record<string, string>>;
}

const LINK_EXPIRES_DEFAULT = 7 * 86_400_000;
const LINK_EXPIRES_MAX = 90 * 86_400_000;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const COLUMN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const KEYS = ['show', 'says', 'commands', 'expires', 'uses', 'confirm', 'stepUp', 'related'] as const;
const RELATED_KEYS = ['by', 'show', 'sort', 'most', 'says'] as const;
const RELATED_MAX = 4;
const RELATED_MOST_MAX = 50;
/** The command fields a link page draws (server/links/linkPage.ts). */
const LINK_INPUT_TYPES = ['text', 'textarea', 'number', 'boolean', 'date', 'choice'] as const;

const column = (value: unknown, at: string): string => {
  if (typeof value !== 'string' || !COLUMN.test(value)) throw new Error(`${at} names a column of the resource's table.`);
  return value;
};
const words = (value: unknown, at: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${at} must be text of at most ${max} characters.`);
  return value.trim();
};
/** One to twelve distinct columns a link page shows. */
const shownColumns = (value: unknown, where: string, what: string): string[] => {
  if (!Array.isArray(value) || !value.length || value.length > 12)
    throw new Error(`${where} needs "show": one to twelve columns of ${what}. A link that shows nothing opens nothing.`);
  const show = value.map((item) => column(item, `${where}, "show"`));
  if (new Set(show).size !== show.length) throw new Error(`${where}, "show" names one column twice.`);
  return show;
};
const saysOf = (value: unknown, where: string, show: readonly string[]): Record<string, Record<string, string>> => {
  if (!isRecord(value)) throw new Error(`${where}, "says" is { column: { value: 'Words' } }.`);
  return Object.fromEntries(
    Object.entries(value).map(([shown, map]) => {
      if (!show.includes(shown)) throw new Error(`${where}, "says" has words for "${shown}", which "show" does not name.`);
      if (!isRecord(map) || !Object.keys(map).length) throw new Error(`${where}, "says.${shown}" is { value: 'Words' }.`);
      return [
        shown,
        Object.fromEntries(Object.entries(map).map(([stored, text]) => [stored, words(text, `${where}, "says.${shown}.${stored}"`, 60)])),
      ];
    }),
  );
};

/** A link's `related` block: its shape here, its tables and keys against the database in appLinkProblems. */
function parseLinkRelated(raw: unknown, where: string): Record<string, AppLinkRelated> {
  const block = plainRecord(raw, `${where}, "related"`, '{ resource: { by?, show, sort?, most, says? } }');
  const entries = Object.entries(block);
  if (!entries.length || entries.length > RELATED_MAX)
    throw new Error(`${where}, "related" names one to ${RELATED_MAX} resources whose rows point at the record.`);
  const related: Record<string, AppLinkRelated> = {};
  for (const [child, value] of entries) {
    const at = `${where}, "related.${child}"`;
    if (!NAME.test(child)) throw new Error(`${at} names a resource of the App.`);
    const spec = plainRecord(value, at, '{ by?, show, sort?, most, says? }');
    allowKeys(spec, RELATED_KEYS, at);
    const show = shownColumns(spec.show, at, 'each row the list shows');
    /* No paging and no request parameter: the cap is the whole of what a holder can be shown, so it is said. */
    if (!Number.isSafeInteger(spec.most) || (spec.most as number) < 1 || (spec.most as number) > RELATED_MOST_MAX)
      throw new Error(`${at} needs "most": how many rows the list shows, a whole number from 1 to ${RELATED_MOST_MAX}.`);
    const list: AppLinkRelated = { show, most: spec.most as number };
    if (spec.by !== undefined) list.by = column(spec.by, `${at}, "by"`);
    if (spec.sort !== undefined) {
      if (typeof spec.sort !== 'string') throw new Error(`${at}, "sort" is one column, '-' first for newest or largest first.`);
      const descending = spec.sort.startsWith('-');
      list.sort = { column: column(descending ? spec.sort.slice(1) : spec.sort, `${at}, "sort"`), descending };
    }
    if (spec.says !== undefined) list.says = saysOf(spec.says, at, show);
    related[child] = list;
  }
  return related;
}

/* 'confirm: ["zip_code"]' asks "Zip code"; the record form says the label. */
const labelOf = (name: string) => {
  const spaced = name.replace(/_/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/** A resource's `links` block, by name. `resource` is the block's logical name, which each command must target. */
export function parseResourceLinks(raw: unknown, at: string, resource: string): Record<string, AppLinkDef> {
  const block = plainRecord(raw, at, '{ name: { show, says?, commands?, expires?, uses?, confirm?, stepUp?, related? } }');
  const links: Record<string, AppLinkDef> = {};
  for (const [name, value] of Object.entries(block)) {
    const where = `${at}, "${name}"`;
    if (!NAME.test(name)) throw new Error(`${where} needs a name: a letter, then letters, digits or underscores.`);
    const spec = plainRecord(value, where, '{ show, says?, commands?, expires?, uses?, confirm?, stepUp?, related? }');
    allowKeys(spec, KEYS, where);
    const show = shownColumns(spec.show, where, 'the record its holder sees');
    const link: AppLinkDef = { show, expires: LINK_EXPIRES_DEFAULT };
    if (spec.says !== undefined) link.says = saysOf(spec.says, where, show);
    if (spec.commands !== undefined) {
      if (!Array.isArray(spec.commands) || spec.commands.length > 8)
        throw new Error(`${where}, "commands" must be a list of at most eight commands the holder may run on the record.`);
      const commands = spec.commands.map((command) => {
        if (typeof command !== 'string')
          throw new Error(`${where}, "commands" names each command by name, as the commands module registers it.`);
        if (!isRegisteredCommand(command))
          throw new Error(`${where}, "commands" names "${command}", which the commands module does not register.`);
        const entry = registeredCommand(command)!;
        /* The holder holds one record: a command that names another, a selection or none would reach past it. */
        if (entry.target !== resource || entry.targets !== 'one')
          throw new Error(
            `${where}, "commands" names "${command}", which ${entry.target !== resource ? `acts on "${entry.target}"` : `targets '${entry.targets}'`}; ` +
              `a link runs only commands that target one record of "${resource}" (targets: 'one').`,
          );
        if (entry.public)
          throw new Error(`${where}, "commands" names "${command}", which a public form runs; a link runs a command of the App's own.`);
        /* The link page asks with plain controls: a field it cannot draw would be a command its holder cannot run. */
        const asks = entry.input.find(
          (field) =>
            !LINK_INPUT_TYPES.includes((field as { type?: string }).type as never) ||
            (field.type === 'choice' && field.source !== undefined),
        );
        if (asks)
          throw new Error(
            `${where}, "commands" names "${command}", which asks "${asks.name}" as ${(asks as { type?: string }).type}; ` +
              `a link page asks only ${LINK_INPUT_TYPES.join(', ')} fields.`,
          );
        return command;
      });
      if (new Set(commands).size !== commands.length) throw new Error(`${where}, "commands" names one command twice.`);
      if (commands.length) link.commands = commands;
    }
    if (spec.expires !== undefined) {
      const ms = parseDuration(spec.expires);
      if (ms === undefined || ms <= 0 || ms > LINK_EXPIRES_MAX)
        throw new Error(`${where}, "expires" is how long a link opens: ${DURATION_WORDS}, at most '90 days'.`);
      link.expires = ms;
    }
    if (spec.uses !== undefined) {
      if (!Number.isSafeInteger(spec.uses) || (spec.uses as number) < 1 || (spec.uses as number) > 1_000)
        throw new Error(`${where}, "uses" is how many opens spend the link: a whole number from 1 to 1000, or left out.`);
      link.uses = spec.uses as number;
    }
    if (spec.confirm !== undefined) {
      const entries: [string, unknown][] = Array.isArray(spec.confirm)
        ? spec.confirm.map((item) => [column(item, `${where}, "confirm"`), undefined])
        : isRecord(spec.confirm)
          ? Object.entries(spec.confirm)
          : [];
      if (!entries.length || entries.length > 3)
        throw new Error(
          `${where} has a "confirm" that is not one to three columns only the holder knows: ['zip'], or { zip: 'ZIP code' }.`,
        );
      link.confirm = entries.map(([name, label]) => ({
        column: column(name, `${where}, "confirm"`),
        label: label === undefined ? labelOf(name) : words(label, `${where}, "confirm.${name}"`, 80),
      }));
      if (new Set(link.confirm.map((item) => item.column)).size !== link.confirm.length)
        throw new Error(`${where}, "confirm" names one column twice.`);
      for (const item of link.confirm)
        if (show.includes(item.column))
          throw new Error(`${where}, "confirm" asks for "${item.column}", which "show" names: a link never shows what it asks.`);
    }
    if (spec.stepUp !== undefined) link.stepUp = parseLinkStepUp(spec.stepUp, `${where}, "stepUp"`);
    if (spec.related !== undefined) {
      /* Lists of a record's children are more behind one token than the record: whoever holds it proves it twice. */
      if (!link.stepUp && !link.confirm)
        throw new Error(
          `${where} has "related" without a "stepUp" or a "confirm": a link that shows a record's related rows asks its holder for a second factor.`,
        );
      link.related = parseLinkRelated(spec.related, where);
    }
    links[name] = link;
  }
  return links;
}

/** A stored link's record key (commandKeyText: `[[column, value], …]`) as column → value, or undefined when it is not one. */
export function linkRowKey(rowKey: string): Record<string, string> | undefined {
  try {
    const pairs = JSON.parse(rowKey) as unknown;
    if (!Array.isArray(pairs) || !pairs.length) return undefined;
    return Object.fromEntries(pairs.map((pair) => [String((pair as unknown[])[0]), String((pair as unknown[])[1])]));
  } catch {
    return undefined;
  }
}

/**
 * The one foreign key column of `child` that points at `parent`'s key, and the key column it names: `by` when said,
 * else the child's only key to the parent. A string is why there is none. One column each side, since the link's
 * key is one value per column and a list is read by `by = <that value>` alone.
 */
export function relatedForeignKey(
  schema: DatabaseSchema,
  child: { id: string; name: string },
  parent: { id: string; name: string; columns: readonly { name: string; primaryKey?: boolean }[] },
  by: string | undefined,
): { by: string; key: string } | string {
  const at = (ref: string, table: { id: string; name: string }) => ref === table.id || ref === table.name;
  const keys = schema.foreignKeys.filter(
    (fk) =>
      at(fk.from.table, child) &&
      at(fk.to.table, parent) &&
      fk.from.columns.length === 1 &&
      (by === undefined || fk.from.columns[0] === by),
  );
  if (keys.length === 0)
    return by === undefined ? `has no foreign key to ${parent.name}` : `has no single-column foreign key "${by}" to ${parent.name}`;
  if (keys.length > 1) return `has ${keys.length} foreign keys to ${parent.name}; "by" names the one the list follows`;
  const key = keys[0].to.columns[0];
  const primary = parent.columns.filter((col) => col.primaryKey).map((col) => col.name);
  if (primary.length !== 1 || primary[0] !== key) return `points at ${parent.name}.${key}, which is not its one key column`;
  return { by: keys[0].from.columns[0], key };
}

/**
 * Each link's columns judged against the database and the resource: every
 * one a column of its table, none `hidden` and none outside the resource's
 * field ceiling, since holding a link adds no read the App does not grant.
 */
export function appLinkProblems(
  app: Pick<AppDef, 'resources' | 'auth'> & Partial<Pick<AppDef, 'views'>>,
  schema: DatabaseSchema,
): string[] {
  const problems: string[] = [];
  /* A link is served at /<app>/l/…: a view keyed "l" would be an address the link door answers first. */
  if (app.views && Object.hasOwn(app.views, 'l') && Object.values(app.resources ?? {}).some((resource) => resource.links))
    problems.push('views "l": a link is served at /l/, so no view can be keyed "l" in an App that declares links.');
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    if (!resource.links) continue;
    /* A link's holder is no member: in an App whose rows are scoped by tenant, a link is held to the tenant it was
       minted in (tenant/tenantLinks.ts), so only a tenant's own rows carry one — a global or platform row has no
       tenant to hold it to. A row policy is not asked about a link at all — the link is the grant for its one row
       (policy/appPolicyContext.ts withLink). */
    if (isTenantApp(app) && resource.owner !== 'tenant') {
      problems.push(
        `resources "${name}", "links": in an App whose rows are scoped by tenant, only a tenant's own rows (owner: 'tenant') carry links.`,
      );
      continue;
    }
    /* The catalog here is the App's, in logical names, as appNotifyRules reads it. */
    const table = schema.tables.find((each) => each.id === name) ?? tableNamed(schema, name);
    for (const [linkName, link] of Object.entries(resource.links)) {
      const at = `resources "${name}", links "${linkName}"`;
      if (!table) {
        problems.push(`${at}: the resource names no table here.`);
        continue;
      }
      const has = (col: string) => table.columns.some((c) => c.name === col);
      const hidden = new Set(resource.hidden ?? []);
      const readable = resource.fields ? new Set(resource.fields.read) : undefined;
      const named: [string, string][] = [
        ...link.show.map((col): [string, string] => ['show', col]),
        ...(link.confirm ?? []).map((item): [string, string] => ['confirm', item.column]),
        ...(link.stepUp ? [['stepUp', link.stepUp.column] as [string, string]] : []),
      ];
      for (const [key, col] of named) {
        if (!has(col)) problems.push(`${at}, "${key}" names "${col}", which is not a column of ${table.name}.`);
        else if (key === 'show' && (hidden.has(col) || (readable && !readable.has(col))))
          problems.push(
            `${at}, "show" names "${col}", which the resource ${hidden.has(col) ? 'hides' : 'does not let anyone read'}; a link adds no read.`,
          );
      }
      if (link.stepUp && has(link.stepUp.column)) {
        const unfit = stepUpAddressProblem(link.stepUp, table, resource.display);
        if (unfit) problems.push(`${at}, "stepUp" ${unfit}`);
      }
      for (const [childName, list] of Object.entries(link.related ?? {}))
        problems.push(...relatedProblems(app, schema, `${at}, "related.${childName}"`, childName, list, table));
    }
  }
  return problems;
}

/** A resource's table as links read it: by its id, else by its name. One rule for the check and the door's query. */
export function linkTable(schema: DatabaseSchema, resource: string): DatabaseSchema['tables'][number] | undefined {
  return schema.tables.find((each) => each.id === resource) ?? tableNamed(schema, resource);
}

/** One `related` list against the App and the database: a resource whose rows point at the record, and columns anyone may read. */
function relatedProblems(
  app: Pick<AppDef, 'resources' | 'auth'>,
  schema: DatabaseSchema,
  at: string,
  childName: string,
  list: AppLinkRelated,
  parent: DatabaseSchema['tables'][number],
): string[] {
  const child = app.resources?.[childName];
  if (!child) return [`${at} names "${childName}", which is not a resource of the App.`];
  /* The list is read through the link's tenant-bound reads, which hold only a tenant's own rows. */
  if (isTenantApp(app) && child.owner !== 'tenant')
    return [`${at}: in an App whose rows are scoped by tenant, a link lists only a tenant's own rows (owner: 'tenant').`];
  const table = linkTable(schema, childName);
  if (!table) return [`${at}: the resource names no table here.`];
  const problems: string[] = [];
  /* The list is not written to the read audit: the link's page draws it outside any command. */
  if (child.audit?.reads)
    problems.push(
      `${at}: "${childName}" audits its reads (audit.reads), and a link's related list is not audited yet; show it through a command, or drop the audit.`,
    );
  const fk = relatedForeignKey(schema, table, parent, list.by);
  if (typeof fk === 'string') problems.push(`${at}: ${table.name} ${fk}.`);
  const hidden = new Set(child.hidden ?? []);
  const readable = child.fields ? new Set(child.fields.read) : undefined;
  /* A file's bytes are served by their own door under the App's grants; a link page draws text. */
  const bytes = new Set([child.file?.content, child.file?.thumbnail].filter((col): col is string => col !== undefined));
  /* The columns that say where the server keeps the bytes, and what they hash to: the server's, never a page's. */
  const kept = new Map<string, string>();
  if (child.file?.object !== undefined) kept.set(child.file.object, 'object');
  if (child.file?.hash !== undefined) kept.set(child.file.hash, 'hash');
  const named: [string, string][] = [
    ...list.show.map((col): [string, string] => ['show', col]),
    ...(list.sort ? [['sort', list.sort.column] as [string, string]] : []),
  ];
  for (const [key, col] of named) {
    if (!table.columns.some((c) => c.name === col))
      problems.push(`${at}, "${key}" names "${col}", which is not a column of ${table.name}.`);
    else if (hidden.has(col) || (readable && !readable.has(col)))
      problems.push(
        `${at}, "${key}" names "${col}", which the resource ${hidden.has(col) ? 'hides' : 'does not let anyone read'}; a link adds no read.`,
      );
    else if (bytes.has(col)) problems.push(`${at}, "${key}" names "${col}", the file's bytes; a link lists text, not files.`);
    else if (kept.has(col))
      problems.push(
        `${at}, "${key}" names "${col}", the file's ${kept.get(col)} column, which only the server reads; a link lists text, not files.`,
      );
  }
  return problems;
}

/**
 * What `check` says about a links resource's rows outliving, or being outlived by, their links: advice, not a
 * refusal. A link names its row by key and re-reads it at each open; the door revokes a link whose row is gone
 * (linkRoutes.ts), but only when someone opens it, so a row deleted outside a command (a cascade, plain SQL) leaves
 * its links live until then, and a key the database hands out again would have them name the new row.
 */
export function appLinkAdvisories(app: Pick<AppDef, 'resources'>, schema: DatabaseSchema): string[] {
  const advice: string[] = [];
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    if (!resource.links || Object.keys(resource.links).length === 0) continue;
    const table = schema.tables.find((each) => each.id === name) ?? tableNamed(schema, name);
    if (!table) continue;
    const parents = [
      ...new Set(
        schema.foreignKeys
          .filter((fk) => fk.onDelete === 'cascade' && (fk.from.table === table.id || fk.from.table === table.name))
          .map((fk) => fk.to.table),
      ),
    ].sort();
    if (parents.length > 0)
      advice.push(
        `resources "${name}", "links" [link-cascade]: its rows are deleted with their ${parents.map((parent) => `"${parent}"`).join(' or ')} (ON DELETE CASCADE), which revokes none of their links until one is opened. Revoke them in the command that deletes the parent (context.revokeLinks), or accept that they stay live until then.`,
      );
    if (table.reusesKeys)
      advice.push(
        `resources "${name}", "links" [link-key-reuse]: ${table.name} is keyed by an INTEGER PRIMARY KEY without AUTOINCREMENT, so SQLite may give a deleted row's key to the next insert, and a link to the deleted row would open the new one. Declare the key INTEGER PRIMARY KEY AUTOINCREMENT.`,
      );
  }
  return advice;
}
