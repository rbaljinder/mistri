/**
 * A channel that is not email (an integration's `channel`, such as SMS),
 * delivered as a command's `send(...)` effect: written beside the receipt,
 * sent after commit by event delivery, retried as any effect is. A `notify`
 * rule that sends on the channel is queued in its write's transaction instead
 * (the integrations store's message table) and decided by the loop below.
 *
 * Core decides whether a message may go before the integration sees it, in
 * this order, and logs every outcome in the integrations store's message
 * table — the inbox record an operator reads:
 *  1. the recipient opted out on this channel (a STOP the provider sent,
 *     recorded by the webhook): suppressed, `opted_out`;
 *  2. the App did not say it holds consent, and the recipient never opted
 *     in on the channel: suppressed, `no_consent`;
 *  3. it would arrive inside the App's quiet hours, in the recipient's zone
 *     when the message names one: held until they end, then sent by the
 *     host's loop, which asks 1 again first;
 *  4. otherwise it is sent, under the effect's idempotency key, which the
 *     provider dedupes a retried send by.
 * A send the package refuses (refuse(reason)) is recorded failed and not
 * tried again; one that fails otherwise is the delivery's to retry.
 *
 * Email is the one channel the platform sends itself (`send: { channel:
 * 'email' }`), through the config's email service, to an address a record
 * holds — someone who may have no account. Its order is 1 and 2 as above
 * (an unsubscribe link's opt-out is 1), then:
 *  3. the write was a public visitor's and the address is not one they
 *     proved with a code in the form: suppressed, `unproven`, so a form is
 *     no relay to whatever address someone types;
 *  4. the address had five of these emails in the last day, or the App sent
 *     five hundred in the last hour: suppressed, `rate_limited`. In a tenant
 *     App both count one tenant's mail, as its consent is one tenant's;
 *  5. otherwise it is sent: plain text, the title its subject, the reason
 *     the recipient gets it and the link that stops it at its foot, and the
 *     same link as its List-Unsubscribe header. No quiet hours: mail waits
 *     in an inbox.
 */
import { createHash } from 'node:crypto';
import { channelBody, effectIdempotencyKey, EFFECT_EVENT_PREFIX } from '../commands/commandEffects.js';
import { isBusinessCommandExecutionError } from '../commands/commandErrors.js';
import type { EventPublicationTransport } from '../events/eventPublisher.js';
import { QUEUED, type IntegrationStore, type MessageRow } from '../../adapters/integrations/integrationStore.js';
import { EMAIL_CHANNEL } from '../../adapters/inbox/inbox.js';
import { EmailFailure, type EmailTransport } from '../email/email.js';
import type { UnsubscribeClaim } from '../email/unsubscribe.js';
import { knownTimeZone, type CapturedIntegrations } from './integrationDeclaration.js';
import type { IntegrationRuntime } from './integrationRuntime.js';

/**
 * A recipient's address as consent is kept by: a digest, so the opt-out list
 * is not a list of numbers or addresses. Each channel says what one address
 * is: a phone number's spaces, dots, dashes and brackets are the same number
 * written another way, but `john.doe@` and `johndoe@` are two people, so an
 * email address is only trimmed and lowercased.
 */
export function channelHolder(address: string, channel: string): string {
  const same = address.trim().toLowerCase();
  return createHash('sha256')
    .update(`mistri.channel-holder.v1\n${channel === EMAIL_CHANNEL ? same : same.replace(/[\s().-]/g, '')}`)
    .digest('hex');
}

const MINUTE = 60_000;
/* A send that may pass is tried again a minute on, eight times in all, then recorded failed: on every channel. */
const SEND_ATTEMPTS = 8;
/** The minute of the day it is in a zone. */
function minuteIn(zone: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return value('hour') * 60 + value('minute');
}

/** When a message sent now may arrive: now, or the end of the quiet hours it would arrive in. */
export function quietUntil(quiet: CapturedIntegrations['quietHours'], zone: string | undefined, now: number): number {
  if (!quiet) return now;
  const minute = minuteIn(zone && knownTimeZone(zone) ? zone : quiet.timezone, now);
  const inside = quiet.from < quiet.to ? minute >= quiet.from && minute < quiet.to : minute >= quiet.from || minute < quiet.to;
  if (!inside) return now;
  const wait = (quiet.to - minute + 1440) % 1440;
  return now + wait * MINUTE - (now % MINUTE);
}

interface Message {
  readonly to: string;
  readonly text: string;
  readonly consent: boolean;
  readonly timezone?: string;
}

/** The channel's sender over a runtime: the delivery transport for its effects, and the loop that sends what quiet hours held. */
export function channelSender(runtime: IntegrationRuntime, channel: string) {
  const integration = [...runtime.declared.use.values()].find((candidate) => candidate.channel?.name === channel);
  const put = (row: MessageRow) => runtime.store.putMessage(row);

  /** Send one message now, if it may go: the row it leaves, and whether the delivery is done with it. */
  async function attempt(row: MessageRow, signal: AbortSignal): Promise<'accepted' | 'rejected'> {
    const consent = await runtime.store.consent(runtime.appId, row.tenant, channel, channelHolder(row.recipient, channel));
    if (consent?.state === 'out') {
      await put({
        ...row,
        state: 'suppressed',
        reason: 'opted_out',
        dueAt: null,
        at: runtime.now(),
      });
      return 'accepted';
    }
    if (!integration?.channel) {
      await put({
        ...row,
        state: 'failed',
        reason: 'no integration sends on this channel',
        dueAt: null,
        at: runtime.now(),
      });
      return 'rejected';
    }
    const secrets = await runtime.secrets(row.tenant, integration.name);
    if (!secrets) {
      await put({
        ...row,
        state: 'failed',
        reason: `${integration.name} is not set up`,
        dueAt: null,
        at: runtime.now(),
      });
      return 'rejected';
    }
    try {
      const sent = (await integration.channel.send(
        integration.client(secrets),
        Object.freeze({
          to: row.recipient,
          text: row.text,
          idempotencyKey: row.key,
        }),
        Object.freeze({ signal }),
      )) as { id?: unknown } | null;
      const id = typeof sent?.id === 'string' ? sent.id : null;
      await put({
        ...row,
        state: 'sent',
        reason: null,
        providerId: id,
        dueAt: null,
        attempts: row.attempts + 1,
        at: runtime.now(),
      });
      return 'accepted';
    } catch (error) {
      if (isBusinessCommandExecutionError(error)) {
        await put({
          ...row,
          state: 'failed',
          reason: error.reason ?? error.code,
          dueAt: null,
          attempts: row.attempts + 1,
          at: runtime.now(),
        });
        return 'rejected';
      }
      throw error;
    }
  }

  const transport =
    (routed: ReadonlySet<string>): EventPublicationTransport =>
    async (publication) => {
      const envelope = publication.envelope;
      if (!envelope.name.startsWith(EFFECT_EVENT_PREFIX) || !routed.has(`${envelope.commandId}\n${envelope.name}`)) return 'accepted';
      let message: Message;
      try {
        message = channelBody((JSON.parse(envelope.payloadJson) as { body?: unknown }).body) as unknown as Message;
      } catch {
        return 'rejected';
      }
      const key = effectIdempotencyKey(envelope.receiptId, envelope.name.slice(EFFECT_EVENT_PREFIX.length));
      const before = await runtime.store.message(runtime.appId, key);
      // Already decided: a redelivery after the outcome was written changes nothing.
      if (before && before.state !== 'failed') return 'accepted';
      const now = runtime.now();
      const row: MessageRow = before ?? {
        app: runtime.appId,
        key,
        tenant: envelope.tenantId ?? '',
        channel,
        recipient: message.to,
        text: message.text,
        state: 'held',
        reason: null,
        providerId: null,
        dueAt: null,
        attempts: 0,
        at: now,
      };
      return decide(row, message.consent, message.timezone, publication.signal);
    };

  /** Steps 1 to 3, then the send: a command's message as its delivery arrives, a queued notice as the loop finds it. */
  async function decide(
    row: MessageRow,
    consented: boolean,
    zone: string | undefined,
    signal: AbortSignal,
  ): Promise<'accepted' | 'rejected'> {
    const now = runtime.now();
    const consent = await runtime.store.consent(runtime.appId, row.tenant, channel, channelHolder(row.recipient, channel));
    if (consent?.state === 'out') {
      await put({
        ...row,
        state: 'suppressed',
        reason: 'opted_out',
        dueAt: null,
        at: now,
      });
      return 'accepted';
    }
    if (!consented && consent?.state !== 'in') {
      await put({
        ...row,
        state: 'suppressed',
        reason: 'no_consent',
        dueAt: null,
        at: now,
      });
      return 'accepted';
    }
    const due = quietUntil(runtime.declared.quietHours, zone, now);
    if (due > now) {
      await put({
        ...row,
        state: 'held',
        reason: 'quiet_hours',
        dueAt: due,
        at: now,
      });
      return 'accepted';
    }
    return attempt(row, signal);
  }

  /** Send what quiet hours held and is now due, and decide the notices writes queued, a page at a time. True when
      anything was sent or settled. */
  async function sendDue(): Promise<boolean> {
    const mine = await runtime.store.due(runtime.appId, runtime.now(), 32, channel);
    for (const row of mine) {
      try {
        const signal = AbortSignal.timeout(12_000);
        await (row.reason === QUEUED ? decide(row, row.consent === true, row.timezone ?? undefined, signal) : attempt(row, signal));
      } catch {
        /* A send that may pass is held again a minute on, and the next loop asks again: eight times in all, as
           email's, then it is recorded failed. Held without end, a message the provider never takes was tried
           every minute for good and read "held" to an operator, never "failed". */
        const attempts = row.attempts + 1;
        await put(
          attempts >= SEND_ATTEMPTS
            ? {
                ...row,
                state: 'failed',
                reason: `${integration?.name ?? channel} did not accept it`,
                dueAt: null,
                attempts,
                at: runtime.now(),
              }
            : { ...row, dueAt: runtime.now() + MINUTE, attempts, at: runtime.now() },
        );
      }
    }
    return mine.length > 0;
  }
  return Object.freeze({ transport, sendDue });
}

/** The email channel's caps: per address a day, per App an hour, counted from the messages it sent. */
export const EMAIL_LIMITS = Object.freeze({
  perAddress: 5,
  perAddressMs: 86_400_000,
  perApp: 500,
  perAppMs: 3_600_000,
});

/** The built-in email channel over an App's integrations store: the loop that decides and sends what its writes queued. */
export function emailChannelSender(
  options: Readonly<{
    appId: string;
    store: IntegrationStore;
    transport: EmailTransport;
    /** The address that stops this mail for its holder, absolute. */
    unsubscribe: (claim: UnsubscribeClaim) => string;
    now?: () => number;
  }>,
) {
  const { appId, store, transport } = options;
  const now = options.now ?? Date.now;
  const put = (row: MessageRow) => store.putMessage(row);

  /** Steps 1 to 5 for one queued message. */
  async function decide(row: MessageRow): Promise<void> {
    const at = now();
    const suppress = (reason: string) => put({ ...row, state: 'suppressed', reason, dueAt: null, at });
    const holder = channelHolder(row.recipient, EMAIL_CHANNEL);
    const consent = await store.consent(appId, row.tenant, EMAIL_CHANNEL, holder);
    if (consent?.state === 'out') return suppress('opted_out');
    if (row.consent !== true && consent?.state !== 'in') return suppress('no_consent');
    if (row.actorKind === 'public') return suppress('unproven');
    if (
      (await store.sentSince(appId, row.tenant, EMAIL_CHANNEL, at - EMAIL_LIMITS.perAddressMs, row.recipient)) >= EMAIL_LIMITS.perAddress ||
      (await store.sentSince(appId, row.tenant, EMAIL_CHANNEL, at - EMAIL_LIMITS.perAppMs)) >= EMAIL_LIMITS.perApp
    )
      return suppress('rate_limited');
    const link = options.unsubscribe({
      app: appId,
      tenant: row.tenant,
      channel: EMAIL_CHANNEL,
      holder,
    });
    const [subject] = row.text.split('\n', 1);
    try {
      await transport.send({
        to: row.recipient,
        subject,
        text: `${row.text}\n\nTo stop these emails: ${link}\n`,
        unsubscribe: link,
      });
    } catch (error) {
      if (error instanceof EmailFailure && error.permanent)
        return put({
          ...row,
          state: 'failed',
          reason: error.message,
          dueAt: null,
          attempts: row.attempts + 1,
          at: now(),
        });
      throw error;
    }
    await put({
      ...row,
      state: 'sent',
      reason: null,
      dueAt: null,
      attempts: row.attempts + 1,
      at: now(),
    });
  }

  /** Decide what the writes queued and is due, a page at a time. True when anything was settled. */
  async function sendDue(): Promise<boolean> {
    const due = await store.due(appId, now(), 32, EMAIL_CHANNEL);
    for (const row of due) {
      try {
        await decide(row);
      } catch {
        // A relay that may come back: a minute on, and the opt-out and the caps are asked again then.
        const attempts = row.attempts + 1;
        await put(
          attempts >= SEND_ATTEMPTS
            ? {
                ...row,
                state: 'failed',
                reason: 'the email service did not accept it',
                dueAt: null,
                attempts,
                at: now(),
              }
            : { ...row, dueAt: now() + MINUTE, attempts, at: now() },
        );
      }
    }
    return due.length > 0;
  }
  return Object.freeze({ sendDue });
}

/** The App's channels by effect destination (`channel:sms`), as the effect host asks for them. */
export function channelTransports(runtime: IntegrationRuntime) {
  const senders = new Map<string, ReturnType<typeof channelSender>>();
  for (const integration of runtime.declared.use.values())
    if (integration.channel) senders.set(integration.channel.name, channelSender(runtime, integration.channel.name));
  return Object.freeze({
    transport: (destination: string, routed: ReadonlySet<string>): EventPublicationTransport | undefined =>
      senders.get(destination.replace(/^channel:/, ''))?.transport(routed),
    async sendDue(): Promise<boolean> {
      let worked = false;
      for (const sender of senders.values()) if (await sender.sendDue()) worked = true;
      return worked;
    },
  });
}
