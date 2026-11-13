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
}

const LINK_EXPIRES_DEFAULT = 7 * 86_400_000;
const LINK_EXPIRES_MAX = 90 * 86_400_000;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const COLUMN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const KEYS = ['show', 'says', 'commands', 'expires', 'uses', 'confirm', 'stepUp'] as const;
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
/* 'confirm: ["zip_code"]' asks "Zip code"; the record form says the label. */
const labelOf = (name: string) => {
  const spaced = name.replace(/_/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/** A resource's `links` block, by name. `resource` is the block's logical name, which each command must target. */
export function parseResourceLinks(raw: unknown, at: string, resource: string): Record<string, AppLinkDef> {
  const block = plainRecord(raw, at, '{ name: { show, says?, commands?, expires?, uses?, confirm?, stepUp? } }');
  const links: Record<string, AppLinkDef> = {};
  for (const [name, value] of Object.entries(block)) {
    const where = `${at}, "${name}"`;
    if (!NAME.test(name)) throw new Error(`${where} needs a name: a letter, then letters, digits or underscores.`);
    const spec = plainRecord(value, where, '{ show, says?, commands?, expires?, uses?, confirm?, stepUp? }');
    allowKeys(spec, KEYS, where);
    if (!Array.isArray(spec.show) || !spec.show.length || spec.show.length > 12)
      throw new Error(
        `${where} needs "show": one to twelve columns of the record its holder sees. A link that shows nothing opens nothing.`,
      );
    const show = spec.show.map((item) => column(item, `${where}, "show"`));
    if (new Set(show).size !== show.length) throw new Error(`${where}, "show" names one column twice.`);
    const link: AppLinkDef = { show, expires: LINK_EXPIRES_DEFAULT };
    if (spec.says !== undefined) {
      if (!isRecord(spec.says)) throw new Error(`${where}, "says" is { column: { value: 'Words' } }.`);
      link.says = Object.fromEntries(
        Object.entries(spec.says).map(([shown, map]) => {
          if (!show.includes(shown)) throw new Error(`${where}, "says" has words for "${shown}", which "show" does not name.`);
          if (!isRecord(map) || !Object.keys(map).length) throw new Error(`${where}, "says.${shown}" is { value: 'Words' }.`);
          return [
            shown,
            Object.fromEntries(
              Object.entries(map).map(([stored, text]) => [stored, words(text, `${where}, "says.${shown}.${stored}"`, 60)]),
            ),
          ];
        }),
      );
    }
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
    }
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
