/**
 * `[command-trigger]`: a command of a row-policy or tenant App that writes a
 * table whose triggers the row policy cannot bound.
 *
 * Under a row policy a write that fires a trigger is refused unless the
 * trigger is validation-only (scopeTriggers.ts): it reads another table or
 * writes rows the policy never sees. The refusal is right, and it came only
 * when someone pressed the button — a field report met it in production,
 * on a command that updated a column no trigger named, and dropped its
 * ledger's integrity triggers to get past it. Said here, before it serves:
 * the command, the table, each trigger and why it blocks, and what to do.
 *
 * A problem when the triggers refuse every insert, update and delete of the
 * table: whatever the handler writes there is refused. Otherwise a warning
 * naming the writes refused, since which of them the handler makes is its
 * code's to say. A table on a connection whose triggers cannot be read is
 * left to the write, which reads them again and fails closed.
 *
 * A trigger the App names and the proof accepts is not counted (docs/trigger-effects.md); `[trigger-double-write]`
 * says where a command writes a table such a trigger writes too.
 */
import {
  blocksEveryWrite,
  loadTriggerEffects,
  sayBlocked,
  sayRuns,
  sayTriggers,
  type ScopeTrigger,
} from '@mistriwork/engine/adapters/scoped/scopedTransaction.js';
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { logicalResource, type AppDef } from '../../shared/app.js';
import type { RuntimeResources } from '../app/appRuntimeResources.js';
import type { BusinessCommandRegistry } from './businessCommands.js';

const REMEDY =
  'Move what the trigger does into the command, whose writes the policy bounds, or keep the trigger to checks of NEW and OLD ' +
  "that raise (SQLite RAISE(ABORT, '…'); PostgreSQL IF … THEN RAISE EXCEPTION '…'), reading no other table.";
/* A CHECK, a default or a domain is named only when it calls a function of the database's, which may read or write
   any row: PostgreSQL's own functions in its place do not block. */
const CODE_REMEDY =
  "Write the CHECK, default or domain with PostgreSQL's own functions, or move what the function does into the command, " +
  'whose writes the policy bounds.';
const remedyFor = (blocking: readonly ScopeTrigger[]) =>
  blocking.some((trigger) => trigger.kind !== undefined)
    ? blocking.some((trigger) => trigger.kind === undefined)
      ? `${REMEDY} ${CODE_REMEDY}`
      : CODE_REMEDY
    : REMEDY;

/** Whether the App's commands run under a row scope: a row policy's or a tenant's. */
const commandsRunScoped = (app: Pick<AppDef, 'auth'>): boolean => app.auth?.rows === 'policy' || app.auth?.rows === 'tenant';

/* A trigger the App names on a row-policy resource, whose effects the grammar read and the catalog accepts: it runs,
   its effects proven per write (docs/trigger-effects.md). Whether authority.lock approved it is triggerLock.ts's to say. */
const accepted = (app: Pick<AppDef, 'auth' | 'resources'>, logical: string, trigger: ScopeTrigger): boolean =>
  app.auth?.rows === 'policy' && !!app.resources?.[logical]?.triggers?.includes(trigger.name) && !!trigger.effects && !trigger.unaccepted;

/* A table's name without its schema: an effect names the physical table as its catalog does (`public.account`), a
   command's footprint as its source does (`account`). */
const bare = (table: string) => table.slice(table.lastIndexOf('.') + 1);
const EFFECT_VERB = { update: 'writes', insert: 'inserts into', delete: 'deletes from' } as const;

/** The comment-free text of a function's source, strings kept: a comment that names `db.account.update` is not a write. */
function withoutComments(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const end = endOfString(text, i);
      out += text.slice(i, end + 1);
      i = end;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      out += ' ';
    } else out += c;
  }
  return out;
}

/** The index of the quote that closes the string opened at `from` (a template's `${…}` skipped as code); the end of text when it never does. */
function endOfString(text: string, from: number): number {
  const quote = text[from];
  for (let i = from + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === quote) return i;
    else if (quote === '`' && text[i] === '$' && text[i + 1] === '{') {
      const close = matchClose(text, i + 1);
      if (close < 0) return text.length - 1;
      i = close;
    }
  }
  return text.length - 1;
}

/** The index of the bracket that closes the one at `open`, or -1. */
function matchClose(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') i = endOfString(text, i);
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && --depth === 0) return i;
  }
  return -1;
}

/** `text` cut at its top-level commas. */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') i = endOfString(text, i);
    else if (c === '(' || c === '[' || c === '{') {
      const close = matchClose(text, i);
      if (close < 0) return [...parts, text.slice(from)];
      i = close;
    } else if (c === ',') {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** The literal top-level keys of an object literal, or undefined when it is anything else or has a key that is not a name (a spread, a computed key). */
function literalKeys(source: string | undefined): string[] | undefined {
  const text = source?.trim();
  if (!text?.startsWith('{') || matchClose(text, 0) !== text.length - 1) return undefined;
  const keys: string[] = [];
  for (const entry of splitTop(text.slice(1, -1))) {
    const key = /^(?:([A-Za-z_$][\w$]*)|'([^']*)'|"([^"]*)")\s*(?::|$|\()/.exec(entry);
    if (!key) return undefined;
    keys.push((key[1] ?? key[2] ?? key[3])!);
  }
  return keys;
}

/** What a handler writes through the typed db: the columns it gives each table's inserts and updates, and the tables where its source does not say. */
interface HandlerWrites {
  readonly columns: ReadonlyMap<string, ReadonlySet<string>>;
  readonly unreadable: ReadonlySet<string>;
}
const READ_VERBS = new Set(['get', 'find', 'where', 'count']);

/**
 * What the handler's own source says it writes, or undefined when it cannot say for any table: no function to read, a
 * parameter that is not `{ db, … }` or one plain name, or a `db` that is passed on, indexed or renamed (a helper may write
 * anything). A table whose write is not a call with an object literal — a spread, a variable, a computed key, `insertFile`,
 * a verb this does not know — is `unreadable` for that table alone. A text reading, not a parse: it only ever errs toward
 * saying more.
 */
function handlerWrites(handle: unknown): HandlerWrites | undefined {
  if (typeof handle !== 'function') return undefined;
  const text = withoutComments(String(handle));
  /* An arrow with one bare parameter (`ctx => …`) has no parentheses to find. */
  const arrow = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(text);
  const open = arrow ? -1 : text.indexOf('(');
  const close = open < 0 ? -1 : matchClose(text, open);
  if (!arrow && close < 0) return undefined;
  const parameters = arrow ? arrow[1]! : text.slice(open + 1, close).trim();
  const body = arrow ? text.slice(arrow[0].length) : text.slice(close + 1);
  let base: string;
  if (/^[A-Za-z_$][\w$]*$/.test(parameters)) base = `${parameters}.db`;
  else if (parameters.startsWith('{') && matchClose(parameters, 0) === parameters.length - 1) {
    const entries = splitTop(parameters.slice(1, -1));
    if (entries.some((entry) => entry.startsWith('...') || /^db\s*[:=]/.test(entry))) return undefined;
    base = entries.includes('db') ? 'db' : '';
  } else return undefined;
  const columns = new Map<string, Set<string>>();
  const unreadable = new Set<string>();
  if (!base) return { columns, unreadable };
  const root = base.split('.')[0]!;
  const reach = new RegExp(`(?<![\\w$.])${root.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
  for (const found of body.matchAll(reach)) {
    const after = body.slice(found.index + root.length);
    // `ctx.record` and the like are no use of the db; `ctx.db` is the one, and any other `ctx` is passed on.
    if (base !== root) {
      if (/^\s*\.\s*(?!db\b)[A-Za-z_$]/.test(after)) continue;
      if (!/^\s*\.\s*db\b/.test(after)) return undefined;
    }
    const call = /^\s*(?:\.\s*db\s*)?\.\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(after);
    if (!call) return undefined;
    const [, table, verb] = call as unknown as [string, string, string];
    if (READ_VERBS.has(verb) || verb === 'remove') continue;
    const argsAt = found.index + root.length + call[0].length - 1;
    const end = matchClose(body, argsAt);
    const args = end < 0 ? [] : splitTop(body.slice(argsAt + 1, end));
    const keys = verb === 'insert' ? literalKeys(args[0]) : verb === 'update' ? literalKeys(args[1]) : undefined;
    if (!keys) {
      unreadable.add(table);
      continue;
    }
    columns.set(table, new Set([...(columns.get(table) ?? []), ...keys]));
  }
  return { columns, unreadable };
}

/**
 * `[trigger-double-write]`: a command that writes a table an accepted trigger it fires also writes. A footprint names
 * tables, not columns, so for an insert or a delete the table is the finding: two inserts are two rows whatever their
 * columns. For an update, the handler's own source says which columns it writes (`handlerWrites`), and the finding is
 * the columns both write: a handler that sets `status` on an account whose trigger posts `posted_minor` is fine as it
 * is. Where the source cannot say — a spread, a variable for the changes, a `db` handed to a helper, no handler to read —
 * it is a warning as before, since the field report's handlers kept the balance updates the triggers now make, and each
 * would apply twice.
 */
function doubleWrites(
  app: Pick<AppDef, 'auth' | 'sources' | 'resources'>,
  id: string,
  command: { readonly source: string; readonly write: readonly string[]; readonly handle?: unknown },
  triggersOf: (logical: string) => readonly ScopeTrigger[] | undefined,
): string[] {
  const written = new Map(
    [...new Set(command.write)].map((table) => {
      const logical = logicalResource(app, command.source, table);
      return [bare(app.resources?.[logical]?.physical ?? table), table] as const;
    }),
  );
  const said: string[] = [];
  let handler: HandlerWrites | undefined | null = null;
  for (const table of new Set(command.write)) {
    const logical = logicalResource(app, command.source, table);
    for (const trigger of triggersOf(logical) ?? []) {
      if (!accepted(app, logical, trigger)) continue;
      for (const effect of trigger.effects ?? []) {
        if (effect.kind === 'read') continue;
        const also = written.get(bare(effect.table));
        if (also === undefined) continue;
        let columns = effect.kind === 'update' ? Object.keys(effect.values ?? {}) : [];
        let both = false;
        if (effect.kind === 'update' && columns.length) {
          if (handler === null) handler = handlerWrites(command.handle);
          const own = handler && !handler.unreadable.has(also) ? (handler.columns.get(also) ?? new Set<string>()) : undefined;
          if (own) {
            columns = columns.filter((column) => own.has(column));
            if (!columns.length) continue;
            both = true;
          }
        }
        said.push(
          `command "${id}" writes "${also}", which the trigger "${trigger.name}" on "${table}", a table it writes too, also ${EFFECT_VERB[effect.kind]}` +
            `${columns.length ? ` (${columns.join(', ')})` : ''} [trigger-double-write]: a change both make is applied twice${both ? ` (the handler writes ${columns.join(', ')} too)` : ''}. ` +
            `Leave ${columns.length ? columns.map((column) => `${also}.${column}`).join(', ') : `those rows of "${also}"`} to the trigger and ` +
            "drop the handler's own write of them; a handler that writes only other columns of the table is fine as it is.",
        );
      }
    }
  }
  return said;
}

/** The findings, from each written table's triggers by its logical name (`triggersOf`). */
export function commandTriggerFindings(
  app: Pick<AppDef, 'auth' | 'sources' | 'resources'>,
  commands: BusinessCommandRegistry | undefined,
  triggersOf: (logical: string) => readonly ScopeTrigger[] | undefined,
): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!commands || !commandsRunScoped(app)) return { problems, warnings };
  for (const [id, command] of Object.entries(commands)) {
    warnings.push(...doubleWrites(app, id, command, triggersOf));
    for (const table of new Set(command.write)) {
      const logical = logicalResource(app, command.source, table);
      const blocking = (triggersOf(logical) ?? []).filter((trigger) => !trigger.validates && !accepted(app, logical, trigger));
      if (!blocking.length) continue;
      const said = `command "${id}" writes "${table}", which has ${sayTriggers(blocking)} [command-trigger]: under the row policy`;
      const runs = sayRuns(blocking);
      if (blocksEveryWrite(blocking))
        problems.push(`${said}, every insert, update and delete of "${table}" ${runs} one and is refused with 403. ${remedyFor(blocking)}`);
      else
        warnings.push(
          `${said}, a write that ${runs} ${blocking.length === 1 ? 'it' : 'one'} (${sayBlocked(blocking).join(', ')}) is refused with 403; ` +
            `other writes run. ${remedyFor(blocking)}`,
        );
    }
  }
  return { problems, warnings };
}

/** Each written table's triggers, read once per connection, by the App's logical name for the table. */
export async function commandTriggers(
  app: AppDef,
  resources: RuntimeResources,
  commands: BusinessCommandRegistry | undefined,
  /* The connection's own adapter: the App's source adapter answers only what an App request asks. */
  open: (connection: string) => Promise<Adapter>,
): Promise<(logical: string) => readonly ScopeTrigger[] | undefined> {
  if (!commands || !commandsRunScoped(app)) return () => undefined;
  const written = Object.values(commands).flatMap((command) => command.write.map((table) => logicalResource(app, command.source, table)));
  /* And every resource that names triggers: a chain's next table is judged by its own names (triggerLock.ts). */
  const naming = Object.keys(app.resources ?? {}).filter((resource) => app.resources![resource].triggers?.length);
  return triggersAt(resources, [...written, ...naming], open);
}

/**
 * The triggers of each of `logicals`, read once per connection and judged against its catalog as a scoped write's
 * are (triggerEffects.ts), by logical name. A table on a connection whose triggers cannot be read is left out.
 */
export async function triggersAt(
  resources: RuntimeResources,
  logicals: readonly string[],
  open: (connection: string) => Promise<Adapter>,
): Promise<(logical: string) => readonly ScopeTrigger[] | undefined> {
  const found = new Map<string, readonly ScopeTrigger[]>();
  const connections = new Map<string, Promise<ReadonlyMap<string, readonly ScopeTrigger[]> | undefined>>();
  for (const logical of logicals) {
    if (found.has(logical)) continue;
    let connection: string;
    try {
      connection = resources.connectionFor(logical);
    } catch {
      // A table the App cannot place is the validation's to name.
      continue;
    }
    if (!connections.has(connection))
      connections.set(
        connection,
        Promise.resolve()
          .then(() => open(connection))
          .then(async (adapter) => {
            const triggered = await adapter.triggers?.();
            if (!triggered?.size) return triggered;
            const schema = await adapter.introspect();
            const { resolveTriggerEffects } = await loadTriggerEffects();
            /* What the write's own catalog reads beyond the schema and the triggers — the keys, a table's partitions or
               children, its row security, rules and the writer's privileges, a SQLite table's conflict clauses — so
               check refuses what the write refuses. A source that cannot say accepts no key. */
            const tables = schema.tables.filter((table) => !table.isView);
            const facts = (await adapter.triggerKeys?.(tables.map((table) => table.id))) ?? { keys: () => [], comparison: () => undefined };
            // As the write's catalog: a table it can target has a primary key, and nothing but its triggers in the way.
            const writable = new Set(
              tables
                .filter(
                  (table) => !triggered.has(table.id) && !facts.blocked?.has(table.id) && table.columns.some((column) => column.primaryKey),
                )
                .map((table) => table.id),
            );
            return resolveTriggerEffects({ schema, writable, triggered, foldCase: adapter.dialect === 'sqlite', ...facts });
          })
          .catch(() => undefined),
      );
    const byId = await connections.get(connection)!;
    for (const [id, triggers] of byId ?? []) {
      let named: string | undefined;
      try {
        named = resources.toLogicalAt(id, connection);
      } catch {
        named = undefined;
      }
      if (named === logical) found.set(logical, triggers);
    }
    // Read, and none: the table has no triggers.
    if (byId && !found.has(logical)) found.set(logical, []);
  }
  return (logical) => found.get(logical);
}
