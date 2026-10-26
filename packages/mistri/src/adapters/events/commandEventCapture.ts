/*
 * Reading event declarations and payloads without running anything an
 * application wrote (no getters, proxies, thenables or inherited options),
 * and checking a stored batch against the same rules. Below the command
 * runtime, beside the stores, because the journals and event stores re-check
 * what they keep by exactly the rules the runtime wrote it by.
 */
import { isPromise, isProxy } from 'node:util/types';
import { COMMAND_EVENT_LIMITS, type CommandEventBatch, type CommandEventManifest } from './commandEventTypes.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';

export class BusinessEventDefinitionError extends Error {
  readonly code = 'invalid-event-definition';
  constructor() {
    super('The event declaration is invalid.');
    this.name = 'BusinessEventDefinitionError';
  }
}

export class BusinessEventProjectionError extends Error {
  readonly code = 'invalid-event-payload';
  constructor() {
    super('The event projection did not produce a valid bounded payload.');
    this.name = 'BusinessEventProjectionError';
  }
}

const promiseThen = Promise.prototype.then;
const reserved = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype', 'then']);
const provenance = new Set([
  'appId',
  'storeId',
  'sourceId',
  'scope',
  'tenantId',
  'actorId',
  'actor',
  'source',
  'membershipId',
  'membershipVersion',
  'tenantVersion',
  'roles',
  'deployment',
  'connection',
  'requestId',
  'receiptId',
  'eventId',
  'commandId',
  'commandVersion',
  'envelopeVersion',
  'payloadVersion',
  'correlationId',
  'causationId',
  'causation',
  'occurredAt',
]);
export const definitionError = (): never => {
  throw new BusinessEventDefinitionError();
};
export const projectionError = (): never => {
  throw new BusinessEventProjectionError();
};

/** No getters, inherited options, symbols or proxy traps are inspected. */
export function record(input: unknown, maxKeys: number): Record<string, unknown> {
  if (!input || typeof input !== 'object' || isProxy(input) || Array.isArray(input)) return definitionError();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) return definitionError();
  const keys = Reflect.ownKeys(input);
  if (keys.length > maxKeys) return definitionError();
  const captured: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || reserved.has(key)) return definitionError();
    const property = Object.getOwnPropertyDescriptor(input, key)!;
    if (!property.enumerable || !('value' in property)) return definitionError();
    captured[key] = property.value;
  }
  return captured;
}

export function exact(input: unknown, keys: readonly string[]): Record<string, unknown> {
  const value = record(input, keys.length);
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) return definitionError();
  return value;
}

export function identifier(input: unknown, max: number): string {
  if (typeof input !== 'string' || input.length > max || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(input) || reserved.has(input))
    return definitionError();
  return input;
}

export function eventIdentity(input: unknown): Readonly<{ name: string; version: number }> {
  const value = exact(input, ['name', 'version']);
  if (typeof value.name !== 'string' || value.name.length > COMMAND_EVENT_LIMITS.nameBytes || value.name.split('.').length < 2)
    return definitionError();
  for (const part of value.name.split('.')) identifier(part, COMMAND_EVENT_LIMITS.nameBytes);
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) return definitionError();
  return Object.freeze({ name: value.name, version: value.version as number });
}

function fieldName(input: unknown): string {
  if (
    typeof input !== 'string' ||
    input.length > COMMAND_EVENT_LIMITS.fieldBytes ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(input) ||
    reserved.has(input) ||
    provenance.has(input)
  )
    return definitionError();
  return input;
}

export function fields(input: unknown): readonly string[] {
  if (!input || typeof input !== 'object' || isProxy(input) || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype)
    return definitionError();
  const length = Object.getOwnPropertyDescriptor(input, 'length')!.value as number;
  if (length < 1 || length > COMMAND_EVENT_LIMITS.fields || Reflect.ownKeys(input).length !== length + 1) return definitionError();
  const names: string[] = [];
  for (let index = 0; index < length; index++) {
    const property = Object.getOwnPropertyDescriptor(input, String(index));
    if (!property?.enumerable || !('value' in property)) return definitionError();
    const name = fieldName(property.value);
    if (names.includes(name)) return definitionError();
    names.push(name);
  }
  return Object.freeze(names.sort());
}

function synchronous(input: unknown): unknown {
  if (isPromise(input)) {
    // Consume mistaken async callback rejection without assimilating user
    // thenables. Ordinary objects are checked by descriptors, never .then.
    Reflect.apply(promiseThen, input, [undefined, () => {}]);
    return projectionError();
  }
  return input;
}

export function detached<Value>(input: Value, maxBytes: number): Value {
  const value = JSON.parse(canonicalCommandJson(synchronous(input), maxBytes)) as Value;
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== 'object') return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(value);
  return value;
}

/** Only visit detached JSON after the shared bounded descriptor walk. This
 * traversal adds scalar safety without invoking hooks on application objects. */
function scalarSafety(value: unknown): void {
  if (typeof value === 'string') {
    if (
      Buffer.byteLength(value, 'utf8') > COMMAND_EVENT_LIMITS.stringBytes ||
      [...value].some((character) => {
        const point = character.codePointAt(0)!;
        return point >= 0xd800 && point <= 0xdfff;
      })
    )
      return projectionError();
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) return projectionError();
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      scalarSafety(key);
      scalarSafety(child);
    }
  }
}

export function payloadJson(input: unknown, allowlist?: readonly string[]): string {
  const selected = synchronous(input);
  const value = allowlist ? exact(selected, allowlist) : record(selected, COMMAND_EVENT_LIMITS.fields);
  const keys = Object.keys(value);
  if (!keys.length) return projectionError();
  for (const key of keys) fieldName(key);
  const json = canonicalCommandJson(value, COMMAND_EVENT_LIMITS.payloadBytes);
  scalarSafety(JSON.parse(json));
  return json;
}

/** Independent storage/replay check: preserve the exact supplied order. No
 * registry, parser, projector or runtime authority is consulted or manufactured. */
export function captureCommandEventManifest(input: unknown): CommandEventManifest {
  try {
    const value = detached(input, COMMAND_EVENT_LIMITS.manifestBytes);
    if (!Array.isArray(value) || !value.length || value.length > COMMAND_EVENT_LIMITS.events) return projectionError();
    const seen = new Set<string>();
    return Object.freeze(
      value.map((item) => {
        const identity = eventIdentity(item),
          key = `${identity.name}:${identity.version}`;
        if (seen.has(key)) return projectionError();
        seen.add(key);
        return identity;
      }),
    );
  } catch {
    return projectionError();
  }
}

/** Independent storage/replay validation. Payload JSON must already be
 * canonical; accepting reserialization would hide altered stored bytes.
 * Optional expected identities are compared in exact order. The storage owner
 * still enforces absence/presence, receipt/provenance, digest and schema checks.
 * Nested application schema is NOT re-executed here: its historical meaning is
 * pinned by event/command versions and the complete stored batch association. */
export function captureCommandEventBatch(input: unknown, expected?: CommandEventManifest): CommandEventBatch {
  try {
    const value = detached(input, COMMAND_EVENT_LIMITS.batchBytes);
    if (!Array.isArray(value) || !value.length || value.length > COMMAND_EVENT_LIMITS.events) return projectionError();
    let bytes = 0;
    const captured = value.map((item) => {
      const draft = exact(item, ['name', 'version', 'payloadJson']);
      const identity = eventIdentity({ name: draft.name, version: draft.version });
      if (typeof draft.payloadJson !== 'string' || Buffer.byteLength(draft.payloadJson, 'utf8') > COMMAND_EVENT_LIMITS.payloadBytes) {
        return projectionError();
      }
      const canonical = payloadJson(JSON.parse(draft.payloadJson));
      if (canonical !== draft.payloadJson) return projectionError();
      bytes += Buffer.byteLength(canonical, 'utf8');
      if (bytes > COMMAND_EVENT_LIMITS.batchPayloadBytes) return projectionError();
      return Object.freeze({ ...identity, payloadJson: canonical });
    });
    const manifest = captureCommandEventManifest(captured.map(({ name, version }) => ({ name, version })));
    if (expected !== undefined && canonicalCommandJson(captureCommandEventManifest(expected)) !== canonicalCommandJson(manifest)) {
      return projectionError();
    }
    return Object.freeze(captured);
  } catch {
    return projectionError();
  }
}
