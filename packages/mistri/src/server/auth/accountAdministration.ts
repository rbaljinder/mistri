/**
 * Account administration, the server's side: the accounts of an App that
 * signs people in, their roles, and whether each may sign in, changed by an
 * administrator from the App's own screen rather than by hand against Better
 * Auth's admin endpoints.
 *
 * Every call goes through Better Auth's admin API with the request's own
 * headers, so its admin plugin judges the session a second time: the route
 * in front (http/accountRoutes.ts) has already refused anyone who is not an
 * administrator, and this layer never acts on a session Better Auth would
 * not. What it adds is what the plugin does not know: the roles this App
 * hands out, the administrator never locking themself out, and the audit:
 * every change runs in one transaction of the auth store with a row of the
 * account-administration trail (accountAudit.ts) naming who changed whom,
 * how, and through which session, so a change whose row cannot be written is
 * not made. After it commits, the same fact is one line in the server's log.
 * A deactivation also writes who did it into the account's own ban reason.
 */
import type { IncomingMessage } from 'node:http';
import {
  ADMIN_ROLE,
  ACCOUNTS_PAGE,
  PASSWORD_MAX,
  PASSWORD_MIN,
  rolesOf,
  type AccountAuditPage,
  type AccountChange,
  type AccountSummary,
  type AccountsPage,
} from '../../shared/accountAdministration.js';
import type { AccountAuditStore, AccountAuditWrite } from './accountAudit.js';

/** The slice of Better Auth's admin API this calls. */
export interface AccountAdminApi {
  listUsers(input: {
    headers: Headers;
    query: {
      limit: number;
      offset: number;
      sortBy: string;
      sortDirection: 'asc';
      searchValue?: string;
      searchField?: 'email';
      searchOperator?: 'contains';
      filterField?: 'role';
      filterValue?: string;
      filterOperator?: 'contains';
    };
  }): Promise<unknown>;
  getUser(input: { headers: Headers; query: { id: string } }): Promise<unknown>;
  createUser(input: {
    headers: Headers;
    body: { email: string; name: string; role: string[]; password?: string; data?: { emailVerified: true } };
  }): Promise<unknown>;
  setRole(input: { headers: Headers; body: { userId: string; role: string[] } }): Promise<unknown>;
  banUser(input: { headers: Headers; body: { userId: string; banReason: string } }): Promise<unknown>;
  unbanUser(input: { headers: Headers; body: { userId: string } }): Promise<unknown>;
  setUserPassword(input: { headers: Headers; body: { userId: string; newPassword: string } }): Promise<unknown>;
  revokeUserSessions(input: { headers: Headers; body: { userId: string } }): Promise<unknown>;
  getSession(input: { headers: Headers; query: { disableCookieCache: true } }): Promise<{
    user?: { id?: unknown };
    session?: { impersonatedBy?: unknown };
  } | null>;
}

/** A refusal the screen can say: its status and a sentence naming no stored value but the one given. */
export class AccountAdminRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AccountAdminRefusal';
  }
}

/** What the auth runtime offers the route: the same, read from the request's own headers. */
export interface AccountAdministrationRuntime {
  list(req: IncomingMessage, options: { search?: string; offset?: number }, roles: readonly string[]): Promise<AccountsPage>;
  change(
    req: IncomingMessage,
    actor: { id: string; who: string },
    change: AccountChange,
    roles: readonly string[],
  ): Promise<AccountSummary>;
  trail(options: { offset?: number; accountId?: string }): Promise<AccountAuditPage>;
}

export interface AccountAdministration {
  list(headers: Headers, options: { search?: string; offset?: number }, roles: readonly string[]): Promise<AccountsPage>;
  change(headers: Headers, actor: { id: string; who: string }, change: AccountChange, roles: readonly string[]): Promise<AccountSummary>;
  trail(options: { offset?: number; accountId?: string }): Promise<AccountAuditPage>;
}

const refuse = (status: number, message: string): never => {
  throw new AccountAdminRefusal(status, message);
};

/* The stored user, as Better Auth's admin API returns it: only these fields leave the server. */
function summary(value: unknown): AccountSummary {
  const user = value && typeof value === 'object' && 'user' in value && !('email' in value) ? (value as { user: unknown }).user : value;
  if (!user || typeof user !== 'object') throw new Error('Invalid account data');
  const u = user as Record<string, unknown>;
  if (typeof u.id !== 'string' || typeof u.email !== 'string') throw new Error('Invalid account data');
  const created = u.createdAt instanceof Date ? u.createdAt.toISOString() : typeof u.createdAt === 'string' ? u.createdAt : undefined;
  return {
    id: u.id,
    name: typeof u.name === 'string' ? u.name : '',
    email: u.email,
    roles: rolesOf(u.role),
    active: u.banned !== true && u.banned !== 1,
    ...(created ? { createdAt: created } : {}),
  };
}

/** A person's name as a line of text: trimmed, 1 to 120 characters, no control characters. */
function nameOf(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 120 || /[\p{Cc}]/u.test(name)) refuse(400, 'Enter a name between 1 and 120 characters.');
  return name;
}

function emailOf(value: unknown): string {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) refuse(400, 'Enter an email address like name@example.com.');
  return email;
}

function passwordOf(value: unknown): string {
  if (typeof value !== 'string' || value.length < PASSWORD_MIN || value.length > PASSWORD_MAX) {
    refuse(400, `A password is ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`);
  }
  return value as string;
}

/** A nonempty list of the App's roles, each once. */
function rolesFor(value: unknown, offered: readonly string[]): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 32 || value.some((role) => typeof role !== 'string')) {
    refuse(400, 'Choose at least one role.');
  }
  const roles = [...new Set(value as string[])];
  const unknown = roles.find((role) => !offered.includes(role));
  if (unknown !== undefined) refuse(400, `"${unknown.slice(0, 64)}" is not a role of this App. Its roles: ${offered.join(', ')}.`);
  return roles;
}

/** The one line a committed change leaves in the server's log. */
function log(actor: string, what: string): void {
  console.log(`mistri: accounts: ${actor} ${what}`);
}

const pageFrom = (offset: unknown) =>
  Number.isSafeInteger(offset) && (offset as number) >= 0 && (offset as number) <= 1_000_000 ? (offset as number) : 0;

export function createAccountAdministration(
  api: AccountAdminApi,
  options: {
    passwords: boolean;
    audit: AccountAuditStore;
    /** Ends the account's API tokens and OAuth grants (accountApiTokens.ts), by the actor. */
    revokeTokens?: (accountId: string, by: string) => Promise<void>;
  },
): AccountAdministration {
  const { audit } = options;
  /* Who is asking, as the store has it now: the actor's own session, or an
     administrator's impersonation of them. Read inside the transaction. */
  const principalOf = async (headers: Headers, actor: { id: string }): Promise<string> => {
    const got = await api.getSession({ headers, query: { disableCookieCache: true } });
    if (!got?.user || got.user.id !== actor.id) refuse(403, 'Only an administrator manages accounts.');
    const by = got!.session?.impersonatedBy;
    return typeof by === 'string' && by ? `impersonation:${by}` : 'session';
  };
  const find = async (headers: Headers, id: unknown): Promise<AccountSummary> => {
    if (typeof id !== 'string' || !id.length || id.length > 1024) refuse(400, 'Choose an account.');
    let found: unknown;
    try {
      found = await api.getUser({ headers, query: { id: id as string } });
    } catch {
      refuse(404, 'That account was not found.');
    }
    return summary(found);
  };
  /** The active accounts that hold the administrator role, as the store has them now. */
  const administrators = async (headers: Headers): Promise<string[]> => {
    const found: string[] = [];
    // A page at a time, bounded: an App with thousands of administrators has bigger problems than this check.
    for (let offset = 0; offset < ACCOUNTS_PAGE * 50; offset += ACCOUNTS_PAGE) {
      const answer = (await api.listUsers({
        headers,
        query: {
          limit: ACCOUNTS_PAGE,
          offset,
          sortBy: 'email',
          sortDirection: 'asc',
          filterField: 'role',
          filterValue: ADMIN_ROLE,
          filterOperator: 'contains',
        },
      })) as { users?: unknown };
      if (!answer || !Array.isArray(answer.users)) throw new Error('Invalid account list');
      for (const user of answer.users) {
        const one = summary(user);
        if (one.active && one.roles.includes(ADMIN_ROLE)) found.push(one.id);
      }
      if (answer.users.length < ACCOUNTS_PAGE) break;
    }
    return found;
  };
  /* "There is always an administrator", for changes by two administrators at once: the other administrators' rows are
     locked (in a fixed order, so two changes cannot wait on each other) before they are counted, so a second change
     waits for the first to commit and then counts what it left. The check on one's own account alone cannot see that
     the other administrator is, in the same moment, being removed by this one's target. */
  const keepAnAdministrator = async (headers: Headers, leaving: string): Promise<void> => {
    await audit.lock([...(await administrators(headers))].sort());
    if (!(await administrators(headers)).some((id) => id !== leaving)) {
      refuse(409, 'That would leave no active administrator. Make another account an administrator first.');
    }
  };
  const administration: AccountAdministration = {
    async list(headers, { search, offset = 0 }, roles) {
      const from = pageFrom(offset);
      const text = typeof search === 'string' ? search.trim().slice(0, 254) : '';
      const answer = (await api.listUsers({
        headers,
        query: {
          limit: ACCOUNTS_PAGE,
          offset: from,
          sortBy: 'email',
          sortDirection: 'asc',
          ...(text ? { searchValue: text, searchField: 'email', searchOperator: 'contains' } : {}),
        },
      })) as { users?: unknown; total?: unknown };
      if (!answer || !Array.isArray(answer.users) || typeof answer.total !== 'number') throw new Error('Invalid account list');
      return { accounts: answer.users.map(summary), total: answer.total, offset: from, roles: [...roles], passwords: options.passwords };
    },

    async change(headers, actor, change, roles) {
      if (!change || typeof change !== 'object') refuse(400, 'Say what to change.');
      let line = '';
      const account = await audit.transaction(async () => {
        const principal = await principalOf(headers, actor);
        /* The change's row, in its transaction: only the fields it touched, and never a password. */
        const record = (row: Pick<AccountAuditWrite, 'targetId' | 'targetEmail' | 'before' | 'after'>) =>
          audit.write({ action: change.operation, actorId: actor.id, actorEmail: actor.who, principal, ...row });
        switch (change.operation) {
          case 'create': {
            const email = emailOf(change.email),
              name = nameOf(change.name),
              given = rolesFor(change.roles, roles);
            /* An App that signs in with a password gives the new account one to
               start with; one that signs in with GitHub or Google has none to give. */
            const password = options.passwords ? passwordOf(change.password) : undefined;
            if (!options.passwords && change.password !== undefined) refuse(400, 'This App signs people in without a password.');
            let made: unknown;
            try {
              /* The administrator named the address, as the operator names the first account's (auth.ts): it is
                 proven as far as this App can know, and nothing else would prove it — no link goes out for an
                 account nobody signed up for. Unproven under open sign-up, the account was nobody's `me` and
                 matched no row of a policy until a verification that never came (field report R2). */
              made = await api.createUser({
                headers,
                body: { email, name, role: given, ...(password ? { password } : {}), data: { emailVerified: true } },
              });
            } catch (error) {
              if (/exist/i.test((error as Error).message ?? '')) refuse(409, `An account for ${email} already exists.`);
              throw error;
            }
            const account = summary(made);
            await record({
              targetId: account.id,
              targetEmail: account.email,
              before: null,
              after: { email: account.email, name: account.name, roles: given, active: true },
            });
            line = `created ${account.email} with ${given.join(', ')}`;
            return account;
          }
          case 'setRoles': {
            const account = await find(headers, change.accountId),
              given = rolesFor(change.roles, roles);
            // The one account that cannot lose it: whoever is asking; and no change may leave the App with none (keepAnAdministrator).
            if (account.id === actor.id && !given.includes(ADMIN_ROLE))
              refuse(409, 'You cannot remove your own administrator role. Ask another administrator.');
            if (account.roles.includes(ADMIN_ROLE) && account.active && !given.includes(ADMIN_ROLE)) {
              await keepAnAdministrator(headers, account.id);
            }
            await api.setRole({ headers, body: { userId: account.id, role: given } });
            await record({ targetId: account.id, targetEmail: account.email, before: { roles: account.roles }, after: { roles: given } });
            line = `set the roles of ${account.email} to ${given.join(', ')} (were ${account.roles.join(', ') || 'none'})`;
            return { ...account, roles: given };
          }
          case 'deactivate': {
            const account = await find(headers, change.accountId);
            if (account.id === actor.id) refuse(409, 'You cannot deactivate your own account.');
            if (account.roles.includes(ADMIN_ROLE) && account.active) await keepAnAdministrator(headers, account.id);
            // Better Auth ends every session of a banned account; the reason says who, on the account itself.
            await api.banUser({ headers, body: { userId: account.id, banReason: `Deactivated by ${actor.who}` } });
            // A ban refuses its tokens while it lasts; revoked, they stay refused after a reactivation, as a directory's are.
            await options.revokeTokens?.(account.id, actor.id);
            await record({
              targetId: account.id,
              targetEmail: account.email,
              before: { active: account.active },
              after: { active: false },
            });
            line = `deactivated ${account.email}`;
            return { ...account, active: false };
          }
          case 'reactivate': {
            const account = await find(headers, change.accountId);
            await api.unbanUser({ headers, body: { userId: account.id } });
            await record({ targetId: account.id, targetEmail: account.email, before: { active: account.active }, after: { active: true } });
            line = `reactivated ${account.email}`;
            return { ...account, active: true };
          }
          case 'setPassword': {
            if (!options.passwords) refuse(400, 'This App signs people in without a password.');
            const account = await find(headers, change.accountId),
              password = passwordOf(change.password);
            await api.setUserPassword({ headers, body: { userId: account.id, newPassword: password } });
            // Whoever held the old password may hold a session; a reset ends them, as the reset link does.
            const others = account.id !== actor.id;
            if (others) {
              await api.revokeUserSessions({ headers, body: { userId: account.id } });
              await options.revokeTokens?.(account.id, actor.id);
            }
            // That a password was set, and whether sessions ended: nothing of the password itself.
            await record({
              targetId: account.id,
              targetEmail: account.email,
              before: null,
              after: { password: 'changed', sessionsEnded: others },
            });
            line = `set a new password for ${account.email}`;
            return account;
          }
          default:
            return refuse(400, 'That is not a change this screen makes.');
        }
      });
      log(actor.who, line);
      return account;
    },

    trail({ offset = 0, accountId }) {
      if (accountId !== undefined && (typeof accountId !== 'string' || !accountId.length || accountId.length > 1024))
        refuse(400, 'Choose an account.');
      return audit.read({ offset: pageFrom(offset), ...(accountId ? { accountId } : {}) });
    },
  };
  return Object.freeze(administration);
}
