/**
 * The public jobs vocabulary, `@mistriwork/mistri/jobs`. A job is a declaration: the
 * committed fact that starts it, when it is due, the principal it runs as
 * and the one command it runs. It holds no database handle and no handler;
 * the command's own authorization, footprint and transaction are the whole
 * of what it can do. Declarations are captured and frozen here and nothing
 * runs; the `--jobs` host (jobHost.ts) does that. A jobs module is server
 * configuration: it never reaches an App manifest or the browser.
 *
 * The principals a module declares are its service identities: a name and
 * the App role names it holds. They are server-declared on purpose. There is
 * no account to sign in as, and revoking one means editing the App's role or
 * this module and restarting.
 */
import { isProxy } from 'node:util/types';
import { isBusinessEvent, type BusinessEvent, type BusinessEventPayload } from '../commands/businessEvents.js';
import { parseEvery, type JobEvery } from './jobSchedule.js';
import { parseDuration } from '@mistriwork/engine/shared/duration.js';
import { isWorkflowJob } from '../workflows/workflowKeys.js';
import { capturedWorkflows, type CapturedWorkflow, type Workflows } from '../workflows/workflowModule.js';
import { captureIntegrations, type CapturedIntegrations, type IntegrationsDeclaration } from '../integrations/integrationDeclaration.js';
import { capturedDecisions, decisionJobs, isDecisionJob, type CapturedDecision, type Decisions } from '../decide/decisionModule.js';

/** A command a job names, at the version its registration holds (authority.lock's): the host pins it at load. */
export interface JobCommandReference {
  readonly id: string;
  readonly version: number;
}

/** What `schedule` answers for one event. */
export interface JobSchedule {
  /** When the job is due: epoch milliseconds, a Date, or an ISO date or
   * date-time. Omitted, it is due as soon as it is accepted. */
  readonly runAt?: number | Date | string;
  /** The key of the one record the command targets. */
  readonly key: Readonly<Record<string, string | number>>;
  /** The command's input: plain JSON, identifiers and dates like the event
   * it came from. Omitted, the command gets `{}`. */
  readonly input?: unknown;
}

/**
 * A job that runs at times rather than on a fact: `every` is five cron fields
 * (or `@hourly`, `@daily`, `@weekly`, `@monthly`) read on `timezone`'s wall
 * clock (UTC unless named). Its command names no record (`targets: 'none'`) —
 * a sweep that finds what is due itself — and takes `input` as given. Each
 * slot runs once whichever process sees it first; after a stop, the most
 * recent missed slot runs once and earlier ones are skipped (jobSchedule.ts),
 * and a store with no run of the job yet starts at its next slot. Runs of it
 * never overlap; `mistri jobs run <name>` runs it now, once.
 */
interface EveryJobDeclaration {
  readonly every: string;
  readonly timezone?: string;
  /** A tenant App's, required there and refused elsewhere: `'tenant'` runs
   * the job once per active tenant each slot, as the service in that tenant;
   * `'platform'` runs it once, in the platform realm, over the platform's
   * own rows and no tenant's. The command's realm must be the same. */
  readonly realm?: 'tenant' | 'platform';
  /** A principal the module declares; the command runs as it. */
  readonly runAs: string;
  /** The one command the job runs, by name. */
  readonly command: string;
  /** The command's input, plain JSON; omitted, `{}`. */
  readonly input?: unknown;
}

export interface JobDeclaration<Payload extends BusinessEventPayload<Payload>> {
  /** The committed fact that starts the job, and the command, by name, that records it. */
  readonly on: Readonly<{ event: BusinessEvent<Payload>; command: string }>;
  /** A principal the module declares; the command runs as it. */
  readonly runAs: string;
  /** The one command the job runs, by name. */
  readonly command: string;
  /** From the event's validated payload to the command's target, input and
   * due time. Synchronous and pure: a redelivered event must plan the same job. */
  readonly schedule: (event: Payload) => JobSchedule;
}

declare const jobType: unique symbol;
/** A captured job declaration. */
export interface Job {
  readonly on?: Readonly<{ event: Readonly<{ name: string; version: number }>; command: string }>;
  readonly every?: string;
  readonly runAs: string;
  readonly command: string;
  readonly [jobType]: true;
}

/** A timer, run through the jobs. A machine's `after`: a record in `state` of `resource` for `ms` since its `since`
 * runs the command. A resource's `at` (appAt.ts): `since` is the column holding the instant it is due, `ms` is 0, and
 * `when` the condition the record must match; it has no machine column or state. */
export interface MachineTimer {
  readonly resource: string;
  /** The machine's column and the state an `after` timer waits in. */
  readonly column?: string;
  readonly state?: string;
  readonly since: string;
  readonly ms: number;
  readonly after: string;
  /** The column an `at` timer is due at. */
  readonly at?: string;
  /** An `at` timer's condition, in the query language over the record's own columns. */
  readonly when?: string;
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** A timer, said for a refusal: `the machine of "ticket" runs "expire" after 3 days in "open"`, `"ticket" runs "breach" at due_at`. */
export function saidTimer(timer: MachineTimer, command: string): string {
  return timer.at === undefined
    ? `the machine of "${timer.resource}" runs "${command}" after ${timer.after} in "${timer.state}"`
    : `"${timer.resource}" runs "${command}" at ${timer.at}${timer.when === undefined ? '' : ` when ${timer.when}`}`;
}

/** A service principal: the App roles it holds, by name. */
export interface JobPrincipal {
  readonly roles: readonly string[];
}

/** The durable job store's bounds. Changing any of them is a new store namespace. */
export interface JobStoreOptions {
  /** Default `jobs`. */
  readonly namespace?: string;
  readonly maxAttempts?: number;
  readonly leaseMs?: number;
  readonly backoffMs?: Readonly<{ base: number; cap: number }>;
  /** Jobs leased at once. Default and ceiling 1: a job's command shares the source's one writer with HTTP. */
  readonly maxInFlight?: number;
}

export interface JobsOptions {
  readonly principals: Readonly<Record<string, JobPrincipal>>;
  readonly store?: JobStoreOptions;
  /** Verified inbound endpoints, by name: `POST {mount}/api/inbound/{name}`. An integration's webhooks take its name there. */
  readonly inbound?: Readonly<Record<string, Inbound>>;
  /** Durable workflows: `defineWorkflows({ ... })`. Their steps run as a principal declared here. */
  readonly workflows?: Workflows;
  /** A tenant App's email, in and out: the commands that take a message in, send the held ones and open a signed link. */
  readonly mail?: MailDeclaration;
  /** The integrations the App uses, the commands their webhook events run, and the quiet hours its channels keep. */
  readonly integrations?: IntegrationsDeclaration;
  /** Typed decisions with calibrated probabilities: `defineDecisions({ ... })`. Each runs as a principal declared here. */
  readonly decisions?: Decisions;
}

/* ---------- a tenant App's mail ---------- */

/** An address as a message names it. */
export interface MailAddress {
  readonly address: string;
  readonly name?: string;
}

/** One inbound message, as the webhook delivered it and the platform read it. */
export interface InboundMail {
  /** The tenant it was addressed to, and the mailbox: `help` of `help+acme@in.example.com`. */
  readonly tenant: string;
  readonly mailbox: string;
  /** The address it was delivered to, which routed it. */
  readonly recipient: string;
  readonly from: MailAddress;
  readonly to: readonly MailAddress[];
  readonly cc: readonly MailAddress[];
  readonly subject: string;
  readonly messageId: string;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  /** What the sender wrote, the quoted history cut off: the text sent, or the HTML's words. */
  readonly text: string;
  /** The HTML sanitized as a rich text column keeps it, the quoted history cut off; '' when none was sent. */
  readonly html: string;
  /** Each attachment checked against the file resource `receive.attachments` names: content in base64. */
  readonly attachments: readonly Readonly<{ name: string; type: string; size: number; content: string }>[];
}

/** One held message as the `send.claim` command returns it: `{ messages: OutboundMessage[] }`. */
export interface OutboundMessage {
  /** The App's own id for it: `send.record` is told what became of it by this. */
  readonly id: string;
  readonly to: string | readonly string[];
  readonly cc?: string | readonly string[];
  /** `Name <address>` or an address: the mailbox it is sent from. */
  readonly from: string;
  readonly replyTo?: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  /** `<id@domain>`, kept by the App so a reply finds its thread; made up when absent and told to `record`. */
  readonly messageId?: string;
  readonly inReplyTo?: string;
  readonly references?: string | readonly string[];
  /** A signed link to this record of the `links` command's resource, put where the text and HTML say `{link}`. */
  readonly link?: Readonly<Record<string, string | number>>;
}

export interface MailDeclaration {
  /** Each inbound message runs `command` as `runAs` in the tenant it was addressed to. */
  readonly receive?: Readonly<{
    runAs: string;
    command: string;
    /** From the message to the command's input. Pure. Omitted: `{ to, from, from_name, subject, body, message_id, in_reply_to, references }`. */
    input?: (mail: InboundMail) => unknown;
    /** The file resource attachments are checked against (its size and name rules); omitted, attachments are not passed on. */
    attachments?: string;
  }>;
  /** Every `every` (`'30 seconds'`), in each active tenant: `claim` returns held messages, each is sent, and `record` is told what became of it. */
  readonly send?: Readonly<{ runAs: string; claim: string; record: string; every?: string }>;
  /**
   * A signed link's record opens through `command` (a verb of the record), run
   * as `runAs` in the link's tenant, and its result is the page the link shows.
   * `reply` names a command of the same record, with a text input `body`, that
   * the page's reply box runs; omitted, the page is read-only.
   */
  readonly links?: Readonly<{ runAs: string; command: string; reply?: string }>;
}

/** The mail a module declares, as the host reads it. */
export interface CapturedMail {
  readonly receive?: Readonly<{
    runAs: string;
    command: JobCommandReference;
    input?: (mail: InboundMail) => unknown;
    attachments?: string;
  }>;
  readonly send?: Readonly<{ runAs: string; claim: JobCommandReference; record: JobCommandReference; everyMs: number }>;
  readonly links?: Readonly<{ runAs: string; command: JobCommandReference; reply?: JobCommandReference }>;
}

/* ---------- inbound endpoints ---------- */

/** How an HMAC-signed delivery is verified. Nothing here is a secret: `secret` names an environment variable. */
export interface HmacOptions {
  /** The environment variable that holds the shared secret, never the secret. */
  readonly secret: string;
  /** Default `sha256`. */
  readonly algorithm?: 'sha256' | 'sha1' | 'sha512';
  readonly signature: Readonly<{
    readonly header: string;
    /** Default `hex`. */
    readonly encoding?: 'hex' | 'base64';
    /** Text before the digest in the header, such as Slack's `v0=`. */
    readonly prefix?: string;
  }>;
  /**
   * The delivery's time, refused outside `window` (`'30 seconds'`, `'5 minutes'`, `'1 hour'`), on
   * either side of now. Epoch seconds or milliseconds. Required: without a
   * signed time a captured delivery can be sent again once its receipt is pruned.
   */
  readonly timestamp: Readonly<{ readonly header: string; readonly window: string }>;
  /** What is signed, from `{timestamp}` and `{body}` (the raw bytes). Default `{timestamp}.{body}`. */
  readonly signed?: string;
}

declare const verifierType: unique symbol;
/** A way to verify an inbound delivery: what `hmac(...)` returns. */
export interface InboundVerifier {
  readonly kind: 'hmac';
  readonly [verifierType]: true;
}

/** An hmac verifier as the host reads it. */
export interface CapturedHmac {
  readonly kind: 'hmac';
  readonly secretEnv: string;
  readonly algorithm: 'sha256' | 'sha1' | 'sha512';
  readonly signatureHeader: string;
  readonly encoding: 'hex' | 'base64';
  readonly prefix: string;
  /** Required: every delivery carries a signed time, checked against `windowMs`. */
  readonly timestampHeader: string;
  readonly windowMs: number;
  /** The signed text as parts: a literal, or the delivery's `timestamp` or raw `body`. */
  readonly signed: readonly (string | { readonly part: 'timestamp' | 'body' })[];
}

// The body is the sender's JSON: the declaration's functions say what they read of it.
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface InboundDeclaration {
  /** How a delivery proves it came from the sender: `hmac({ ... })`. */
  readonly verify: InboundVerifier;
  /** The service principal the command runs as, declared in this module's `principals`. */
  readonly runAs: string;
  /** The one command a delivery runs, by name. */
  readonly command: string;
  /** The sender's own id for the delivery: it becomes the command receipt's idempotency key, so a retry replays it. Pure. */
  readonly key: (body: any) => string | number;
  /** From the parsed body to the command's input. Pure. */
  readonly input: (body: any) => unknown;
  /** From the parsed body to the key of the record the command names. Only for a command that targets a record. Pure. */
  readonly target?: (body: any) => Readonly<Record<string, string | number>>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

declare const inboundType: unique symbol;
/** A captured inbound declaration. */
export interface Inbound {
  readonly runAs: string;
  readonly command: string;
  readonly [inboundType]: true;
}

/** An inbound endpoint as the host reads it. */
export interface CapturedInbound {
  readonly name: string;
  readonly verify: CapturedHmac;
  readonly runAs: string;
  readonly command: JobCommandReference;
  readonly key: (body: unknown) => unknown;
  readonly input: (body: unknown) => unknown;
  readonly target?: (body: unknown) => unknown;
}

declare const moduleType: unique symbol;
/** What a `--jobs` file exports by default. */
export interface JobModule {
  readonly jobs: readonly string[];
  readonly [moduleType]: true;
}

export class JobDeclarationError extends Error {
  readonly code = 'invalid-job-declaration';
  constructor(message: string) {
    super(message);
    this.name = 'JobDeclarationError';
  }
}

/** A job as the host reads it: the declaration, and the event it decodes. */
export interface CapturedJob {
  readonly id: string;
  readonly version: number;
  /* An event job's: the fact that starts it, the command that records it, and how it plans the run. */
  // The event's payload type is the declaration's business, erased here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly event?: BusinessEvent<any>;
  readonly from?: JobCommandReference;
  readonly schedule?: (payload: unknown) => unknown;
  /* A time job's: its slots, and the command's input. */
  readonly every?: JobEvery;
  readonly input?: unknown;
  /** A tenant App's time job: once per active tenant, or once on the platform. */
  readonly realm?: 'tenant' | 'platform';
  /* A machine timer's (appMachine.ts `after`): the records that have stayed in a state this long. */
  readonly timer?: MachineTimer;
  readonly runAs: string;
  readonly command: JobCommandReference;
  /** A decision's job (decide/decisionModule.ts): the decisions it runs, which its own handler answers. */
  readonly decide?: readonly string[];
}
export interface CapturedJobModule {
  readonly jobs: ReadonlyMap<string, CapturedJob>;
  readonly principals: ReadonlyMap<string, readonly string[]>;
  readonly store: JobStoreOptions;
  readonly inbound: ReadonlyMap<string, CapturedInbound>;
  readonly workflows: ReadonlyMap<string, CapturedWorkflow>;
  readonly mail?: CapturedMail;
  readonly integrations?: CapturedIntegrations;
  /** The module's decisions by name; each runs as one of its jobs (`decide-…`). */
  readonly decisions?: ReadonlyMap<string, CapturedDecision>;
}

const reserved = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);
const JOB_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const COMMAND_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
/** A principal's name; its actor id is `service:<name>`. */
const PRINCIPAL = /^[a-z][a-z0-9-]{0,62}$/;
const fail = (message: string): never => {
  throw new JobDeclarationError(message);
};
const jobs = new WeakMap<object, Omit<CapturedJob, 'id'>>();
const modules = new WeakMap<object, CapturedJobModule>();
/** What defineJobs captured, so the captured module passes where the export does. */
const captures = new WeakSet<object>();

function plainRecord(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return fail(`${where} must be a plain object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return fail(`${where} must not inherit configuration.`);
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || reserved.has(key)) return fail(`${where} has an unsafe property.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) return fail(`${where} must contain only enumerable data properties.`);
    copy[key] = descriptor.value;
  }
  return copy;
}
function exactly(value: Record<string, unknown>, keys: readonly string[], where: string, optional: readonly string[] = []): void {
  for (const key of Object.keys(value)) if (!keys.includes(key) && !optional.includes(key)) fail(`${where} has an unknown option: ${key}.`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${where} is missing its ${key}.`);
}
/* A command by its name, as the App and the registry name it; its version is
   the registration's, pinned when the host loads the module (pinJobs). */
function commandReference(value: unknown, where: string): JobCommandReference {
  if (typeof value !== 'string' || !COMMAND_ID.test(value)) {
    return fail(`${where} must name a command, as defineCommands registers it: command: 'flagOverdueReview'.`);
  }
  return Object.freeze({ id: value, version: 1 });
}

/**
 * The module with each job's commands at the versions the registry holds
 * them (authority.lock's), which is what a job's delivery route and its
 * command requests carry. A job itself is at version 1: what it runs and
 * when is its commands' contract.
 */
export function pinJobs(module: CapturedJobModule, commands: Readonly<Record<string, { readonly version: number }>>): CapturedJobModule {
  const version = (reference: JobCommandReference) =>
    Object.hasOwn(commands, reference.id) ? commands[reference.id].version : reference.version;
  const jobs = new Map(
    [...module.jobs].map(([id, job]) => [
      id,
      Object.freeze({
        ...job,
        ...(job.from ? { from: Object.freeze({ id: job.from.id, version: version(job.from) }) } : {}),
        command: Object.freeze({ id: job.command.id, version: version(job.command) }),
      }),
    ]),
  );
  const inbound = new Map(
    [...module.inbound].map(([name, endpoint]) => [
      name,
      Object.freeze({ ...endpoint, command: Object.freeze({ id: endpoint.command.id, version: version(endpoint.command) }) }),
    ]),
  );
  const pin = (reference: JobCommandReference) => Object.freeze({ id: reference.id, version: version(reference) });
  const mail = module.mail && {
    ...(module.mail.receive ? { receive: Object.freeze({ ...module.mail.receive, command: pin(module.mail.receive.command) }) } : {}),
    ...(module.mail.send
      ? { send: Object.freeze({ ...module.mail.send, claim: pin(module.mail.send.claim), record: pin(module.mail.send.record) }) }
      : {}),
    ...(module.mail.links
      ? {
          links: Object.freeze({
            ...module.mail.links,
            command: pin(module.mail.links.command),
            ...(module.mail.links.reply ? { reply: pin(module.mail.links.reply) } : {}),
          }),
        }
      : {}),
  };
  const pinned = Object.freeze({ ...module, jobs, inbound, ...(mail ? { mail: Object.freeze(mail) } : {}) });
  captures.add(pinned);
  return pinned;
}

/**
 * Capture and freeze one job, without calling its schedule. This is a
 * trusted-code API, not a sandbox: the schedule runs in the server.
 */
export function defineJob(declaration: EveryJobDeclaration): Job;
export function defineJob<Payload extends BusinessEventPayload<Payload>>(declaration: JobDeclaration<Payload>): Job;
export function defineJob<Payload extends BusinessEventPayload<Payload>>(declaration: JobDeclaration<Payload> | EveryJobDeclaration): Job {
  const value = plainRecord(declaration, 'Job');
  if (Object.hasOwn(value, 'every')) return defineEveryJob(value);
  exactly(value, ['on', 'runAs', 'command', 'schedule'], 'Job');
  const version = 1;
  const on = plainRecord(value.on, 'Job on');
  exactly(on, ['event', 'command'], 'Job on');
  if (!isBusinessEvent(on.event)) fail('Job on.event must be an event created with defineEvent.');
  const event = on.event as BusinessEvent<Payload>;
  const from = commandReference(on.command, 'Job on.command');
  if (typeof value.runAs !== 'string' || !PRINCIPAL.test(value.runAs))
    fail('Job runAs must name a principal: lowercase letters, digits and hyphens.');
  const command = commandReference(value.command, 'Job command');
  if (typeof value.schedule !== 'function' || isProxy(value.schedule)) fail('Job schedule must be a function.');
  const schedule = value.schedule as (payload: unknown) => unknown;
  const job = Object.freeze({
    on: Object.freeze({ event: Object.freeze({ name: event.name, version: event.version }), command: from.id }),
    runAs: value.runAs as string,
    command: command.id,
  }) as unknown as Job;
  jobs.set(
    job,
    Object.freeze({
      version,
      event,
      from,
      runAs: value.runAs as string,
      command,
      schedule: (payload: unknown) => Reflect.apply(schedule, undefined, [payload]),
    }),
  );
  return job;
}

/** A job that runs at times: its slots read, its input copied as plain JSON. */
function defineEveryJob(value: Record<string, unknown>): Job {
  exactly(value, ['every', 'runAs', 'command'], 'Job', ['timezone', 'input', 'realm']);
  if (Object.hasOwn(value, 'realm') && value.realm !== 'tenant' && value.realm !== 'platform') fail("Job realm is 'tenant' or 'platform'.");
  let every: JobEvery;
  try {
    every = parseEvery(value.every, value.timezone ?? 'UTC');
  } catch (error) {
    return fail(`Job ${(error as Error).message}`);
  }
  if (typeof value.runAs !== 'string' || !PRINCIPAL.test(value.runAs))
    fail('Job runAs must name a principal: lowercase letters, digits and hyphens.');
  const command = commandReference(value.command, 'Job command');
  let input: unknown = {};
  if (Object.hasOwn(value, 'input')) {
    try {
      input = JSON.parse(JSON.stringify(value.input));
    } catch {
      return fail('Job input must be plain JSON.');
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail("Job input must be an object of the command's input.");
  }
  const job = Object.freeze({ every: every.text, runAs: value.runAs as string, command: command.id }) as unknown as Job;
  jobs.set(
    job,
    Object.freeze({
      version: 1,
      every,
      input,
      runAs: value.runAs as string,
      command,
      ...(value.realm === undefined ? {} : { realm: value.realm as 'tenant' | 'platform' }),
    }),
  );
  return job;
}

const INBOUND_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/* RFC 9110's token: what a header name may be. */
const HEADER = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const verifiers = new WeakMap<object, CapturedHmac>();
const inbounds = new WeakMap<object, Omit<CapturedInbound, 'name'>>();

/** `'30 seconds'`, `'5 minutes'` or `'1 hour'`, at most a day: how far a delivery's time may be from now. */
function windowMs(value: unknown): number {
  const ms = parseDuration(value);
  if (!ms || ms > 86_400_000) return fail("hmac timestamp window is a duration of at most a day, like window: '5 minutes'.");
  return ms;
}

/**
 * Verify a delivery by an HMAC of its raw bytes under a shared secret. The
 * secret is named by environment variable and read when the server starts;
 * the declaration never holds it.
 */
export function hmac(options: HmacOptions): InboundVerifier {
  const value = plainRecord(options, 'hmac');
  /* A timestamp is required. Without one the signature covers the body alone,
     and a captured delivery replays for as long as anyone holds it: the
     command's receipt makes a replay idempotent only while the receipt is
     kept, and once it is pruned the replay runs the command again. */
  if (value && typeof value === 'object' && !Object.hasOwn(value, 'timestamp')) {
    fail(
      "hmac needs a timestamp: name the header the sender puts the delivery's time in and a window, such as timestamp: { header: 'x-timestamp', window: '5 minutes' }. " +
        'Without a signed time a captured delivery can be replayed once its receipt is pruned.',
    );
  }
  exactly(value, ['secret', 'signature', 'timestamp'], 'hmac', ['algorithm', 'signed']);
  if (typeof value.secret !== 'string' || !ENV_NAME.test(value.secret))
    fail("hmac secret names the environment variable that holds the secret, such as secret: 'CREDIT_CALLBACK_SECRET'.");
  const algorithm = value.algorithm ?? 'sha256';
  if (algorithm !== 'sha256' && algorithm !== 'sha1' && algorithm !== 'sha512') fail('hmac algorithm is sha256, sha1 or sha512.');
  const signature = plainRecord(value.signature, 'hmac signature');
  exactly(signature, ['header'], 'hmac signature', ['encoding', 'prefix']);
  if (typeof signature.header !== 'string' || !HEADER.test(signature.header)) fail('hmac signature.header names a header.');
  const encoding = signature.encoding ?? 'hex';
  if (encoding !== 'hex' && encoding !== 'base64') fail('hmac signature.encoding is hex or base64.');
  const prefix = signature.prefix ?? '';
  if (typeof prefix !== 'string' || prefix.length > 32) fail("hmac signature.prefix is short text, such as 'v0='.");
  const stamp = plainRecord(value.timestamp, 'hmac timestamp');
  exactly(stamp, ['header', 'window'], 'hmac timestamp');
  if (typeof stamp.header !== 'string' || !HEADER.test(stamp.header)) fail('hmac timestamp.header names a header.');
  const timestampHeader = (stamp.header as string).toLowerCase(),
    window = windowMs(stamp.window);
  const template = value.signed ?? '{timestamp}.{body}';
  if (typeof template !== 'string' || template.length > 256) fail('hmac signed is a template of {timestamp}, {body} and literal text.');
  const signed: Array<string | { part: 'timestamp' | 'body' }> = [];
  let parts = 0;
  for (const piece of (template as string).split(/(\{[a-z]+\})/)) {
    if (piece === '{body}') {
      signed.push({ part: 'body' });
      parts++;
    } else if (piece === '{timestamp}') signed.push({ part: 'timestamp' });
    else if (/^\{[a-z]+\}$/.test(piece)) fail(`hmac signed has an unknown part ${piece}: use {timestamp} or {body}.`);
    else if (piece) signed.push(piece);
  }
  if (!parts) fail('hmac signed must include {body}: a signature that does not cover the body proves nothing.');
  if (!signed.some((part) => typeof part !== 'string' && part.part === 'timestamp')) {
    fail('hmac names a timestamp, so signed must include {timestamp}: an unsigned time can be replayed with a fresh one.');
  }
  const verifier = Object.freeze({ kind: 'hmac' as const }) as unknown as InboundVerifier;
  verifiers.set(
    verifier,
    Object.freeze({
      kind: 'hmac',
      secretEnv: value.secret as string,
      algorithm: algorithm as 'sha256' | 'sha1' | 'sha512',
      signatureHeader: (signature.header as string).toLowerCase(),
      encoding: encoding as 'hex' | 'base64',
      prefix: prefix as string,
      timestampHeader,
      windowMs: window,
      signed: Object.freeze(signed),
    }),
  );
  return verifier;
}

/**
 * Capture and freeze one inbound endpoint, without calling its functions.
 * Like a job, a trusted-code declaration: they run in the server.
 */
export function defineInbound(declaration: InboundDeclaration): Inbound {
  const value = plainRecord(declaration, 'Inbound');
  exactly(value, ['verify', 'runAs', 'command', 'key', 'input'], 'Inbound', ['target']);
  const verify = typeof value.verify === 'object' && value.verify ? verifiers.get(value.verify) : undefined;
  if (!verify) fail('Inbound verify must be created with hmac(...).');
  if (typeof value.runAs !== 'string' || !PRINCIPAL.test(value.runAs))
    fail('Inbound runAs must name a principal: lowercase letters, digits and hyphens.');
  const command = commandReference(value.command, 'Inbound command');
  const functions = (['key', 'input', 'target'] as const).flatMap((name) => {
    if (!Object.hasOwn(value, name)) return [];
    const fn = value[name];
    if (typeof fn !== 'function' || isProxy(fn)) return fail(`Inbound ${name} must be a function of the parsed body.`);
    return [[name, (body: unknown) => Reflect.apply(fn, undefined, [body])] as const];
  });
  const endpoint = Object.freeze({ runAs: value.runAs as string, command: command.id }) as unknown as Inbound;
  inbounds.set(
    endpoint,
    Object.freeze({ verify: verify!, runAs: value.runAs as string, command, ...Object.fromEntries(functions) }) as Omit<
      CapturedInbound,
      'name'
    >,
  );
  return endpoint;
}

/** The principals a module's mail runs as. */
function mailPrincipals(mail: CapturedMail): string[] {
  return [mail.receive?.runAs, mail.send?.runAs, mail.links?.runAs].filter((runAs): runAs is string => runAs !== undefined);
}

const RESOURCE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** `mail`, checked and frozen: each part's principal and commands named, its functions wrapped, nothing called. */
function captureMail(value: unknown): CapturedMail {
  const mail = plainRecord(value, 'Jobs mail');
  exactly(mail, [], 'Jobs mail', ['receive', 'send', 'links']);
  if (!Object.keys(mail).length) fail('Jobs mail declares receive, send or links.');
  const principal = (runAs: unknown, where: string) => {
    if (typeof runAs !== 'string' || !PRINCIPAL.test(runAs))
      fail(`${where} runAs must name a principal: lowercase letters, digits and hyphens.`);
    return runAs as string;
  };
  const out: { -readonly [K in keyof CapturedMail]: CapturedMail[K] } = {};
  if (mail.receive !== undefined) {
    const receive = plainRecord(mail.receive, 'Mail receive');
    exactly(receive, ['runAs', 'command'], 'Mail receive', ['input', 'attachments']);
    let input: ((mail: InboundMail) => unknown) | undefined;
    if (receive.input !== undefined) {
      const fn = receive.input;
      if (typeof fn !== 'function' || isProxy(fn)) fail('Mail receive.input must be a function of the message.');
      input = (message: InboundMail) => Reflect.apply(fn as (mail: InboundMail) => unknown, undefined, [message]);
    }
    if (receive.attachments !== undefined && (typeof receive.attachments !== 'string' || !RESOURCE.test(receive.attachments)))
      fail('Mail receive.attachments names a file resource of the App.');
    out.receive = Object.freeze({
      runAs: principal(receive.runAs, 'Mail receive'),
      command: commandReference(receive.command, 'Mail receive.command'),
      ...(input ? { input } : {}),
      ...(receive.attachments === undefined ? {} : { attachments: receive.attachments as string }),
    });
  }
  if (mail.send !== undefined) {
    const send = plainRecord(mail.send, 'Mail send');
    exactly(send, ['runAs', 'claim', 'record'], 'Mail send', ['every']);
    const everyMs = send.every === undefined ? 60_000 : parseDuration(send.every);
    if (!everyMs || everyMs < 5_000 || everyMs > 86_400_000)
      fail("Mail send.every is a duration from 5 seconds to a day, like every: '30 seconds'.");
    out.send = Object.freeze({
      runAs: principal(send.runAs, 'Mail send'),
      claim: commandReference(send.claim, 'Mail send.claim'),
      record: commandReference(send.record, 'Mail send.record'),
      everyMs: everyMs!,
    });
  }
  if (mail.links !== undefined) {
    const links = plainRecord(mail.links, 'Mail links');
    exactly(links, ['runAs', 'command'], 'Mail links', ['reply']);
    out.links = Object.freeze({
      runAs: principal(links.runAs, 'Mail links'),
      command: commandReference(links.command, 'Mail links.command'),
      ...(links.reply === undefined ? {} : { reply: commandReference(links.reply, 'Mail links.reply') }),
    });
  }
  return Object.freeze(out);
}

/**
 * A `--jobs` module's default export: its jobs by id, and the principals
 * they run as. Every principal a job names must be declared, with at least
 * one role. Ids name durable rows; keep this module on the server.
 */
export function defineJobs(declared: Readonly<Record<string, Job>>, options: JobsOptions): JobModule {
  const value = plainRecord(declared, 'Jobs');
  const entries = Object.entries(value);
  const settings = plainRecord(options, 'Jobs options');
  exactly(settings, ['principals'], 'Jobs options', ['store', 'inbound', 'workflows', 'mail', 'integrations', 'decisions']);
  const endpoints = Object.hasOwn(settings, 'inbound') ? plainRecord(settings.inbound, 'Jobs inbound') : {};
  const declaredWorkflows = Object.hasOwn(settings, 'workflows') ? capturedWorkflows(settings.workflows) : [];
  const mail = Object.hasOwn(settings, 'mail') ? captureMail(settings.mail) : undefined;
  const declaredDecisions = Object.hasOwn(settings, 'decisions') ? capturedDecisions(settings.decisions) : [];
  if (
    !entries.length &&
    !Object.keys(endpoints).length &&
    !declaredWorkflows.length &&
    !mail &&
    !Object.hasOwn(settings, 'integrations') &&
    !declaredDecisions.length
  )
    fail('Jobs must declare at least one job or inbound endpoint, a workflow, mail, integrations or decisions.');
  const captured = new Map<string, CapturedJob>();
  for (const [id, job] of entries) {
    if (!JOB_ID.test(id) || id.length > 64)
      fail('Job ids must start with a letter and contain only letters, digits, underscores or hyphens.');
    // A workflow's wake-ups are jobs under this prefix, so no job of the module's own may take it.
    if (isWorkflowJob(id)) fail(`Job id "${id}" is reserved: the "wf-" prefix belongs to workflows.`);
    if (isDecisionJob(id)) fail(`Job id "${id}" is reserved: the "decide-" prefix belongs to decisions.`);
    const found = job && typeof job === 'object' ? jobs.get(job) : undefined;
    if (!found) return fail(`Job "${id}" must be created with defineJob.`);
    captured.set(id, Object.freeze({ id, ...found }));
  }
  const principals = new Map<string, readonly string[]>();
  for (const [name, principal] of Object.entries(plainRecord(settings.principals, 'Jobs principals'))) {
    if (!PRINCIPAL.test(name)) fail(`Principal "${name}" must be lowercase letters, digits and hyphens.`);
    const grant = plainRecord(principal, `Principal "${name}"`);
    exactly(grant, ['roles'], `Principal "${name}"`);
    const roles = grant.roles;
    if (
      !Array.isArray(roles) ||
      !roles.length ||
      roles.length > 16 ||
      roles.some((role) => typeof role !== 'string' || !role.trim()) ||
      new Set(roles).size !== roles.length
    )
      fail(`Principal "${name}" must hold a nonempty list of distinct role names.`);
    principals.set(name, Object.freeze([...(roles as string[])]));
  }
  for (const job of captured.values()) {
    if (!principals.has(job.runAs)) fail(`Job "${job.id}" runs as "${job.runAs}", which the module's principals do not declare.`);
  }
  const decisions = new Map(declaredDecisions.map((decision) => [decision.name, decision] as const));
  for (const decision of declaredDecisions)
    if (!principals.has(decision.runAs))
      fail(`Decision "${decision.name}" runs as "${decision.runAs}", which the module's principals do not declare.`);
  for (const job of decisionJobs(declaredDecisions)) captured.set(job.id, job);
  const inbound = new Map<string, CapturedInbound>();
  for (const [name, endpoint] of Object.entries(endpoints)) {
    if (!INBOUND_NAME.test(name))
      fail('Inbound names start with a letter and contain only letters, digits, underscores or hyphens, at most 64.');
    const found = endpoint && typeof endpoint === 'object' ? inbounds.get(endpoint) : undefined;
    if (!found) return fail(`Inbound "${name}" must be created with defineInbound.`);
    if (!principals.has(found.runAs)) fail(`Inbound "${name}" runs as "${found.runAs}", which the module's principals do not declare.`);
    inbound.set(name, Object.freeze({ name, ...found }));
  }
  for (const runAs of mail ? mailPrincipals(mail) : []) {
    if (!principals.has(runAs)) fail(`Mail runs as "${runAs}", which the module's principals do not declare.`);
  }
  const integrations = Object.hasOwn(settings, 'integrations') ? captureIntegrations(settings.integrations, principals, fail) : undefined;
  // An integration's webhooks are an inbound endpoint named after it (integrationInbound.ts): one address, one endpoint.
  for (const name of inbound.keys())
    if (integrations?.use.get(name)?.webhooks)
      fail(`Inbound "${name}" takes the address of integration "${name}"'s webhooks, POST /api/inbound/${name}: name it otherwise.`);
  const workflows = new Map<string, CapturedWorkflow>();
  for (const workflow of declaredWorkflows) {
    if (!principals.has(workflow.runAs))
      fail(`Workflow "${workflow.name}" runs as "${workflow.runAs}", which the module's principals do not declare.`);
    workflows.set(workflow.name, workflow);
  }
  let store: JobStoreOptions = Object.freeze({});
  if (Object.hasOwn(settings, 'store')) {
    const bounds = plainRecord(settings.store, 'Jobs store');
    exactly(bounds, [], 'Jobs store', ['namespace', 'maxAttempts', 'leaseMs', 'backoffMs', 'maxInFlight']);
    // Checked whole, with their ranges, where the store policy is captured.
    store = Object.freeze({
      ...bounds,
      ...(bounds.backoffMs ? { backoffMs: Object.freeze({ ...plainRecord(bounds.backoffMs, 'Jobs store backoffMs') }) } : {}),
    }) as JobStoreOptions;
  }
  const module = Object.freeze({ jobs: Object.freeze([...captured.keys()]) }) as unknown as JobModule;
  const capture = Object.freeze({
    jobs: captured,
    principals,
    store,
    inbound,
    workflows,
    ...(mail ? { mail } : {}),
    ...(integrations ? { integrations } : {}),
    ...(decisions.size ? { decisions } : {}),
  });
  modules.set(module, capture);
  captures.add(capture);
  return module;
}

/** The captured module behind a defineJobs result, or that captured module
 * itself; anything else, however alike, refuses. */
/** Whether a module runs jobs at all: one of only mail, inbound endpoints or integrations needs no job store, and none is made. */
export function runsJobs(module: Pick<CapturedJobModule, 'jobs' | 'workflows'>): boolean {
  return module.jobs.size > 0 || module.workflows.size > 0;
}

export function capturedJobModule(value: unknown): CapturedJobModule {
  if (value && typeof value === 'object' && captures.has(value)) return value as CapturedJobModule;
  const captured = value && typeof value === 'object' ? modules.get(value) : undefined;
  return captured ?? fail('The jobs module must export a defineJobs result by default.');
}

/**
 * The module with the App's machine timers as jobs of its own (`after-<resource>-<state>-<n>`),
 * each run as the first principal whose roles are granted its command: a timer's guards are
 * its command's grants. A timer no principal may run is refused.
 */
export function withMachineTimers(
  module: CapturedJobModule,
  timers: readonly (MachineTimer & { command: string })[],
  granted: (roles: readonly string[], command: string) => boolean,
): CapturedJobModule {
  if (!timers.length) return module;
  const jobs = new Map(module.jobs);
  timers.forEach((timer, index) => {
    const runAs = [...module.principals].find(([, roles]) => granted(roles, timer.command))?.[0];
    if (!runAs)
      fail(
        `${capital(saidTimer(timer, timer.command))}, and no principal of the jobs module is granted it. Grant it to a principal's role.`,
      );
    const id = (timer.at ? `at-${timer.resource}-${timer.at}` : `after-${timer.resource}-${timer.state}-${index + 1}`)
      .replace(/[^A-Za-z0-9_-]/g, '-')
      .slice(0, 64);
    const { command, ...rest } = timer;
    jobs.set(
      id,
      Object.freeze({ id, version: 1, runAs: runAs!, command: Object.freeze({ id: command, version: 1 }), timer: Object.freeze(rest) }),
    );
  });
  const next = Object.freeze({ ...module, jobs });
  captures.add(next);
  return next;
}
