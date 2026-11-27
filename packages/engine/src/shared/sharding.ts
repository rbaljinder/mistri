/**
 * Horizontal sharding primitives shared across the engine and App framework:
 * deterministic virtual-bucket hashing, self-routing IDs (vbucket-int64 and
 * vbucket-ulid), self-routing opaque tokens, and the dialect-agnostic
 * ShardRouter.
 *
 * Keys map through virtual buckets (`0..buckets-1`, default 4096) rather than
 * directly modulo the shard count. Splitting a shard or rebalancing a range
 * moves bucket ownership in the topology without rehashing keys or breaking
 * already-minted self-routing IDs.
 *
 * Pure TypeScript with no Node-only imports so both server planners and shared
 * validation modules can import it safely.
 */

export type ShardStrategy = 'hash' | 'range' | 'list' | 'directory';
export type ShardStatus = 'active' | 'draining' | 'read_only';
export type ShardIdEncoding = 'vbucket-int64' | 'vbucket-ulid';

/** Inclusive `[start, end]` virtual-bucket interval owned by one shard. */
export type ShardBucketRange = readonly [start: number, end: number];

/** Half-open `[min, max)` range for range-sharded topologies; omitted endpoints are unbounded. */
export interface ShardKeyRange {
  readonly min?: string | number;
  readonly max?: string | number;
}

interface ShardNode {
  readonly id: string;
  readonly status?: ShardStatus;
  /** Inclusive virtual-bucket ranges for hash/directory topologies. */
  readonly buckets?: readonly ShardBucketRange[];
  /** Key interval for range-sharded topologies. */
  readonly range?: ShardKeyRange;
  /** Explicit key values owned by this shard for list-sharded topologies. */
  readonly values?: readonly (string | number)[];
}

interface ShardTopology {
  readonly strategy: ShardStrategy;
  readonly buckets?: number;
  readonly shards: readonly ShardNode[];
}

export interface ShardRouter {
  readonly strategy: ShardStrategy;
  readonly buckets: number;
  readonly shards: readonly ShardNode[];
  /** Physical shard ID owning virtual bucket `bucket`. */
  shardForBucket(bucket: number): string;
  /** Physical shard ID owning `key` under this topology's strategy. */
  shardForKey(key: string | number): string;
  /** Physical shard ID decoded from a self-routing ID, or undefined when the ID is not valid for `encoding`. */
  shardForId(id: string | number, encoding: ShardIdEncoding): string | undefined;
  /** Group `keys` by their target shard ID, preserving arrival order within each shard. */
  shardsForKeys(keys: readonly (string | number)[]): Map<string, Array<string | number>>;
  /** Topology metadata for `shardId`, or undefined if unknown. */
  node(shardId: string): ShardNode | undefined;
  /** Every configured shard ID, in topology order. */
  allShards(): readonly string[];
  /** Shard IDs that accept new writes (`status !== 'read_only'`). */
  writableShards(): readonly string[];
}

/** Default virtual bucket count: 12 bits (`0..4095`), matching vbucket-int64 and vbucket-ulid bit widths. */
export const DEFAULT_SHARD_BUCKETS = 4096;
export const MIN_SHARD_BUCKETS = 1;
export const MAX_SHARD_BUCKETS = 4096;
export const MAX_SHARDS = 512;

/** Custom epoch for vbucket-int64 Snowflake/TSID IDs: 2025-01-01T00:00:00.000Z (~69.7 years in 41 bits). */
export const VBUCKET_INT64_EPOCH_MS = 1_735_689_600_000;

const SHARD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const DECIMAL_INT_RE = /^[1-9][0-9]{0,18}$/;
const MAX_SIGNED_INT64 = 0x7fff_ffff_ffff_ffffn;
const VBUCKET_BITS = 12n;
const SEQ_BITS = 10n;
const VBUCKET_MASK = (1n << VBUCKET_BITS) - 1n;
const SEQ_MASK = (1n << SEQ_BITS) - 1n;
const TIMESTAMP_SHIFT = VBUCKET_BITS + SEQ_BITS;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const VBUCKET_ULID_RE = /^v([0-9a-f]{3})_[0-9A-HJKMNP-TV-Z]{26}$/;
const SELF_ROUTING_TOKEN_RE = /^s\.([A-Za-z0-9][A-Za-z0-9_-]{0,62})\.(.+)$/;

const MASK64 = 0xffff_ffff_ffff_ffffn;
const FNV64_OFFSET = 0xcbf2_9ce4_8422_2325n;
const FNV64_PRIME = 0x0000_0100_0000_01b3n;

/** Whether `value` is a valid shard identifier: letters, digits, `_` or `-`, 1–63 characters. */
export function isShardId(value: unknown): value is string {
  return typeof value === 'string' && SHARD_ID_RE.test(value);
}

/** Whether `value` is a valid virtual-bucket count (`1..4096`). */
export function isBucketCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_SHARD_BUCKETS && value <= MAX_SHARD_BUCKETS;
}

/**
 * Deterministic 64-bit FNV-1a + SplitMix64 finalizer mapping any shard key to a
 * virtual bucket in `[0, buckets - 1]`. Identical across Node and browser
 * runtimes regardless of endianness or V8 version.
 */
export function vbucketOf(key: string | number, buckets: number = DEFAULT_SHARD_BUCKETS): number {
  if (!isBucketCount(buckets)) {
    throw new RangeError(
      `Shard bucket count must be a whole number from ${MIN_SHARD_BUCKETS} to ${MAX_SHARD_BUCKETS}; got ${String(buckets)}.`,
    );
  }
  const text = typeof key === 'number' ? String(key) : key;
  let hash = FNV64_OFFSET;
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code < 0x80) {
      hash = ((hash ^ BigInt(code)) * FNV64_PRIME) & MASK64;
    } else if (code < 0x800) {
      hash = ((hash ^ BigInt(0xc0 | (code >> 6))) * FNV64_PRIME) & MASK64;
      hash = ((hash ^ BigInt(0x80 | (code & 0x3f))) * FNV64_PRIME) & MASK64;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(++i);
      code = 0x10000 + (((code & 0x3ff) << 10) | (low & 0x3ff));
      hash = ((hash ^ BigInt(0xf0 | (code >> 18))) * FNV64_PRIME) & MASK64;
      hash = ((hash ^ BigInt(0x80 | ((code >> 12) & 0x3f))) * FNV64_PRIME) & MASK64;
      hash = ((hash ^ BigInt(0x80 | ((code >> 6) & 0x3f))) * FNV64_PRIME) & MASK64;
      hash = ((hash ^ BigInt(0x80 | (code & 0x3f))) * FNV64_PRIME) & MASK64;
    } else {
      hash = ((hash ^ BigInt(0xe0 | (code >> 12))) * FNV64_PRIME) & MASK64;
      hash = ((hash ^ BigInt(0x80 | ((code >> 6) & 0x3f))) * FNV64_PRIME) & MASK64;
      hash = ((hash ^ BigInt(0x80 | (code & 0x3f))) * FNV64_PRIME) & MASK64;
    }
  }
  // SplitMix64 avalanche so short sequential numeric keys spread uniformly across buckets.
  hash = ((hash ^ (hash >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & MASK64;
  hash = ((hash ^ (hash >> 27n)) * 0x94d0_49bb_1331_11ebn) & MASK64;
  hash = (hash ^ (hash >> 31n)) & MASK64;
  return Number(hash % BigInt(buckets));
}

let lastInt64Ms = -1;
let lastInt64Seq = 0;

/**
 * Mint a positive 64-bit time-ordered integer ID (returned as a decimal string
 * to avoid JS float rounding past 2^53) with 12 virtual-bucket bits embedded:
 * `[41-bit ms since 2025-01-01][12-bit vbucket][10-bit sequence]`.
 */
export function encodeVbucketInt64(vbucket: number, nowMs: number = Date.now(), seq?: number): string {
  if (!Number.isInteger(vbucket) || vbucket < 0 || vbucket >= MAX_SHARD_BUCKETS) {
    throw new RangeError(`vbucket must be an integer in 0..${MAX_SHARD_BUCKETS - 1}; got ${String(vbucket)}.`);
  }
  let ms = Math.max(VBUCKET_INT64_EPOCH_MS + 1, Math.floor(nowMs));
  let sequence: number;
  if (seq !== undefined) {
    if (!Number.isInteger(seq) || seq < 0 || seq > Number(SEQ_MASK)) {
      throw new RangeError(`sequence must be an integer in 0..${Number(SEQ_MASK)}; got ${String(seq)}.`);
    }
    sequence = seq;
  } else {
    if (ms <= lastInt64Ms) {
      ms = lastInt64Ms;
      lastInt64Seq = (lastInt64Seq + 1) & Number(SEQ_MASK);
      if (lastInt64Seq === 0) ms = ++lastInt64Ms;
    } else {
      lastInt64Ms = ms;
      lastInt64Seq = 0;
    }
    sequence = lastInt64Seq;
  }
  const delta = BigInt(ms - VBUCKET_INT64_EPOCH_MS);
  if (delta >= 1n << 41n) throw new RangeError('Timestamp exceeds vbucket-int64 41-bit range.');
  const id = (delta << TIMESTAMP_SHIFT) | (BigInt(vbucket) << SEQ_BITS) | BigInt(sequence);
  return id.toString(10);
}

/** Decode the embedded virtual bucket (`0..4095`) from a `vbucket-int64` ID, or undefined if malformed. */
export function decodeVbucketInt64(id: string | number): number | undefined {
  const text = typeof id === 'number' ? (Number.isSafeInteger(id) && id > 0 ? String(id) : '') : id.trim();
  if (!DECIMAL_INT_RE.test(text)) return undefined;
  const parsed = BigInt(text);
  if (parsed <= 0n || parsed > MAX_SIGNED_INT64) return undefined;
  return Number((parsed >> SEQ_BITS) & VBUCKET_MASK);
}

function encodeCrockford(value: bigint, length: number): string {
  const chars = Array.from<string>({ length });
  let remaining = value;
  for (let i = length - 1; i >= 0; i--) {
    chars[i] = CROCKFORD[Number(remaining & 31n)]!;
    remaining >>= 5n;
  }
  return chars.join('');
}

function randomEntropy(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(out);
  } else {
    for (let i = 0; i < bytes; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

/**
 * Mint a self-routing ULID-shaped text ID prefixed with 3 lowercase hex
 * virtual-bucket digits: `v<3hex>_<10-char-ts><16-char-rand>` (31 chars total).
 */
export function encodeVbucketUlid(vbucket: number, nowMs: number = Date.now(), entropy?: Uint8Array): string {
  if (!Number.isInteger(vbucket) || vbucket < 0 || vbucket >= MAX_SHARD_BUCKETS) {
    throw new RangeError(`vbucket must be an integer in 0..${MAX_SHARD_BUCKETS - 1}; got ${String(vbucket)}.`);
  }
  const ms = Math.max(0, Math.floor(nowMs));
  const ts = encodeCrockford(BigInt(ms), 10);
  const bytes = entropy ?? randomEntropy(10);
  if (bytes.length < 10) throw new RangeError('vbucket-ulid entropy requires at least 10 bytes.');
  let rand = 0n;
  for (let i = 0; i < 10; i++) rand = (rand << 8n) | BigInt(bytes[i]!);
  const suffix = encodeCrockford(rand, 16);
  return `v${vbucket.toString(16).padStart(3, '0')}_${ts}${suffix}`;
}

/** Decode the embedded virtual bucket (`0..4095`) from a `vbucket-ulid` ID, or undefined if malformed. */
export function decodeVbucketUlid(id: string | number): number | undefined {
  if (typeof id !== 'string') return undefined;
  const match = VBUCKET_ULID_RE.exec(id);
  if (!match) return undefined;
  return Number.parseInt(match[1]!, 16);
}

/** Encode a self-routing opaque token carrying its target shard ID (`s.<shardId>.<token>`). */
export function encodeSelfRoutingToken(shardId: string, token: string): string {
  if (!isShardId(shardId)) throw new RangeError(`Invalid shard id "${shardId}".`);
  if (!token || token.includes('\n') || token.includes('\r'))
    throw new RangeError('Self-routing token payload must be a non-empty single line.');
  return `s.${shardId}.${token}`;
}

/** Decode a self-routing opaque token (`s.<shardId>.<token>`), or undefined when not self-routing. */
export function decodeSelfRoutingToken(value: string): Readonly<{ shardId: string; token: string }> | undefined {
  const match = SELF_ROUTING_TOKEN_RE.exec(value);
  if (!match) return undefined;
  return { shardId: match[1]!, token: match[2]! };
}

/** Partition `[0, buckets - 1]` evenly into contiguous ranges across `shardIds`. */
export function assignDefaultBuckets(
  shardIds: readonly string[],
  buckets: number = DEFAULT_SHARD_BUCKETS,
): ReadonlyMap<string, readonly ShardBucketRange[]> {
  if (!shardIds.length) throw new RangeError('At least one shard is required to assign virtual buckets.');
  if (!isBucketCount(buckets)) {
    throw new RangeError(
      `Shard bucket count must be a whole number from ${MIN_SHARD_BUCKETS} to ${MAX_SHARD_BUCKETS}; got ${String(buckets)}.`,
    );
  }
  if (shardIds.length > buckets) {
    throw new RangeError(`Cannot assign ${buckets} virtual buckets across ${shardIds.length} shards; increase "buckets".`);
  }
  const assigned = new Map<string, readonly ShardBucketRange[]>();
  const base = Math.floor(buckets / shardIds.length);
  const extra = buckets % shardIds.length;
  let cursor = 0;
  shardIds.forEach((id, index) => {
    const span = base + (index < extra ? 1 : 0);
    assigned.set(id, [[cursor, cursor + span - 1]]);
    cursor += span;
  });
  return assigned;
}

function compareRangeValues(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const left = String(a),
    right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function keyInRange(key: string | number, range: ShardKeyRange): boolean {
  if (range.min !== undefined && compareRangeValues(key, range.min) < 0) return false;
  if (range.max !== undefined && compareRangeValues(key, range.max) >= 0) return false;
  return true;
}

/**
 * Compile a validated, immutable `ShardRouter` from `topology`.
 *
 * Refuses duplicate shard IDs, overlapping/missing virtual buckets (under
 * `'hash'`), missing range/list declarations, or unsupported bucket counts.
 */
export function createShardRouter(topology: ShardTopology): ShardRouter {
  const { strategy } = topology;
  const buckets = topology.buckets ?? DEFAULT_SHARD_BUCKETS;
  if (!isBucketCount(buckets)) {
    throw new RangeError(
      `Shard bucket count must be a whole number from ${MIN_SHARD_BUCKETS} to ${MAX_SHARD_BUCKETS}; got ${String(buckets)}.`,
    );
  }
  if (!topology.shards.length) throw new Error('Sharded topology must define at least one shard.');
  if (topology.shards.length > MAX_SHARDS) {
    throw new Error(`Sharded topology defines ${topology.shards.length} shards; at most ${MAX_SHARDS}.`);
  }
  const byId = new Map<string, ShardNode>();
  const orderedIds: string[] = [];
  for (const node of topology.shards) {
    if (!isShardId(node.id)) throw new Error(`Invalid shard id "${String(node.id)}".`);
    if (byId.has(node.id)) throw new Error(`Duplicate shard id "${node.id}".`);
    byId.set(node.id, Object.freeze({ ...node }));
    orderedIds.push(node.id);
  }

  let bucketTable: Int32Array | undefined;
  let listMap: Map<string, string> | undefined;

  if (strategy === 'hash' || strategy === 'directory') {
    const anyExplicit = topology.shards.some((node) => node.buckets !== undefined);
    const defaults = anyExplicit ? undefined : assignDefaultBuckets(orderedIds, buckets);
    bucketTable = new Int32Array(buckets).fill(-1);
    for (let index = 0; index < topology.shards.length; index++) {
      const node = topology.shards[index]!;
      const ranges = anyExplicit ? (node.buckets ?? []) : defaults!.get(node.id)!;
      for (const [start, end] of ranges) {
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end >= buckets || start > end) {
          throw new Error(`Shard "${node.id}" has invalid bucket range [${String(start)}, ${String(end)}] for ${buckets} buckets.`);
        }
        for (let b = start; b <= end; b++) {
          if (bucketTable[b] !== -1) {
            throw new Error(`Virtual bucket ${b} is assigned to both "${orderedIds[bucketTable[b]!]}" and "${node.id}".`);
          }
          bucketTable[b] = index;
        }
      }
    }
    if (strategy === 'hash') {
      for (let b = 0; b < buckets; b++) {
        if (bucketTable[b] === -1) {
          throw new Error(`Virtual bucket ${b} has no owning shard; every bucket 0..${buckets - 1} must be assigned.`);
        }
      }
    }
  } else if (strategy === 'list') {
    listMap = new Map<string, string>();
    for (const node of topology.shards) {
      if (!node.values?.length) throw new Error(`List-sharded node "${node.id}" must declare non-empty "values".`);
      for (const value of node.values) {
        const key = String(value);
        if (listMap.has(key)) {
          throw new Error(`Shard list value "${key}" is assigned to both "${listMap.get(key)}" and "${node.id}".`);
        }
        listMap.set(key, node.id);
      }
    }
  } else if (strategy === 'range') {
    for (const node of topology.shards) {
      if (!node.range) throw new Error(`Range-sharded node "${node.id}" must declare a "range".`);
      if (node.range.min !== undefined && node.range.max !== undefined && compareRangeValues(node.range.min, node.range.max) >= 0) {
        throw new Error(`Shard "${node.id}" has an empty or inverted range [${String(node.range.min)}, ${String(node.range.max)}).`);
      }
    }
  }

  const frozenShards = Object.freeze([...byId.values()]);
  const all = Object.freeze([...orderedIds]);
  const writable = Object.freeze(frozenShards.filter((node) => node.status !== 'read_only').map((node) => node.id));

  const shardForBucket = (bucket: number): string => {
    if (!Number.isInteger(bucket) || bucket < 0 || bucket >= buckets) {
      throw new RangeError(`Virtual bucket ${String(bucket)} is out of range 0..${buckets - 1}.`);
    }
    if (!bucketTable) {
      throw new Error(`Strategy "${strategy}" does not route by virtual bucket.`);
    }
    const shardIdx = bucketTable[bucket]!;
    if (shardIdx < 0) throw new Error(`Virtual bucket ${bucket} has no assigned shard.`);
    return orderedIds[shardIdx]!;
  };

  const shardForKey = (key: string | number): string => {
    if (strategy === 'hash' || strategy === 'directory') {
      return shardForBucket(vbucketOf(key, buckets));
    }
    if (strategy === 'list') {
      const found = listMap!.get(String(key));
      if (!found) throw new Error(`No shard owns list key "${String(key)}".`);
      return found;
    }
    for (const node of frozenShards) {
      if (node.range && keyInRange(key, node.range)) return node.id;
    }
    throw new Error(`No shard range covers key "${String(key)}".`);
  };

  const shardForId = (id: string | number, encoding: ShardIdEncoding): string | undefined => {
    const bucket = encoding === 'vbucket-int64' ? decodeVbucketInt64(id) : decodeVbucketUlid(id);
    if (bucket === undefined || bucket >= buckets) return undefined;
    if (!bucketTable) return undefined;
    const shardIdx = bucketTable[bucket]!;
    return shardIdx >= 0 ? orderedIds[shardIdx] : undefined;
  };

  const shardsForKeys = (keys: readonly (string | number)[]): Map<string, Array<string | number>> => {
    const grouped = new Map<string, Array<string | number>>();
    for (const key of keys) {
      const shardId = shardForKey(key);
      const list = grouped.get(shardId);
      if (list) list.push(key);
      else grouped.set(shardId, [key]);
    }
    return grouped;
  };

  return Object.freeze({
    strategy,
    buckets,
    shards: frozenShards,
    shardForBucket,
    shardForKey,
    shardForId,
    shardsForKeys,
    node: (shardId: string) => byId.get(shardId),
    allShards: () => all,
    writableShards: () => writable,
  });
}
