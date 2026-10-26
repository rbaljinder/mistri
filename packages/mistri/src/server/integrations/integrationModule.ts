/**
 * An integration, as a package declares it (`@mistriwork/mistri/integration`):
 * a vendor's API behind a fixed contract that core holds every App to.
 *
 *   defineIntegration({
 *     name: 'fakepay',
 *     secrets: ['apiKey', 'webhookSecret'],
 *     client: ({ secrets }) => new FakePay(secrets.apiKey),
 *     actions: { charge: { input, output, run: (client, input, { idempotencyKey }) => client.charge(input, idempotencyKey) } },
 *     webhooks: { verify: (delivery, { secrets, now }) => …, events: { paid: { type: 'charge.succeeded', payload } } },
 *     channel: { name: 'sms', send: (client, message) => client.sms(message) },
 *   })
 *
 * The package owns the vendor: its SDK, its request shapes, how its
 * signatures read. Core owns everything a vendor must never decide: where
 * the secrets live (sealed, per tenant, entered on a settings screen and
 * never in App source), the idempotency key every call carries and the
 * journal that records it, retries, the webhook endpoint and its replay
 * window, which command an event runs and as whom, and whether a message
 * may be sent at all (consent, opt-out, quiet hours). So a package is small
 * and cannot get any of those wrong, and core never imports a vendor SDK.
 *
 * Captured at definition, as commands are: the functions are taken once, the
 * shapes are checked to be shapes, and anything the contract does not name
 * is refused with the key it would have taken.
 */
import { isProxy } from 'node:util/types';
import { describeShape, type Shape, type ShapeOf } from '../commands/commandShapes.js';

declare const integrationType: unique symbol;
declare const actionTypes: unique symbol;

/** What a webhook request handed `verify`: its headers, lowercased, and its raw body, before any parsing. */
export interface IntegrationDelivery {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: Buffer;
}

/** One verified event: the provider's id for it (what a retry repeats), its type, when the provider sent it, and its data. */
export interface IntegrationEvent {
  readonly id: string;
  readonly type: string;
  /** When the provider says it sent this delivery, in milliseconds; core refuses one outside its window. */
  readonly at: number;
  readonly data: unknown;
}

/** One action: its input and output shapes, and the call. `run` throws refuse(reason) for a definite no; anything else is retried. */
export interface IntegrationActionDefinition<Client, In, Out> {
  readonly input: Shape<In>;
  readonly output: Shape<Out>;
  run(client: Client, input: In, call: Readonly<{ idempotencyKey: string; signal: AbortSignal }>): Out | Promise<Out>;
}

/** An event the provider sends, by the name the App maps: its type on the wire, and the payload a command receives as input. */
export interface IntegrationEventDefinition<Payload> {
  readonly type: string;
  readonly payload: Shape<Payload>;
  /** The payload field holding a recipient who opted out (an SMS "STOP"): core records it and sends that recipient nothing more. */
  readonly optOut?: string;
  /** The payload field holding a recipient who opted back in ("START"). */
  readonly optIn?: string;
}

/** One message on a channel, as core hands it to the package once consent, opt-out and quiet hours allowed it. */
export interface ChannelMessage {
  readonly to: string;
  readonly text: string;
  /** The same for every attempt at this message: the provider's dedupe key. */
  readonly idempotencyKey: string;
}

/** A way to reach a person that is not email: `send` delivers one message and answers the provider's id for it. */
export interface IntegrationChannelDefinition<Client> {
  /** The channel's name, as a command's `send(name, …)` effect says it: `sms`. */
  readonly name: string;
  send(
    client: Client,
    message: ChannelMessage,
    call: Readonly<{ signal: AbortSignal }>,
  ): Readonly<{ id: string }> | Promise<Readonly<{ id: string }>>;
}

/* What any action is, as the actions record is constrained: its shapes read as anything, its run takes what its input shape gives. */
type AnyAction<Client> = Readonly<{
  input: Shape<unknown>;
  output: Shape<unknown>;
  run(client: Client, input: never, call: Readonly<{ idempotencyKey: string; signal: AbortSignal }>): unknown;
}>;

/** What a package passes to defineIntegration. */
export interface IntegrationDefinition<
  Name extends string,
  Secret extends string,
  Client,
  Actions extends Readonly<Record<string, AnyAction<Client>>>,
  Events extends Readonly<Record<string, IntegrationEventDefinition<unknown>>>,
> {
  /** Lowercase letters, digits and hyphens: the webhook's address (`/api/inbound/<name>`) and the settings screen's heading. */
  readonly name: Name;
  /** The secrets a deployment enters on the settings screen, by name. Never in App source. */
  readonly secrets: readonly Secret[];
  /** The vendor client, made from one tenant's secrets when a call or a message needs it. */
  client(context: Readonly<{ secrets: Readonly<Record<Secret, string>> }>): Client;
  readonly actions?: Actions;
  readonly webhooks?: Readonly<{
    /** The provider's signature checked against the raw body: the event, or null for a delivery that does not verify. */
    verify(
      delivery: IntegrationDelivery,
      context: Readonly<{ secrets: Readonly<Record<Secret, string>>; now: number }>,
    ): IntegrationEvent | null;
    readonly events: Events;
  }>;
  readonly channel?: IntegrationChannelDefinition<Client>;
}

/** Each action's input and output, as its shapes read: what a command's call is typed by. */
type ActionTypes<Actions> = {
  readonly [K in keyof Actions]: Readonly<{ input: ActionShape<Actions[K], 'input'>; output: ActionShape<Actions[K], 'output'> }>;
};
type ActionShape<Action, Key extends 'input' | 'output'> = Action extends Readonly<Record<Key, infer S>> ? ShapeOf<S> : unknown;

/** What defineIntegration returns: the package's integration, as an App's jobs module lists it. */
export interface Integration<Name extends string = string, Actions = unknown> {
  readonly name: Name;
  readonly [integrationType]: true;
  /* Types only: never set. A command's call reads its input and output from here. */
  readonly [actionTypes]?: Actions;
}

/**
 * Each package's integration by its name, so a command's
 * `integrations.<name>.<action>(input)` is typed by the action's shapes. A
 * package registers its own, beside its factory:
 * `declare module '@mistriwork/mistri/integration' { interface IntegrationRegistry { fakepay: ReturnType<typeof fakepay> } }`.
 * One it does not register is still called, with its input and output unknown.
 */
// oxlint-disable-next-line no-empty-interface -- filled by each package's declaration merging
export interface IntegrationRegistry {}

type RegisteredActions<Name> = Name extends keyof IntegrationRegistry
  ? IntegrationRegistry[Name] extends Integration<string, infer Actions>
    ? Actions
    : undefined
  : undefined;
type Call<Name, Action> =
  RegisteredActions<Name> extends Readonly<Record<Action & string, Readonly<{ input: infer In; output: infer Out }>>>
    ? (input: In) => Promise<Out>
    : (input: unknown) => Promise<Readonly<Record<string, unknown>>>;

/** What a command declares it calls: `{ fakepay: ['charge'] }`. */
export type IntegrationUses = Readonly<Record<string, readonly string[]>>;

/** A registered integration's declared actions are among the ones it has; an unregistered one's are any names. */
export type IntegrationUsesGuard<Uses> = {
  readonly integrations?: {
    readonly [Name in keyof Uses]: RegisteredActions<Name> extends undefined
      ? Uses[Name]
      : readonly (keyof RegisteredActions<Name> & string)[];
  };
};

/** The calls a command's lookup makes: only the integrations and actions it declares, each typed by its package. */
export type IntegrationCallsOf<Uses> = {
  readonly [Name in keyof Uses]: {
    readonly [Action in Uses[Name] extends readonly (infer Each)[] ? Each & string : never]: Call<Name, Action>;
  };
};

/** One action as core holds it. */
interface CapturedAction {
  readonly input: Shape<unknown>;
  readonly output: Shape<unknown>;
  run(client: unknown, input: unknown, call: Readonly<{ idempotencyKey: string; signal: AbortSignal }>): unknown;
}

/** The integration as core holds it once captured. */
export interface CapturedIntegration {
  readonly name: string;
  readonly secrets: readonly string[];
  client(secrets: Readonly<Record<string, string>>): unknown;
  readonly actions: ReadonlyMap<string, CapturedAction>;
  readonly webhooks?: Readonly<{
    verify(delivery: IntegrationDelivery, context: Readonly<{ secrets: Readonly<Record<string, string>>; now: number }>): unknown;
    readonly events: ReadonlyMap<string, Readonly<{ type: string; payload: Shape<unknown>; optOut?: string; optIn?: string }>>;
  }>;
  readonly channel?: Readonly<{
    name: string;
    send(client: unknown, message: ChannelMessage, call: Readonly<{ signal: AbortSignal }>): unknown;
  }>;
}

export class IntegrationDeclarationError extends Error {
  readonly code = 'invalid-integration';
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationDeclarationError';
  }
}
const fail = (message: string): never => {
  throw new IntegrationDeclarationError(message);
};

/** A name core puts in a path and a table row. */
export const INTEGRATION_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const MEMBER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SECRET = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const EVENT_TYPE = /^[\x21-\x7e]{1,128}$/;

const captured = new WeakMap<object, CapturedIntegration>();

function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return fail(`${where} must be a plain object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return fail(`${where} must not inherit configuration.`);
  return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, where: string, required: readonly string[], optional: readonly string[] = []): void {
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${where} needs "${key}".`);
  for (const key of Object.keys(value))
    if (!required.includes(key) && !optional.includes(key))
      fail(`${where} has no "${key}". It takes: ${[...required, ...optional].join(', ')}.`);
}
function fn<T extends (...args: never[]) => unknown>(value: unknown, where: string): T {
  if (typeof value !== 'function' || isProxy(value)) return fail(`${where} must be a function.`);
  const taken = value as (...args: unknown[]) => unknown;
  return ((...args: unknown[]) => Reflect.apply(taken, undefined, args)) as unknown as T;
}
function shapeOf(value: unknown, where: string): Shape<unknown> {
  if (!value || (typeof value !== 'object' && typeof value !== 'function') || typeof (value as Shape<unknown>).parse !== 'function')
    return fail(`${where} must be a shape from @mistriwork/mistri/integration (shape, text, int, …).`);
  return value as Shape<unknown>;
}
/* An event's payload is a command's input, so it is an object of named fields: the check reads them by name. */
function objectShape(value: unknown, where: string): Shape<unknown> {
  const taken = shapeOf(value, where);
  if (describeShape(taken).kind !== 'object') fail(`${where} must be shape({ … }): a command takes it as its input, field by field.`);
  return taken;
}

/**
 * Capture a package's integration. Throws an IntegrationDeclarationError
 * naming what is wrong; the result is what an App's jobs module lists.
 */
export function defineIntegration<
  const Name extends string,
  const Secret extends string,
  Client,
  const Actions extends Readonly<Record<string, AnyAction<Client>>>,
  const Events extends Readonly<Record<string, IntegrationEventDefinition<unknown>>>,
>(definition: IntegrationDefinition<Name, Secret, Client, Actions, Events>): Integration<Name, ActionTypes<Actions>> {
  const value = record(definition, 'An integration');
  only(value, 'An integration', ['name', 'secrets', 'client'], ['actions', 'webhooks', 'channel']);
  const name = value.name;
  if (typeof name !== 'string' || !INTEGRATION_NAME.test(name))
    fail('An integration is named in lowercase letters, digits and hyphens, starting with a letter, at most 40: name: "fakepay".');
  const where = `Integration "${name as string}"`;
  const secrets = value.secrets;
  if (
    !Array.isArray(secrets) ||
    secrets.length > 16 ||
    secrets.some((secret) => typeof secret !== 'string' || !SECRET.test(secret)) ||
    new Set(secrets).size !== secrets.length
  )
    fail(`${where} secrets is a list of at most 16 distinct names of letters, digits and underscores: secrets: ['apiKey'].`);
  const client = fn<(context: { secrets: Readonly<Record<string, string>> }) => unknown>(value.client, `${where} client`);
  const actions = new Map<string, CapturedAction>();
  if (value.actions !== undefined) {
    for (const [action, declared] of Object.entries(record(value.actions, `${where} actions`))) {
      if (!MEMBER.test(action))
        fail(`${where} action "${action}" needs a name of letters, digits and underscores, starting with a letter.`);
      const at = `${where} action "${action}"`;
      const entry = record(declared, at);
      only(entry, at, ['input', 'output', 'run']);
      actions.set(
        action,
        Object.freeze({
          input: shapeOf(entry.input, `${at} input`),
          output: objectShape(entry.output, `${at} output`),
          run: fn<CapturedAction['run']>(entry.run, `${at} run`),
        }),
      );
    }
  }
  let webhooks: CapturedIntegration['webhooks'];
  if (value.webhooks !== undefined) {
    const declared = record(value.webhooks, `${where} webhooks`);
    only(declared, `${where} webhooks`, ['verify', 'events']);
    const events = new Map<string, Readonly<{ type: string; payload: Shape<unknown>; optOut?: string; optIn?: string }>>();
    const types = new Set<string>();
    for (const [event, given] of Object.entries(record(declared.events, `${where} webhooks.events`))) {
      if (!MEMBER.test(event)) fail(`${where} event "${event}" needs a name of letters, digits and underscores, starting with a letter.`);
      const at = `${where} event "${event}"`;
      const entry = record(given, at);
      only(entry, at, ['type', 'payload'], ['optOut', 'optIn']);
      if (typeof entry.type !== 'string' || !EVENT_TYPE.test(entry.type))
        fail(`${at} type is the provider's event type: type: 'charge.succeeded'.`);
      if (types.has(entry.type as string)) fail(`${at} type "${entry.type as string}" is another event's: one name per type.`);
      types.add(entry.type as string);
      const payload = objectShape(entry.payload, `${at} payload`);
      const fields = (describeShape(payload) as { fields: Readonly<Record<string, unknown>> }).fields;
      for (const key of ['optOut', 'optIn'] as const) {
        if (entry[key] === undefined) continue;
        if (typeof entry[key] !== 'string' || !Object.hasOwn(fields, entry[key] as string))
          fail(`${at} ${key} names the payload field holding the recipient, one of: ${Object.keys(fields).join(', ')}.`);
      }
      events.set(
        event,
        Object.freeze({
          type: entry.type as string,
          payload,
          ...(entry.optOut === undefined ? {} : { optOut: entry.optOut as string }),
          ...(entry.optIn === undefined ? {} : { optIn: entry.optIn as string }),
        }),
      );
    }
    if (!events.size) fail(`${where} webhooks.events names at least one event.`);
    webhooks = Object.freeze({
      verify: fn<NonNullable<CapturedIntegration['webhooks']>['verify']>(declared.verify, `${where} webhooks.verify`),
      events,
    });
  }
  let channel: CapturedIntegration['channel'];
  if (value.channel !== undefined) {
    const declared = record(value.channel, `${where} channel`);
    only(declared, `${where} channel`, ['name', 'send']);
    if (typeof declared.name !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(declared.name) || declared.name === 'email')
      fail(`${where} channel is named in lowercase letters, digits and hyphens, and is not "email" (core's own): name: 'sms'.`);
    channel = Object.freeze({
      name: declared.name as string,
      send: fn<NonNullable<CapturedIntegration['channel']>['send']>(declared.send, `${where} channel send`),
    });
  }
  if (!actions.size && !webhooks && !channel) fail(`${where} declares no actions, webhooks or channel: nothing an App could use.`);
  const integration = Object.freeze({ name }) as unknown as Integration<Name, ActionTypes<Actions>>;
  captured.set(
    integration,
    Object.freeze({
      name: name as string,
      secrets: Object.freeze([...(secrets as string[])]),
      client: (given: Readonly<Record<string, string>>) => client({ secrets: given }),
      actions,
      ...(webhooks ? { webhooks } : {}),
      ...(channel ? { channel } : {}),
    }),
  );
  return integration;
}

/** The captured integration behind a defineIntegration result; anything else, however alike, refuses. */
export function capturedIntegration(value: unknown): CapturedIntegration {
  const found = value && typeof value === 'object' ? captured.get(value) : undefined;
  return found ?? fail('An App lists integrations made by defineIntegration (@mistriwork/mistri/integration).');
}

/**
 * What a command's lookup calls: `integrations.<name>.<action>(input)`, one
 * recorded, idempotent call answering the action's output, for each action
 * the command declares (`integrations: { fakepay: ['charge'] }`).
 */
export type IntegrationCalls = Readonly<
  Record<string, Readonly<Record<string, (input: unknown) => Promise<Readonly<Record<string, unknown>>>>>>
>;
