/**
 * A command's effects: what it asks of a system outside its database once it
 * has committed. Two things: a JSON POST to a webhook the operator configured
 * (`"kind": "webhook"` in the config file), and a message on an integration's
 * channel (`send('sms', …)`: integrations/integrationChannels.ts
 * says what core decides before it goes). On a tenant App each is delivered
 * as the tenant it was written for.
 *
 *   effects: { notifyDealer: post('dealer-hooks', output => ({ applicationId: output.applicationId })) }
 *
 * An effect rides the command's events. Each is captured at definition as an
 * event the platform owns, `effect.<name>` version 1, whose one field, `body`,
 * is the projection of the validated output. So it is written in the
 * command's own transaction beside its receipt — nothing is sent unless the
 * command commits, and a replay writes nothing again — and delivered by event
 * delivery: a lease, an attempt budget, backoff, `failed`, and redrive from
 * @mistriwork/mistri/maintenance. The webhook's answer is its status alone: its body
 * is never read, and nothing it says reaches a transaction. A system that
 * has something to report calls a command.
 */
import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import type { CommandEventEnvelope, CommandEventJson } from '../../adapters/events/commandEventTypes.js';
import { HttpSourceError } from '@mistriwork/engine/adapters/http/egress.js';
import type { EventPublicationTransport } from '../events/eventPublisher.js';
import { defineOpaqueEvent, defineEventProjection, type BusinessEventOutput, type BusinessEventProjection } from './businessEvents.js';

declare const effectType: unique symbol;

/** A JSON object: what a webhook receives as the effect's `payload`. */
export type EffectPayload = { readonly [key: string]: CommandEventJson };

/** What `post` returns: an effect, captured when the command is defined. */
export interface CommandEffect<Output> {
  readonly destination: string;
  readonly [effectType]: (output: Output) => void;
}

/** The platform's event name prefix for effects; no command event may use it. */
export const EFFECT_EVENT_PREFIX = 'effect.';
/** How many effects one command may declare; they share the event batch's limits. */
const MAX_EFFECTS = 8;
/* A webhook connection's name: what `post` names and the config file declares. */
export const WEBHOOK_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const EFFECT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

interface DeclaredEffect {
  destination: string;
  project: (output: unknown) => unknown;
  /** `envelope: false`: the body is the projection itself, and `headers` ride with each call. */
  bare?: { headers?: (output: unknown) => unknown };
}
const declared = new WeakMap<object, DeclaredEffect>();

/** What `post` may be told beyond the projection. */
export interface PostOptions<Output> {
  /** false: the POST's body is the projection itself, not the `{ effect, command, receipt, occurredAt, payload }`
   * envelope — what an incoming-webhook URL such as Slack's expects. */
  readonly envelope: false;
  /** Headers for this call, from the output (a provider's Idempotency-Key, say). Only with `envelope: false`. */
  readonly headers?: (output: BusinessEventOutput<Output>) => Readonly<Record<string, string>>;
}

/**
 * One POST of the projected output to the webhook named `destination`, after
 * the command commits. `project` receives the validated output, as an event
 * projection does, and returns a JSON object. By default it is sent inside
 * the platform's envelope; `{ envelope: false }` sends the projection alone.
 */
export function post<Output>(
  destination: string,
  project: (output: BusinessEventOutput<Output>) => EffectPayload,
  options?: PostOptions<Output>,
): CommandEffect<Output> {
  if (typeof destination !== 'string' || !WEBHOOK_NAME.test(destination)) {
    throw new TypeError('post() names a webhook connection: letters, digits, underscores and hyphens, starting with a letter.');
  }
  if (typeof project !== 'function' || isProxy(project)) throw new TypeError('post() takes a function from the output to a JSON object.');
  let bare: DeclaredEffect['bare'];
  if (options !== undefined) {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      isProxy(options) ||
      Object.keys(options).some((key) => key !== 'envelope' && key !== 'headers')
    ) {
      throw new TypeError('post() options are { envelope: false, headers? }.');
    }
    if (options.envelope !== false) throw new TypeError('post() option envelope is false, or left out for the default envelope.');
    const headers = options.headers;
    if (headers !== undefined && (typeof headers !== 'function' || isProxy(headers)))
      throw new TypeError('post() option headers is a function from the output to a map of header names and values.');
    bare = Object.freeze(headers ? { headers: (output: unknown) => Reflect.apply(headers, undefined, [output]) } : {});
  }
  const effect = Object.freeze({ destination });
  declared.set(effect, { destination, project: (output) => Reflect.apply(project, undefined, [output]), ...(bare ? { bare } : {}) });
  return effect as CommandEffect<Output>;
}

/** What a channel message's projection returns: who it goes to, what it says, and whether they agreed to hear it. */
export interface ChannelMessageProjection {
  /** The recipient's address on the channel: a phone number in E.164 for SMS. */
  readonly to: string;
  readonly text: string;
  /** Whether the App holds the recipient's consent to be sent this (a box they ticked, a reply they sent).
      Without it nothing is sent, unless they opted in on the channel itself (a "START"). */
  readonly consent: boolean;
  /** The recipient's IANA time zone, which their quiet hours are read in; the App's own when left out. */
  readonly timezone?: string;
}
/** The effect destination a channel's messages go to; no webhook may be named so. */
export const CHANNEL_DESTINATION_PREFIX = 'channel:';
const CHANNEL_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * One message on an integration's channel (`sms`), after the command
 * commits. Core checks the recipient's opt-out and the message's consent and
 * holds it through quiet hours before the integration ever sees it; every
 * outcome is recorded in the integrations store's message log.
 */
export function send<Output>(
  channel: string,
  project: (output: BusinessEventOutput<Output>) => ChannelMessageProjection,
): CommandEffect<Output> {
  if (typeof channel !== 'string' || !CHANNEL_NAME.test(channel) || channel === 'email')
    throw new TypeError(
      "send() names an integration's channel in lowercase letters, digits and hyphens: send('sms', …). Email is notify's.",
    );
  if (typeof project !== 'function' || isProxy(project))
    throw new TypeError('send() takes a function from the output to { to, text, consent }.');
  const destination = `${CHANNEL_DESTINATION_PREFIX}${channel}`;
  const effect = Object.freeze({ destination });
  declared.set(effect, { destination, project: (output) => channelBody(Reflect.apply(project, undefined, [output])) });
  return effect as CommandEffect<Output>;
}

/* A channel message as the event records it: checked when the command projects it, again when it is delivered. */
export function channelBody(value: unknown): EffectPayload {
  const message = value as Partial<ChannelMessageProjection> | null;
  if (!message || typeof message !== 'object' || Array.isArray(message) || isProxy(message))
    throw new TypeError('A channel message is { to, text, consent, timezone? }.');
  const keys = Object.keys(message);
  if (keys.some((key) => !['to', 'text', 'consent', 'timezone'].includes(key)))
    throw new TypeError('A channel message is { to, text, consent, timezone? }.');
  if (typeof message.to !== 'string' || !message.to.trim() || message.to.length > 320)
    throw new TypeError("A channel message's to is the recipient's address.");
  if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 2000)
    throw new TypeError("A channel message's text is from 1 to 2,000 characters.");
  if (typeof message.consent !== 'boolean')
    throw new TypeError("A channel message says whether the App holds the recipient's consent: consent: true.");
  if (message.timezone !== undefined && (typeof message.timezone !== 'string' || message.timezone.length > 64))
    throw new TypeError("A channel message's timezone is an IANA zone.");
  return {
    to: message.to.trim(),
    text: message.text,
    consent: message.consent,
    ...(message.timezone === undefined ? {} : { timezone: message.timezone }),
  };
}

/* A header a call may add: RFC 9110's token and a visible value, as the webhook's
   own are. The request owns the rest (webhooks.ts); the Idempotency-Key is the one a call may replace. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const OWNED_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'accept',
  'connection',
  'transfer-encoding',
  'cookie',
  'authorization',
]);
const MAX_HEADERS = 8;
/** A call's own headers, checked: what an effect's `headers` and a workflow's `w.call` may add. `credential` is the
 * connection's own auth header (an `x-api-key`), which the request owns as it owns authorization. Throws TypeError. */
export function callHeaders(value: unknown, credential?: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value))
    throw new TypeError("An effect's headers are an object of header names and values.");
  const entries = Object.entries(value);
  if (entries.length > MAX_HEADERS) throw new TypeError(`An effect sends at most ${MAX_HEADERS} headers.`);
  const headers: Record<string, string> = {};
  for (const [name, text] of entries) {
    if (
      !HEADER_NAME.test(name) ||
      OWNED_HEADERS.has(name.toLowerCase()) ||
      name.toLowerCase() === credential ||
      typeof text !== 'string' ||
      !text ||
      text.length > 512 ||
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f]/.test(text)
    ) {
      throw new TypeError("An effect's headers are names and visible values the request does not own.");
    }
    headers[name.toLowerCase()] = text;
  }
  return headers;
}

/** What a command's effects were captured as: event projections, and which webhook each goes to. */
export interface CapturedEffects {
  /** Event slots, `effect-<name>`, to join the command's own. */
  readonly slots: Readonly<Record<string, BusinessEventProjection<unknown>>>;
  /** Each effect's name and destination, in declaration order. */
  readonly targets: readonly Readonly<{ name: string; destination: string }>[];
}

/* A body is a JSON object of JSON values; the event's own bounds do the rest. */
function parseBody(value: unknown): { body: EffectPayload } {
  const body = (value as { body?: unknown })?.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError("An effect's payload is a JSON object.");
  return { body: body as EffectPayload };
}
/* A bare effect's payload: the body, its call headers and the mark that says it is bare. */
function parseBare(value: unknown, credential?: string): { body: EffectPayload; headers: Record<string, string>; bare: true } {
  const { body } = parseBody(value);
  const headers = callHeaders((value as { headers?: unknown }).headers, credential);
  return { body, headers, bare: true };
}

/** Capture `effects` at definition. Throws a TypeError naming what is wrong. */
export function captureCommandEffects(effects: unknown): CapturedEffects {
  if (
    !effects ||
    typeof effects !== 'object' ||
    Array.isArray(effects) ||
    isProxy(effects) ||
    Object.getPrototypeOf(effects) !== Object.prototype
  )
    throw new TypeError('effects is an object of named post(...) effects.');
  const entries = Object.entries(effects);
  if (!entries.length || entries.length > MAX_EFFECTS) throw new TypeError(`effects names from 1 to ${MAX_EFFECTS} effects.`);
  const slots: Record<string, BusinessEventProjection<unknown>> = {};
  const targets: Array<Readonly<{ name: string; destination: string }>> = [];
  for (const [name, effect] of entries) {
    if (!EFFECT_NAME.test(name))
      throw new TypeError(`effect "${name}" needs a name of letters, digits and underscores, starting with a letter.`);
    const captured = effect && typeof effect === 'object' ? declared.get(effect) : undefined;
    if (!captured) throw new TypeError(`effect "${name}" is not a post(...) or send(...) effect.`);
    const bare = captured.bare;
    if (bare) {
      const event = defineOpaqueEvent<{ body: EffectPayload; headers: Record<string, string>; bare: true }>(
        `${EFFECT_EVENT_PREFIX}${name}`,
        ['body', 'headers', 'bare'],
        { parse: parseBare },
      );
      slots[`effect-${name}`] = defineEventProjection(event, (output) => ({
        body: captured.project(output) as EffectPayload,
        headers: callHeaders(bare.headers ? bare.headers(output) : {}),
        bare: true as const,
      }));
    } else {
      const event = defineOpaqueEvent<{ body: EffectPayload }>(`${EFFECT_EVENT_PREFIX}${name}`, ['body'], { parse: parseBody });
      slots[`effect-${name}`] = defineEventProjection(event, (output) => ({ body: captured.project(output) as EffectPayload }));
    }
    targets.push(Object.freeze({ name, destination: captured.destination }));
  }
  return Object.freeze({ slots: Object.freeze(slots), targets: Object.freeze(targets) });
}

/** The key a webhook deduplicates by: one per receipt and effect, whatever the attempt. */
export function effectIdempotencyKey(receiptId: string, effect: string): string {
  return createHash('sha256').update(`mistri.effect\n${receiptId}\n${effect}`).digest('hex');
}

/** What a webhook POST receives. */
export interface EffectRequest {
  /** The tenant whose command it was, on a tenant App; absent on an App without tenants. */
  readonly tenant?: string;
  readonly effect: string;
  readonly command: string;
  readonly receipt: string;
  readonly occurredAt: string;
  readonly payload: EffectPayload;
}

/** A webhook connection, opened: one POST, answering its status alone.
 * A bare effect sends its projection as the body, with the headers its call named. */
export interface Webhook {
  /** The connection's own auth header, lowercased, when it is not authorization: a call may never set it. */
  readonly credentialHeader?: string;
  post(body: EffectRequest | EffectPayload, idempotencyKey: string, headers?: Readonly<Record<string, string>>): Promise<number>;
  /** A workflow's `w.call`: one request under the connection's address and credential, answering its status and, for a 2xx, its JSON. */
  call?(
    request: Readonly<{
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      path: string;
      body?: unknown;
      headers?: Readonly<Record<string, string>>;
    }>,
    idempotencyKey: string,
  ): Promise<Readonly<{ status: number; json: unknown }>>;
}

/**
 * One webhook destination's transport. A receipt's other facts reach this
 * destination too; it sends only the effects routed to it, by command and
 * name, and accepts the rest unsent. A 2xx is accepted; a 4xx other than 408
 * and 429 is rejected; anything else, and a failure to reach the webhook, is
 * unknown. Both are asked again after backoff, as any event destination's are,
 * and fail once the attempts are spent, for an operator to redrive.
 */
export function webhookTransport(options: Readonly<{ webhook: Webhook; routed: ReadonlySet<string> }>): EventPublicationTransport {
  const { webhook, routed } = options;
  return async (publication) => {
    const envelope: CommandEventEnvelope = publication.envelope;
    if (!envelope.name.startsWith(EFFECT_EVENT_PREFIX) || !routed.has(`${envelope.commandId}\n${envelope.name}`)) return 'accepted';
    const effect = envelope.name.slice(EFFECT_EVENT_PREFIX.length);
    let body: EffectRequest | EffectPayload;
    let headers: Record<string, string> | undefined;
    try {
      const payload = JSON.parse(envelope.payloadJson) as { bare?: unknown };
      // The connection's credential header is checked here, where the connection is known; the command could not.
      if (payload.bare === true) ({ body, headers } = parseBare(payload, webhook.credentialHeader));
      else
        body = Object.freeze({
          ...(envelope.tenantId === undefined ? {} : { tenant: envelope.tenantId }),
          effect,
          command: envelope.commandId,
          receipt: envelope.receiptId,
          occurredAt: envelope.occurredAt,
          payload: parseBody(payload).body,
        });
    } catch {
      return 'rejected';
    }
    let status: number;
    try {
      status = await webhook.post(body, effectIdempotencyKey(envelope.receiptId, effect), headers);
    } catch (error) {
      // A refused address or a redirect will be refused again: the operator changes the connection, then redrives.
      if (error instanceof HttpSourceError && (error.reason === 'refused' || error.reason === 'redirect')) return 'rejected';
      throw error;
    }
    if (status >= 200 && status <= 299) return 'accepted';
    if (status >= 400 && status <= 499 && status !== 408 && status !== 429) return 'rejected';
    throw new Error(`The webhook answered ${status}.`);
  };
}
