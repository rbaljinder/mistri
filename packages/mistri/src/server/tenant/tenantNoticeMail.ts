/**
 * A tenant App's notices that are emailed as well (`notify` with `email:
 * true`): the server's outbox (email/outbox.ts) over the deployment's own
 * store, each message read as its recipient.
 *
 * A notice's outbox row is written with the notice, in the write's own
 * transaction, in the inbox the notice is kept in: the tenant's whose record
 * it is, or the platform realm's (tenantInbox.ts). A pass finds the inboxes
 * with a row due, names each one's tenant among the tenants active now, and
 * asks of every row what that inbox's lease asks of a request of the
 * recipient's own: the address must be an account of the App's sign-in
 * store, the runtime must admit that account's membership of that tenant
 * (the admission a browser's lease takes, so a removed or suspended member
 * is admitted nowhere), the person must not have turned email off in that
 * inbox, and the record must be one their grants there read now. The words
 * are the inbox's words for that reader. Anything less drops the row unsent:
 * an inbox whose tenant is not active, an address no member holds. Nothing
 * here reads as the platform: each read is the recipient's, in the one
 * tenant the row was kept for.
 *
 * The link opens the record in that tenant (`?tenant=`, or `?realm=platform`):
 * a hint the chooser checks against the session's own memberships, never a
 * grant. Retries, failures and the loop are the outbox's.
 */
import { tenantInbox } from '../../adapters/inbox/inbox.js';
import type { InboxMailStore, MailOutcome, QueuedMail } from '../../adapters/inbox/inboxMail.js';
import { INBOX_SEGMENT, recordSegments } from '../../shared/appAddress.js';
import { NO_MOUNT, outward, type AddressMount } from '@mistriwork/engine/shared/mount.js';
import { appRoutes, type LoadedApp } from '../app/apps.js';
import type { EmailTransport } from '../email/email.js';
import { BATCH, LEASE_MS, mailLoop, messageOf, tallied, unsent, type OutboxTally } from '../email/outbox.js';
import { TenantContextError, TenantUnavailableError } from '@mistriwork/engine/server/evidence.js';
import { noticeForReader } from '../inbox.js';
import { canonicalLocale } from '@mistriwork/engine/shared/appLocale.js';
import { createTenantApiRequest } from './tenantApiRequest.js';
import { readAdapter } from './tenantHttp.js';
import type { TenantNames } from './tenantNames.js';
import type { PlatformReadContext } from './tenantPlatformReadRuntime.js';
import type { TenantReadContext } from './tenantReadRuntime.js';
import { tenantServedSchema } from './tenantServedSchema.js';

/** What of the enrolled deployment the sender uses: its reads as a request, and the outbox beside its inbox. */
interface NoticeMailDeployment<Request> {
  withContext<T>(request: Request, selectors: readonly string[], run: (context: TenantReadContext) => T | Promise<T>): Promise<T>;
  withPlatformContext<T>(request: Request, run: (context: PlatformReadContext) => T | Promise<T>): Promise<T>;
  readonly platform: boolean;
  readonly inbox: { inboxMail(): InboxMailStore; tenants(): Promise<readonly string[]> };
}

interface TenantNoticeMailOptions<Request> {
  loaded: Pick<LoadedApp, 'app' | 'pages'>;
  deployment: NoticeMailDeployment<Request>;
  /** Who an address signs in as, read again each time the runtime asks; null for no account of this App. */
  account: (email: string) => Promise<{ id: string } | null>;
  transport: EmailTransport;
  /** The public origin a message's link starts with. */
  baseURL: string;
  mount?: AddressMount;
  /** What a person calls a tenant, for the line that says where it happened. */
  names?: TenantNames;
  now?: () => number;
  idleMs?: number;
  maxIdleMs?: number;
  warn?: (message: string) => void;
}

const skipped: MailOutcome = { kind: 'skipped' };

export function openTenantNoticeMail<Request>(options: TenantNoticeMailOptions<Request>) {
  const { app } = options.loaded;
  const { deployment } = options;
  const now = options.now ?? Date.now;
  const warn = options.warn ?? ((message) => console.error(`mistri: ${message}`));
  const base = options.baseURL.replace(/\/+$/, '');
  /* The request is the recipient's membership as it stands: every role the App
     declares, narrowed by the runtime to the ones that membership holds. */
  const roles = Object.keys(app.auth?.roles ?? {});

  async function deliver(store: InboxMailStore, mail: QueuedMail, tenantId: string | undefined): Promise<keyof OutboxTally> {
    let outcome: MailOutcome;
    try {
      const person = await options.account(mail.recipient);
      if (!person || (await store.emailOff(mail.app, mail.recipient))) outcome = skipped;
      else {
        const request = createTenantApiRequest(async () => {
          const again = await options.account(mail.recipient);
          if (again?.id !== person.id) throw new Error('The address is no longer this account.');
          return { id: person.id, who: mail.recipient };
        }, roles) as Request;
        const realm = tenantId === undefined ? 'platform' : 'tenant';
        const tell = async (context: TenantReadContext | PlatformReadContext) => {
          const schema = tenantServedSchema(context, app, new Date(now()), mail.recipient);
          const told = await noticeForReader(app, readAdapter(context), schema, {
            id: mail.notice,
            resource: mail.resource,
            key: mail.key,
            uses: mail.uses,
            title: mail.title,
          });
          if (!told) return undefined;
          let segments: string[] | undefined;
          try {
            /* The address this member's browser says: under the views their roles in this context are served. */
            segments = recordSegments(appRoutes(options.loaded as LoadedApp, schema, realm, context.principal.roles), mail.resource, {
              key: told.key,
            });
          } catch {
            segments = undefined;
          }
          /* The member's own locale as a request of theirs reads it (tenantReadRuntime.ts), for the lines around the title. */
          return { title: told.title, segments, locale: context.locale };
        };
        let told: Awaited<ReturnType<typeof tell>>;
        try {
          told =
            tenantId === undefined
              ? await deployment.withPlatformContext(request, tell)
              : await deployment.withContext(request, [tenantId], tell);
        } catch (error) {
          // A store that could not answer is asked again; a membership the runtime refuses is no reader.
          if (!(error instanceof TenantContextError) || error instanceof TenantUnavailableError) throw error;
          told = undefined;
        }
        if (!told) outcome = skipped;
        else {
          const path = `/${encodeURIComponent(app.id)}/${(told.segments ?? [INBOX_SEGMENT]).join('/')}`;
          const selector = tenantId === undefined ? 'realm=platform' : `tenant=${encodeURIComponent(tenantId)}`;
          const link = `${base}${outward(options.mount ?? NO_MOUNT, path)}?${selector}`;
          let place: string | undefined;
          if (tenantId !== undefined && options.names) {
            try {
              place = (await options.names([tenantId]))[tenantId];
            } catch {
              place = undefined;
            }
          }
          await options.transport.send({
            to: mail.recipient,
            ...messageOf(app, link, told.title, mail.actorName, place, told.locale ?? canonicalLocale(app.ui.locale)),
          });
          outcome = { kind: 'sent' };
        }
      }
    } catch (error) {
      outcome = unsent(error, mail, now(), warn, app.id);
    }
    await store.settleMail(mail, outcome);
    return tallied(outcome);
  }

  /** One pass: every inbox of this App with a row due, each named to its tenant. */
  async function drainOnce(): Promise<OutboxTally> {
    const tally: OutboxTally = { sent: 0, skipped: 0, retried: 0, failed: 0 };
    const store = deployment.inbox.inboxMail();
    const at = now();
    const due = await store.dueInboxes(app.id, new Date(at).toISOString());
    if (!due.length) return tally;
    const tenants = new Map<string, string>();
    if (due.some((inbox) => inbox !== app.id))
      for (const tenant of await deployment.inbox.tenants()) tenants.set(tenantInbox(app.id, tenant), tenant);
    for (const inbox of due) {
      const platform = inbox === app.id;
      const tenantId = platform ? undefined : tenants.get(inbox);
      const claimed = await store.claimMail(inbox, new Date(at).toISOString(), new Date(at + LEASE_MS).toISOString(), BATCH);
      for (const mail of claimed) {
        // An inbox no active tenant names, or the platform realm's where this deployment serves none: nobody reads it now.
        if ((platform && !deployment.platform) || (!platform && tenantId === undefined)) {
          await store.settleMail(mail, skipped);
          tally.skipped += 1;
        } else tally[await deliver(store, mail, tenantId)] += 1;
      }
    }
    return tally;
  }

  return mailLoop(drainOnce, {
    idleMs: options.idleMs ?? 1_000,
    maxIdleMs: options.maxIdleMs ?? 30_000,
    warn,
    what: 'the email outbox',
  });
}
