/*
 * A business command's definition, the one place a command is declared: what
 * it acts on (`target`, `targets`), what it asks (`input`), what it may touch
 * (its source and footprint), what must hold of its target (`when`), what it
 * reads first (`sources`, `lookup`), what it does (`validate`, `initial`,
 * `handle`, `output`, `events`), and what it asks of other systems once it
 * commits (`effects`). The App names it by its registry key and never imports
 * it; the server sends the browser its input with the App.
 * Registration captures and freezes
 * the definition without running any of it; the executor
 * (businessCommandExecution.ts) runs it, and the authorizer binds it to one
 * App's grants.
 */
import { parseComputed } from '@mistriwork/engine/shared/computedParse.js';
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import {
  commandFieldsDeep,
  type AppCommandField,
  type CommandInitialOf,
  type CommandInput,
  type CommandInputOf,
} from '../../shared/command.js';
import { parseCommandInput } from '../../shared/commandInputParse.js';
import { COMMAND_FIELD_PATH } from '@mistriwork/engine/shared/commandFieldPath.js';
import { CommandInputRefusal, readCommandInput } from '../../shared/commandInput.js';
import {
  captureCommandEvents,
  type BusinessEventPick,
  type BusinessEventProjection,
  type CapturedCommandEvents,
} from './businessEvents.js';
import { captureCommandEffects, EFFECT_EVENT_PREFIX, type CapturedEffects, type CommandEffect } from './commandEffects.js';
import {
  sourceName,
  type CommandTables,
  type LocalName,
  type ReadTable,
  type RowOf,
  type SourceTables,
  type UntypedRow,
} from './commandDb.js';
import type { LookupSources } from './commandLookup.js';
import type { IntegrationCalls, IntegrationCallsOf, IntegrationUses, IntegrationUsesGuard } from '../integrations/integrationModule.js';
import type { SavedDraftContext } from '../forms/savedForms.js';
import type { WhenGuard } from '../../../schema/query.js';
import { cutSensitive } from '../forms/formKey.js';
import { brokenRules, draftHolds, draftNames, readsRecord, type BoundCondition, type DraftRule } from '../../shared/commandDraft.js';
import { readRichTextInput } from '../richText.js';
import { NO_OUTPUT, describeShape, preserveShapeDescriptor, type Shape } from './commandShapes.js';
import { captureCommandFlagGate, type CommandFlagGate, type CommandFlags } from './commandFlags.js';
import type { CommandHandlerDoor } from './commandTrack.js';

/**
 * A Standard Schema (standardschema.dev): what valibot, zod and arktype
 * implement, and what `validate` may be instead of a function. mistri
 * depends on none of them; an author who wants one brings it.
 */
export interface StandardSchema<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output };
  };
}
type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly { readonly message: string; readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] }[] };

/* Written as a method, so its parameter is bivariant: a command over
   particular fields is still a registered command over any. */
type ValidateFunction<I extends CommandInput, Input> = {
  check(input: CommandInputOf<I>, context: BusinessCommandValidationContext): Input | void;
}['check'];
/** A command's own rules over its parsed input: a synchronous function, or a Standard Schema. */
type CommandValidate<I extends CommandInput, Input> = ValidateFunction<I, Input> | StandardSchema<CommandInputOf<I>, Input>;

/** What a command's `validate` knows beside the parsed input: who asked, and which command. */
export interface BusinessCommandValidationContext {
  readonly actor: BusinessCommandActor;
  readonly commandId: string;
  readonly version: number;
}

export interface BusinessCommandActor {
  readonly id: string;
  readonly appId: string;
  readonly roles: readonly string[];
  /**
   * The signed-in account's email, as its verified session says — the value
   * `me` means beside a text column and the one the change history records —
   * so a handler can write who acted (`moved_by: actor.email`) or the row a
   * person is (`auth.me`). Set by the server from the session, never from a
   * request body; absent for a public or service principal, and for an
   * account the session names no email for.
   */
  readonly email?: string;
  /** The signed-in account's display name, from the same session, when it has one. */
  readonly name?: string;
  /**
   * Absent for a signed-in user. `'public'`: whoever submits a public form,
   * signed out or not, with no roles and no session, running only a command
   * marked `public`. `'service'`: a principal the server's jobs module
   * declares, id `service:<name>`, holding the role names it declares; it
   * runs a job's command, never a public one, and a role granting generic
   * writes or operations is refused for it.
   */
  readonly kind?: 'public' | 'service';
  /** The public form the public principal came through; its id is `public:<form>`. */
  readonly form?: string;
  /**
   * Whether this principal is a lender's operator inside a dealer, under an
   * audited support session. Orthogonal to `kind`, not one of its values: such
   * an operator is a signed-in user holding one of the dealer's own roles, and
   * the create-path rules that read `kind` are about public and service
   * principals, not about this.
   *
   * It is set by the runtime that admitted the session, from support evidence
   * the support owner minted, exactly as `kind: 'service'` is set by the jobs
   * runtime — never from anything a request carries. Its only effect is that a
   * command declaring `support: 'refuse'` will not run for it.
   */
  readonly support?: true;
}

/** What every handler context holds, whatever the command's shape. */
interface CommandContextBase {
  readonly flags: CommandFlags;
  readonly actor: BusinessCommandActor;
  readonly requestId: string;
  readonly commandId: string;
  readonly version: number;
  readonly source: string;
  readonly signal: AbortSignal;
  readonly now: () => Date;
}

/**
 * A handler's context, untyped: the shape a helper outside a definition can
 * name. A definition's own `handle` receives the typed twin — its `db` holds
 * exactly its footprint's tables, and `record` or `records` is present
 * exactly when the command names a record.
 */
export interface BusinessCommandContext extends CommandContextBase {
  /**
   * Which door the request came through, as the server knows it: `ui` (an
   * action, a form, an import or a public form), `api`, `mcp`, `job` or
   * `workflow`. Never read from the request.
   */
  readonly door: CommandHandlerDoor;
  /** The day `now()` falls on in the App's `ui.timezone` (UTC without one), as `YYYY-MM-DD`: the day a DATE column's
      `today` stamp writes, so a handler's day and a stamp's agree wherever the server runs. */
  readonly today: () => string;
  readonly db: Readonly<Record<string, ReadTable<UntypedRow>>>;
  /** The target, read and checked in this transaction: a one-target command that names a record. */
  readonly record?: UntypedRow;
  /** Every target, in request order: a `targets: 'many'` command. */
  readonly records?: readonly UntypedRow[];
  /** The raw transaction under the same footprint, audit and cancellation: the escape hatch. */
  readonly tx: WriteTransaction;
  /** The next number of the App's sequence `name` — `nextNumber('lead', { per: dealer_id, start: 1001 })` —
   * taken in this transaction: never the same twice, spent only if the command commits, gaps possible.
   * Counted per `per` and, in a tenant App, per tenant; it reads no rows, so a row policy does not hide the count.
   * `after` is the highest number rows already hold (a seed's, an import's): the number taken is past it too. */
  readonly nextNumber: CommandNextNumber;
  /** What `lookup` returned, when the command looks up. */
  readonly lookup?: unknown;
  /**
   * A tenant App's public form only: where this submission lands, decided by
   * the server from the intake address the visitor's link carried. `'tenant'`
   * when it names one active tenant — insert that tenant's rows, the owner
   * injected — and `'platform'` otherwise, for the platform's triage — its own
   * rows only. Absent on every other command. Answer both alike: the visitor
   * must not be able to tell them apart.
   */
  readonly intake?: 'tenant' | 'platform';
  /** A placed public form's admitted destination, captured by its source owner.
   * This is not native tenant membership and carries no binding or anchors. */
  readonly placement?: Readonly<{ tenantId: string }>;
  /**
   * A step of a public form saved on every step (a step that runs its own command), and its
   * submit: the application this request runs in. On the first step `start`
   * holds the columns the root row is inserted with — spread them into it —
   * and `root` is null; on every later step and the submit `root` is the root
   * row's key, which the server found from the applicant's cookie. Every read
   * and write is fenced to that one application: the root by its key, the
   * tables that reference it by their link (filled in on insert). Absent on
   * every other command.
   */
  readonly draft?: SavedDraftContext;
  /**
   * Files the platform received for this run and hands to it beside the input
   * — an inbound email's attachments (the jobs module's `mail.receive`) — each
   * checked against the file resource it names. Store one with
   * `db.<file resource>.insertFile(file, values)`. Absent on every other command.
   */
  readonly files?: readonly CommandFile[];
}

/** A file handed to a command run beside its input: its name, type, size and bytes. */
export interface CommandFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly data: Uint8Array;
}

/** What `initial` reads through: the target at the revision prepare reads, and reads only. A signed-in form's
    command (`targets: 'none'`) has no `record`. */
export interface BusinessCommandInitialContext extends CommandContextBase {
  readonly db: Readonly<Record<string, ReadTable<UntypedRow>>>;
  readonly record?: UntypedRow;
  readonly tx: Pick<WriteTransaction, 'query' | 'count'>;
}

/** Read-only, bounded batch eligibility. No input, writes or raw transaction.
 * Provisional host integration: declaring this alone does not filter UI yet. */
export interface BusinessCommandAvailabilityContext extends CommandContextBase {
  readonly db: Readonly<Record<string, ReadTable<UntypedRow>>>;
  readonly records: readonly UntypedRow[];
}

/**
 * What `lookup` reads through, before the transaction opens: the declared
 * sources' tables, read only, and the target as it stood then. The handler's
 * `record` is read again inside the transaction, at the form's revision.
 */
export interface BusinessCommandLookupContext extends CommandContextBase {
  readonly sources: LookupSources;
  /** The integrations the command declares, each action a function of its input. */
  readonly integrations: IntegrationCalls;
  readonly record?: UntypedRow;
  readonly records?: readonly UntypedRow[];
}

/** A public command names no record (`public: true` implies `targets: 'none'`). */
type Names<Many, Pub> = [Pub] extends [true] ? 'none' : Many;
type RecordPart<Row, Many> = [Many] extends ['none']
  ? object
  : [Many] extends ['many']
    ? { readonly records: readonly Row[] }
    : { readonly record: Row };
type Tables<Src, Target extends string> = SourceTables<Src, Target>;
type Reads<Target extends string, Read extends readonly string[], Write extends readonly string[]> =
  | LocalName<Target>
  | Read[number]
  | Write[number];
type Writes<Target extends string, Write extends readonly string[]> = LocalName<Target> | Write[number];

/** A handler's sequence: see BusinessCommandContext.nextNumber. */
type CommandNextNumber = (
  name: string,
  options?: { readonly per?: string | number; readonly start?: number; readonly after?: number | null },
) => Promise<number>;

/** A definition's handler context, typed by its source, target and footprint. */
type CommandHandlerContext<
  Src,
  Target extends string,
  Read extends readonly string[],
  Write extends readonly string[],
  Many,
  Lookup,
  Pub = undefined,
> = CommandContextBase & {
  readonly door: CommandHandlerDoor;
  readonly today: BusinessCommandContext['today'];
  readonly db: CommandTables<Tables<Src, Target>, Reads<Target, Read, Write>, Writes<Target, Write>>;
  readonly tx: WriteTransaction;
  readonly nextNumber: CommandNextNumber;
  readonly intake?: BusinessCommandContext['intake'];
  readonly placement?: BusinessCommandContext['placement'];
  readonly draft?: SavedDraftContext;
  readonly files?: BusinessCommandContext['files'];
  readonly lookup: Lookup;
} & RecordPart<RowOf<Src, Target>, Names<Many, Pub>>;

/** A definition's `lookup` context: the declared sources, and the target as it stood before the transaction. */
type CommandLookupContext<Src, Target extends string, Many, Pub = undefined, Uses = object> = CommandContextBase & {
  readonly sources: LookupSources;
  /** `integrations.<name>.<action>(input)`: one recorded, idempotent call, typed by the package's action. */
  readonly integrations: IntegrationCallsOf<Uses>;
} & RecordPart<RowOf<Src, Target>, Names<Many, Pub>>;

/** A definition's `initial` context: every footprint table read-only, and the target — none for a form's command. */
type CommandInitialContext<
  Src,
  Target extends string,
  Read extends readonly string[],
  Write extends readonly string[],
  Many = 'one',
> = CommandContextBase & {
  readonly db: CommandTables<Tables<Src, Target>, Reads<Target, Read, Write>, never>;
  readonly tx: Pick<WriteTransaction, 'query' | 'count'>;
} & RecordPart<RowOf<Src, Target>, Many>;

type CommandAvailabilityContext<
  Src,
  Target extends string,
  Read extends readonly string[],
  Write extends readonly string[],
> = CommandContextBase & {
  readonly db: CommandTables<Tables<Src, Target>, Reads<Target, Read, Write>, never>;
  readonly records: readonly RowOf<Src, Target>[];
};

/* A key an `initial` sets to undefined: a key with no value is left out (`...(bin === undefined ? {} : { bin })`),
   since a prefill of undefined is no value the form can hold and is refused when it is served. An optional key
   (`-?` drops the undefined its `?` adds) is fine; a key whose value may itself be undefined is not. */
type Present<T> = { [K in keyof T]-?: T[K] };
type UndefinedKeys<T> = T extends readonly (infer E)[]
  ? UndefinedKeys<E>
  : T extends object
    ? string extends keyof T
      ? never
      : { [K in keyof T]-?: undefined extends Present<T>[K] ? K : UndefinedKeys<Present<T>[K]> }[keyof T]
    : never;
type InitialSaysValues<Init> = [UndefinedKeys<Init>] extends [never]
  ? unknown
  : { initial: `An initial value is a value: leave "${UndefinedKeys<Init> & string}" out rather than set it to undefined.` };

/**
 * What `defineCommand` takes: the whole command, in the server-only module.
 * Its name is its key in `defineCommands`, which is how the App names it;
 * there is no version to write — authority.lock keeps each contract's, and
 * `mistri check --bump <name>` moves it when a published contract breaks.
 */
export interface CommandDefinition<
  I extends CommandInput,
  Output,
  Input,
  Src,
  Target extends string,
  Read extends readonly string[],
  Write extends readonly string[],
  Many extends 'one' | 'many' | 'none' | undefined,
  Lookup = undefined,
  Init extends CommandInitialOf<I> = CommandInitialOf<I>,
  Pub extends true | undefined = undefined,
  Uses extends IntegrationUses = {},
> {
  /** A `defineSource` handle, or the source's name (untyped). */
  readonly source: Src;
  /** The table it acts on — or, naming no record (`targets: 'none'`), the one it creates rows in. Source-local, or
      qualified with its own source. */
  readonly target: Target;
  /** How many existing records one request names: `'one'` (the default) is read into `record` and checked at the
      revision the form read; `'many'`, a queue's selection, into `records`; `'none'`, a form's command, names none. */
  readonly targets?: Many;
  /** Tables read beyond the target and what is written. */
  readonly read?: Read;
  /** Tables written beyond the target. The target is always read and written. */
  readonly write?: Write;
  /** `true`: the command only adds rows beside its target (a note, a comment, an attachment) and has nothing of the
      target's to overwrite. It is then refused as `stale_record` at its first write to the target, if it makes one and
      the record moved since the request read it, not before the handler, so a record other people keep editing still
      takes the note. Needs a table in `write` beyond the target. Left out, every command is refused up front, as
      before. */
  readonly appendOnly?: true;
  /** Tables of `read` the handler reads under the command's own authority, not the caller's:
      `elevate: { read: ['rate_card'] }`. A role granted the command need not read them; what the handler
      reads there reaches the caller only as the declared output. `mistri check --design` lists each one. */
  readonly elevate?: { readonly read: readonly Read[number][] };
  /** The App's sources, and the resources of each, that `lookup` reads before the transaction: `{ valuations: ['estimate'] }`. */
  readonly sources?: Readonly<Record<string, readonly string[]>>;
  /** The integrations `lookup` calls, and the actions of each: `{ fakepay: ['charge'] }`. Each call carries an
      idempotency key and is recorded; a replay of the request is answered from the record, never by the provider. */
  readonly integrations?: Uses;
  /** The input, fields keyed by name, `field.*` from @mistriwork/mistri/commands: what the form asks and the handler reads.
      Left out, the command asks nothing. */
  readonly input?: I;
  /** What must hold of the target, or it is `ineligible_state`, in the query language: `'status = open and owner_id = me'`. The
      App's buttons for the command carry it, so a selection is prepared against the same condition. */
  readonly when?: string;
  /** Conditions over the whole draft, each said at the first field it names when it does not hold, judged in the form
      as someone types, at each step's check and as the command runs, after the input's own rules and before
      `validate`: `rules: [{ must: 'confirm_email = email', message: 'The email addresses do not match.' }]`. */
  readonly rules?: readonly { readonly must: string; readonly when?: string; readonly message: string }[];
  /** A feature condition, additional to all ordinary command and row permissions. */
  readonly enabledBy?: CommandFlagGate;
  /**
   * The rule the declaration cannot state, over the parsed input, before any
   * transaction: a synchronous function (`refuse('invalid_input', 'field')`,
   * or return the input to run with), or a Standard Schema.
   */
  readonly validate?: CommandValidate<I, Input>;
  /** Starting values for the form: over the record, read at the revision prepare serves; or, for a signed-in
      form's command (`targets: 'none'`), over no record. */
  initial?(context: CommandInitialContext<Src, Target, Read, Write, Names<Many, Pub>>): Init | Promise<Init>;
  /** Optional read-only eligibility per record, in order. Host integration is
   * provisional; handlers must retain their authorization checks. */
  availability?(context: CommandAvailabilityContext<Src, Target, Read, Write>): readonly boolean[] | Promise<readonly boolean[]>;
  /**
   * Reads `sources` after `validate`, before the transaction opens; what it
   * returns (JSON, at most 64 KiB) reaches `handle` as `lookup`. A failure
   * refuses a first attempt, temporarily_unavailable; a replay still answers.
   */
  lookup?(context: CommandLookupContext<Src, Target, Many, Pub, Uses>, input: Input): Lookup | Promise<Lookup>;
  /** The result's shape: the handler's return type, checked before commit and before a replay.
      Omitted, the handler returns nothing and the receipt keeps an empty body. */
  readonly output?: Shape<Output>;
  /** Named facts projected only from validated, authorized fresh output. */
  readonly events?: Readonly<Record<string, BusinessEventProjection<NoInfer<Output>> | BusinessEventPick<NoInfer<Output>>>>;
  /** What to ask of other systems once the command commits, by name: `post(webhook, project)`. */
  readonly effects?: Readonly<Record<string, CommandEffect<NoInfer<Output>>>>;
  readonly public?: Pub;
  readonly realm?: 'tenant' | 'platform';
  /** A platform command acting in one tenant: the input field that names it (`tenant: 'customer_id'`). Its handler
      writes that tenant's rows as a member's would, owner placed for it, and the platform's own rows; nothing of any
      other tenant's. The field is a required text or reference field, asked whatever the record says. */
  readonly tenant?: keyof I & string;
  readonly audit?: BusinessCommandAudit;
  /** What the command keeps: `none`, `receipts` or `audit`; overrides the App's `track`. See BusinessCommand. */
  readonly track?: 'none' | 'receipts' | 'audit';
  readonly support?: 'refuse';
  handle(
    context: CommandHandlerContext<Src, Target, Read, Write, Many, Lookup, Pub>,
    input: Input,
  ): Loose<NoInfer<Output>> | Promise<Loose<NoInfer<Output>>>;
}

/* What a handler's return is checked against: the output's shape with each
   literal loosened to its primitive. The output type is the shape's alone
   (NoInfer), and TypeScript types a returned `'Lead converted.'` as string
   before it knows that shape, so the exact literal is the shape's to check,
   at run time, as it checks every value. */
type Loose<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends readonly (infer Item)[]
        ? Loose<Item>[]
        : T extends object
          ? { [K in keyof T]: Loose<T[K]> }
          : T;

/** A registered command, as the executor and the authorizer read it. */
export interface BusinessCommand<Input, Output, I extends CommandInput = CommandInput> {
  /** The contract's version: 1, or authority.lock's once a breaking change was bumped. Keys receipts, jobs and API routes. */
  readonly version: number;
  readonly source: string;
  /** Source-local. */
  readonly target: string;
  /** The whole footprint, the target first. */
  readonly read: readonly string[];
  /** The whole written footprint, the target first. */
  readonly write: readonly string[];
  /** Tables of `read` read under the command's own authority, not the caller's (CommandDefinition.elevate). */
  readonly elevate?: { readonly read: readonly string[] };
  /** The input declaration, the only one: the App is served it. */
  readonly input: I;
  /** The declaration parsed into its field list: what the server reads a request by, and what the browser draws. */
  readonly fields: readonly AppCommandField[];
  readonly when?: string;
  /** Rules over the whole draft, judged after the input's own and before `validate` (CommandRule). */
  readonly rules?: readonly DraftRule[];
  readonly enabledBy?: CommandFlagGate;
  readonly validate?: CommandValidate<I, Input>;
  initial?(context: BusinessCommandInitialContext): CommandInitialOf<I> | Promise<CommandInitialOf<I>>;
  availability?(context: BusinessCommandAvailabilityContext): readonly boolean[] | Promise<readonly boolean[]>;
  readonly output: Shape<Output>;
  readonly events?: Readonly<Record<string, BusinessEventProjection<NoInfer<Output>> | BusinessEventPick<NoInfer<Output>>>>;
  /** Posted to their webhooks once the command commits; recorded as the platform's `effect.<name>` events. */
  readonly effects?: Readonly<Record<string, CommandEffect<Output>>>;
  /** What `lookup` reads, by source. */
  readonly sources?: Readonly<Record<string, readonly string[]>>;
  /** What `lookup` calls, by integration. */
  readonly integrations?: Readonly<Record<string, readonly string[]>>;
  lookup?(context: BusinessCommandLookupContext, input: Input): unknown;
  /**
   * Runnable by a public principal through an App's public form, and by nothing
   * else: a public command may not be granted to a role. It names no existing
   * row (it implies `targets: 'none'`) and reads only within its own footprint.
   */
  readonly public?: true;
  /**
   * `'many'` accepts an ordered list of keys in one request and hands the
   * handler `records`; the whole list commits or nothing does. Neither a
   * public nor an event-emitting command may be `'many'` yet. `'none'` names
   * no record: a form's command, public or signed in.
   */
  readonly targets?: 'one' | 'many' | 'none';
  /**
   * The realm the command runs in: a tenant's (the default), or the platform
   * realm's (`auth.tenancy.platform`). A platform command writes platform rows
   * and updates a tenant's, across tenants; it never inserts or deletes a
   * tenant's row, never sets an owner, and is neither public nor
   * event-emitting — unless it names one tenant to act in (`tenant`).
   */
  readonly realm?: 'tenant' | 'platform';
  /**
   * A platform command that acts in one tenant names the input field that
   * says which. The runtime reads that tenant's row, active, before the
   * transaction and fences it there; the handler then inserts, updates and
   * removes that tenant's rows as a member's command would, owner placed for
   * it, beside the platform's own rows, and no other tenant's row is in its
   * scope. The receipt is the platform member's; every audit row names the
   * tenant (or the platform, for a platform row).
   */
  readonly tenant?: keyof I & string;
  /**
   * What the command audit keeps of each write's before and after image.
   * `redact: 'values'` keeps every operation, resource, record key and column
   * name and replaces each value with {@link AUDIT_REDACTED}; a list of column
   * names replaces only those columns' values, in every resource the command
   * writes. Record keys are identity and are always kept. Omitted, the audit
   * keeps full values — except on a `public` command, whose default is
   * `'values'`. Receipts, replay and the idempotency fingerprint are
   * unaffected, so changing it is not a breaking change.
   */
  readonly audit?: BusinessCommandAudit;
  /**
   * What running the command keeps, beyond its own writes:
   * - `none`: nothing. A retry after a lost answer runs it again.
   * - `receipts`: a receipt per request, so a retry with the same
   *   idempotency key is answered by the first run instead of a second one.
   * - `audit`: the receipt and every change the command made, before and
   *   after (as `audit` redacts it).
   * Overrides the App's `track`; absent, the App's, else `none`. A command
   * reached through a door that retries — the App API, MCP, a job, a request
   * with an Idempotency-Key header — keeps at least receipts whatever is
   * declared, and one that records events keeps its audit.
   */
  readonly track?: 'none' | 'receipts' | 'audit';
  /**
   * Whether an operator inside a dealer may run this command. Commands are
   * allowed under a support session by default, because a session exists to get
   * the dealer's work done and every change it makes is recorded beside it.
   * `'refuse'` withholds one anyway: an operation whose consequence leaves the
   * dealer's own records — paying out, sending to a customer, closing an
   * account for good — is the dealer's to run, not the lender's to run for
   * them. It narrows nothing else: the same command stays available to the
   * dealer's own members.
   */
  readonly support?: 'refuse';
  /** See CommandDefinition.appendOnly: the stale check waits for a write to the target, if the command makes one. */
  readonly appendOnly?: true;
  readonly handle: (context: BusinessCommandContext, input: Input) => Output | Promise<Output>;
}

export interface BusinessCommandAudit {
  readonly redact?: 'values' | readonly string[];
}

/** What a redacted value is written as in `__mistri_command_audit.changes_json`. */
export const AUDIT_REDACTED = '[redacted]';

// A registry is heterogeneous. Its named members retain their concrete input/output types.
// The eventual dispatcher must parse unknown input before calling an erased member.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyBusinessCommand = BusinessCommand<any, any, any>;
/** What a definition says that the platform would say without it, kept for `check` (commandRestated.ts). */
const restatements = new WeakMap<object, readonly string[]>();
export const commandRestatements = (command: object): readonly string[] => restatements.get(command) ?? [];

export type BusinessCommandRegistry = Readonly<Record<string, AnyBusinessCommand>>;

export class BusinessCommandDefinitionError extends Error {
  readonly code = 'invalid-command-definition';
  constructor(message: string) {
    super(message);
    this.name = 'BusinessCommandDefinitionError';
  }
}

/** A lookup this App cannot run, refused with why and what is allowed: never behind a stage's generic refusal. */
export class CommandLookupRefusal extends BusinessCommandDefinitionError {
  constructor(message: string) {
    super(message);
    this.name = 'CommandLookupRefusal';
  }
}

const reserved = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const commandIdentifier = /^[A-Za-z][A-Za-z0-9_-]*$/;
const registered = new WeakSet<object>();
const commandEvents = new WeakMap<object, unknown>();
/* Every event slot a command's batch carries, its effects' included: what its fingerprint names. */
const commandSlots = new WeakMap<object, readonly string[]>();
const commandEffects = new WeakMap<object, CapturedEffects['targets']>();
/* The callbacks as registration captured them: replacing one on the
   caller's object afterwards changes nothing that runs. */
const commandRules = new WeakMap<
  object,
  {
    validate?: (...args: unknown[]) => unknown;
    initial?: (...args: unknown[]) => unknown;
    availability?: (...args: unknown[]) => unknown;
    lookup?: (...args: unknown[]) => unknown;
  }
>();
const definitionKeys = new Set([
  'source',
  'target',
  'read',
  'write',
  'appendOnly',
  'elevate',
  'input',
  'when',
  'rules',
  'validate',
  'initial',
  'output',
  'events',
  'effects',
  'sources',
  'integrations',
  'lookup',
  'public',
  'targets',
  'audit',
  'track',
  'realm',
  'tenant',
  'support',
  'handle',
  'availability',
  'enabledBy',
]);
const fail = (message: string): never => {
  throw new BusinessCommandDefinitionError(message);
};

/*
 * `tenant: 'customer_id'`: the input field naming the one tenant a platform
 * command acts in. It is read from every run's request before the transaction
 * opens, so it is always there and always the value the form asked: a required
 * text or reference field at the top of the input, asked whatever the record
 * says, kept as itself rather than a hash.
 */
function tenantOption(value: unknown, fields: readonly AppCommandField[]): void {
  if (typeof value !== 'string' || !value) fail('Command tenant must name an input field.');
  const field = fields.find((candidate) => candidate.name === value);
  if (!field) fail(`Command tenant names "${String(value)}", which is not a field of its input.`);
  if (field!.type !== 'text' && field!.type !== 'reference')
    fail(`Command tenant names "${String(value)}", a ${field!.type} field; a tenant is named by a text or reference field.`);
  if (field!.required !== true || field!.when !== undefined)
    fail(
      `Command tenant names "${String(value)}", which a run may leave empty; the field naming the tenant is required, whatever the record says.`,
    );
  if (field!.type === 'text' && field!.sensitive)
    fail(`Command tenant names "${String(value)}", a sensitive field; the command reads the tenant itself, not what is kept of it.`);
}

/*
 * `rules: [{ must: 'confirm_email = email', message: 'The email addresses do not match.' }]`: conditions over the
 * draft, in the language a resource's validation speaks, naming this input's own fields and nothing it reads — no
 * record, no table, so a step's check can never be a lookup. Never a sensitive field: nothing reads its value.
 */
const RULES_MOST = 64;
function rulesOption(value: unknown, fields: readonly AppCommandField[]): readonly DraftRule[] {
  if (!Array.isArray(value) || value.length > RULES_MOST)
    return fail(`Command rules are a list of at most ${RULES_MOST} { must, message } (and when), each a condition over the input.`);
  const top = new Map(fields.map((field) => [field.name, field]));
  return Object.freeze(
    value.map((raw, index) => {
      const at = `Command rules ${index + 1}`;
      const rule = plainRecord(raw, at);
      for (const key of Object.keys(rule))
        if (!['must', 'when', 'message'].includes(key)) fail(`${at} has an unknown option: ${key}. It takes must, when and message.`);
      if (typeof rule.message !== 'string' || !rule.message.trim() || rule.message.length > 200)
        fail(`${at} needs a message of at most 200 characters: what the form says at the field.`);
      for (const key of ['must', 'when'] as const) {
        if (rule[key] === undefined) continue;
        if (typeof rule[key] !== 'string' || !rule[key].trim() || rule[key].length > 1000)
          fail(`${at} has a ${key} that is not a condition.`);
        let names: { fields: string[]; record: string[] };
        try {
          names = draftNames(rule[key] as string, `${at}, ${key}`);
        } catch (error) {
          return fail((error as Error).message);
        }
        if (names.record.length) fail(`${at} reads record.${names.record[0]}; a rule reads the input alone.`);
        if (key === 'must' && !names.fields.length) fail(`${at} names no field in must; a rule is about the input.`);
        for (const name of names.fields) {
          const field = top.get(name);
          if (!field) fail(`${at} names "${name}", which is not a field of the input.`);
          if (field!.type === 'text' && field!.sensitive)
            fail(`${at} names "${name}", a sensitive field; nothing reads a sensitive value.`);
          if (['group', 'lines', 'richText', 'choices', 'defined'].includes(field!.type))
            fail(`${at} names "${name}", a ${field!.type} field a rule cannot compare.`);
        }
      }
      if (rule.must === undefined) fail(`${at} needs must: the condition the input must meet.`);
      return Object.freeze({
        must: (rule.must as string).trim(),
        ...(rule.when === undefined ? {} : { when: (rule.when as string).trim() }),
        message: (rule.message as string).trim(),
      });
    }),
  );
}

/** Internal: the command's rules a parsed input breaks, at their fields. */
function registeredRuleBreaks(command: AnyBusinessCommand, input: unknown, now = new Date()): Array<{ field: string; message: string }> {
  if (!command.rules?.length || !input || typeof input !== 'object') return [];
  return brokenRules(command.rules, input as Record<string, unknown>, command.fields, now);
}

/*
 * `elevate: { read: [...] }`: tables of the read footprint the handler reads
 * under the command's authority. Each is named in `read` as well — the
 * handler's typed `db` is built from `read` — so `elevate` only says whose
 * authority a read is under, never a second footprint. Never the target or a
 * written table: whoever runs a command reads its target (it is shown to them)
 * and must be able to write what it writes.
 */
function elevateOption(
  value: unknown,
  target: string,
  reads: readonly string[],
  writes: readonly string[],
): { readonly read: readonly string[] } {
  const record = plainRecord(value, 'Command elevate');
  for (const key of Object.keys(record)) if (key !== 'read') fail(`Command elevate has an unknown option: ${key}. It takes read.`);
  const tables = resources(record.read, 'Command elevate read');
  if (!tables.length)
    fail('Command elevate read names no table: name the tables of read the handler reads above the caller, or drop elevate.');
  for (const table of tables) {
    if (table === target) fail(`Command elevate read names the target "${table}"; whoever runs a command reads its target.`);
    if (writes.includes(table))
      fail(`Command elevate read names "${table}", which it writes; whoever runs a command must write what it writes.`);
    if (!reads.includes(table)) fail(`Command elevate read names "${table}", which is not in its read footprint; add it to read.`);
  }
  return Object.freeze({ read: Object.freeze([...tables]) });
}

/** The tables a command reads under its caller's authority: its footprint less what it elevates. */
export function callerRead(command: Pick<BusinessCommand<unknown, unknown>, 'read' | 'elevate'>): readonly string[] {
  const elevated = command.elevate?.read;
  return elevated?.length ? command.read.filter((table) => !elevated.includes(table)) : command.read;
}

function plainRecord(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(`${where} must be a plain object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return fail(`${where} must not inherit configuration.`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || reserved.has(key)) return fail(`${where} has an unsafe property.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) return fail(`${where} must contain only enumerable data properties.`);
  }
  return value as Record<string, unknown>;
}

function logicalName(value: unknown, where: string): string {
  if (typeof value !== 'string' || !identifier.test(value) || reserved.has(value)) {
    return fail(`${where} must be an unqualified, non-reserved identifier.`);
  }
  return value;
}

/** A list of distinct source-local tables; absent is none. */
function resources(value: unknown, where: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return fail(`${where} must be a list of source-local resources.`);
  const names: string[] = [];
  for (const item of value) {
    const name = logicalName(item, where);
    if (names.includes(name)) return fail(`${where} contains a duplicate resource.`);
    names.push(name);
  }
  return names;
}

function validator<T>(value: unknown, where: string): Shape<T> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(`${where} must be a shape: a synchronous parse function.`);
  const parse = (value as { parse?: unknown }).parse;
  if (typeof parse !== 'function') return fail(`${where} must be a shape: a synchronous parse function.`);
  // Do not invoke application validators during registration. Capture their method
  // so replacing it after registration cannot change the validated definition.
  return preserveShapeDescriptor(
    value,
    Object.freeze({
      parse(input: unknown): T {
        const result: unknown = Reflect.apply(parse, value, [input]);
        if (
          result !== null &&
          (typeof result === 'object' || typeof result === 'function') &&
          typeof (result as { then?: unknown }).then === 'function'
        ) {
          // A mistaken async parser may already have rejected. Consume that
          // rejection while refusing its asynchronous result synchronously.
          void Promise.resolve(result).catch(() => {});
          return fail(`${where} must return synchronously, not a promise.`);
        }
        return result as T;
      },
    }),
  );
}

/* An audit option is data the executor reads on every write, so it is
   captured whole here: a plain object with one known key, and a list of
   distinct unqualified column names or the single word 'values'. */
function auditOption(value: unknown): BusinessCommandAudit {
  const audit = plainRecord(value, 'Command audit');
  for (const key of Object.keys(audit)) if (key !== 'redact') fail(`Command audit has an unknown option: ${key}.`);
  if (!Object.hasOwn(audit, 'redact')) return Object.freeze({});
  if (audit.redact === 'values') return Object.freeze({ redact: 'values' as const });
  if (!Array.isArray(audit.redact)) return fail('Command audit redact must be "values" or a list of column names.');
  const columns: string[] = [];
  for (const column of audit.redact as unknown[]) {
    if (typeof column !== 'string' || !identifier.test(column)) fail('Command audit redact must list unqualified column names.');
    if (columns.includes(column as string)) fail('Command audit redact contains a duplicate column.');
    columns.push(column as string);
  }
  return Object.freeze({ redact: Object.freeze(columns) });
}

/* `when` is the query language the executor compiles against the target on every run, and the App's buttons ask the browser. */
function whenOption(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000)
    fail("Command when must be nonempty query-language text, like 'status = open'.");
  return (value as string).trim();
}

/* `validate` as registration captures it: the function itself, or a
   Standard Schema's own validate, whose first issue refuses the input by the
   path it names (nothing else of it is kept or echoed). A schema that answers
   asynchronously is refused like an async function: validate runs before the
   transaction, synchronously. */
function validateOption(value: unknown): (...args: unknown[]) => unknown {
  if (typeof value === 'function') return value as (...args: unknown[]) => unknown;
  const standard =
    value && typeof value === 'object' ? (value as { '~standard'?: { version?: unknown; validate?: unknown } })['~standard'] : undefined;
  if (!standard || standard.version !== 1 || typeof standard.validate !== 'function') {
    return fail('Command validate must be a function or a Standard Schema.');
  }
  const check = standard.validate as (input: unknown) => unknown;
  return (input: unknown) => {
    const result = Reflect.apply(check, standard, [input]) as StandardResult<unknown> | PromiseLike<unknown>;
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') return result;
    const outcome = result as StandardResult<unknown>;
    if (!outcome.issues) return outcome.value;
    const path = (outcome.issues[0]?.path ?? [])
      .map((part) => (part && typeof part === 'object' ? part.key : part))
      .reduce<string>(
        (text, part) => (typeof part === 'number' ? `${text}[${part}]` : text ? `${text}.${String(part)}` : String(part)),
        '',
      );
    throw new CommandInputRefusal(COMMAND_FIELD_PATH.test(path) ? path : '', 'type');
  };
}

/* `integrations` names each integration a lookup calls, and the actions of it:
   `{ fakepay: ['charge'] }`. Whether they exist is the App's to say once its
   jobs module lists them (integrations/integrationChecks.ts). */
function integrationsOption(value: unknown): Readonly<Record<string, readonly string[]>> {
  const declared = plainRecord(value, 'Command integrations');
  const entries = Object.entries(declared);
  if (!entries.length || entries.length > 8) fail('Command integrations names from 1 to 8 integrations.');
  const out: Record<string, readonly string[]> = {};
  for (const [name, actions] of entries) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(name))
      fail(`Command integrations "${name}" is not an integration's name: lowercase letters, digits and hyphens.`);
    if (
      !Array.isArray(actions) ||
      !actions.length ||
      actions.length > 16 ||
      actions.some((action) => typeof action !== 'string' || !identifier.test(action)) ||
      new Set(actions).size !== actions.length
    )
      fail(`Command integrations "${name}" lists the actions the lookup calls: ${name}: ['charge'].`);
    out[name] = Object.freeze([...(actions as string[])]);
  }
  return Object.freeze(out);
}

/* `sources` names App sources, and the resources of each a lookup reads:
   data the binding judges against the App, captured and frozen here. */
function sourcesOption(value: unknown): Readonly<Record<string, readonly string[]>> {
  const sources = plainRecord(value, 'Command sources');
  const entries = Object.entries(sources);
  if (!entries.length || entries.length > 8) fail('Command sources names from 1 to 8 sources.');
  const result: Record<string, readonly string[]> = {};
  for (const [source, tables] of entries) {
    logicalName(source, 'Command sources');
    const names = resources(tables, `Command sources "${source}"`);
    if (!names.length || names.length > 16) fail(`Command sources "${source}" names from 1 to 16 resources.`);
    result[source] = Object.freeze([...names]);
  }
  return Object.freeze(result);
}

const freezeDeep = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
};

/**
 * Validate and freeze a server definition without invoking its validators or handler.
 * This is a trusted-code API, not a sandbox or a resource-authorization boundary.
 * The input type is the declaration's (CommandInputOf), or what `validate` returns.
 */
export function defineCommand<
  const I extends CommandInput,
  Output,
  Input = CommandInputOf<I>,
  Src = string,
  const Target extends string = string,
  const Read extends readonly (keyof Tables<Src, Target> & string)[] = [],
  const Write extends readonly (keyof Tables<Src, Target> & string)[] = [],
  const Many extends 'one' | 'many' | 'none' | undefined = undefined,
  Lookup = undefined,
  Init extends CommandInitialOf<I> = CommandInitialOf<I>,
  const When extends string = string,
  const Pub extends true | undefined = undefined,
  const Uses extends IntegrationUses = {},
>(
  definition: CommandDefinition<I, Output, Input, Src, Target, Read, Write, Many, Lookup, Init, Pub, Uses> &
    InitialSaysValues<Init> &
    /* A registered integration's actions are named as its package declares them (integrationModule.ts). */
    NoInfer<IntegrationUsesGuard<Uses>> &
    /* `when` is read against the target's columns where the App's generated schema registers them (packages/mistri/schema/query.d.ts). */
    { readonly when?: When } & NoInfer<WhenGuard<Target, When>>,
): BusinessCommand<Input, Output, I> {
  const value = plainRecord(definition, 'Command');
  for (const key of Object.keys(value)) {
    if (!definitionKeys.has(key)) fail(`Command has an unknown option: ${key}.`);
  }
  // Absent is the common slip (a docs example once left it out), and "not an identifier" did not say so.
  if (value.source === undefined) fail("Command has no source: name the App source it runs on, as `source: 'business'`.");
  const source = logicalName(sourceName(value.source), 'Command source');
  // A reference writes a secondary source's target qualified by that source.
  const written =
    typeof value.target === 'string' && value.target.startsWith(`${source}.`) ? value.target.slice(source.length + 1) : value.target;
  const target = logicalName(written, 'Command target');
  // The target is always read and written, and whatever is written is read:
  // naming either again is redundant, never a second footprint, so a
  // registered command's own footprint spreads back in unchanged.
  const writes = resources(value.write, 'Command write footprint').filter((table) => table !== target);
  const reads = resources(value.read, 'Command read footprint').filter((table) => table !== target && !writes.includes(table));
  const read = Object.freeze([target, ...reads, ...writes]),
    write = Object.freeze([target, ...writes]);
  const elevate = Object.hasOwn(value, 'elevate') ? elevateOption(value.elevate, target, reads, writes) : undefined;
  if (elevate && value.public === true) fail('A public command has no role to read above: drop its elevate.');
  if (typeof value.handle !== 'function') fail('Command handler must be a function.');
  if (Object.hasOwn(value, 'initial') && typeof value.initial !== 'function') fail('Command initial must be a function.');
  if (Object.hasOwn(value, 'availability') && typeof value.availability !== 'function') fail('Command availability must be a function.');
  const validate = Object.hasOwn(value, 'validate') ? validateOption(value.validate) : undefined;
  if (Object.hasOwn(value, 'targets') && !['one', 'many', 'none'].includes(value.targets as string))
    fail('Command targets must be "one", "many" or "none".');
  // A command names an existing record unless it says it names none: a form's command. A public one is one.
  if (value.public === true && value.targets !== undefined && value.targets !== 'none')
    fail('A public command runs from a public form and names no record: drop its targets.');
  const names = value.targets !== 'none' && value.public !== true;
  if (Object.hasOwn(value, 'availability') && !names)
    fail("Command availability judges existing target records; a command with targets: 'none' names none.");
  if (Object.hasOwn(value, 'public') && value.public !== true) fail('Command public must be true when present.');
  if (value.targets === 'many' && Object.hasOwn(value, 'events'))
    fail('A command that targets many cannot emit events yet: an event batch belongs to one audited target.');
  if (Object.hasOwn(value, 'when') && !names)
    fail("Command when is a precondition on its record; a command with targets: 'none' names none.");
  if (Object.hasOwn(value, 'realm') && value.realm !== 'tenant' && value.realm !== 'platform')
    fail('Command realm must be "tenant" or "platform".');
  if (Object.hasOwn(value, 'appendOnly') && value.appendOnly !== true) fail('Command appendOnly must be true when present.');
  if (value.appendOnly === true && (!names || write.length < 2))
    fail('Command appendOnly adds rows beside the record it acts on; it needs a target record and a table in write beyond it.');
  // One word, and only the withholding one: there is no "allow" to write,
  // because allowed is what a command already is under support.
  if (Object.hasOwn(value, 'support') && value.support !== 'refuse') fail('Command support must be "refuse" when present.');
  // The platform realm's commands are refused under support for the whole
  // account already (tenantContexts.ts), so saying it again per command would
  // read as if the rule were this option's to grant.
  if (value.support === 'refuse' && value.realm === 'platform') {
    fail('A platform-realm command is already refused while its account is inside a dealer, so it takes no support option.');
  }
  // The platform realm's commands run from its signed-in context only and
  // emit no events: an event batch is a tenant's, read by that tenant's consumers.
  if (value.realm === 'platform' && (value.public === true || Object.hasOwn(value, 'events'))) {
    fail('A platform command is neither public nor event-emitting.');
  }
  if (Object.hasOwn(value, 'tenant') && value.realm !== 'platform')
    fail(
      "Command tenant names the tenant a platform command acts in; a tenant's own command acts in its own. Add realm: 'platform', or drop tenant.",
    );
  if (Object.hasOwn(value, 'initial') && (value.targets === 'many' || value.public === true)) {
    fail(
      "Command initial prefills a signed-in form, over one record or none (targets: 'none'); a selection's command and a public form's prepare none.",
    );
  }
  const sources = Object.hasOwn(value, 'sources') ? sourcesOption(value.sources) : undefined;
  const integrations = Object.hasOwn(value, 'integrations') ? integrationsOption(value.integrations) : undefined;
  if (Object.hasOwn(value, 'lookup') && typeof value.lookup !== 'function') fail('Command lookup must be a function.');
  if ((sources !== undefined || integrations !== undefined) !== Object.hasOwn(value, 'lookup')) {
    fail(
      integrations !== undefined
        ? 'Command integrations are called from its lookup, before the transaction opens: declare a lookup beside them.'
        : 'Command lookup reads its "sources", and only a lookup reads them: declare both, or neither.',
    );
  }
  // A call is made once per request and recorded; the command's own transaction stays the database's alone.
  if (integrations !== undefined && value.targets === 'many')
    fail('A command that targets many cannot call integrations yet: a call is recorded once per request, for one record.');
  let effects: CapturedEffects | undefined;
  if (Object.hasOwn(value, 'effects')) {
    try {
      effects = captureCommandEffects(value.effects);
    } catch (error) {
      return fail(`Command ${(error as Error).message}`);
    }
    // An effect is recorded as an event, so it goes where events go.
    if (value.targets === 'many')
      fail('A command that targets many cannot have effects yet: an effect is an event, and an event batch belongs to one audited target.');
    if (value.realm === 'platform') fail('A platform command is neither public nor event-emitting, so it has no effects.');
  }
  let fields: readonly AppCommandField[], input: CommandInput;
  try {
    // A command that asks nothing leaves `input` out.
    fields = freezeDeep(parseCommandInput(value.input ?? {}, 'Command input', { publicForm: value.public === true }));
    input = freezeDeep(structuredClone((value.input ?? {}) as CommandInput));
  } catch (error) {
    return fail((error as Error).message);
  }
  /* A number's live lines read as the page reads them (CommandLive.tsx), so a line that cannot be worked out fails
     here, not blank there. Here rather than in the shared parser, which the first paint carries without the
     expression parser. */
  for (const each of fields) {
    if ((each.type !== 'number' && each.type !== 'money') || !each.live) continue;
    const numbers = new Set(fields.filter((other) => other.type === 'number' || other.type === 'money').map((other) => other.name));
    for (const [word, expression] of Object.entries(each.live)) {
      try {
        parseComputed(expression, (name) => numbers.has(name));
      } catch (error) {
        return fail(`Command input, input "${each.name}" live "${word}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  for (const { field, path } of commandFieldsDeep(fields)) {
    // An input asked by the record's state is one record's to ask; one asked by the draft is any command's.
    if (
      field.type !== 'group' &&
      field.type !== 'lines' &&
      field.when !== undefined &&
      (value.targets ?? 'one') !== 'one' &&
      readsRecord(field.when)
    )
      fail(
        `Command input "${path}" is asked "when: ${field.when}", which reads the record (record.<column>), and only a command that targets one record has one.`,
      );
    /* Questions defined in rows are read through the command's own reads, as its handler reads, and
       `whose` picks them by the one record a form asks about. */
    if (field.type === 'defined') {
      // The form shows the questions to whoever fills it in, so they are read as that reader reads, never elevated.
      if (!read.includes(field.from) || elevate?.read.includes(field.from))
        fail(`Command input "${path}" asks the questions in "${field.from}"; declare it among the command's read, not elevated.`);
      if (field.whose !== undefined && (value.targets ?? 'one') !== 'one')
        fail(
          `Command input "${path}" picks its questions by the record (whose: '${field.whose}'), which only a command that targets one record has.`,
        );
      continue;
    }
    /* A record's lines are rows the handler writes in its own transaction: the grant to write them is the
       command's footprint, so a role that may run it need not write the table. */
    if (field.type === 'lines') {
      if (!write.includes(field.from) || field.from === target)
        fail(`Command input "${path}" asks lines of "${field.from}"; declare it among the command's write, beside its target.`);
      continue;
    }
    if (field.type === 'group' || field.default === undefined) continue;
    const start = field.default;
    if (typeof start === 'object') {
      // The record is read when one record's form is prepared, and the reader when a signed-in form is (a
      // form's command prepares over no record); a batch has neither, a public form no reader.
      if ('record' in start && (value.targets ?? 'one') !== 'one')
        fail(`Command input "${path}" starts from the record, which only a command that targets one record reads.`);
      if ('auto' in start && start.auto === 'me' && value.targets === 'many')
        fail(`Command input "${path}" starts from the reader, which a selection's command does not prepare.`);
      continue;
    }
    // A literal must be an answer the field itself accepts.
    const { below: _below, above: _above, ...alone } = field as AppCommandField & { below?: string; above?: string };
    try {
      readCommandInput([alone as AppCommandField], { [field.name]: start }, { partial: true });
    } catch {
      fail(`Command input "${path}" starts as ${JSON.stringify(start)}, which the field itself refuses.`);
    }
  }
  if (Object.hasOwn(value, 'tenant')) tenantOption(value.tenant, fields);
  const rules = Object.hasOwn(value, 'rules') ? rulesOption(value.rules, fields) : undefined;
  const audit = Object.hasOwn(value, 'audit') ? auditOption(value.audit) : undefined;
  if (Object.hasOwn(value, 'track') && !['none', 'receipts', 'audit'].includes(value.track as string))
    fail('Command track must be "none", "receipts" or "audit".');
  const when = Object.hasOwn(value, 'when') ? whenOption(value.when) : undefined;
  let enabledBy: CommandFlagGate | undefined;
  if (Object.hasOwn(value, 'enabledBy')) {
    try {
      enabledBy = captureCommandFlagGate(value.enabledBy);
    } catch (error) {
      return fail((error as Error).message);
    }
  }
  let events: BusinessCommand<Input, Output>['events'], capturedEvents: CapturedCommandEvents<Output> | undefined;
  let slots: readonly string[] | undefined;
  if (Object.hasOwn(value, 'events') || effects) {
    let refusal = 'Command events must be named typed event projections.';
    try {
      const declared = Object.hasOwn(value, 'events') ? (value.events as NonNullable<typeof events>) : undefined;
      // Checked as written first (data properties only), and never under a name effects are recorded under.
      let outputShape: ReturnType<typeof describeShape> | undefined;
      try {
        outputShape = describeShape(value.output ?? NO_OUTPUT);
      } catch {
        /* a hand-written output names no fields to check a pick against */
      }
      if (declared && captureCommandEvents(declared, outputShape).expectation.some((event) => event.name.startsWith(EFFECT_EVENT_PREFIX))) {
        refusal = 'Command events may not use "effect." names: "effect." is the platform\'s, for effects.';
        throw new Error();
      }
      const merged: Record<string, BusinessEventProjection<Output> | BusinessEventPick<Output>> = { ...declared };
      for (const [slot, projection] of Object.entries(effects?.slots ?? {})) {
        if (Object.hasOwn(merged, slot)) {
          refusal = `Command events slot "${slot}" is where an effect is recorded; name the event another way.`;
          throw new Error();
        }
        merged[slot] = projection as BusinessEventProjection<Output>;
      }
      capturedEvents = captureCommandEvents(merged, outputShape);
      // Capture the named surface too; callers retain their original declaration
      // object, while the private captured projector is never replaced.
      if (declared) events = Object.freeze({ ...declared });
      slots = Object.freeze(Object.keys(merged).sort());
    } catch {
      return fail(refusal);
    }
  }
  const result = {
    version: 1,
    source,
    target,
    read,
    write,
    ...(elevate === undefined ? {} : { elevate }),
    input: input as I,
    ...(when === undefined ? {} : { when }),
    ...(rules === undefined ? {} : { rules }),
    ...(enabledBy === undefined ? {} : { enabledBy }),
    ...(Object.hasOwn(value, 'validate') ? { validate: value.validate as BusinessCommand<Input, Output, I>['validate'] } : {}),
    ...(Object.hasOwn(value, 'initial') ? { initial: value.initial as BusinessCommand<Input, Output, I>['initial'] } : {}),
    ...(Object.hasOwn(value, 'availability')
      ? { availability: value.availability as BusinessCommand<Input, Output, I>['availability'] }
      : {}),
    output: value.output === undefined ? (NO_OUTPUT as Shape<Output>) : validator<Output>(value.output, 'Command output'),
    ...(events === undefined ? {} : { events }),
    ...(effects === undefined
      ? {}
      : { effects: Object.freeze({ ...(value.effects as NonNullable<BusinessCommand<Input, Output, I>['effects']>) }) }),
    ...(sources === undefined ? {} : { sources }),
    ...(integrations === undefined ? {} : { integrations }),
    ...(Object.hasOwn(value, 'lookup') ? { lookup: value.lookup as BusinessCommand<Input, Output, I>['lookup'] } : {}),
    ...(value.public === true ? { public: true as const } : {}),
    ...(value.public === true
      ? { targets: 'none' as const }
      : value.targets === undefined
        ? {}
        : { targets: value.targets as 'one' | 'many' | 'none' }),
    ...(value.realm === undefined ? {} : { realm: value.realm as 'tenant' | 'platform' }),
    ...(value.tenant === undefined ? {} : { tenant: value.tenant as keyof I & string }),
    ...(audit === undefined ? {} : { audit }),
    ...(value.track === undefined ? {} : { track: value.track as 'none' | 'receipts' | 'audit' }),
    ...(value.support === undefined ? {} : { support: value.support as 'refuse' }),
    ...(value.appendOnly === true ? { appendOnly: true as const } : {}),
    handle: value.handle as BusinessCommand<Input, Output, I>['handle'],
  } as BusinessCommand<Input, Output, I>;
  // Derived, so not spread: a registered command spreads back into defineCommand as its definition.
  Object.defineProperty(result, 'fields', { value: fields, enumerable: false });
  Object.freeze(result);
  registered.add(result);
  if (capturedEvents) commandEvents.set(result, capturedEvents);
  if (slots) commandSlots.set(result, slots);
  if (effects) commandEffects.set(result, effects.targets);
  const stated: string[] = [];
  if (value.public === true && value.targets === 'none') stated.push("targets: 'none' is implied by public: true. Delete it.");
  // The executor parses the handler's return against `output` already; parsing it again in the handler repeats that.
  if (typeof value.handle === 'function' && /\breturn\s+[A-Za-z_$][\w$]*\.parse\(\{/.test(String(value.handle))) {
    stated.push('the handler returns out.parse({ … }), which the executor already does against `output`. Return the object.');
  }
  if (stated.length) restatements.set(result, stated);
  commandRules.set(result, {
    ...(validate ? { validate } : {}),
    ...(typeof value.initial === 'function' ? { initial: value.initial as (...args: unknown[]) => unknown } : {}),
    ...(typeof value.availability === 'function' ? { availability: value.availability as (...args: unknown[]) => unknown } : {}),
    ...(typeof value.lookup === 'function' ? { lookup: value.lookup as (...args: unknown[]) => unknown } : {}),
  });
  return result;
}

/** A line's cell read against the catalog the command runs over (commandInput.ts `lineCell`). */
type ReadCellOption = NonNullable<Parameters<typeof readCommandInput>[2]>['cell'];

/**
 * Internal: a request's input read against the command's declaration, then
 * its own `validate`. Throws the declaration's CommandInputRefusal, or
 * whatever `validate` throws; the executor classifies both.
 */
export function parseRegisteredInput(
  command: AnyBusinessCommand,
  raw: unknown,
  context: BusinessCommandValidationContext,
  options: {
    publicForm: boolean;
    cell?: ReadCellOption;
    /** Each `keep: 'handler'` value, whole, for the executor's call to the handler and nothing else. */
    reveal?: (name: string, value: string) => void;
    /** The record-reading `when`s, bound to the target (commandDraft.ts); absent, those fields are judged later. */
    bound?: Readonly<Record<string, BoundCondition>>;
    now?: Date;
  },
): unknown {
  if (!registered.has(command)) return fail('Command must be created with defineCommand.');
  const read = readCommandInput(command.fields, raw, {
    publicForm: options.publicForm,
    richText: (value, most) => readRichTextInput(value, {}, most),
    ...(options.cell ? { cell: options.cell } : {}),
  });
  judgeDraft(command, read, options.bound, options.now);
  // A sensitive input is what it keeps from here on: validate, the handler, the fingerprint and the audit never hold the value.
  const parsed = cutSensitive(command.fields, read, context.actor.appId, options.reveal);
  const validate = commandRules.get(command)?.validate;
  if (!validate) return parsed;
  const result: unknown = Reflect.apply(validate, undefined, [parsed, context]);
  if (
    result !== null &&
    (typeof result === 'object' || typeof result === 'function') &&
    typeof (result as { then?: unknown }).then === 'function'
  ) {
    void Promise.resolve(result).catch(() => {});
    return fail('Command validate must return synchronously, not a promise.');
  }
  return result === undefined ? parsed : result;
}

/** A rule the draft breaks, or a field its conditions hide given or show missing: refused at that field. */
export class DraftRefusal extends Error {
  constructor(
    readonly path: string,
    readonly said?: string,
  ) {
    super('The command input is invalid.');
    this.name = 'DraftRefusal';
  }
}

/**
 * The draft's own conditions over a read input: a field its `when` hides must not be given, one it shows must be
 * unless optional; then the command's rules. A `when` that reads the record is judged only once bound (the run binds
 * it in its transaction, prepare where the form opens); unbound here, it waits.
 */
export function judgeDraft(
  command: AnyBusinessCommand,
  input: Readonly<Record<string, unknown>>,
  bound?: Readonly<Record<string, BoundCondition>>,
  now = new Date(),
): void {
  for (const field of command.fields) {
    if (field.type === 'group' || field.type === 'lines' || field.when === undefined) continue;
    const condition = bound?.[field.name] ?? (readsRecord(field.when) ? undefined : field.when);
    if (condition === undefined) continue;
    const shown = draftHolds(condition, input, command.fields, now);
    const given = Object.hasOwn(input, field.name);
    if (shown ? !given && field.required : given) throw new DraftRefusal(field.name);
  }
  const [broken] = registeredRuleBreaks(command, input, now);
  if (broken) throw new DraftRefusal(broken.field, broken.message);
}

/** Internal: the captured `initial`, when the command declares one. */
export function registeredInitial(command: AnyBusinessCommand): ((context: BusinessCommandInitialContext) => unknown) | undefined {
  if (!registered.has(command)) return fail('Command must be created with defineCommand.');
  const initial = commandRules.get(command)?.initial;
  return initial && ((context: BusinessCommandInitialContext) => Reflect.apply(initial, undefined, [context]));
}

/** Internal: capture only; callers still establish principal/record authority. */
export function registeredAvailability(
  command: AnyBusinessCommand,
): ((context: BusinessCommandAvailabilityContext) => unknown) | undefined {
  if (!registered.has(command)) return fail('Command must be created with defineCommand.');
  const availability = commandRules.get(command)?.availability;
  return availability && ((context: BusinessCommandAvailabilityContext) => Reflect.apply(availability, undefined, [context]));
}

/** Internal execution metadata; application code never receives a journal or
 * the ability to replace captured declarations after command registration. */
export function getCommandEvents<Input, Output>(command: BusinessCommand<Input, Output>): CapturedCommandEvents<Output> | undefined {
  if (!registered.has(command)) return fail('Command must be created with defineCommand.');
  return commandEvents.get(command) as CapturedCommandEvents<Output> | undefined;
}

/** Internal: every event slot the command's batch carries, its own and its effects', sorted: what its fingerprint names. */
export function commandEventSlots(command: AnyBusinessCommand): readonly string[] {
  if (!registered.has(command)) return fail('Command must be created with defineCommand.');
  return commandSlots.get(command) ?? [];
}

/** Internal: each effect's name and webhook, in declaration order, when the command has effects. */
export function getCommandEffects(command: AnyBusinessCommand): CapturedEffects['targets'] | undefined {
  if (!registered.has(command)) return fail('Command must be created with defineCommand.');
  return commandEffects.get(command);
}

/** Internal: the captured `lookup`, when the command declares one. */
export function registeredLookup(
  command: AnyBusinessCommand,
): ((context: BusinessCommandLookupContext, input: unknown) => unknown) | undefined {
  if (!registered.has(command)) return fail('Command must be created with defineCommand.');
  const lookup = commandRules.get(command)?.lookup;
  return lookup && ((context: BusinessCommandLookupContext, input: unknown) => Reflect.apply(lookup, undefined, [context, input]));
}

/**
 * A command's name is its key here — how the App names it — and nothing
 * else. Keep this registry on the server, never in an App manifest or
 * browser bundle.
 */
export function defineCommands<const Commands extends Record<string, AnyBusinessCommand>>(commands: Commands): Readonly<Commands> {
  const value = plainRecord(commands, 'Command registry');
  const entries = Object.entries(value);
  const result: Record<string, AnyBusinessCommand> = Object.create(null);
  for (const [id, definition] of entries) {
    if (!commandIdentifier.test(id)) fail('Command IDs must start with a letter and contain only letters, digits, underscores or hyphens.');
    if (!definition || typeof definition !== 'object' || !registered.has(definition)) {
      fail(`Command "${id}" must be created with defineCommand.`);
    }
    result[id] = definition as AnyBusinessCommand;
  }
  return Object.freeze(result) as Readonly<Commands>;
}

/**
 * Internal: the registry with each command at its contract's version, as
 * authority.lock records it (1 for a command the lock does not name). The
 * copies are registered as the originals were, with the same captured rules,
 * events and effects; a registry already at those versions comes back as it is.
 */
export function withCommandVersions(
  registry: BusinessCommandRegistry,
  versions: (id: string) => number | undefined,
): BusinessCommandRegistry {
  const entries = Object.entries(registry);
  if (entries.every(([id, command]) => command.version === (versions(id) ?? 1))) return registry;
  const result: Record<string, AnyBusinessCommand> = Object.create(null);
  for (const [id, command] of entries) {
    const version = versions(id) ?? 1;
    if (command.version === version) {
      result[id] = command;
      continue;
    }
    if (!registered.has(command)) fail(`Command "${id}" must be created with defineCommand.`);
    const copy = { ...command, version };
    Object.defineProperty(copy, 'fields', { value: command.fields, enumerable: false });
    Object.freeze(copy);
    registered.add(copy);
    for (const map of [commandEvents, commandSlots, commandEffects, commandRules] as WeakMap<object, unknown>[]) {
      if (map.has(command)) map.set(copy, map.get(command));
    }
    result[id] = copy as AnyBusinessCommand;
  }
  return Object.freeze(result);
}
