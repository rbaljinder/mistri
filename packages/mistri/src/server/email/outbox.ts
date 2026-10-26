/**
 * The email outbox's sender: notices that are emailed as well (`notify` with
 * `email: true`, and mentions under such a rule) leave the store after their
 * write has committed, never from inside it.
 *
 * The notice and its row in the outbox are written in the triggering write's
 * own transaction (adapters/inbox/inboxMail.ts), so the queue is exactly the
 * writes that committed. This loop claims due rows, one App at a time, and
 * for each asks what the inbox asks when the notice is read, of a reader it
 * builds for the recipient: the address must be an account of the App (a
 * column holding someone's email is not permission to mail them), the
 * account must not have turned email off, and the record must be one its
 * grants may read now — or, in a row-policy App, one the policy gives that
 * account now — or the row is dropped unsent. The words are the
 * inbox's words for that reader: the title only while they may read every
 * column it was filled from.
 *
 * A send that fails is tried again later — a minute, then twice as long each
 * time, up to an hour — and after eight attempts, or at once when the server
 * refused the message for good, the row is kept as `failed` with the reason,
 * for an operator. None of this reaches the write: it committed long ago.
 *
 * The loop is the `--jobs` host's shape (jobHost.ts): a setTimeout chain,
 * never two cycles at a time, a second's wait after an idle cycle growing to
 * half a minute, and a write in this process that queues mail wakes it.
 */
import { asBackgroundWork } from '@mistriwork/engine/adapters/writeLanes.js';
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { onMailQueued, type InboxMailStore, type MailOutcome, type QueuedMail } from '../../adapters/inbox/inboxMail.js';
import { storesOf } from '../stores/appStores.js';
import { grantsByRole, isRowPolicyApp, resolveAppAccess, type AppDef, type AppFormView } from '../../shared/app.js';
import { appKeepsInbox } from '../../shared/appNotify.js';
import { recordSegments } from '../../shared/appAddress.js';
import { noticeLines, recipientLocale } from './noticeBody.js';
import { INBOX_SEGMENT } from '../../shared/appAddress.js';
import { NO_MOUNT, outward, type AddressMount } from '@mistriwork/engine/shared/mount.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { AppHost } from '../app/apps.js';
import { appRoutes } from '../app/apps.js';
import { loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import { AppAccessDenied, authorizeResources } from '../app/appAccess.js';
import { httpPolicyReads, type HttpAppPolicy } from '../policy/appPolicyHttp.js';
import { appEntrypoint } from '../app/appEntrypoint.js';
import { nativeMailAccount } from '../auth/authAccounts.js';
import { appInboxConnection, ensureAppInbox, noticeForReader } from '../inbox.js';
import { nextIdleWait } from '../jobs/jobHost.js';
import { EmailFailure, type EmailTransport } from './email.js';

/** An address's account: its id and roles. */
export interface MailAccount {
  id: string;
  roles: readonly string[];
}

interface OutboxOptions {
  registry: Registry;
  /** The Apps served now: re-read each cycle, so a reload's rules are the ones that apply. */
  hosts: () => readonly AppHost[];
  transport: EmailTransport;
  /** The public origin a message's link starts with. */
  baseURL: string;
  /** Where the Apps are served and under what path (shared/mount.ts): a link is said as the browser will read it. */
  mount?: () => AddressMount;
  /** Who an address signs in as. Defaults to the App's own sign-in store. */
  account?: (host: AppHost, email: string) => Promise<MailAccount | null>;
  /** A row-policy App's policy as served now: the recipient's rows are the ones it gives their account. */
  policy?: (host: AppHost) => HttpAppPolicy | undefined;
  now?: () => number;
  idleMs?: number;
  maxIdleMs?: number;
  /** Where the loop's own failures are said; never a message's words. */
  warn?: (message: string) => void;
}

export interface OutboxTally {
  sent: number;
  skipped: number;
  retried: number;
  failed: number;
}

export const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 8;
export const BATCH = 20;
/** The wait before attempt n + 1: a minute, doubling, at most an hour. */
export const retryDelay = (attempts: number) => Math.min(3_600_000, 60_000 * 2 ** Math.max(0, attempts - 1));

const holdsMail = (adapter: unknown): adapter is { inboxMail(): InboxMailStore } =>
  typeof adapter === 'object' && adapter !== null && typeof (adapter as { inboxMail?: unknown }).inboxMail === 'function';

/** Whether an App's rules email anyone: then its server needs an email service. */
export function appSendsEmail(app: AppDef): boolean {
  return appKeepsInbox(app) && Object.values(app.resources ?? {}).some((resource) => resource.notify?.some((rule) => rule.email));
}

/** What of an App mails someone: its notify rules, a status check's step-up, a form's address proof. */
function mailingParts(app: AppDef): string[] {
  const parts = appSendsEmail(app) ? ['a notify rule says email: true'] : [];
  for (const [key, view] of Object.entries(app.views)) {
    const form = view as AppFormView;
    if (form.statusCheck?.stepUp) parts.push(`form "${key}" declares a status check stepUp`);
    if (form.link?.email?.verified) parts.push(`form "${key}" proves the applicant's email with a code`);
  }
  return parts;
}

/** Refuse at startup what cannot be served: mail with no email service. */
export function emailProblems(app: AppDef, hasTransport: boolean): string | undefined {
  const parts = mailingParts(app);
  if (parts.length && !hasTransport)
    return `${app.name}: ${parts[0]}, and this server has no email service. Add one to the config file: { "name": "mail", "kind": "email", "url": "smtps://…" or "log:", "from": "…" }.`;
  return undefined;
}

const defaultAccount = async (host: AppHost, email: string): Promise<MailAccount | null> => {
  if (!host.auth) return null;
  const found = await nativeMailAccount(host.auth, email);
  return found ? { id: found.id, roles: found.roles } : null;
};

/** The recipient's reader: their grants over the App's catalog, as a request of theirs would read. */
async function readerFor(
  registry: Registry,
  app: AppDef,
  entry: string,
  roles: readonly string[],
  lease: (owner: string) => void,
): Promise<{ adapter: Adapter; schema: DatabaseSchema }> {
  const resources = await loadAppRuntimeResources(registry, app, entry, lease);
  const grant = resolveAppAccess(app, resources.schema, roles);
  const scoped = grantsByRole(app) || grant.fields ? authorizeResources(resources, grant) : resources;
  return { adapter: scoped.adapter, schema: scoped.schema };
}

/** The message: the notice's words, a link to the record, and how to stop. `place`: the tenant it happened in,
    named, for a person who is a member of several (tenant/tenantNoticeMail.ts). */
export function messageOf(
  app: AppDef,
  link: string,
  title: string,
  by: string,
  place?: string,
  /** The recipient's locale (noticeBody.ts recipientLocale): the lines around the title are said in it. */
  locale?: string,
): { subject: string; text: string } {
  const lines = noticeLines(locale);
  return {
    subject: title,
    text: [
      title,
      '',
      ...(place ? [lines.place(place)] : []),
      ...(by ? [lines.by(by)] : []),
      lines.open(link),
      '',
      lines.why(app.name),
    ].join('\n'),
  };
}

export function createEmailOutbox(options: OutboxOptions) {
  const now = options.now ?? Date.now;
  const account = options.account ?? defaultAccount;
  const idleMs = options.idleMs ?? 1_000,
    maxIdleMs = options.maxIdleMs ?? 30_000;
  const warn = options.warn ?? ((message) => console.error(`mistri: ${message}`));
  const base = options.baseURL.replace(/\/+$/, '');

  async function deliver(host: AppHost, store: InboxMailStore, mail: QueuedMail, entry: string): Promise<keyof OutboxTally> {
    const { app } = host.app;
    const releases: Array<() => void> = [];
    let outcome: MailOutcome;
    try {
      const person = await account(host, mail.recipient);
      if (!person || (await store.emailOff(app.id, mail.recipient))) outcome = { kind: 'skipped' };
      else {
        const tell = async (reader: { adapter: Adapter; schema: DatabaseSchema }) => {
          const told = await noticeForReader(app, reader.adapter, reader.schema, {
            id: mail.notice,
            resource: mail.resource,
            key: mail.key,
            uses: mail.uses,
            title: mail.title,
          });
          if (!told) return undefined;
          let segments: string[] | undefined;
          try {
            /* The address the recipient's browser says: the first view showing the table among the views their
               roles are served (appRoutes), not the whole App's — a technician's repair is /repairs/12, a
               resident's the same record at /my-requests/12. None of theirs is their notifications. */
            segments = recordSegments(appRoutes(host.app, reader.schema, undefined, person.roles), mail.resource, { key: told.key });
          } catch {
            segments = undefined;
          }
          const locale = await recipientLocale(app, reader.schema, (request) => reader.adapter.query(request), mail.recipient);
          return { title: told.title, segments, locale };
        };
        let told: Awaited<ReturnType<typeof tell>>;
        if (isRowPolicyApp(app)) {
          /* The policy is asked for this account as a session of theirs would ask it, and its
             answer is read now: a record it no longer gives them is not mailed. Not served yet
             (a reload between policies) is a send tried again, not a recipient refused. */
          const policy = options.policy?.(host);
          if (!policy) throw new Error('the row policy is not served yet.');
          try {
            told = await policy.withAccount({ id: person.id, who: mail.recipient, role: person.roles.join(',') }, (context) =>
              tell({ adapter: httpPolicyReads(context).adapter, schema: context.schema }),
            );
          } catch (error) {
            if (!(error instanceof AppAccessDenied)) throw error;
            told = undefined;
          }
        } else
          told = await tell(
            await readerFor(options.registry, app, entry, person.roles, (owner) => releases.push(options.registry.lease(owner))),
          );
        if (!told) outcome = { kind: 'skipped' };
        else {
          const link = `${base}${outward(options.mount?.() ?? NO_MOUNT, `/${encodeURIComponent(app.id)}/${(told.segments ?? [INBOX_SEGMENT]).join('/')}`)}`;
          await options.transport.send({ to: mail.recipient, ...messageOf(app, link, told.title, mail.actorName, undefined, told.locale) });
          outcome = { kind: 'sent' };
        }
      }
    } catch (error) {
      outcome = unsent(error, mail, now(), warn, app.id);
    } finally {
      for (const release of releases.reverse()) release();
    }
    await store.settleMail(mail, outcome);
    return tallied(outcome);
  }

  /** One pass over every served App that emails: what was due, sent or settled. */
  async function drainOnce(): Promise<OutboxTally> {
    const tally: OutboxTally = { sent: 0, skipped: 0, retried: 0, failed: 0 };
    for (const host of options.hosts()) {
      if (!appSendsEmail(host.app.app) || host.unavailable) continue;
      await ensureAppInbox(options.registry, host);
      const connection = appInboxConnection(options.registry, host.app.app.id);
      const entry = appEntrypoint(host, options.registry);
      if (!connection || !entry) continue;
      const { adapter } = await options.registry.open(connection);
      const stores = storesOf(adapter);
      if (!holdsMail(stores)) continue;
      const store = stores.inboxMail();
      const at = now();
      const due = await store.claimMail(host.app.app.id, new Date(at).toISOString(), new Date(at + LEASE_MS).toISOString(), BATCH);
      for (const mail of due) tally[await deliver(host, store, mail, entry)] += 1;
    }
    return tally;
  }

  return mailLoop(drainOnce, { idleMs, maxIdleMs, warn, what: 'the email outbox' });
}

/** What became of a send that threw: tried again later, or kept as failed once refused for good or past the attempts. */
export function unsent(
  error: unknown,
  mail: Pick<QueuedMail, 'attempts'>,
  at: number,
  warn: (message: string) => void,
  app: string,
): MailOutcome {
  const reason = error instanceof Error ? error.message : 'the message could not be sent.';
  const permanent = error instanceof EmailFailure && error.permanent;
  const outcome: MailOutcome =
    permanent || mail.attempts + 1 >= MAX_ATTEMPTS
      ? { kind: 'failed', error: reason }
      : { kind: 'retry', at: new Date(at + retryDelay(mail.attempts + 1)).toISOString(), error: reason };
  warn(`email for a notice of "${app}" ${outcome.kind === 'failed' ? 'failed for good' : 'will be tried again'}: ${reason}`);
  return outcome;
}

export const tallied = (outcome: MailOutcome): keyof OutboxTally =>
  outcome.kind === 'sent' ? 'sent' : outcome.kind === 'skipped' ? 'skipped' : outcome.kind === 'retry' ? 'retried' : 'failed';

/** The loop around one pass (the header's shape), shared with a tenant App's sender (tenant/tenantNoticeMail.ts). */
export function mailLoop(
  drain: () => Promise<OutboxTally>,
  options: { idleMs: number; maxIdleMs: number; warn: (message: string) => void; what: string },
) {
  const { idleMs, maxIdleMs, warn } = options;
  const runOnce = () => asBackgroundWork(drain);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<boolean> | undefined;
  let stopping = false,
    started = false;
  let waited: number | undefined;
  let unlisten: (() => void) | undefined;
  const cycle = (): Promise<boolean> =>
    (active ??= runOnce()
      .then(
        (tally) => tally.sent + tally.skipped + tally.retried + tally.failed > 0,
        (error) => {
          warn(`${options.what}: ${(error as Error).message}`);
          return false;
        },
      )
      .finally(() => {
        active = undefined;
      }));
  const schedule = (delay: number) => {
    if (stopping) return;
    waited = delay;
    timer = setTimeout(() => {
      timer = undefined;
      void cycle().then((worked) => schedule(nextIdleWait(waited, worked, idleMs, maxIdleMs)));
    }, delay);
    timer.unref?.();
  };
  const wake = () => {
    if (!started || stopping) return;
    if (!timer) {
      waited = 0;
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    schedule(50);
    waited = 0;
  };
  return Object.freeze({
    runOnce,
    start() {
      if (started || stopping) return;
      started = true;
      unlisten = onMailQueued(wake);
      schedule(0);
    },
    async stop() {
      stopping = true;
      unlisten?.();
      if (timer) clearTimeout(timer);
      await active;
    },
  });
}
