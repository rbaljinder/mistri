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

/** The bound on one command request, envelope included. A text input may be 65,536 characters (up to four bytes each, and escaped), so the envelope holds eight times that. */
export const MAX_COMMAND_BYTES = 524_288;
/** How deep a value nests, its root at depth 0: a document a server renders through this walk (the App API's) is held to it too. */
export const MAX_JSON_DEPTH = 16;
/** How many JSON nodes the canonical walk accepts: exported so the App API document can name the same ceiling when exceeded. */
export const MAX_JSON_NODES = 10_000;
const MAX_NODES = MAX_JSON_NODES;
/** Names that belong to Object.prototype, never to data. */
export const reservedKeys: ReadonlySet<string> = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);
const invalid = (): never => {
  throw new CommandInputError();
};

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;

interface SnappedMeta {
  readonly json: string;
  readonly bytes: number;
  readonly nodes: number;
  readonly depth: number;
}
/** Already-validated, deeply frozen objects/arrays returned by `snapshot()`, reused in O(1) on repeat walks. */
const snappedObjects = new WeakMap<object, SnappedMeta>();

/** Read descriptors once, producing the serialized bytes and immutable snapshot together. */
export function snapshot(value: unknown, maxBytes: number): { json: string; value: Json; bytes: number; nodes: number } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return invalid();
  if (value !== null && typeof value === 'object') {
    const kept = snappedObjects.get(value);
    if (kept) {
      if (kept.bytes > maxBytes) return invalid();
      return { json: kept.json, value: value as Json, bytes: kept.bytes, nodes: kept.nodes };
    }
  }
  const active = new WeakSet<object>();
  const tokens: string[] = [];
  let bytes = 0;
  let nodes = 0;
  let reach = 0;
  const appendAscii = (token: string) => {
    bytes += token.length;
    if (bytes > maxBytes) invalid();
    tokens.push(token);
  };
  const string = (text: string) => {
    const len = text.length;
    if (len > maxBytes - bytes) invalid();
    const rawBytes = Buffer.byteLength(text, 'utf8');
    if (rawBytes > maxBytes - bytes) invalid();
    const encoded = JSON.stringify(text);
    const encodedBytes = rawBytes === len && encoded.length === len + 2 ? encoded.length : Buffer.byteLength(encoded, 'utf8');
    bytes += encodedBytes;
    if (bytes > maxBytes) invalid();
    tokens.push(encoded);
  };
  const visit = (item: unknown, depth: number): Json => {
    if (++nodes > MAX_NODES || depth > MAX_JSON_DEPTH) return invalid();
    if (depth > reach) reach = depth;
    if (item === null) {
      appendAscii('null');
      return null;
    }
    if (typeof item === 'string') {
      string(item);
      return item;
    }
    if (typeof item === 'boolean') {
      appendAscii(item ? 'true' : 'false');
      return item;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) return invalid();
      appendAscii(JSON.stringify(item));
      return Object.is(item, -0) ? 0 : item;
    }
    if (typeof item !== 'object') return invalid();
    const kept = snappedObjects.get(item);
    if (kept) {
      if (depth + kept.depth > MAX_JSON_DEPTH || nodes + kept.nodes - 1 > MAX_NODES || bytes + kept.bytes > maxBytes) return invalid();
      if (depth + kept.depth > reach) reach = depth + kept.depth;
      nodes += kept.nodes - 1;
      bytes += kept.bytes;
      tokens.push(kept.json);
      return item as Json;
    }
    if (types.isProxy(item) || active.has(item)) return invalid();
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype)) return invalid();
    const length = array ? (Object.getOwnPropertyDescriptor(item, 'length')!.value as number) : 0;
    if (array && (!Number.isSafeInteger(length) || length < 0 || length > MAX_NODES - nodes)) return invalid();
    const startNodes = nodes - 1;
    const startBytes = bytes;
    const startToken = tokens.length;
    const parentReach = reach;
    reach = depth;
    active.add(item);
    try {
      const keys = Reflect.ownKeys(item);
      let frozen: Json;
      if (array) {
        if (keys.length !== length + 1) return invalid();
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          if (key === 'length') continue;
          if (typeof key !== 'string' || !ARRAY_INDEX.test(key) || Number(key) >= length) return invalid();
        }
        const copy: Json[] = [];
        appendAscii('[');
        for (let index = 0; index < length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, index);
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return invalid();
          if (index) appendAscii(',');
          copy.push(visit(descriptor.value, depth + 1));
        }
        appendAscii(']');
        frozen = Object.freeze(copy);
      } else {
        if (keys.length > MAX_NODES - nodes) return invalid();
        const names: string[] = [];
        const rawVals: Record<string, unknown> = Object.create(null);
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          if (typeof key !== 'string' || reservedKeys.has(key)) return invalid();
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return invalid();
          names.push(key);
          rawVals[key] = descriptor.value;
        }
        if (names.length > 1) names.sort();
        const copy: Record<string, Json> = Object.create(null);
        appendAscii('{');
        for (let index = 0; index < names.length; index++) {
          const name = names[index];
          if (index) appendAscii(',');
          string(name);
          appendAscii(':');
          copy[name] = visit(rawVals[name], depth + 1);
        }
        appendAscii('}');
        frozen = Object.freeze(copy);
      }
      const subtreeDepth = reach - depth;
      if (parentReach > reach) reach = parentReach;
      // Memoize top-level envelopes and their immediate children (key, input, result) so repeat walks hit O(1).
      if (depth <= 2) {
        const json = startToken === 0 ? tokens.join('') : tokens.slice(startToken).join('');
        snappedObjects.set(frozen as object, {
          json,
          bytes: bytes - startBytes,
          nodes: nodes - startNodes,
          depth: subtreeDepth,
        });
      }
      return frozen;
    } finally {
      active.delete(item);
    }
  };
  const copy = visit(value, 0);
  const rootMeta = copy !== null && typeof copy === 'object' ? snappedObjects.get(copy) : undefined;
  return { json: rootMeta ? rootMeta.json : tokens.join(''), value: copy, bytes, nodes };
}

/** Deterministic JSON, with UTF-16 lexically sorted object keys and JSON number spelling. */
export function canonicalCommandJson(value: unknown, maxBytes = MAX_COMMAND_BYTES): string {
  try {
    return snapshot(value, maxBytes).json;
  } catch {
    return invalid();
  }
}
