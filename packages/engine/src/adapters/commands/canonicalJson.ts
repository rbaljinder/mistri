/*
 * Canonical JSON: the one bounded walk that reads a command request, and the
 * one spelling (sorted keys, JSON number spelling) that the command journals,
 * event stores, job stores and auth store digest and compare. It refuses what
 * JSON.stringify would run or drop quietly (getters, proxies, cycles, foreign
 * prototypes, reserved keys) without invoking any of it. It sits with the
 * stores, below the command runtime, because both read by it.
 */
import { types } from 'node:util';
import { COMMAND_FIELD_PATH } from '../../shared/commandFieldPath.js';

export class CommandInputError extends Error {
  readonly code = 'invalid_input';
  /* Where in the envelope the request was refused — `key`, `idempotencyKey`,
     `keys[3]`, `key.tenant_id`. The message stays fixed, as every refusal's
     does; this is the part that tells a caller which of a dozen members to
     look at, and without it an agent could not tell a malformed request from
     a broken platform. It is always one of the envelope's own member names or
     a name from the App's declaration — never a key the request invented,
     which would echo text the caller chose into whatever reads a refusal.
     The path is held to the same bound a handler's refusal is. */
  readonly field?: string;
  constructor(field?: string) {
    super('The command request is invalid.');
    this.name = 'CommandInputError';
    if (typeof field === 'string' && field.length <= 200 && COMMAND_FIELD_PATH.test(field)) this.field = field;
  }
}

/** The bound on one command request, envelope included. */
export const MAX_COMMAND_BYTES = 65_536;
const MAX_DEPTH = 16;
const MAX_NODES = 10_000;
/** Names that belong to Object.prototype, never to data. */
export const reservedKeys: ReadonlySet<string> = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);
const invalid = (): never => {
  throw new CommandInputError();
};

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/** Read descriptors once, producing the serialized bytes and immutable snapshot together. */
export function snapshot(value: unknown, maxBytes: number): { json: string; value: Json } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return invalid();
  const active = new WeakSet<object>();
  const tokens: string[] = [];
  let bytes = 0;
  let nodes = 0;
  const append = (token: string) => {
    bytes += Buffer.byteLength(token, 'utf8');
    if (bytes > maxBytes) invalid();
    tokens.push(token);
  };
  const string = (text: string) => {
    // Refuse oversized strings before allocating their escaped JSON representation.
    if (Buffer.byteLength(text, 'utf8') > maxBytes - bytes) invalid();
    append(JSON.stringify(text));
  };
  const visit = (item: unknown, depth: number): Json => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return invalid();
    if (item === null) {
      append('null');
      return null;
    }
    if (typeof item === 'string') {
      string(item);
      return item;
    }
    if (typeof item === 'boolean') {
      append(item ? 'true' : 'false');
      return item;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) return invalid();
      append(JSON.stringify(item));
      return Object.is(item, -0) ? 0 : item;
    }
    if (typeof item !== 'object' || types.isProxy(item) || active.has(item)) return invalid();
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) return invalid();
    const length = array ? Object.getOwnPropertyDescriptor(item, 'length')!.value : 0;
    if (array && (!Number.isSafeInteger(length) || length < 0 || length > MAX_NODES - nodes)) return invalid();
    active.add(item);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const keys = Reflect.ownKeys(descriptors);
      if (array) {
        if (keys.length !== length + 1) return invalid();
        for (const key of keys) {
          if (key === 'length') continue;
          if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) return invalid();
        }
        const copy: Json[] = [];
        append('[');
        for (let index = 0; index < length; index++) {
          const descriptor = descriptors[index];
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return invalid();
          if (index) append(',');
          copy.push(visit(descriptor.value, depth + 1));
        }
        append(']');
        return Object.freeze(copy);
      }
      if (keys.length > MAX_NODES - nodes) return invalid();
      const names: string[] = [];
      for (const key of keys) {
        if (typeof key !== 'string' || reservedKeys.has(key)) return invalid();
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || !('value' in descriptor)) return invalid();
        names.push(key);
      }
      names.sort();
      const copy: Record<string, Json> = Object.create(null);
      append('{');
      for (let index = 0; index < names.length; index++) {
        const name = names[index];
        if (index) append(',');
        string(name);
        append(':');
        copy[name] = visit(descriptors[name].value, depth + 1);
      }
      append('}');
      return Object.freeze(copy);
    } finally {
      active.delete(item);
    }
  };
  const copy = visit(value, 0);
  return { json: tokens.join(''), value: copy };
}

/** Deterministic JSON, with UTF-16 lexically sorted object keys and JSON number spelling. */
export function canonicalCommandJson(value: unknown, maxBytes = MAX_COMMAND_BYTES): string {
  try {
    return snapshot(value, maxBytes).json;
  } catch {
    return invalid();
  }
}
