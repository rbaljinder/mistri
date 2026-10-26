/**
 * The Console's Governance room: for each App, who did what (its command
 * journal), what the App lets each role do (its authority.lock, in plain
 * English), and who holds which role (the suite's grant ledger).
 *
 * Nothing here is a new record or a new power. The audit is the journal the
 * App's commands already write, beside the grant ledger's own changes; the authority is the report the server
 * started from; the accounts are the suite grants, read with the same
 * administrator check as the suite's own access page, which stays where
 * roles are changed. Authority is the App's, as in the Operations room: the
 * caller must hold that App's `admin` role, read through the App's own
 * session projection, so one App's administrator sees nothing of another.
 * A tenant App has no such role: its Accounts view is its own membership
 * administration, read with the caller's own administration grant, and the
 * room points to the App's own screens for support sessions and API tokens,
 * which are read on the leases that already admit them.
 * A refusal is a code, and nothing carries a command's input, result or a
 * changed value: the audit names which fields changed, never what to.
 */
import { runtimeRelation, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SuiteAccessView } from '../../shared/suiteAdministration.js';
import type {
  AdministrationMembershipPage,
  AdministrationMembershipPageRequest,
  AdministrationPageRequest,
  AdministrationTenantPage,
} from '../../shared/tenantAdministration.js';
import { authorityChanges, authoritySentences, type AuthorityGroup } from '../app/authoritySentences.js';
import { THE_APP } from '../../shared/appFeatures.js';
import { send } from '@mistriwork/engine/server/http/reply.js';
import { grantsIn, type ConsoleOperationsOwner } from './operations.js';

/** One command as the journal holds it, for the room: who, which command, on what, which fields. */
interface ConsoleAuditRow {
  readonly id: string;
  readonly at: string;
  readonly actor: string;
  readonly command: string;
  readonly version: number;
  readonly tenant: string | null;
  readonly resource: string | null;
  readonly key: unknown;
  readonly fields: readonly string[];
  /** How many records the command changed: one receipt names each. */
  readonly targets: number;
  /** The connection whose journal holds it, never its address. */
  readonly database: string;
}

interface ConsoleAuditQuery {
  readonly actor?: string;
  /** A command id or a resource name. */
  readonly what?: string;
  /** ISO instants, `[from, to)`. */
  readonly from?: string;
  readonly to?: string;
  /** The last row of the page before: newer rows are not repeated. */
  readonly before?: { readonly at: string; readonly id: string };
  readonly limit: number;
}

/**
 * A tenant App's membership administration, read only (tenantAdministration.ts):
 * `open` answers null for an account with no administration grant, and each
 * page holds only the tenants and roles that grant reaches.
 */
export interface ConsoleTenantAccounts {
  open(request: IncomingMessage, accountId: string): Promise<{ readonly context: string } | null>;
  tenants(request: IncomingMessage, input: AdministrationPageRequest): Promise<AdministrationTenantPage>;
  memberships(request: IncomingMessage, input: AdministrationMembershipPageRequest): Promise<AdministrationMembershipPage>;
  /** Where the App is served: its support sessions and API tokens are its own screens there. */
  readonly href: string;
  /** A platform role reads every tenant's support sessions there (`supportAudit`). */
  readonly supportSessions: boolean;
  /** Its members make and end API tokens there, on their tenant's lease (`api`). */
  readonly apiTokens: boolean;
}

/** One App's governance, as its host holds it. Absent parts are views the room does not show. */
export interface ConsoleGovernance {
  /** The command journal of each of the App's databases, newest first. */
  readonly audit?: (query: ConsoleAuditQuery) => Promise<readonly ConsoleAuditRow[]>;
  /** The authority the server started with (authority.lock's text), and whether a lock holds it. */
  readonly authority?: () => {
    readonly report: string;
    readonly locked: boolean;
    readonly startedAt: number;
  };
  /**
   * The report an earlier start of this deployment served, and when the
   * current one was first served (suiteAuthority's history). Absent, or with
   * nothing earlier recorded, the room says it sees only this start.
   */
  readonly previousAuthority?: () => Promise<{ readonly report: string; readonly at: number } | undefined>;
  /** The App's holders and grant changes, for an administrator (suiteGrantStore `listAccess`). */
  readonly access?: (accountId: string) => SuiteAccessView | Promise<SuiteAccessView>;
  /**
   * The grant changes the audit lists beside the journal, newest first, with
   * the same administrator check (suiteGrantStore `listAccessChanges`).
   * Times are epoch ms; `actor` is who changed a grant.
   */
  readonly accessAudit?: (
    accountId: string,
    query: {
      readonly actor?: string;
      readonly from?: number;
      readonly to?: number;
      readonly before?: { readonly at: number; readonly id: string };
      readonly limit: number;
    },
  ) => SuiteAccessView['changes'] | Promise<SuiteAccessView['changes']>;
  /** An account's email, for a name the room can show; null when the account is not the suite's. */
  readonly email?: (accountId: string) => Promise<string | null>;
  /** The account an email names, for the audit's "who" filter. */
  readonly accountOf?: (email: string) => Promise<string | null>;
  /** A record's canonical address in the App, when its table has one: for `roles`, the address the person holding
      them is served (appRoutes), so a link from the room opens where their own browser would. */
  readonly recordHref?: (resource: string, key: unknown, roles?: readonly string[]) => string | undefined;
  /** Where the App's roles are changed: the suite's access page. */
  readonly manageHref?: string;
  /** A tenant App's accounts: its own administration decides who reads the room, not a suite role. */
  readonly tenantAccounts?: ConsoleTenantAccounts;
}

type View = 'audit' | 'authority' | 'accounts';
const PAGE = 50;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)~([A-Za-z0-9_-]{1,128})$/;
const DAY = 86_400_000;

const refuse = (response: ServerResponse, status: number, code: string) => {
  send(response, status, { ok: false, code });
  return true;
};
const views = (governance: ConsoleGovernance): View[] => [
  ...(governance.audit ? (['audit'] as const) : []),
  ...(governance.authority ? (['authority'] as const) : []),
  ...(governance.access || governance.tenantAccounts ? (['accounts'] as const) : []),
];
/* An App's own `admin` role; for a tenant App, an administration grant there (open answers a session). */
const isAdministrator = async (owner: ConsoleOperationsOwner, request: IncomingMessage, accountId: string) =>
  owner.governance?.tenantAccounts
    ? (await owner.governance.tenantAccounts.open(request, accountId).catch(() => null)) !== null
    : (await grantsIn(owner, request, accountId)).roles.includes('admin');
/* A tenant id or an administration page cursor, as the administration HTTP takes them: bounded, no control characters. */
const opaque = (value: string, most: number) => value.length > 0 && value.length <= most && !/\p{Cc}/u.test(value);
const MEMBERSHIP_OPERATIONS = ['replaceMembership', 'revokeMembership'] as const;

/** Each id's email, asked once; an account the suite does not know keeps its id alone. */
async function people(governance: ConsoleGovernance, ids: Iterable<string>): Promise<Map<string, string | null>> {
  const found = new Map<string, string | null>();
  for (const id of ids) {
    if (found.has(id)) continue;
    found.set(id, governance.email ? await governance.email(id).catch(() => null) : null);
  }
  return found;
}

/**
 * Answer one `/api/console/governance…` request; false for any other path.
 * Every view is a read: the room changes nothing, and links to the suite's
 * access page for a role change.
 */
export async function consoleGovernanceApi(
  input: Readonly<{
    request: IncomingMessage;
    response: ServerResponse;
    url: URL;
    path: string;
    accountId: string;
    owners: readonly ConsoleOperationsOwner[];
  }>,
): Promise<boolean> {
  const { request, response, url, accountId, owners } = input;
  const match = /^\/governance(?:\/([A-Za-z0-9_-]{1,64})\/(audit|authority|accounts))?$/.exec(input.path);
  if (!match) return false;
  const [, appId, view] = match as unknown as [string, string | undefined, View | undefined];
  if (request.method !== 'GET' && request.method !== 'HEAD') return refuse(response, 405, 'invalid_request');
  const allowed = view === 'audit' ? ['who', 'what', 'from', 'to', 'before'] : view === 'accounts' ? ['tenant', 'after', 'members'] : [];
  if ([...url.searchParams.keys()].some((key) => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1))
    return refuse(response, 400, 'invalid_request');

  if (!appId) {
    const apps = [];
    for (const owner of owners)
      if (owner.governance && (await isAdministrator(owner, request, accountId)))
        apps.push({
          id: owner.appId,
          name: owner.name,
          views: views(owner.governance),
        });
    send(response, 200, { ok: true, apps });
    return true;
  }
  const owner = owners.find((item) => item.appId === appId);
  // An App this Console does not serve and one the caller does not administer are told alike.
  if (!owner?.governance || !(await isAdministrator(owner, request, accountId))) return refuse(response, 403, 'not_granted');
  const governance = owner.governance;
  if (!views(governance).includes(view!)) return refuse(response, 404, 'unavailable');

  if (view === 'accounts' && governance.tenantAccounts) return tenantAccountsView(governance, governance.tenantAccounts, input);
  if (view === 'accounts' && url.searchParams.size) return refuse(response, 400, 'invalid_request');

  if (view === 'authority') {
    const now = governance.authority!();
    const previous = await governance.previousAuthority?.().catch(() => undefined);
    const groups = new Map<AuthorityGroup, { text: string; by: readonly string[] }[]>();
    for (const sentence of authoritySentences(now.report))
      // The App itself is who grants most of it: only a feature that contributes a fact is named.
      groups.set(sentence.group, [
        ...(groups.get(sentence.group) ?? []),
        {
          text: sentence.text,
          by: sentence.by.filter((who) => who !== THE_APP),
        },
      ]);
    send(response, 200, {
      ok: true,
      startedAt: new Date(now.startedAt).toISOString(),
      locked: now.locked,
      groups: [...groups].map(([group, sentences]) => ({ group, sentences })),
      ...(previous
        ? {
            since: new Date(previous.at).toISOString(),
            changes: authorityChanges(previous.report, now.report),
          }
        : { changes: null }),
    });
    return true;
  }

  if (view === 'accounts') {
    let access: SuiteAccessView;
    try {
      access = await governance.access!(accountId);
    } catch {
      // The ledger's own administrator check refused, or it could not be read: both are the room's to say alike.
      return refuse(response, 503, 'unavailable');
    }
    const names = await people(governance, [
      ...access.grants.map((grant) => grant.subjectId),
      ...access.changes.flatMap((change) => [change.subjectId, change.actorId]),
    ]);
    const person = (id: string) => ({ id, email: names.get(id) ?? null });
    send(response, 200, {
      ok: true,
      accounts: access.grants.map((grant) => ({
        ...person(grant.subjectId),
        roles: grant.roles,
        revision: grant.revision,
      })),
      more: access.more,
      changes: access.changes.map((change) => ({
        at: new Date(change.at).toISOString(),
        subject: person(change.subjectId),
        // A grant a provider's claims set is the provider's: its actor is `provider:<id>`, shown as it is.
        actor: person(change.actorId),
        before: change.before,
        after: change.after,
      })),
      ...(governance.manageHref ? { manageHref: governance.manageHref } : {}),
    });
    return true;
  }

  const who = url.searchParams.get('who')?.trim(),
    what = url.searchParams.get('what')?.trim(),
    from = url.searchParams.get('from'),
    to = url.searchParams.get('to'),
    before = url.searchParams.get('before');
  const day = (text: string | null) =>
    text === null ? undefined : DATE.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) ? Date.parse(`${text}T00:00:00Z`) : NaN;
  const fromDay = day(from),
    toDay = day(to);
  const cursor = before === null ? undefined : CURSOR.exec(before);
  if (
    (who !== undefined && (!who || who.length > 320)) ||
    (what !== undefined && !NAME.test(what)) ||
    Number.isNaN(fromDay) ||
    Number.isNaN(toDay) ||
    (fromDay !== undefined && toDay !== undefined && fromDay > toDay) ||
    (before !== null && !cursor)
  )
    return refuse(response, 400, 'invalid_request');
  // An email is looked up; anything else is an account id as the journal holds it. An unknown email finds no rows.
  const actor = who === undefined ? undefined : who.includes('@') ? ((await governance.accountOf?.(who).catch(() => null)) ?? null) : who;
  if (actor === null) {
    send(response, 200, { ok: true, rows: [] });
    return true;
  }
  type Entry =
    | ConsoleAuditRow
    | (SuiteAccessView['changes'][number] & {
        readonly kind: 'access';
        readonly iso: string;
      });
  let rows: Entry[];
  try {
    const commands = await governance.audit!({
      ...(actor === undefined ? {} : { actor }),
      ...(what === undefined ? {} : { what }),
      ...(fromDay === undefined ? {} : { from: new Date(fromDay).toISOString() }),
      ...(toDay === undefined ? {} : { to: new Date(toDay + DAY).toISOString() }),
      ...(cursor ? { before: { at: cursor[1], id: cursor[2] } } : {}),
      limit: PAGE + 1,
    });
    // A role change is neither a command nor a resource: a `what` filter names only the journal's rows.
    const changes =
      what === undefined && governance.accessAudit
        ? await governance.accessAudit(accountId, {
            ...(actor === undefined ? {} : { actor }),
            ...(fromDay === undefined ? {} : { from: fromDay }),
            ...(toDay === undefined ? {} : { to: toDay + DAY }),
            ...(cursor ? { before: { at: Date.parse(cursor[1]), id: cursor[2] } } : {}),
            limit: PAGE + 1,
          })
        : [];
    // One feed, newest first, ordered as each source pages itself, so the shared cursor resumes both.
    const key = (entry: Entry) => ('kind' in entry ? entry.iso : entry.at);
    rows = [
      ...commands,
      ...changes.map((change) => ({
        ...change,
        kind: 'access' as const,
        iso: new Date(change.at).toISOString(),
      })),
    ].sort((a, b) => (key(a) === key(b) ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : key(a) < key(b) ? 1 : -1));
  } catch {
    // The ledger's administrator check refused, or a source could not be read: a gap is never shown as quiet.
    return refuse(response, 503, 'unavailable');
  }
  const page = rows.slice(0, PAGE);
  const names = await people(governance, new Set(page.flatMap((row) => ('kind' in row ? [row.actorId, row.subjectId] : [row.actor]))));
  // The administrator reading the room follows each record link as themself: to the address their roles are served.
  const viewer = governance.recordHref && !governance.tenantAccounts ? (await grantsIn(owner, request, accountId)).roles : undefined;
  const person = (id: string) => ({ id, email: names.get(id) ?? null });
  const last = page.at(-1);
  send(response, 200, {
    ok: true,
    rows: page.map((row) => {
      if ('kind' in row)
        return {
          kind: 'access',
          id: row.id,
          at: row.iso,
          who: person(row.actorId),
          subject: person(row.subjectId),
          before: row.before,
          after: row.after,
        };
      const href = row.resource === null ? undefined : governance.recordHref?.(row.resource, row.key, viewer);
      return {
        id: row.id,
        at: row.at,
        who: person(row.actor),
        command: row.command,
        version: row.version,
        ...(row.tenant ? { tenant: row.tenant } : {}),
        ...(row.resource === null ? {} : { resource: row.resource }),
        ...(href ? { href } : {}),
        fields: row.fields,
        targets: row.targets,
        database: row.database,
      };
    }),
    ...(rows.length > PAGE && last ? { next: `${'kind' in last ? last.iso : last.at}~${last.id}` } : {}),
  });
  return true;
}

/**
 * A tenant App's accounts: the tenants the caller's administration grant
 * names, and one tenant's memberships within the roles it reaches. Every read
 * opens administration afresh, as the App's own screen does, so a grant
 * withdrawn closes the view at once. It changes nothing.
 */
async function tenantAccountsView(
  governance: ConsoleGovernance,
  accounts: ConsoleTenantAccounts,
  input: Readonly<{
    request: IncomingMessage;
    response: ServerResponse;
    url: URL;
    accountId: string;
  }>,
): Promise<boolean> {
  const { request, response, url, accountId } = input;
  const tenant = url.searchParams.get('tenant'),
    after = url.searchParams.get('after'),
    members = url.searchParams.get('members');
  if (
    (tenant !== null && !opaque(tenant, 128)) ||
    (after !== null && !opaque(after, 128)) ||
    (members !== null && (tenant === null || !opaque(members, 1024)))
  )
    return refuse(response, 400, 'invalid_request');
  let session;
  try {
    session = await accounts.open(request, accountId);
  } catch {
    return refuse(response, 503, 'unavailable');
  }
  if (!session) return refuse(response, 403, 'not_granted');
  const owner = { expectedAccount: accountId, context: session.context };
  let page: AdministrationTenantPage;
  try {
    page = await accounts.tenants(request, {
      ...owner,
      ...(after === null ? {} : { after }),
      limit: PAGE,
    });
  } catch {
    return refuse(response, 503, 'unavailable');
  }
  let chosen: AdministrationMembershipPage | undefined;
  if (tenant !== null) {
    // Each operation's page holds only the roles that operation reaches: the first one the grant answers is read.
    for (const operation of MEMBERSHIP_OPERATIONS) {
      chosen = await accounts
        .memberships(request, {
          ...owner,
          tenantId: tenant,
          operation,
          ...(members === null ? {} : { after: members }),
          limit: PAGE,
        })
        .catch(() => undefined);
      if (chosen) break;
    }
    // A tenant the grant does not reach and one that is not there are told alike.
    if (!chosen) return refuse(response, 403, 'not_granted');
  }
  const names = await people(governance, chosen?.items.map((item) => item.accountId) ?? []);
  send(response, 200, {
    ok: true,
    tenants: page.items.map((target) => ({
      id: target.tenantId,
      ...(target.name ? { name: target.name } : {}),
      status: target.tenant?.status ?? null,
      // Whether its members can be read here: a grant may reach a tenant only to set its assistant.
      members: target.capabilities.some((capability) => (MEMBERSHIP_OPERATIONS as readonly string[]).includes(capability.operation)),
    })),
    ...(page.next ? { next: page.next } : {}),
    ...(chosen && tenant !== null
      ? {
          chosen: {
            id: tenant,
            members: chosen.items.map((item) => ({
              id: item.accountId,
              email: names.get(item.accountId) ?? null,
              status: item.status,
              roles: item.roles,
              validUntil: new Date(item.validUntil).toISOString(),
            })),
            ...(chosen.next ? { next: chosen.next } : {}),
          },
        }
      : {}),
    href: accounts.href,
    supportSessions: accounts.supportSessions,
    apiTokens: accounts.apiTokens,
  });
  return true;
}

/**
 * The command journal of each of an App's databases, read when asked, newest
 * first and merged: a receipt and its first target. A database with no
 * journal (an App that has run no command there) adds nothing; one that
 * cannot be opened fails the read, so a gap is never shown as quiet.
 */
export function consoleCommandAudit(
  appId: string,
  databases: () => readonly Readonly<{
    name: string;
    url: string | undefined;
  }>[],
): (query: ConsoleAuditQuery) => Promise<readonly ConsoleAuditRow[]> {
  return async (query) => {
    const [{ openMigrationDb, dialectOf }, { COMMAND_JOURNAL_TABLES: tables }] = await Promise.all([
      import('@mistriwork/engine/server/migrate/database.js'),
      import('../../adapters/commands/commandJournalSchema.js'),
    ]);
    const found: ConsoleAuditRow[] = [];
    for (const { name, url } of databases()) {
      if (url === undefined) continue;
      const dialect = dialectOf(url);
      // The journal is kept on SQLite and PostgreSQL only.
      if (dialect === 'mysql') continue;
      const table = (each: string) => runtimeTable(dialect, each);
      const db = await openMigrationDb(url, [], false);
      try {
        const present = await db.all(
          dialect === 'postgres'
            ? `SELECT 1 AS present FROM pg_catalog.pg_tables WHERE schemaname = '${runtimeRelation('postgres', tables.receipt).schema}' AND tablename = ?`
            : `SELECT 1 AS present FROM main.sqlite_schema WHERE type = 'table' AND name = ?`,
          [tables.receipt],
        );
        if (!present.length) continue;
        const where = ['r.app_id = ?'],
          params: unknown[] = [appId];
        const and = (clause: string, ...values: unknown[]) => {
          where.push(clause);
          params.push(...values);
        };
        if (query.actor !== undefined) and('r.actor_id = ?', query.actor);
        if (query.what !== undefined) and('(r.command_id = ? OR r.target = ?)', query.what, query.what);
        if (query.from !== undefined) and('r.completed_at >= ?', query.from);
        if (query.to !== undefined) and('r.completed_at < ?', query.to);
        if (query.before)
          and('(r.completed_at < ? OR (r.completed_at = ? AND r.id < ?))', query.before.at, query.before.at, query.before.id);
        const rows = await db.all<{
          id: string;
          at: string;
          actor: string;
          command: string;
          version: number | string;
          tenant: string;
          target: string | null;
          keys_json: string | null;
          changes_json: string | null;
        }>(
          `SELECT r.id AS id, ${dialect === 'postgres' ? `to_char(r.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` : 'r.completed_at'} AS at,
            r.actor_id AS actor, r.command_id AS command, r.command_version AS version,
            r.tenant_id AS tenant, r.target AS target, r.keys_json AS keys_json, r.changes_json AS changes_json
          FROM ${table(tables.receipt)} r
          WHERE ${where.join(' AND ')}
          ORDER BY r.completed_at DESC, r.id DESC LIMIT ${Math.max(1, Math.min(query.limit, 500))}`,
          params,
        );
        for (const row of rows) {
          const parse = (text: string | null): unknown => {
            try {
              return text === null ? null : JSON.parse(text);
            } catch {
              return null;
            }
          };
          // Each target's key and changes are kept as texts, in request order: the first is shown, with how many there are.
          const list = (text: string | null): unknown[] => {
            const parsed = parse(text);
            return Array.isArray(parsed) ? parsed : [];
          };
          const keys = list(row.keys_json);
          const changes = parse(typeof list(row.changes_json)[0] === 'string' ? (list(row.changes_json)[0] as string) : null);
          found.push(
            Object.freeze({
              id: row.id,
              at: row.at,
              actor: row.actor,
              command: row.command,
              version: Number(row.version),
              tenant: row.tenant || null,
              resource: row.target,
              key: parse(typeof keys[0] === 'string' ? keys[0] : null),
              // The names of what changed, never the values.
              fields: Object.freeze(changes && typeof changes === 'object' && !Array.isArray(changes) ? Object.keys(changes).sort() : []),
              targets: keys.length,
              database: name,
            }),
          );
        }
      } finally {
        await db.close().catch(() => {});
      }
    }
    return found.sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.at < b.at ? 1 : -1)).slice(0, query.limit);
  };
}
