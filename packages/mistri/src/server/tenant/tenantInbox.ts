/**
 * Notifications on a tenant App: its `notify` rules, bound to the deployment's
 * own private writer, and the inbox each notice is kept in.
 *
 * The capture is the ordinary one (adapters/inbox/inbox.ts), beneath the
 * tenant writer's scoped transactions, so a notice is written with the write
 * that sends it, whichever realm or principal made that write. What is the
 * tenant's here is the inbox: a notice about a tenant-owned record is kept in
 * that tenant's inbox (`tenantInbox`), named by the owner read off the record
 * in the write's own transaction; one about a platform-owned record is kept
 * in the platform realm's, the App's own. An inbox is read and marked only on
 * a lease, as the lease's account, in the lease's own inbox — a member's
 * tenant, never one a request names — and each notice is shown only while its
 * record is one that lease can read (server/inbox.ts).
 *
 * So one person in two tenants reads each tenant's notices in that tenant's
 * tab, and the platform realm's inbox holds the notices about its own
 * records: a notice about a tenant's record is that tenant's.
 * What a rule reads to find its recipient and its words stays on its own side
 * of the realm boundary: a tenant table's rule reads tenant and shared tables,
 * a platform table's reads platform and shared ones.
 *
 * A person here is a row per membership, holding the account's id (`auth.me`,
 * which `me` reads too). A rule that reaches one — a reference to a person, an
 * @mention — tells that account at its email, which `members` reads from the
 * sign-in store, and only while the account is an active member of the tenant
 * the notice is kept in (the platform realm, for a platform record). The id
 * is the tenant's own data; the membership is not, so a person row naming
 * someone else's account tells nobody.
 *
 * A rule with `email: true` queues a row in the outbox beside the notice, in
 * the same transaction and the same inbox; the host's sender mails it after
 * the commit, as the recipient's own membership of that inbox's tenant
 * (tenantNoticeMail.ts).
 */
import {
  InboxUnavailable,
  mentionTables,
  physicalMentions,
  physicalSend,
  tenantInbox,
  type NoticeBinding,
  type NoticeMembers,
  type NoticePath,
  type NoticeRule,
} from '../../adapters/inbox/inbox.js';
import { bindNotices } from '../stores/writeCaptures.js';
import { storesOf } from '../stores/appStores.js';
import type { AppDef } from '../../shared/app.js';
import { appKeepsInbox, appNotifyRules, notifyRulePaths, type NotifyPath } from '../../shared/appNotify.js';
import { PLATFORM_TENANT_ID } from './tenantPlatform.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';
import type { TenantReadSource } from './tenantReadSource.js';
import { tenantIdentifier } from '@mistriwork/engine/server/evidence.js';
import { contactEmailWording, noticeWords } from '../app/noticeWords.js';
import { findTable } from '@mistriwork/engine/shared/schema.js';

/** The App's notify rules, by the physical table the writer is asked it by, each tenant-owned table's with its owner.
    `members`: an account's email while it is a member where a notice is kept; absent, a person tells nobody. */
export function tenantNoticeBinding(
  app: AppDef,
  ownership: TenantOwnershipSnapshot,
  members?: NoticeMembers,
  /** A tenant's default locale (its branding's `locale`), for a recipient whose own row names none. */
  tenantLocale?: (tenant: string) => Promise<string | undefined>,
): NoticeBinding {
  const binding = new Map<string, NoticeRule[]>();
  if (!appKeepsInbox(app)) return binding;
  const { rules, problems } = appNotifyRules(app, ownership.schema);
  if (problems.length) throw new Error(problems[0]);
  const physical = (table: string) => {
    const id = ownership.resources[table];
    if (id === undefined) throw new Error(`notify: "${table}" is not one of this tenant App's own tables.`);
    return id;
  };
  for (const [resource, compiled] of rules) {
    const owner = ownership.ownership[resource];
    if (!owner || owner.kind === 'global')
      throw new Error(`resources "${resource}", notify: a shared resource is written by nobody, so it tells nobody.`);
    /* A tenant's record is told of from what that tenant and the shared tables
       hold, and a platform record from the platform's: a recipient or a word
       read from across the realm boundary would carry it across. */
    /* A mention finds its person, a team and its members on the same side:
       a tenant's record mentions that tenant's people, read among its own rows. */
    const crossing = compiled
      .flatMap(notifyRulePaths)
      .flatMap((path) => path.hops)
      .concat(
        compiled.flatMap((rule) =>
          mentionTables(rule.mentions).map((table) => ({
            table,
            key: '',
            column: '',
          })),
        ),
      )
      .find((hop) => {
        const kind = ownership.ownership[hop.table]?.kind;
        return kind !== 'global' && kind !== owner.kind;
      });
    if (crossing) {
      throw new Error(
        `resources "${resource}", notify: it reads "${crossing.table}", which is the ${owner.kind === 'tenant' ? "platform's" : "tenants'"}; ` +
          "a notice reads what its own record's side of the tenancy holds.",
      );
    }
    const path = (logical: NotifyPath): NoticePath => ({
      column: logical.column,
      hops: logical.hops.map((hop) => ({
        table: physical(hop.table),
        key: hop.key,
        column: hop.column,
      })),
      ...(logical.account ? { account: true as const } : {}),
    });
    const columns = new Set(findTable(ownership.schema, resource)?.columns.map((column) => column.name) ?? []);
    binding.set(
      physical(resource),
      compiled.map((rule) =>
        Object.freeze({
          app: app.id,
          on: rule.on,
          ...(rule.when ? { when: rule.when } : {}),
          to: rule.to.map(path),
          title: rule.title.map((part) => (typeof part === 'string' || 'message' in part ? part : path(part))),
          ...(rule.say
            ? (() => {
                const said = noticeWords(
                  app,
                  rule.say.message,
                  rule.say.args.map((arg) => ({
                    name: arg.name,
                    path: path(arg.path),
                  })),
                  {
                    schema: ownership.schema,
                    physical,
                    ...(tenantLocale ? { tenantLocale } : {}),
                  },
                );
                return said ? { say: said } : {};
              })()
            : {}),
          open: rule.open,
          uses: rule.uses,
          ...(rule.email ? { email: true as const } : {}),
          ...(rule.mentions
            ? {
                mentions: physicalMentions(rule.mentions, physical, (table) => {
                  const own = ownership.ownership[table];
                  return own?.kind === 'tenant' ? own.column : undefined;
                }),
              }
            : {}),
          /* Mail to an address the record holds reads as it does without tenants: why the recipient gets it, and the
             address a visitor proved in a form, the one a visitor's write may mail. */
          ...(rule.send
            ? {
                send: physicalSend(rule.send, path, contactEmailWording(app, resource, columns)),
              }
            : {}),
          ...(owner.kind === 'tenant' ? { owner: owner.column } : {}),
          ...(members && (rule.mentions?.account || rule.to.some((each) => each.account)) ? { members } : {}),
        }),
      ),
    );
  }
  return binding;
}

interface InboxStoreAdapter {
  inboxReady(): Promise<boolean>;
}

/**
 * Attest the store on the deployment's writer and bind the rules to it, once,
 * before the writer is published. A database without the store refuses
 * startup, naming the call that provisions it.
 */
export async function bindTenantInboxStore(
  /* The deployment's writer: a dialect adapter, whose App stores answer (stores/appStores.ts), or a store that answers itself. */
  adapter: object,
  binding: NoticeBinding,
  dialect: 'sqlite' | 'postgres',
): Promise<void> {
  if (!binding.size) return;
  if (!(await (storesOf(adapter) as InboxStoreAdapter).inboxReady())) {
    const call = `provisionStores({ ${dialect === 'sqlite' ? 'sqlite: path' : 'postgres: url'} }, { only: ['inbox'] })`;
    throw new InboxUnavailable(
      `This tenant App's resources notify people, and its database holds no notification store. ` +
        `It is provisioned once, never on startup: run ${call} from @mistriwork/mistri/maintenance against the App's own database, then start again.`,
    );
  }
  bindNotices(adapter, binding);
}

/** The inbox a lease reads: its tenant's, or the platform realm's own (`@platform`, or no tenant). */
export function leaseInbox(appId: string, tenantId: string | undefined): string {
  return tenantId === undefined || tenantId === PLATFORM_TENANT_ID ? appId : tenantInbox(appId, tenantId);
}

/**
 * A tenant App's `members` (tenantNoticeBinding): an account's email, read
 * from the sign-in store, while the account holds an active membership of
 * the tenant the notice is kept in — or of the platform realm, for a
 * platform record — on the deployment's discovery reader, never the lease's.
 * An id the store would refuse to look up names nobody.
 */
export function tenantNoticeMembers(input: {
  readonly appId: string;
  readonly source: TenantOwnershipSnapshot['source'];
  readonly deployment: string;
  readonly now: () => number;
  /** The reader that answers membership; opened after the writer, so read when a write is told. */
  readonly reader: () => Pick<TenantReadSource, 'readMembership' | 'readPlatformMembership'> | undefined;
  readonly accountEmail: (accountId: string) => Promise<string | null>;
}): NoticeMembers {
  return async (account, tenant) => {
    const reader = input.reader();
    if (!reader) return undefined;
    try {
      tenantIdentifier(account, 1024);
      if (tenant !== undefined) tenantIdentifier(tenant);
    } catch {
      return undefined;
    }
    const lookup = {
      appId: input.appId,
      accountId: account,
      source: input.source,
      deployment: input.deployment,
    };
    const member =
      tenant === undefined
        ? await reader
            .readPlatformMembership({ realm: 'platform', ...lookup })
            .then((record) => record?.platformStatus === 'active' && record)
        : await reader.readMembership({ ...lookup, tenantId: tenant }).then((record) => record?.tenantStatus === 'active' && record);
    if (!member || member.status !== 'active' || input.now() >= member.validUntil) return undefined;
    return (await input.accountEmail(account)) ?? undefined;
  };
}
