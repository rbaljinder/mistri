/*
 * The business events a command declares: defineEvent, and the projections
 * that turn a command's output into bounded event payloads. The readers that
 * never run application code, and the checks on a stored batch, live beside
 * the stores in adapters/events/commandEventCapture.ts.
 */
import { isProxy } from 'node:util/types';
import { describeShape, type Shape, type ShapeDescriptor } from './commandShapes.js';
import {
  COMMAND_EVENT_LIMITS,
  type CommandEventBatch,
  type CommandEventExpectation,
  type CommandEventJson,
} from '../../adapters/events/commandEventTypes.js';
import { canonicalCommandJson } from './commandPayload.js';
import {
  definitionError,
  detached,
  eventIdentity,
  exact,
  fields,
  identifier,
  payloadJson,
  projectionError,
  record,
} from '../../adapters/events/commandEventCapture.js';

/** Internal server-only authoring foundation. Nothing is registered with the
 * command executor or exported from a public package entry by this module. */
export { COMMAND_EVENT_LIMITS } from '../../adapters/events/commandEventTypes.js';
export {
  BusinessEventDefinitionError,
  BusinessEventProjectionError,
  captureCommandEventBatch,
  captureCommandEventManifest,
} from '../../adapters/events/commandEventCapture.js';

type PayloadShape<Payload> = { readonly [Key in keyof Payload]: CommandEventJson };
/** What an event payload may be: an object of JSON values. */
export type BusinessEventPayload<Payload> = object & PayloadShape<Payload>;
declare const eventType: unique symbol;
declare const projectionType: unique symbol;
declare const commandsType: unique symbol;

/** Factory-issued opaque definition. The parser stays in a private WeakMap. */
export interface BusinessEvent<Payload extends object & PayloadShape<Payload>> {
  readonly name: string;
  readonly version: number;
  readonly fields: readonly Extract<keyof Payload, string>[];
  readonly [eventType]: Payload;
}

export interface BusinessEventProjection<Output> {
  readonly [projectionType]: (output: Output) => void;
}

/** An event named alone in a command's `events`: its payload is the output's fields of the same names, so every
 * field it names must be one the output has. The values are the output's own, and the payload parser judges them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BusinessEventPick<Output> = BusinessEvent<any> & { readonly fields: readonly Extract<keyof Output, string>[] };

export interface CapturedCommandEvents<Output> {
  readonly expectation: CommandEventExpectation;
  readonly [commandsType]: (output: Output) => void;
}

/** Output is detached and deeply frozen, including nested command results. */
export type BusinessEventOutput<Value> = Value extends readonly (infer Item)[]
  ? readonly BusinessEventOutput<Item>[]
  : Value extends object
    ? { readonly [Key in keyof Value]: BusinessEventOutput<Value[Key]> }
    : Value;

interface CapturedEvent {
  readonly shape: ShapeDescriptor;
  readonly name: string;
  readonly version: number;
  readonly fields: readonly string[];
  parse(value: unknown): unknown;
}
interface CapturedProjection {
  readonly event: CapturedEvent;
  project(output: unknown): unknown;
}
const events = new WeakMap<object, CapturedEvent>();
const projections = new WeakMap<object, CapturedProjection>();
const commands = new WeakMap<object, readonly (CapturedProjection & { readonly slot: string })[]>();

/** An event: its name and the shape of its payload, `defineEvent('ticket.solved', shape({ ticketId: int(), note: text() }))`.
 * The payload's fields are the shape's keys, so they are written once; each is a required field of the payload (say
 * `nullable(…)` for one that may be empty). The shape is the only parser: a hand-written one has no keys to publish.
 * No version: the commands that record it carry its contract in authority.lock (commandContracts.ts).
 * Capture methods and metadata without executing validators. Trusted closures
 * are not sandboxed or made pure; changing their semantics requires versioning. */
export function defineEvent<Payload extends object & PayloadShape<Payload>>(name: string, payload: Shape<Payload>): BusinessEvent<Payload> {
  return capture(name, payload);
}

/** The platform's own events (an effect's call), whose payloads a hand-written parser reads and whose fields it lists:
 * not the author's spelling, so not exported from `@mistriwork/mistri/commands`. */
export function defineOpaqueEvent<Payload extends object & PayloadShape<Payload>>(
  name: string,
  listed: readonly Extract<keyof Payload, string>[],
  payload: Shape<Payload>,
): BusinessEvent<Payload> {
  return capture(name, payload, listed);
}

function capture<Payload extends object & PayloadShape<Payload>>(
  name: string,
  payload: Shape<Payload>,
  listed?: readonly string[],
): BusinessEvent<Payload> {
  try {
    // Every event is at version 1: a breaking change is its commands' to bump.
    const identity = eventIdentity({ name, version: 1 });
    const parser = exact(payload, ['parse']);
    if (typeof parser.parse !== 'function' || isProxy(parser.parse)) return definitionError();
    const descriptor = describeShape(payload);
    if (!listed && descriptor.kind !== 'object') return definitionError();
    const allowlist = fields(listed ?? Object.keys((descriptor as Extract<ShapeDescriptor, { kind: 'object' }>).fields));
    const parse = parser.parse;
    const receiver = Object.freeze({ parse });
    const captured: CapturedEvent = Object.freeze({
      ...identity,
      fields: allowlist,
      shape: descriptor,
      parse: (input: unknown) => Reflect.apply(parse, receiver, [input]),
    });
    const event = Object.freeze({ name: captured.name, version: captured.version, fields: allowlist });
    events.set(event, captured);
    return event as BusinessEvent<Payload>;
  } catch {
    return definitionError();
  }
}

/** Whether `value` is an event defineEvent issued; a lookalike is not. */
export function isBusinessEvent(value: unknown): value is BusinessEvent<Record<string, CommandEventJson>> {
  return !!value && typeof value === 'object' && events.has(value);
}

/** A delivered payload, read back through its declaration: the same field
 * allowlist and the declaration's own parser, on a detached copy. A consumer
 * never sees a field the declaration does not admit. */
export function parseEventPayload<Payload extends BusinessEventPayload<Payload>>(event: BusinessEvent<Payload>, json: string): Payload {
  try {
    const captured = events.get(event);
    if (!captured || typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > COMMAND_EVENT_LIMITS.payloadBytes)
      return projectionError();
    const selected = payloadJson(JSON.parse(json), captured.fields);
    return detached(
      captured.parse(detached(JSON.parse(selected), COMMAND_EVENT_LIMITS.payloadBytes)),
      COMMAND_EVENT_LIMITS.payloadBytes,
    ) as Payload;
  } catch {
    return projectionError();
  }
}

/** Explicit projection receives only validated output; it cannot choose any
 * envelope field. The caller must have validated/authorized that output first. */
export function defineEventProjection<Output, Payload extends object & PayloadShape<Payload>>(
  event: BusinessEvent<Payload>,
  project: (output: BusinessEventOutput<Output>) => Payload,
): BusinessEventProjection<Output> {
  const captured = events.get(event);
  if (!captured || typeof project !== 'function' || isProxy(project)) return definitionError();
  const declaration = Object.freeze({});
  projections.set(
    declaration,
    Object.freeze({ event: captured, project: (output: unknown) => Reflect.apply(project, undefined, [output]) }),
  );
  return declaration as BusinessEventProjection<Output>;
}

/** An event named alone carries the output fields it declares, by name. A field the output lacks is refused
 * here, where the command is defined, rather than when the command first runs. */
function picked(candidate: object, output: ShapeDescriptor | undefined): CapturedProjection | undefined {
  const event = events.get(candidate);
  if (!event) return undefined;
  if (output?.kind === 'object' && event.fields.some((field) => !Object.hasOwn(output.fields, field))) return undefined;
  return Object.freeze({
    event,
    project: (value: unknown) => Object.fromEntries(event.fields.map((field) => [field, (value as Record<string, unknown>)[field]])),
  });
}

/** Capture once at registration. Slots, event identities and payload fields
 * have deterministic order independent of object/array insertion order. */
export function captureCommandEvents<Output>(
  declarations: Readonly<Record<string, BusinessEventProjection<Output> | BusinessEventPick<Output>>>,
  output?: ShapeDescriptor,
): CapturedCommandEvents<Output> {
  try {
    const value = record(declarations, COMMAND_EVENT_LIMITS.events);
    const slots = Object.keys(value).sort();
    if (!slots.length) return definitionError();
    const seen = new Set<string>();
    const captured = slots.map((slot) => {
      identifier(slot, COMMAND_EVENT_LIMITS.fieldBytes);
      const candidate = value[slot];
      const projection = candidate && typeof candidate === 'object' ? (projections.get(candidate) ?? picked(candidate, output)) : undefined;
      if (!projection) return definitionError();
      const identity = `${projection.event.name}:${projection.event.version}`;
      if (seen.has(identity)) return definitionError();
      seen.add(identity);
      return Object.freeze({ slot, ...projection });
    });
    const expectation: CommandEventExpectation = Object.freeze(
      captured.map(({ event }) =>
        Object.freeze({
          name: event.name,
          version: event.version,
        }),
      ),
    );
    const result = Object.freeze({ expectation });
    commands.set(result, Object.freeze(captured));
    return result as CapturedCommandEvents<Output>;
  } catch {
    return definitionError();
  }
}

/** Serializable event contracts, captured without running a payload parser. */
export function commandEventContracts(declarations: CapturedCommandEvents<unknown>): unknown[] {
  const captured = commands.get(declarations);
  if (!captured) return definitionError();
  return captured.map(({ slot, event }) => ({ slot, name: event.name, fields: event.fields, payload: event.shape }));
}

/** Fresh execution only. Replay/status must validate stored batch associations
 * without running this function, a handler, or an application validator again.
 * No partial batch is returned on failure; transaction rollback is the caller's
 * obligation. This module performs no writes and generates no IDs/timestamps. */
export function projectCommandEvents<Output>(declarations: CapturedCommandEvents<Output>, validatedOutput: Output): CommandEventBatch {
  try {
    const captured = commands.get(declarations);
    if (!captured) return projectionError();
    const output = detached(validatedOutput, COMMAND_EVENT_LIMITS.outputBytes);
    let bytes = 0;
    const projected = captured.map(({ event, project }) => {
      // Enforce the allowlist before and after the validator: stripping a raw
      // row or secretly appending fields cannot pass as a bounded projection.
      const selected = payloadJson(project(output), event.fields);
      const parsed = event.parse(detached(JSON.parse(selected), COMMAND_EVENT_LIMITS.payloadBytes));
      const json = payloadJson(parsed, event.fields);
      bytes += Buffer.byteLength(json, 'utf8');
      if (bytes > COMMAND_EVENT_LIMITS.batchPayloadBytes) return projectionError();
      return Object.freeze({ name: event.name, version: event.version, payloadJson: json });
    });
    const result = Object.freeze(projected);
    canonicalCommandJson(result, COMMAND_EVENT_LIMITS.batchBytes);
    return result;
  } catch {
    return projectionError();
  }
}
