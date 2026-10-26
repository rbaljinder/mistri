/**
 * Notifications, the engine-neutral half: what a notice keeps, which writes
 * send one and to whom, and how one write's rows become notices.
 *
 * A notice is the App telling a person that something happened to a record
 * they care about — a reply to their thread, a purchase order of theirs
 * received — kept until they have read it. The App says which writes do
 * that (`notify` on a resource: a new record, a change to a column, an
 * action), bound once per physical adapter by trusted server code, the way a
 * record history is. Like the history, a notice is written beneath every
 * facade, in the triggering write's own transaction, into reserved inbox
 * tables in the same database (`__mistri_inbox_*`, on PostgreSQL
 * `mistri.inbox_*`): a write that commits has told its people, one that
 * rolls back has told nobody, and a notice that cannot be written fails the
 * write.
 *
 * Who is told is read off the record after the write, never off a request:
 * a column holding an email, or a path through references to one (the
 * people table's email, `auth.me`). In a tenant App the people table holds
 * each person's account id instead, which is told at that account's email,
 * and only while the account is a member where the notice is kept: a row a
 * tenant wrote cannot reach anyone outside it. The person who made the write is never
 * told of their own write. The words are the App's, filled from the record
 * as it stood then; whether its recipient may still read them is the
 * server's to decide each time the inbox is read (server/inbox.ts).
 */
import { createHash, randomUUID } from 'node:crypto';
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { mailQueued } from './inboxMail.js';
import { richTextMentioned } from '@mistriwork/engine/shared/richText.js';
import type { NotifyMentions, NotifyPath, NotifySend } from '../../shared/appNotify.js';
import type { QueuedChannelNotice } from '../integrations/integrationStore.js';

export const INBOX_VERSION = 1;
import { INBOX_PREFIX } from './inboxTables.js';
export { INBOX_PREFIX, INBOX_TABLES } from './inboxTables.js';
/** The one index the notice table carries: a person's notices in one App, newest last. */
export const INBOX_INDEX = `${INBOX_PREFIX}notice_recipient`;

/** Bounds, the same on every engine. A title past its bound is kept cut. */
export const INBOX_LIMITS = Object.freeze({
  app: 128,
  recipient: 320,
  resource: 512,
  key: 2048,
  title: 1000,
  uses: 4096,
  actor: 320,
  actorName: 200,
  action: 200,
});
/** A title as the App says it, once filled: a line, not a message body. */
const NOTICE_TITLE_CHARS = 200;

export class InboxUnavailable extends Refusal {
  constructor(
    message = 'The notification store is missing or is not the layout this version expects. It is provisioned once, never on ' +
      "startup: run `mistri migrate stores up --app <the App's directory>`, or provisionStores(<the database>, { only: ['inbox'] }) from @mistriwork/mistri/maintenance " +
      'against the database, then start again. A foreign layout is refused, not altered.',
  ) {
    super(message);
    this.name = 'InboxUnavailable';
  }
}

/* ---------- which writes notify whom ---------- */

/** A value read off the record: its own column, then one read per reference crossed. */
export interface NoticePath {
  readonly column: string;
  /** Each hop reads `column` of the `table` row whose `key` column holds the value so far. Physical table ids. */
  readonly hops: readonly { readonly table: string; readonly key: string; readonly column: string }[];
  /** The value is a native account's id (a tenant App's people, `auth.me`), told at its email by the rule's `members`. */
  readonly account?: true;
}

/**
 * The email of an account that is a member where a notice is kept — `tenant`,
 * the record's owner, or undefined for the platform realm's own records — or
 * undefined: no such account, or not a member there now. Trusted server code
 * supplies it (tenant/tenantInbox.ts); the capture never asks a request.
 */
export type NoticeMembers = (account: string, tenant: string | undefined) => Promise<string | undefined>;

/** One `notify` rule, compiled against the catalog by trusted server code. */
export interface NoticeRule {
  /** The App the notice belongs to: its inbox is read per App. */
  readonly app: string;
  readonly on:
    | { readonly kind: 'insert' }
    | { readonly kind: 'update'; readonly columns?: readonly string[] }
    | { readonly kind: 'action'; readonly label: string }
    /* A flow's notify step names its audience (WriteTransaction.tell): nothing is written, the record is told about. */
    | { readonly kind: 'flow'; readonly audience: string };
  /** The record after the write must satisfy one group (or); a group's conditions all hold (and): a column holds
      one of the values, or, with `not`, none of them (compared as text). */
  readonly when?: readonly (readonly { readonly column: string; readonly values: readonly string[]; readonly not?: true }[])[];
  /** Each resolves to one email, or to nobody. */
  readonly to: readonly NoticePath[];
  /** The words, literal parts and values read off the record; on a `flow` rule, `{ message }` is the step's own words. */
  readonly title: readonly (string | NoticePath | NoticeMessage)[];
  /** A title said from the App's messages instead: its arguments read off the record once, and the words said for
      each recipient in their own locale (server/app/noticeWords.ts) — `recipient` absent for a channel's address. */
  readonly say?: {
    readonly args: readonly { readonly name: string; readonly path: NoticePath }[];
    readonly words: (
      values: Readonly<Record<string, unknown>>,
      recipient: string | undefined,
      tenant: string | undefined,
      sink: Pick<NoticeSink, 'rows'>,
    ) => Promise<string>;
  };
  /** What the notice opens: the record itself, or the one a reference on it names. Logical resource. */
  readonly open: { readonly resource: string; readonly key?: { readonly column: string; readonly target: string } };
  /** Logical `resource.column` pairs the title reads: its recipient sees the words only while they may read every one. */
  readonly uses: readonly string[];
  /** Each notice is emailed too, after the write commits (the outbox). */
  readonly email?: true;
  /** The people a text column mentions, by the handle column of the people table (physical id), and their email there;
      a rich text column's are its stored mentions, a team's its members. `tenant`: a tenant-owned table's ownership
      column, so a handle is found among the record's own tenant's rows and nobody else's. */
  readonly mentions?: NoticeMentions;
  /** A tenant-owned table's ownership column (a tenant App's, tenant/tenantInbox.ts): the notice is kept in
      that tenant's own inbox, read off the record in the write's transaction, and read only on its lease. */
  readonly owner?: string;
  /** Where a recipient is an account id (`account` on a path or the mentions): its email, while a member. Absent,
      an account id tells nobody. */
  readonly members?: NoticeMembers;
  /** The notice told on an integration's channel too: the address read off the record, and the consent and zone it
      says. Queued in the integrations store in this transaction and sent after it commits (integrationChannels.ts). */
  readonly send?: NoticeSend;
}

/** Where a `flow` rule's title says the notify step's words (`{message}`). */
interface NoticeMessage {
  readonly message: true;
}
const isMessage = (part: string | NoticePath | NoticeMessage): part is NoticeMessage => typeof part !== 'string' && 'message' in part;

interface NoticeSend {
  readonly channel: string;
  readonly to: NoticePath;
  readonly consent?: NoticePath;
  readonly timezone?: NoticePath;
  /** The built-in email channel's: the record's columns the server stamps with an address a visitor proved with a code
      (a saved form's `link.email.verified`), and the line that says why the recipient gets the mail. */
  readonly proof?: readonly string[];
  readonly because?: string;
}

/** The channel the platform sends itself, through the config's email service; every other is an integration's. */
export const EMAIL_CHANNEL = 'email';
/* One address, as the transport takes it (email/email.ts): nothing a header could be split on. */
const ONE_ADDRESS = /^[^\s<>@",]+@[^\s<>@",]+\.[^\s<>@",]+$/;
/** An email address as a channel keeps it: trimmed and lowercased, or undefined when it is not one address. */
function emailRecipient(value: string | undefined): string | undefined {
  const address = value?.trim().toLowerCase();
  return address && address.length <= 320 && ONE_ADDRESS.test(address) ? address : undefined;
}

/** Who a rule's mentions tell, in physical table ids (appNotify.ts `NotifyMentions`). */
interface NoticeMentions {
  readonly column: string;
  readonly rich?: true;
  readonly table: string;
  readonly by: string;
  readonly email: string;
  /** `email` holds the account's id (a tenant App's people), as does a team member's `person` without a `key`. */
  readonly account?: true;
  readonly tenant?: string;
  readonly groups?: {
    readonly table: string;
    readonly by: string;
    readonly value: string;
    readonly tenant?: string;
    readonly members: {
      readonly table: string;
      readonly match: string;
      readonly person: string;
      readonly key?: string;
      readonly tenant?: string;
    };
  };
}

/** Every table a rule's mentions read: the people, and a team's rows and the rows that put a person in it. */
export const mentionTables = (mentions: NotifyMentions | undefined): string[] =>
  mentions ? [mentions.table, ...(mentions.groups ? [mentions.groups.table, mentions.groups.members.table] : [])] : [];

/** A rule's channel with its paths in physical names, mapped as the rest of its paths are. */
export function physicalSend(
  send: NotifySend,
  path: (logical: NotifyPath) => NoticePath,
  email: Readonly<{ proof?: readonly string[]; because?: string }> = {},
): NoticeSend {
  return Object.freeze({
    channel: send.channel,
    to: path(send.to),
    ...(send.consent ? { consent: path(send.consent) } : {}),
    ...(send.timezone ? { timezone: path(send.timezone) } : {}),
    ...(send.channel === EMAIL_CHANNEL && email.proof?.length ? { proof: Object.freeze([...email.proof]) } : {}),
    ...(send.channel === EMAIL_CHANNEL && email.because ? { because: email.because } : {}),
  });
}

/** A rule's mentions in physical table ids; `tenant` gives a tenant-owned table's ownership column (tenant/tenantInbox.ts). */
export function physicalMentions(
  mentions: NotifyMentions,
  physical: (table: string) => string,
  tenant: (table: string) => string | undefined = () => undefined,
): NoticeMentions {
  const own = (table: string) => {
    const column = tenant(table);
    return column ? { tenant: column } : {};
  };
  const g = mentions.groups;
  return {
    ...mentions,
    table: physical(mentions.table),
    ...own(mentions.table),
    ...(g
      ? {
          groups: {
            ...g,
            table: physical(g.table),
            ...own(g.table),
            members: { ...g.members, table: physical(g.members.table), ...own(g.members.table) },
          },
        }
      : {}),
  };
}

/**
 * The inbox a tenant's notices are kept in: the App's, under the tenant. The
 * tenant is said by a digest, so the namespace fits the store's bound for
 * every tenant id (tenantMembership.ts takes 128 characters), and it is the
 * whole of what a read or a mark is keyed by: a lease reads and marks its
 * own tenant's notices and never another's.
 */
export function tenantInbox(app: string, tenant: string): string {
  return `${app}/t.${createHash('sha256').update(tenant, 'utf8').digest('base64url').slice(0, 27)}`;
}

/** Physical table id → the rules its writes answer to. */
export type NoticeBinding = ReadonlyMap<string, readonly NoticeRule[]>;

const bindings = new WeakMap<object, NoticeBinding>();

/** Trusted server code only: which of this physical adapter's tables notify. Replaces what was bound. */
export function bindNotices(adapter: object, binding: NoticeBinding): void {
  if (!binding.size) {
    bindings.delete(adapter);
    return;
  }
  bindings.set(adapter, new Map([...binding].map(([table, rules]) => [table, Object.freeze([...rules])])));
}

export const noticeBinding = (adapter: object): NoticeBinding | undefined => bindings.get(adapter);

/* ---------- what one notice stores ---------- */

export interface NoticeRow {
  app: string;
  /** The recipient's email, lowercased: who reads it. */
  recipient: string;
  at: string;
  /** The logical resource the notice opens, and that record's key as JSON. */
  resource: string;
  key: string;
  title: string;
  uses: string[];
  actor: string;
  actorName: string;
  action: string;
  /** Queue it in the outbox too, in the same transaction. */
  email?: true;
}

/** A stored notice read back, newest first. */
export interface StoredNotice extends NoticeRow {
  id: number;
  readAt: string | null;
}

/** What the capture needs from its transaction: a row by key (the writer's), the rows that match, and an append. */
export interface NoticeSink {
  read(
    table: string,
    key: Record<string, string | number>,
    columns?: string[],
    lock?: boolean,
  ): Promise<Record<string, unknown> | undefined>;
  /** Up to `limit` rows whose columns equal these values: a team's members. */
  rows(table: string, where: Record<string, string | number>, columns: string[], limit: number): Promise<Record<string, unknown>[]>;
  notify(row: NoticeRow): Promise<void>;
  /** Queue a channel message in the same transaction; absent where the engine keeps none (a rule that sends on a channel
      is then refused as the App loads). */
  message?(row: QueuedChannelNotice): Promise<void>;
}

/** Who and what the write is, read once when its transaction opens. */
interface NoticeContext {
  readonly actor: string;
  readonly actorName: string;
  readonly action: string;
  readonly at: string;
  /** A signed-in account, a public visitor (a form or a public page, nobody signed in), or the platform and its services. */
  readonly kind: 'account' | 'public' | 'service';
}

/* Values cross the driver: 3 and '3' are one value, a stored boolean is 1 or true. */
function textOf(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return undefined;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
const sameText = (value: unknown, wanted: string) => {
  const text = textOf(value);
  if (text === undefined) return false;
  if (text === wanted) return true;
  return (wanted === 'true' && text === '1') || (wanted === 'false' && text === '0');
};

const EMAIL = /^[^\s@]+@[^\s@]+$/;

/* `@ada` at the start or after a space or punctuation — never inside a word
   or an address (`ada@example.com` mentions nobody). */
const MENTION = /(?:^|[^A-Za-z0-9_@.])@([A-Za-z0-9_][A-Za-z0-9_.-]{0,62}[A-Za-z0-9_]|[A-Za-z0-9_])/g;
/** How many people one write's text may tell: past it, it is a broadcast. */
const MAX_MENTIONS = 20;

/** The handles a text @-mentions, each once, in order. */
export function mentionedHandles(text: unknown): string[] {
  if (typeof text !== 'string' || !text.includes('@')) return [];
  const handles = new Set<string>();
  for (const match of text.matchAll(MENTION)) {
    handles.add(match[1]);
    if (handles.size >= MAX_MENTIONS) break;
  }
  return [...handles];
}

/* A stored rich text mention, however the value came to hold one. */
const STORED_MENTION = /<span\b[^>]*\bdata-type\s*=\s*"mention"/i;

/**
 * Who a value mentions under a rule: a rich text column's stored mentions —
 * the handle each keeps, never the `@Name` drawn in it — and a plain text
 * column's `@handle` words. A plain column written with a stored mention (a
 * command's rich text input saved into it) is read the rich way, so the drawn
 * words are never taken for a handle.
 */
export function noticeMentions(mentions: Pick<NoticeMentions, 'rich' | 'groups'>, value: unknown): { people: string[]; groups: string[] } {
  if (mentions.rich || (typeof value === 'string' && STORED_MENTION.test(value))) {
    const said = richTextMentioned(value);
    return mentions.groups ? said : { people: said.people, groups: [] };
  }
  return { people: mentionedHandles(value), groups: [] };
}

/** How many people one team mentioned may tell; past it, a team is a broadcast list and is told as far as this. */
const MOST_IN_A_TEAM = 100;

/** The columns of the triggering table a rule reads off the record. */
function ruleColumns(rule: NoticeRule): string[] {
  const columns = new Set<string>();
  for (const path of [...rule.to, ...rule.title.filter((part): part is NoticePath => typeof part !== 'string' && !isMessage(part))])
    columns.add(path.column);
  for (const condition of (rule.when ?? []).flat()) columns.add(condition.column);
  if (rule.mentions) columns.add(rule.mentions.column);
  for (const path of rule.send ? [rule.send.to, rule.send.consent, rule.send.timezone] : []) if (path) columns.add(path.column);
  for (const column of rule.send?.proof ?? []) columns.add(column);
  if (rule.open.key) columns.add(rule.open.key.column);
  if (rule.on.kind === 'update') for (const column of rule.on.columns ?? []) columns.add(column);
  if (rule.owner) columns.add(rule.owner);
  return [...columns];
}

/** A record's key as a notice keeps it: its columns in order, each value as the driver gave it. */
export function noticeKey(key: Record<string, unknown>): string {
  const text = JSON.stringify(
    Object.fromEntries(
      Object.keys(key)
        .sort()
        .map((column) => {
          const value = key[column];
          return [column, typeof value === 'number' || typeof value === 'string' ? value : String(value)];
        }),
    ),
  );
  if (Buffer.byteLength(text, 'utf8') > INBOX_LIMITS.key) throw new Refusal("This record's key is too long to be named in a notification.");
  return text;
}

interface NoticeCapture {
  /** The columns the rules on a table read, for the writer to read back after the write. */
  columns(table: string): string[] | undefined;
  inserted(table: string, key: Record<string, string | number>, after: Record<string, unknown>): Promise<void>;
  /** `before`: the record as it was, in the columns the rules read, so an edit tells only the people it newly mentions. */
  updated(
    table: string,
    key: Record<string, string | number>,
    changed: ReadonlySet<string>,
    after: Record<string, unknown>,
    before?: Record<string, unknown>,
  ): Promise<void>;
  /** A flow's notify step about this record: the rules `on: { flow: audience }`, their `{message}` the step's words. */
  told(table: string, key: Record<string, string | number>, audience: string, message: string, row: Record<string, unknown>): Promise<void>;
}

/**
 * One transaction's notices, or undefined where the adapter notifies nobody.
 * A record told of twice in one write — a command that updates it twice — is
 * one notice per person.
 */
export function captureNotices(adapter: object, sink: NoticeSink, context: NoticeContext): NoticeCapture | undefined {
  const binding = bindings.get(adapter);
  if (!binding) return undefined;
  const sent = new Set<string>();
  const actor = context.actor.trim().toLowerCase();

  const resolve = async (path: NoticePath, row: Record<string, unknown>): Promise<unknown> => {
    let value: unknown = row[path.column];
    for (const hop of path.hops) {
      if (value === null || value === undefined || !(typeof value === 'number' || typeof value === 'string')) return undefined;
      const next = await sink.read(hop.table, { [hop.key]: value }, [hop.column]);
      value = next?.[hop.column];
    }
    return value;
  };

  /* The channel's address is whatever the record says, as a `send` effect's `to` is: the App holds the consent it
     names, and core still asks the recipient's opt-out and the quiet hours before anything goes. */
  const queueSend = async (
    rule: NoticeRule,
    send: NoticeSend,
    row: Record<string, unknown>,
    tenant: string,
    record: string,
    text: string,
  ) => {
    const said = textOf(await resolve(send.to, row));
    /* An email address is one address or nothing is queued: a typed `a@b.c, d@e.f` or a line break never reaches a header. */
    const email = send.channel === EMAIL_CHANNEL;
    const address = email ? emailRecipient(said) : said?.trim();
    if (!address || address.length > 320 || !sink.message) return;
    const once = `${rule.app}|${tenant}|${record}|${send.channel}|${address}`;
    if (sent.has(once)) return;
    sent.add(once);
    const zone = send.timezone ? textOf(await resolve(send.timezone, row))?.trim() : undefined;
    await sink.message({
      app: rule.app,
      key: `notify-${randomUUID()}`,
      tenant,
      channel: send.channel,
      recipient: address,
      text: email && send.because ? `${text}\n\n${send.because}` : text,
      consent: send.consent ? sameText(await resolve(send.consent, row), 'true') : false,
      timezone: zone || null,
      /* A visitor's write mails an address only where they proved it in the form: the server stamped it on this record. */
      actorKind:
        context.kind === 'public' && email && (send.proof ?? []).some((column) => emailRecipient(textOf(row[column])) === address)
          ? 'proven'
          : context.kind,
      at: Date.parse(context.at) || Date.now(),
    });
  };

  const holds = (rule: NoticeRule, row: Record<string, unknown>) =>
    !rule.when ||
    rule.when.some((group) =>
      group.every((condition) => condition.values.some((value) => sameText(row[condition.column], value)) !== (condition.not === true)),
    );

  const fire = async (
    table: string,
    key: Record<string, string | number>,
    row: Record<string, unknown>,
    happened: (rule: NoticeRule) => boolean,
    before?: Record<string, unknown>,
    message?: string,
  ) => {
    for (const [index, rule] of (binding.get(table) ?? []).entries()) {
      if (!happened(rule)) continue;
      if (!holds(rule, row)) continue;
      // A tenant's record tells its people in that tenant's inbox; a row that does not say whose it is tells nobody.
      const owner = rule.owner ? row[rule.owner] : undefined;
      if (rule.owner && (typeof owner !== 'string' || !owner)) continue;
      const recipients = new Set<string>();
      const accounts = new Set<string>();
      const tell = (value: unknown, account?: true) => {
        if (account) {
          // Told once its email is known, below; an id is said exactly as stored.
          if (typeof value === 'string' && value) accounts.add(value);
          return;
        }
        const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
        // Nobody to tell, or somebody the write was made by.
        if (!EMAIL.test(email) || email.length > INBOX_LIMITS.recipient || email === actor) return;
        recipients.add(email);
      };
      for (const path of rule.to) tell(await resolve(path, row), path.account);
      /* A mention names a person by their handle, found in the people table
         the App declares, and a team as its members; whether they may read
         the record is asked each time the notice is read or mailed, as for
         every recipient, so one who cannot is never shown it. */
      if (rule.mentions) await mentioned(rule, row, before, (value) => tell(value, rule.mentions!.account));
      /* An account is told at its email, and only while it is a member where
         this notice is kept: a person row that names an account from outside
         the tenant tells nobody. */
      for (const account of accounts) if (rule.members) tell(await rule.members(account, owner as string | undefined));
      if (!recipients.size && !rule.send) continue;
      const line = (text: string) => {
        const said = text.replace(/\s+/g, ' ').trim();
        return said.length > NOTICE_TITLE_CHARS ? `${said.slice(0, NOTICE_TITLE_CHARS - 1)}…` : said;
      };
      let title = '';
      for (const part of rule.title)
        title += typeof part === 'string' ? part : isMessage(part) ? (message ?? '') : (textOf(await resolve(part, row)) ?? '');
      title = line(title);
      /* A title said from the App's messages is read off the record once and said per recipient, in each one's locale. */
      let values: Record<string, unknown> | undefined;
      if (rule.say) {
        values = { message: message ?? '' };
        for (const arg of rule.say.args) values[arg.name] = await resolve(arg.path, row);
      }
      const titleFor = async (recipient: string | undefined) =>
        rule.say ? line(await rule.say.words(values!, recipient, typeof owner === 'string' ? owner : undefined, sink)) : title;
      if (!rule.say && !title) continue;
      if (rule.send) {
        const said = await titleFor(undefined);
        if (said)
          await queueSend(rule, rule.send, row, typeof owner === 'string' ? owner : '', `${index}|${table}|${noticeKey(key)}`, said);
      }
      if (!recipients.size) continue;
      let opens: { resource: string; key: Record<string, unknown> };
      if (rule.open.key) {
        const target = row[rule.open.key.column];
        if (!(typeof target === 'number' || typeof target === 'string')) continue;
        opens = { resource: rule.open.resource, key: { [rule.open.key.target]: target } };
      } else opens = { resource: rule.open.resource, key };
      const keyText = noticeKey(opens.key);
      const app = rule.owner ? tenantInbox(rule.app, owner as string) : rule.app;
      for (const recipient of recipients) {
        const once = `${app}|${index}|${table}|${keyText}|${recipient}`;
        if (sent.has(once)) continue;
        sent.add(once);
        const title = await titleFor(recipient);
        if (!title) continue;
        await sink.notify({
          app,
          recipient,
          at: context.at,
          resource: opens.resource,
          key: keyText,
          title,
          uses: [...rule.uses],
          actor: context.actor,
          actorName: context.actorName,
          action: context.action,
          ...(rule.email ? { email: true as const } : {}),
        });
        if (rule.email) mailQueued();
      }
    }
  };

  /* A tenant's rows are found among that tenant's own: a handle another tenant also uses is not this record's person. */
  const within = (rule: NoticeRule, row: Record<string, unknown>, tenant: string | undefined): Record<string, string> | undefined => {
    if (!tenant) return {};
    const owner = rule.owner ? row[rule.owner] : undefined;
    return typeof owner === 'string' && owner ? { [tenant]: owner } : undefined;
  };
  /* The emails a value's mentions reach — or, where the people table holds account ids, the accounts — each
     person by their handle, each team as its members. */
  const reached = async (rule: NoticeRule, row: Record<string, unknown>, value: unknown): Promise<Set<string>> => {
    const m = rule.mentions!;
    const emails = new Set<string>();
    const add = (email: unknown) => {
      // An account id is matched exactly, as the membership store keeps it; an email in any case.
      if (typeof email === 'string' && email.trim()) emails.add(m.account ? email : email.trim().toLowerCase());
    };
    const said = noticeMentions(m, value);
    const scope = within(rule, row, m.tenant);
    if (!scope) return emails;
    for (const handle of said.people) add((await sink.read(m.table, { ...scope, [m.by]: handle }, [m.email]))?.[m.email]);
    const g = m.groups;
    const teamScope = g && within(rule, row, g.tenant),
      memberScope = g && within(rule, row, g.members.tenant);
    if (!g || !teamScope || !memberScope) return emails;
    for (const handle of said.groups) {
      const value = (await sink.read(g.table, { ...teamScope, [g.by]: handle }, [g.value]))?.[g.value];
      if (!(typeof value === 'string' || typeof value === 'number')) continue;
      for (const member of await sink.rows(
        g.members.table,
        { ...memberScope, [g.members.match]: value },
        [g.members.person],
        MOST_IN_A_TEAM,
      )) {
        const person = member[g.members.person];
        if (!g.members.key) add(person);
        else if (typeof person === 'string' || typeof person === 'number')
          add((await sink.read(m.table, { ...scope, [g.members.key]: person }, [m.email]))?.[m.email]);
      }
    }
    return emails;
  };
  const mentioned = async (
    rule: NoticeRule,
    row: Record<string, unknown>,
    before: Record<string, unknown> | undefined,
    tell: (email: unknown) => void,
  ) => {
    const m = rule.mentions!;
    /* An edit tells only whom it newly reaches where the rule holds: saving
       the same words again tells nobody, a team added tells none of its
       members already mentioned, and a record the rule comes to hold of (a
       post let through review) tells everyone it mentions then. */
    const now = await reached(rule, row, row[m.column]);
    const was = before && holds(rule, before) ? await reached(rule, before, before[m.column]) : new Set<string>();
    for (const email of now) if (!was.has(email)) tell(email);
  };

  return {
    columns(table) {
      const rules = binding.get(table);
      if (!rules) return undefined;
      return [...new Set(rules.flatMap(ruleColumns))];
    },
    inserted: (table, key, after) =>
      fire(table, key, after, (rule) => rule.on.kind === 'insert' || (rule.on.kind === 'action' && rule.on.label === context.action)),
    updated: (table, key, changed, after, before) =>
      fire(
        table,
        key,
        after,
        (rule) => {
          if (!changed.size) return false;
          if (rule.on.kind === 'update') return !rule.on.columns || rule.on.columns.some((column) => changed.has(column));
          return rule.on.kind === 'action' && rule.on.label === context.action;
        },
        before,
      ),
    told: (table, key, audience, message, row) =>
      fire(table, key, row, (rule) => rule.on.kind === 'flow' && rule.on.audience === audience, undefined, message),
  };
}

/* ---------- the store's rows ---------- */

/** Shared row validation for every engine's append: the store's CHECKs say the same. */
export function assertNoticeRow(row: NoticeRow): string {
  const uses = JSON.stringify(row.uses);
  const within = (value: unknown, limit: number, empty = false) =>
    typeof value === 'string' && (empty || value.length > 0) && Buffer.byteLength(value, 'utf8') <= limit;
  if (
    !within(row.app, INBOX_LIMITS.app) ||
    !within(row.recipient, INBOX_LIMITS.recipient) ||
    !within(row.resource, INBOX_LIMITS.resource) ||
    !within(row.key, INBOX_LIMITS.key) ||
    !within(row.title, INBOX_LIMITS.title) ||
    !within(row.actor, INBOX_LIMITS.actor, true) ||
    !within(row.actorName, INBOX_LIMITS.actorName, true) ||
    !within(row.action, INBOX_LIMITS.action, true) ||
    Buffer.byteLength(uses, 'utf8') > INBOX_LIMITS.uses ||
    !Array.isArray(row.uses) ||
    row.uses.some((use) => typeof use !== 'string')
  ) {
    throw new Refusal('Invalid notification.');
  }
  return uses;
}

/** A stored `uses` document read back: the store is ours, but its rows are data. */
function parseNoticeUses(text: unknown): string[] {
  try {
    const parsed = typeof text === 'string' ? JSON.parse(text) : text;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** How many notices one read returns at most. */
export const INBOX_PAGE = 100;

/** A person's notices in one App: newest first, older than `before` when given, unread only when asked. */
export interface InboxQuery {
  app: string;
  recipient: string;
  limit: number;
  before?: number;
  unread?: boolean;
}

/** Mark one person's notices read: these ids, or every one. Never another person's. */
export interface InboxMark {
  app: string;
  recipient: string;
  at: string;
  ids?: readonly number[];
}

export function assertInboxQuery(query: InboxQuery): void {
  if (
    typeof query.app !== 'string' ||
    !query.app ||
    typeof query.recipient !== 'string' ||
    !query.recipient ||
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > INBOX_PAGE ||
    (query.before !== undefined && (!Number.isSafeInteger(query.before) || query.before < 1)) ||
    (query.unread !== undefined && typeof query.unread !== 'boolean')
  )
    throw new Refusal('Invalid notification read.');
}

export function assertInboxMark(mark: InboxMark): void {
  if (
    typeof mark.app !== 'string' ||
    !mark.app ||
    typeof mark.recipient !== 'string' ||
    !mark.recipient ||
    typeof mark.at !== 'string' ||
    (mark.ids !== undefined &&
      (!Array.isArray(mark.ids) ||
        !mark.ids.length ||
        mark.ids.length > INBOX_PAGE ||
        mark.ids.some((id) => !Number.isSafeInteger(id) || id < 1)))
  )
    throw new Refusal('Invalid notification mark.');
}

/** A row read back into its shape, whatever the driver's types. */
export function storedNotice(row: Record<string, unknown>): StoredNotice {
  return {
    id: Number(row.id),
    app: String(row.app),
    recipient: String(row.recipient),
    at: String(row.at),
    resource: String(row.resource),
    key: String(row.key_json),
    title: String(row.title),
    uses: parseNoticeUses(row.uses_json),
    actor: String(row.actor),
    actorName: String(row.actor_name),
    action: String(row.action),
    readAt: row.read_at === null || row.read_at === undefined ? null : String(row.read_at),
  };
}
