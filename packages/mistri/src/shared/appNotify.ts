/**
 * `notify` on a resource: which writes tell which people, in the App's words.
 *
 *   post: { notify: [{ on: 'insert', to: 'thread_id.author_id', title: 'New reply in {thread_id.title}', opens: 'thread_id' }] }
 *   purchase_order: { notify: [{ on: { changes: 'status' }, when: 'status = received or status = cancelled', to: 'buyer_email',
 *     title: 'Purchase order {id} is {status}' }] }
 *
 * `on` is what happens: a new record (`'insert'`), any change to it
 * (`'update'`), a change to one of some columns (`{ changes }` — an
 * assignment is a change to the column that names who), or an action or
 * command by its action's id (`{ action: 'approve' }`), or a flow's notify
 * step that names this rule's audience (`{ flow: 'requester' }`: nothing is
 * written, and `{message}` in the title is the step's own words, appFlows.ts).
 * `when` narrows it to the records that,
 * after the write, hold in the query language: `=`, `!=` and `in` on its own columns, joined by `and` / `or`. `to` is who is told: a text column holding
 * an email, a reference to the table people are rows of (`auth.me`), or a
 * path through references to either. In a tenant App the people table
 * holds each person's account id (as `me` reads it), and a person found
 * there is told at that account's email while a member of the record's
 * tenant (adapters/inbox/inbox.ts). `title` is the notice, with `{column}`
 * and `{reference.column}` filled from the record, and `open` is the record
 * it opens when not the record itself.
 *
 * `send` tells it on an integration's channel as well (`send: { channel: 'sms',
 * to: 'customer.phone', consent: 'customer.sms_ok', timezone:
 * 'customer.timezone' }`): the title is the message, sent to the address the
 * record holds, under the channel contract — the App's consent column, the
 * recipient's opt-out, the quiet hours (server/integrations/integrationChannels.ts).
 * A rule that sends on a channel may leave `to` out: then it tells nobody's inbox.
 *
 * Two readers: the parse (shape only, as the App loads) and the catalog
 * (appNotifyRules), which judges every name and compiles each rule to what
 * the writer runs (adapters/inbox/inbox.ts), in logical names.
 */
import { isTenantApp, type AppDef } from './appModel.js';
import { isRecord, plainRecord, allowKeys } from '@mistriwork/engine/shared/model.js';
import { personTable } from './appMe.js';
import { isMessageRef, type AppMessageRef } from '@mistriwork/engine/shared/appMessages.js';
import { parseQuery } from '@mistriwork/engine/shared/query.js';
import { columnKind, isBinaryType, primaryKey, tableNamed, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';

/** A rule as authored. */
export interface AppNotifyRule {
  on: 'insert' | 'update' | { changes: string[] } | { action: string } | { flow: string };
  when?: string;
  to: string[];
  /** The words, or a message of the App's catalogs (`msg('ticket.assigned')`), said per recipient in their locale. */
  title: string | AppMessageRef;
  opens?: string;
  email?: true;
  /** The notice told on an integration's channel too: paths to the address, the consent the App holds, the zone. */
  send?: { channel: string; to: string; consent?: string; timezone?: string };
  /** The text column whose mentions are told, and the people table's column a handle is: a plain text column's
      `@handle` words, a rich text column's stored mentions (whose display rule says `by`, so it may be left out). */
  mentions?: { in: string; by?: string };
}

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,2}$/;
/** An audience a flow's notify step names: a word its rows can say. */
const AUDIENCE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const PLACEHOLDER = /\{([^{}]*)\}/g;
/** Rules on one resource; more is a feed, not a notice. */
const MAX_RULES = 16;

const listOf = (value: unknown, at: string, what: string): string[] => {
  const items = typeof value === 'string' ? [value] : Array.isArray(value) ? value : undefined;
  if (!items?.length || items.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`${at} must be ${what}.`);
  return (items as string[]).map((item) => item.trim());
};

/** One resource's `notify`, shape only: the catalog judges every name it says. */
export function parseNotify(raw: unknown, at: string): AppNotifyRule[] {
  if (!Array.isArray(raw)) throw new Error(`${at} must be a list of rules: [{ on, to, title }].`);
  if (raw.length > MAX_RULES) throw new Error(`${at} has ${raw.length} rules; a resource notifies through at most ${MAX_RULES}.`);
  return raw.map((item, i) => {
    const here = `${at} ${i + 1}`;
    const rule = plainRecord(item, here, 'an object { on, to, title, when?, opens? }');
    allowKeys(rule, ['on', 'to', 'title', 'when', 'opens', 'email', 'mentions', 'send'], here, {
      open: 'is now "opens", the reference whose record the notice opens',
    });
    let on: AppNotifyRule['on'];
    if (rule.on === 'insert' || rule.on === 'update') on = rule.on;
    else if (isRecord(rule.on) && Object.keys(rule.on).length === 1 && rule.on.changes !== undefined) {
      on = { changes: listOf(rule.on.changes, `${here}, "on.changes"`, 'a column or a list of columns') };
    } else if (isRecord(rule.on) && Object.keys(rule.on).length === 1 && typeof rule.on.action === 'string' && rule.on.action.trim()) {
      on = { action: rule.on.action.trim() };
    } else if (
      isRecord(rule.on) &&
      Object.keys(rule.on).length === 1 &&
      typeof rule.on.flow === 'string' &&
      AUDIENCE.test(rule.on.flow.trim())
    ) {
      on = { flow: rule.on.flow.trim() };
    } else {
      throw new Error(
        `${here}: "on" is 'insert', 'update', { changes: 'column' }, { action: 'approve' } or { flow: 'requester' } — what happens to the record that tells someone.`,
      );
    }
    let mentions: AppNotifyRule['mentions'];
    if (rule.mentions !== undefined) {
      const said = plainRecord(
        rule.mentions,
        `${here}, "mentions"`,
        "{ in: 'body', by: 'handle' }: the text column, and the people table's handle column",
      );
      allowKeys(said, ['in', 'by'], `${here}, "mentions"`);
      const name = (value: unknown) =>
        typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.trim()) ? value.trim() : undefined;
      const text = name(said.in),
        by = said.by === undefined ? undefined : name(said.by);
      if (!text || (said.by !== undefined && !by))
        throw new Error(
          `${here}, "mentions" is { in: 'body', by: 'handle' }: the text column whose mentions are told, and the column of auth.me's table a handle is ` +
            "(a rich text column's display rule says it, so there it may be left out).",
        );
      mentions = { in: text, ...(by ? { by } : {}) };
    }
    if (rule.email !== undefined && rule.email !== true)
      throw new Error(`${here}, "email" is true or left out: true sends each notice by email as well.`);
    let send: AppNotifyRule['send'];
    if (rule.send !== undefined) {
      const said = plainRecord(rule.send, `${here}, "send"`, "{ channel: 'sms', to: 'phone' }");
      allowKeys(said, ['channel', 'to', 'consent', 'timezone'], `${here}, "send"`);
      for (const key of ['channel', 'to', 'consent', 'timezone']) {
        const value = said[key],
          channel = key === 'channel';
        if (value === undefined && !channel && key !== 'to') continue;
        if (typeof value !== 'string' || !(channel ? /^[a-z][a-z0-9_]*$/ : PATH).test(value))
          throw new Error(
            `${here}, "send.${key}" is ${channel ? "an integration's channel, like 'sms'" : 'a column, or a path of at most two references'}.`,
          );
      }
      send = said as AppNotifyRule['send'];
    }
    const to =
      rule.to === undefined && (mentions || send)
        ? []
        : listOf(rule.to, `${here}, "to"`, 'who is told: a column holding an email, a reference to a person, or a path to one');
    if (to.some((path) => !PATH.test(path)))
      throw new Error(`${here}, "to": "${to.find((path) => !PATH.test(path))}" is not a column or a path of at most two references.`);
    let title: string | AppMessageRef;
    if (isMessageRef(rule.title)) {
      /* Said per recipient after the write (appMessages.ts); the loader bound every argument but {message} to a path. */
      for (const [name, path] of Object.entries(rule.title.args ?? {}))
        if (!PATH.test(path))
          throw new Error(
            `${here}, "title": msg('${rule.title.message}') reads {${name}} from "${path}", which is not a column or a path of at most two references.`,
          );
      title = Object.freeze({ message: rule.title.message, ...(rule.title.args ? { args: Object.freeze({ ...rule.title.args }) } : {}) });
    } else {
      if (typeof rule.title !== 'string' || !rule.title.trim())
        throw new Error(`${here} needs a "title": the notice, as its reader sees it.`);
      title = rule.title.trim();
      if (title.length > 200) throw new Error(`${here}: "title" is ${title.length} characters; a notice is a line, at most 200.`);
      for (const [, path] of title.matchAll(PLACEHOLDER)) {
        if (!PATH.test(path.trim())) throw new Error(`${here}, "title": {${path}} is not a column or a path of at most two references.`);
      }
    }
    if (typeof on === 'object' && 'flow' in on && mentions)
      throw new Error(`${here}: a flow's notice tells its audience; "mentions" tells whom a write's words name. Leave it out.`);
    const parsed: AppNotifyRule = {
      on,
      to,
      title,
      ...(rule.email === true ? { email: true as const } : {}),
      ...(mentions ? { mentions } : {}),
      ...(send ? { send } : {}),
    };
    if (rule.when !== undefined) {
      if (typeof rule.when !== 'string' || !rule.when.trim()) {
        throw new Error(
          `${here}, "when" is a condition in the query language, like 'status = received'; it holds of the record after the write.`,
        );
      }
      parsed.when = rule.when.trim();
    }
    if (rule.opens !== undefined) {
      if (typeof rule.opens !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(rule.opens.trim())) {
        throw new Error(`${here}, "opens" names the reference whose record the notice opens, like 'thread_id'.`);
      }
      parsed.opens = rule.opens.trim();
    }
    return parsed;
  });
}

/** Whether an App keeps an inbox: a signed-in App with a `notify` rule. A tenant App keeps one per tenant (tenant/tenantInbox.ts). */
export function appKeepsInbox(app: AppDef): boolean {
  return Boolean(app.auth) && Object.values(app.resources ?? {}).some((resource) => resource.notify?.length);
}

/* ---------- against the catalog ---------- */

/** A rule's `when`, as the writer reads it: groups alternate (or); a group's conditions all hold (and). */
type NotifyWhen = Array<Array<{ column: string; values: string[]; not?: true }>>;

/** A `when` in the query language over one table, or why it cannot be one: a notice judges the record in hand, so
    only `=`, `!=` and `in` of its own columns, joined by and / or. */
export function compileNotifyWhen(table: TableMeta, schema: DatabaseSchema, text: string): NotifyWhen | string {
  const { query, errors } = parseQuery(`${table.name} ${text}`, { schema, now: new Date() });
  if (!query || errors.length) return errors.map((error) => error.message).join(' ') || 'could not be read.';
  if (query.columns.length || query.orderBy.length || query.limit !== undefined)
    return 'holds conditions only; leave out show, sort and limit.';
  const groups: NotifyWhen = [];
  for (const group of query.filter.groups) {
    const compiled: NotifyWhen[number] = [];
    for (const condition of group) {
      const values =
        condition.op === 'in' && Array.isArray(condition.value)
          ? condition.value
          : condition.value === undefined || Array.isArray(condition.value)
            ? undefined
            : [condition.value];
      if ((condition.op !== '=' && condition.op !== '!=' && condition.op !== 'in') || condition.other !== undefined || !values) {
        return "can say `column = value`, `!=` and `in (…)` of the record's own columns, joined by and / or.";
      }
      compiled.push({
        column: condition.column,
        values: values.map((value) => String(value)),
        ...(condition.op === '!=' ? { not: true as const } : {}),
      });
    }
    groups.push(compiled);
  }
  return groups;
}

/** Whether a record holding these values (as text) meets a compiled `when`. */
export function notifyWhenHolds(when: NotifyWhen, record: Readonly<Record<string, string>>): boolean {
  return when.some((group) => group.every((condition) => condition.values.includes(record[condition.column]) !== (condition.not === true)));
}

/** A value read off the record, in logical names: the column, then one read per reference crossed. */
export interface NotifyPath {
  column: string;
  hops: Array<{ table: string; key: string; column: string }>;
  /** It ends at a tenant App's people table, whose column holds an account id, not an email. */
  account?: true;
}

/** One rule compiled, in logical names; the server maps tables to physical ones as it binds. */
interface CompiledNotifyRule {
  on: { kind: 'insert' } | { kind: 'update'; columns?: string[] } | { kind: 'action'; label: string } | { kind: 'flow'; audience: string };
  when?: NotifyWhen;
  to: NotifyPath[];
  /** `{ message: true }`: a flow rule's `{message}`, the notify step's own words. Empty where `say` is the title. */
  title: Array<string | NotifyPath | { message: true }>;
  /** A title said from the App's messages, per recipient: the key and each argument's path off the record. */
  say?: { message: string; args: Array<{ name: string; path: NotifyPath }> };
  open: { resource: string; key?: { column: string; target: string } };
  uses: string[];
  email?: true;
  /** A text column of the record, and the people table (logical id) with the column a handle is and the one its email is. */
  mentions?: NotifyMentions;
  send?: NotifySend;
}

/** A rule's channel, in logical names: the paths to the address, the App's consent and the recipient's zone. */
export interface NotifySend {
  channel: string;
  to: NotifyPath;
  consent?: NotifyPath;
  timezone?: NotifyPath;
}

/**
 * Who a rule's mentions tell, in logical names. `rich`: the column holds rich
 * text, so a mention is a stored `data-id`, never an `@word`. `groups`: a team
 * mentioned is told as its members — the team's row found by its handle, then
 * the rows that put a person in it (`members`): a link table's, each naming a
 * person by `person` (their row's `key`), or the people table's own, whose
 * `person` is then the email itself.
 */
export interface NotifyMentions {
  column: string;
  rich?: true;
  table: string;
  by: string;
  email: string;
  /** `email` is a tenant App's account column: each person reached is an account id, told at its email. */
  account?: true;
  groups?: {
    table: string;
    by: string;
    /** The team row's column its members name. */
    value: string;
    members: { table: string; match: string; person: string; key?: string };
  };
}

/** Every path a rule reads off its record: whom it tells, its words and its channel's address, consent and zone. */
export function notifyRulePaths(rule: Pick<CompiledNotifyRule, 'to' | 'title' | 'send' | 'say'>): NotifyPath[] {
  const send = rule.send ? [rule.send.to, rule.send.consent, rule.send.timezone].filter((path): path is NotifyPath => !!path) : [];
  return [
    ...rule.to,
    ...rule.title.filter((part): part is NotifyPath => typeof part !== 'string' && !('message' in part)),
    ...(rule.say?.args.map((arg) => arg.path) ?? []),
    ...send,
  ];
}

/** Every rule the App declares, by logical resource, and what does not resolve. */
export function appNotifyRules(app: AppDef, schema: DatabaseSchema): { rules: Map<string, CompiledNotifyRule[]>; problems: string[] } {
  const rules = new Map<string, CompiledNotifyRule[]>();
  const problems: string[] = [];
  const declared = Object.entries(app.resources ?? {}).filter(([, resource]) => resource.notify?.length);
  if (!declared.length) return { rules, problems };
  if (!app.auth) {
    problems.push(
      `resources "${declared[0][0]}", notify: a notice is read by the person it is for, and this App has no sign-in. Add "auth".`,
    );
    return { rules, problems };
  }
  /* An action is named by its id, the resource's own first; what runs is said by its label (inbox.ts), so the rule keeps that. */
  const labelOf = (resource: string, id: string) =>
    (app.resources?.[resource]?.actions ?? []).find((action) => action.id === id)?.label ??
    Object.values(app.resources ?? {})
      .flatMap((each) => each.actions ?? [])
      .find((action) => action.id === id)?.label;
  const person = personTable(app, schema);
  /* A tenant App's people are rows per membership, found by account id: a notice tells that account. */
  const account = isTenantApp(app) ? { account: true as const } : {};
  const tableOf = (name: string): TableMeta | undefined => schema.tables.find((table) => table.id === name) ?? tableNamed(schema, name);
  /* A team mentioned is told as its members: the team's row by its handle, and the rows that put a person in it. */
  const mentionGroups = (
    groups: { from: string; by: string; through?: string },
    people: TableMeta,
    at: string,
  ): NonNullable<NotifyMentions['groups']> | string => {
    const team = tableOf(groups.from);
    if (!team) return `${at} names "${groups.from}", which is no table here.`;
    const handle = team.columns.find((c) => c.name === groups.by);
    if (!handle) return `${at} names "${groups.by}", which is not a column of ${team.name}.`;
    const pointing = (from: TableMeta, to: TableMeta) =>
      from.columns.filter((c) => c.references && tableOf(c.references.table)?.id === to.id);
    if (groups.through === undefined) {
      const [member, ...more] = pointing(people, team);
      if (!member || more.length)
        return (
          `${at}: ${people.name} has ${member ? 'more than one reference' : 'no reference'} to ${team.name}, so who is in a team cannot be read. ` +
          'Name the link rows with "through".'
        );
      return {
        table: team.id,
        by: handle.name,
        value: member.references!.column,
        members: { table: people.id, match: member.name, person: person.column! },
      };
    }
    const link = tableOf(groups.through);
    if (!link) return `${at}: "through" names "${groups.through}", which is no table here.`;
    const [toTeam, ...moreTeams] = pointing(link, team),
      [toPerson, ...morePeople] = pointing(link, people);
    if (!toTeam || !toPerson || moreTeams.length || morePeople.length)
      return `${at}: "through" names ${link.name}, which needs one reference to ${team.name} and one to ${people.name}.`;
    return {
      table: team.id,
      by: handle.name,
      value: toTeam.references!.column,
      members: { table: link.id, match: toTeam.name, person: toPerson.name, key: toPerson.references!.column },
    };
  };

  for (const [name, resource] of declared) {
    const table = tableOf(name);
    if (!table) continue;
    /* An unwritten resource never changes, so its rules could never fire. */
    if (resource.access !== 'write') {
      problems.push(
        `resources "${name}", notify: nothing writes ${table.name} (its access is not 'write'), so no rule on it could ever tell anyone.`,
      );
      continue;
    }
    const compiled: CompiledNotifyRule[] = [];
    for (const [i, rule] of resource.notify!.entries()) {
      const at = `resources "${name}", notify ${i + 1}`;
      const said: string[] = [];
      const uses = new Set<string>();
      const column = (on: TableMeta, named: string) => on.columns.find((candidate) => candidate.name === named);
      /* A path: its first name a column here, each next one a column of the
         record the one before it references. */
      const walk = (path: string, what: string): { path: NotifyPath; end: { table: TableMeta; name: string } } | undefined => {
        const [first, ...rest] = path.split('.');
        let col = column(table, first);
        if (!col) {
          said.push(`${at}: ${what} "${path}" names "${first}", which is not a column of ${table.name}.`);
          return undefined;
        }
        const hops: NotifyPath['hops'] = [];
        let last = { table, name: first };
        for (const next of rest) {
          const ref = col.references;
          /* A notice is written in the transaction of the change, which reads
             its own database alone; a reference to another source is not in it. */
          const from = last.table.id,
            through = col.name;
          if (schema.foreignKeys?.some((fk) => fk.stitched && fk.from.table === from && fk.from.columns[0] === through)) {
            said.push(
              `${at}: ${what} "${path}" goes through "${col.name}", a reference to ${ref?.table} in another source. ` +
                'A notice is written with the change, in its own database, so it reads only what that database holds.',
            );
            return undefined;
          }
          const target = ref ? tableOf(ref.table) : undefined;
          if (!ref || !target) {
            said.push(`${at}: ${what} "${path}" goes through "${col.name}", which references no table here.`);
            return undefined;
          }
          const nextColumn = column(target, next);
          if (!nextColumn) {
            said.push(`${at}: ${what} "${path}" names "${next}", which is not a column of ${target.name}.`);
            return undefined;
          }
          hops.push({ table: target.id, key: ref.column, column: next });
          col = nextColumn;
          last = { table: target, name: next };
        }
        return { path: { column: first, hops }, end: last };
      };

      const to: NotifyPath[] = [];
      for (const path of rule.to) {
        const found = walk(path, '"to"');
        if (!found) continue;
        const end = column(found.end.table, found.end.name)!;
        if (person.table && end.references && tableOf(end.references.table)?.id === person.table.id) {
          // A person, by their row: their email (a tenant App's: their account) is the column auth.me names.
          found.path.hops.push({ table: person.table.id, key: end.references.column, column: person.column! });
          to.push({ ...found.path, ...account });
        } else if (columnKind(end.type) === 'text' && !end.references) to.push(found.path);
        else {
          said.push(
            `${at}: "to" "${path}" ends at ${found.end.table.name}.${found.end.name}, which holds no email. ` +
              (end.references
                ? `It references ${end.references.table}; say which of its columns holds the email, or declare auth.me: { from: '${end.references.table}', column: '<email column>' }.`
                : 'Name a text column holding an email, or a reference to the table auth.me names.'),
          );
        }
      }

      const title: CompiledNotifyRule['title'] = [];
      let say: CompiledNotifyRule['say'];
      const authored = typeof rule.title === 'string' ? rule.title : '';
      if (typeof rule.title !== 'string') {
        say = { message: rule.title.message, args: [] };
        for (const [name, bound] of Object.entries(rule.title.args ?? {})) {
          const found = walk(bound, `msg('${rule.title.message}')'s {${name}}`);
          if (!found) continue;
          const end = column(found.end.table, found.end.name)!;
          if (isBinaryType(end.type)) {
            said.push(
              `${at}: msg('${rule.title.message}')'s {${name}} is ${found.end.table.name}.${found.end.name}, which holds bytes, not words.`,
            );
            continue;
          }
          say.args.push({ name, path: found.path });
          uses.add(`${table.id}.${found.path.column}`);
          for (const hop of found.path.hops) uses.add(`${hop.table}.${hop.column}`);
        }
      }
      let cursor = 0;
      for (const match of authored.matchAll(PLACEHOLDER)) {
        if (match.index! > cursor) title.push(authored.slice(cursor, match.index));
        cursor = match.index! + match[0].length;
        if (typeof rule.on === 'object' && 'flow' in rule.on && match[1].trim() === 'message') {
          title.push({ message: true });
          continue;
        }
        const found = walk(match[1].trim(), "the title's");
        if (!found) continue;
        const end = column(found.end.table, found.end.name)!;
        if (isBinaryType(end.type)) {
          said.push(`${at}: the title's {${match[1]}} is ${found.end.table.name}.${found.end.name}, which holds bytes, not words.`);
          continue;
        }
        title.push(found.path);
        uses.add(`${table.id}.${found.path.column}`);
        for (const hop of found.path.hops) uses.add(`${hop.table}.${hop.column}`);
      }
      if (cursor < authored.length) title.push(authored.slice(cursor));

      let on: CompiledNotifyRule['on'];
      if (rule.on === 'insert') on = { kind: 'insert' };
      else if (rule.on === 'update') on = { kind: 'update' };
      else if ('changes' in rule.on) {
        const missing = rule.on.changes.find((name) => !column(table, name));
        if (missing) said.push(`${at}: "on.changes" names "${missing}", which is not a column of ${table.name}.`);
        on = { kind: 'update', columns: [...rule.on.changes] };
      } else if ('flow' in rule.on) {
        if (!resource.flows) said.push(`${at}: "on.flow" is told by a flow's notify step, and ${name} has no flows.`);
        on = { kind: 'flow', audience: rule.on.flow };
      } else {
        const label = labelOf(name, rule.on.action);
        if (label === undefined) said.push(`${at}: "on.action" names "${rule.on.action}", which is no action's id in this App.`);
        on = { kind: 'action', label: label ?? rule.on.action };
      }

      let when: NotifyWhen | undefined;
      if (rule.when !== undefined) {
        const compiledWhen = compileNotifyWhen(table, schema, rule.when);
        if (typeof compiledWhen === 'string') said.push(`${at}: "when" ${compiledWhen}`);
        else when = compiledWhen;
      }

      let open: CompiledNotifyRule['open'] = { resource: name };
      if (rule.opens !== undefined) {
        const ref = column(table, rule.opens)?.references;
        const target = ref ? tableOf(ref.table) : undefined;
        const resourceName = target ? Object.keys(app.resources ?? {}).find((key) => tableOf(key)?.id === target.id) : undefined;
        if (!ref || !target) said.push(`${at}: "opens" names "${rule.opens}", which is not a reference of ${table.name}.`);
        else if (!resourceName)
          said.push(`${at}: "opens" names "${rule.opens}", which references ${target.name}, and no resource block declares it.`);
        else if (primaryKey(target).length !== 1 || primaryKey(target)[0] !== ref.column)
          said.push(`${at}: "opens" names "${rule.opens}", which does not reference ${target.name}'s one-column key.`);
        else open = { resource: resourceName, key: { column: rule.opens, target: ref.column } };
      } else if (!primaryKey(table).length) said.push(`${at}: ${table.name} has no primary key, so a notice could not open its record.`);

      let mentions: CompiledNotifyRule['mentions'];
      if (rule.mentions) {
        const text = column(table, rule.mentions.in);
        /* A rich text column keeps a mention as the handle its display rule
           stores (`by`), so the rule and the column must mean one thing by it. */
        const shown = resource.display?.[rule.mentions.in];
        const rich = shown?.format === 'richText';
        const declared = rich ? shown.mentions : undefined;
        const by = rule.mentions.by ?? declared?.by;
        const handle = person.table && by ? column(person.table, by) : undefined;
        if (!text || columnKind(text.type) !== 'text' || text.references)
          said.push(`${at}: "mentions.in" names "${rule.mentions.in}", which is not a text column of ${table.name}.`);
        else if (!person.table || !person.column)
          said.push(
            `${at}: "mentions" finds people by their handle in the table auth.me names, and this App declares no auth.me: { table, column }.`,
          );
        else if (!by)
          said.push(
            `${at}: "mentions" needs "by", the column of ${person.table.name} a handle is` +
              (rich ? `; or give ${table.name}.${text.name}'s display rule mentions: { from, by }.` : '.'),
          );
        else if (declared && rule.mentions.by !== undefined && declared.by !== rule.mentions.by)
          said.push(
            `${at}: "mentions.by" is "${rule.mentions.by}", and ${table.name}.${text.name}'s display rule stores a mention as "${declared.by}". ` +
              `They must agree: a mention is kept as the handle the editor stores. Leave "by" out to take the display rule's.`,
          );
        else if (declared && tableOf(declared.from)?.id !== person.table.id)
          said.push(
            `${at}: ${table.name}.${text.name}'s display rule offers mentions of "${declared.from}", and a notice finds its person in ` +
              `${person.table.name}, the table auth.me names. Mention the people auth.me names.`,
          );
        else if (!handle || (columnKind(handle.type) !== 'text' && columnKind(handle.type) !== 'number'))
          said.push(`${at}: "mentions.by" names "${by}", which is not a text or number column of ${person.table.name}.`);
        else {
          const groups = declared?.groups
            ? mentionGroups(declared.groups, person.table, `${at}: ${table.name}.${text.name}'s mentions.groups`)
            : undefined;
          if (typeof groups === 'string') said.push(groups);
          else
            mentions = {
              column: text.name,
              ...(rich ? { rich: true as const } : {}),
              table: person.table.id,
              by: handle.name,
              email: person.column,
              ...account,
              ...(groups ? { groups } : {}),
            };
        }
      }

      let send: NotifySend | undefined;
      if (rule.send) {
        const named = (key: string) => `"send.${key}"`;
        const text = (path: string, key: string): NotifyPath | undefined => {
          const found = walk(path, named(key));
          if (!found) return undefined;
          const end = column(found.end.table, found.end.name)!;
          if (columnKind(end.type) !== 'text' || end.references) {
            said.push(`${at}: ${named(key)} "${path}" ends at ${found.end.table.name}.${found.end.name}, which is not a text column.`);
            return undefined;
          }
          return found.path;
        };
        const address = text(rule.send.to, 'to');
        const consent = rule.send.consent ? walk(rule.send.consent, named('consent'))?.path : undefined;
        const timezone = rule.send.timezone ? text(rule.send.timezone, 'timezone') : undefined;
        if (address) send = { channel: rule.send.channel, to: address, ...(consent ? { consent } : {}), ...(timezone ? { timezone } : {}) };
      }

      problems.push(...said);
      if (said.length || (!to.length && !mentions && !send)) continue;
      compiled.push({
        on,
        ...(when ? { when } : {}),
        to,
        title,
        ...(say ? { say } : {}),
        open,
        uses: [...uses],
        ...(rule.email ? { email: true as const } : {}),
        ...(mentions ? { mentions } : {}),
        ...(send ? { send } : {}),
      });
    }
    if (compiled.length) rules.set(name, compiled);
  }
  return { rules, problems };
}

/**
 * Advice, never a refusal: a configuration that writes every notice to
 * nobody, silently. A notice reaches a person through the column `auth.me`
 * names — an email in an App, the account's id in a tenant App — and a value
 * of the other kind tells nobody, without an error, since the catalog cannot
 * say what a text column holds. Its name usually can.
 */
export function notifyAdvisories(app: AppDef, schema: DatabaseSchema): string[] {
  const me = app.auth?.me;
  if (!me) return [];
  const { rules } = appNotifyRules(app, schema);
  const person = personTable(app, schema);
  const reaches = [...rules].find(([, list]) =>
    list.some(
      (rule) =>
        rule.mentions || rule.to.some((path) => path.hops.some((hop) => hop.table === person.table?.id && hop.column === person.column)),
    ),
  );
  if (!reaches) return [];
  const at = `resources "${reaches[0]}", notify`;
  if (isTenantApp(app) && /mail/i.test(me.column))
    return [
      `${at}: auth.me's "${me.column}" looks like an email column. In a tenant App it holds each person's account id, ` +
        "which a notice is told at; an email there tells nobody (and is nobody's me).",
    ];
  if (!isTenantApp(app) && /(?:^|_)id$|account/i.test(me.column))
    return [
      `${at}: auth.me's "${me.column}" looks like an id. A notice is told at the email that column holds, so a value ` +
        'that is not an email tells nobody. Name the column holding the email.',
    ];
  return [];
}
