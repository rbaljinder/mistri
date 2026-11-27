/**
 * Control-plane shard routing directory contract, in-memory reference
 * implementation, and TTL + pub/sub invalidation cache.
 *
 * The directory holds ONLY routing metadata and discovery indexes — never
 * authoritative per-tenant business data or membership fences. Each shard keeps
 * its own authoritative `tenant_tenant` and `tenant_membership` rows so reads
 * and writes retain single-transaction fencing. If a cached route goes stale
 * during a live tenant move, the old shard fails closed with `TenantMovedError`,
 * prompting one directory refresh.
 */
import {
  createShardRouter,
  DEFAULT_SHARD_BUCKETS,
  isShardId,
  type ShardBucketRange,
  type ShardRouter,
  type ShardStatus,
  type ShardStrategy,
} from '@mistriwork/engine/shared/sharding.js';

export const SHARD_DIRECTORY_VERSION = 1;
export const SHARD_TOPOLOGY_CHANNEL = 'mistri_shard_topology';

export const SHARD_DIRECTORY_TABLES = Object.freeze({
  meta: '__mistri_shard_meta',
  node: '__mistri_shard_node',
  tenant: '__mistri_shard_tenant',
  accountTenant: '__mistri_shard_account_tenant',
  host: '__mistri_shard_host',
  lookup: '__mistri_shard_lookup',
});

export interface ShardDirectoryBinding {
  readonly appId: string;
  readonly sourceId: string;
  readonly storeId: string;
  readonly strategy?: ShardStrategy;
  readonly buckets?: number;
}

export interface DirectoryShardNode {
  readonly shardId: string;
  readonly label: string;
  readonly status: ShardStatus;
  readonly buckets?: readonly ShardBucketRange[];
  readonly weight: number;
  readonly updatedAt: number;
}

export type DirectoryTenantStatus = 'active' | 'suspended' | 'migrating' | 'closed';

export interface DirectoryTenantPlacement {
  readonly tenantId: string;
  readonly shardId: string;
  readonly status: DirectoryTenantStatus;
  readonly displayName: string | null;
  readonly version: number;
  readonly updatedAt: number;
}

export interface DirectoryAccountTenant {
  readonly accountId: string;
  readonly tenantId: string;
  readonly shardId: string;
  readonly status: 'active' | 'revoked';
}

export interface DirectoryHostEntry {
  readonly host: string;
  readonly tenantId: string;
  readonly shardId: string;
  readonly app: string;
  readonly kind: 'subdomain' | 'custom';
  readonly status: 'active' | 'pending' | 'failed';
  readonly primary: boolean;
}

export interface DirectoryLookupEntry {
  readonly resource: string;
  readonly lookupKey: string;
  readonly shardId: string;
  readonly vbucket: number;
}

/**
 * Thrown by a shard cell when a request arrives for a tenant that has moved or
 * is marked `migrating` on that shard. Signals `CachedShardDirectory` to
 * invalidate the cached route and re-read from the control plane once.
 */
export class TenantMovedError extends Error {
  readonly code = 'tenant_moved';
  constructor(
    readonly tenantId: string,
    readonly fromShardId: string,
    message = `Tenant "${tenantId}" is no longer served by shard "${fromShardId}".`,
  ) {
    super(message);
    this.name = 'TenantMovedError';
  }
}

export interface ShardDirectory {
  listShards(): Promise<readonly DirectoryShardNode[]>;
  registerShard(node: Omit<DirectoryShardNode, 'updatedAt'>): Promise<DirectoryShardNode>;
  updateShardStatus(shardId: string, status: ShardStatus): Promise<boolean>;
  /** Choose an active shard for placing a newly created tenant (weighted least-loaded). */
  pickShardForNewTenant(): Promise<string>;

  getTenant(tenantId: string): Promise<DirectoryTenantPlacement | undefined>;
  shardForTenant(tenantId: string): Promise<string | undefined>;
  placeTenant(input: {
    readonly tenantId: string;
    readonly shardId: string;
    readonly status?: DirectoryTenantStatus;
    readonly displayName?: string | null;
  }): Promise<DirectoryTenantPlacement>;
  setTenantStatus(tenantId: string, status: DirectoryTenantStatus): Promise<DirectoryTenantPlacement | undefined>;
  /** Atomically flip `tenantId` to `targetShardId` and update its account-index and host rows. */
  moveTenantPlacement(tenantId: string, targetShardId: string, status?: DirectoryTenantStatus): Promise<DirectoryTenantPlacement>;

  indexAccountTenant(entry: DirectoryAccountTenant): Promise<void>;
  removeAccountTenant(accountId: string, tenantId: string): Promise<void>;
  tenantsForAccount(accountId: string): Promise<readonly DirectoryAccountTenant[]>;

  upsertHost(entry: DirectoryHostEntry): Promise<void>;
  removeHost(host: string): Promise<boolean>;
  getHost(host: string): Promise<DirectoryHostEntry | undefined>;
  listHosts(): Promise<readonly DirectoryHostEntry[]>;

  /** Opt-in non-tenant lookup vindex for natural keys and legacy PKs. */
  putLookup(entry: DirectoryLookupEntry): Promise<void>;
  getLookup(resource: string, lookupKey: string): Promise<DirectoryLookupEntry | undefined>;
  removeLookup(resource: string, lookupKey: string): Promise<boolean>;

  /** Build an immutable ShardRouter snapshot from the currently registered shards. */
  router(): Promise<ShardRouter>;
  /** Subscribe to topology / placement change notifications; returns unsubscribe. */
  onTopologyChange(listener: () => void): () => void;
  close(): Promise<void>;
}

/**
 * In-memory `ShardDirectory` implementing the full control-plane routing
 * contract. Used by tests and local single-process sharded simulations.
 */
export class MemoryShardDirectory implements ShardDirectory {
  private readonly shards = new Map<string, DirectoryShardNode>();
  private readonly tenants = new Map<string, DirectoryTenantPlacement>();
  private readonly accountTenants = new Map<string, DirectoryAccountTenant>();
  private readonly hosts = new Map<string, DirectoryHostEntry>();
  private readonly lookups = new Map<string, DirectoryLookupEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly strategy: ShardStrategy;
  private readonly buckets: number;

  constructor(
    options: {
      readonly strategy?: ShardStrategy;
      readonly buckets?: number;
      readonly now?: () => number;
    } = {},
  ) {
    this.strategy = options.strategy ?? 'directory';
    this.buckets = options.buckets ?? DEFAULT_SHARD_BUCKETS;
    this.now = options.now ?? Date.now;
  }

  private readonly now: () => number;

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Listener errors must never break directory writes. */
      }
    }
  }

  async listShards(): Promise<readonly DirectoryShardNode[]> {
    return Object.freeze([...this.shards.values()]);
  }

  async registerShard(node: Omit<DirectoryShardNode, 'updatedAt'>): Promise<DirectoryShardNode> {
    if (!isShardId(node.shardId)) throw new RangeError(`Invalid shard id "${node.shardId}".`);
    if (!Number.isFinite(node.weight) || node.weight < 0) throw new RangeError(`Shard weight must be non-negative.`);
    const stored: DirectoryShardNode = Object.freeze({ ...node, updatedAt: this.now() });
    this.shards.set(node.shardId, stored);
    this.notify();
    return stored;
  }

  async updateShardStatus(shardId: string, status: ShardStatus): Promise<boolean> {
    const existing = this.shards.get(shardId);
    if (!existing) return false;
    this.shards.set(shardId, Object.freeze({ ...existing, status, updatedAt: this.now() }));
    this.notify();
    return true;
  }

  async pickShardForNewTenant(): Promise<string> {
    const active = [...this.shards.values()].filter((node) => node.status === 'active' && node.weight > 0);
    if (!active.length) throw new Error('No active shard with positive placement weight is available for new tenants.');
    const counts = new Map<string, number>();
    for (const shard of active) counts.set(shard.shardId, 0);
    for (const tenant of this.tenants.values()) {
      if (tenant.status !== 'closed' && counts.has(tenant.shardId)) {
        counts.set(tenant.shardId, counts.get(tenant.shardId)! + 1);
      }
    }
    active.sort((a, b) => counts.get(a.shardId)! / a.weight - counts.get(b.shardId)! / b.weight || a.shardId.localeCompare(b.shardId));
    return active[0]!.shardId;
  }

  async getTenant(tenantId: string): Promise<DirectoryTenantPlacement | undefined> {
    return this.tenants.get(tenantId);
  }

  async shardForTenant(tenantId: string): Promise<string | undefined> {
    return this.tenants.get(tenantId)?.shardId;
  }

  async placeTenant(input: {
    readonly tenantId: string;
    readonly shardId: string;
    readonly status?: DirectoryTenantStatus;
    readonly displayName?: string | null;
  }): Promise<DirectoryTenantPlacement> {
    if (!this.shards.has(input.shardId)) throw new Error(`Unknown shard "${input.shardId}".`);
    const existing = this.tenants.get(input.tenantId);
    if (existing && existing.shardId !== input.shardId) {
      throw new Error(`Tenant "${input.tenantId}" is already placed on shard "${existing.shardId}".`);
    }
    const placement: DirectoryTenantPlacement = Object.freeze({
      tenantId: input.tenantId,
      shardId: input.shardId,
      status: input.status ?? existing?.status ?? 'active',
      displayName: input.displayName !== undefined ? input.displayName : (existing?.displayName ?? null),
      version: (existing?.version ?? 0) + 1,
      updatedAt: this.now(),
    });
    this.tenants.set(input.tenantId, placement);
    this.notify();
    return placement;
  }

  async setTenantStatus(tenantId: string, status: DirectoryTenantStatus): Promise<DirectoryTenantPlacement | undefined> {
    const existing = this.tenants.get(tenantId);
    if (!existing) return undefined;
    const next: DirectoryTenantPlacement = Object.freeze({
      ...existing,
      status,
      version: existing.version + 1,
      updatedAt: this.now(),
    });
    this.tenants.set(tenantId, next);
    this.notify();
    return next;
  }

  async moveTenantPlacement(
    tenantId: string,
    targetShardId: string,
    status: DirectoryTenantStatus = 'active',
  ): Promise<DirectoryTenantPlacement> {
    if (!this.shards.has(targetShardId)) throw new Error(`Unknown target shard "${targetShardId}".`);
    const existing = this.tenants.get(tenantId);
    if (!existing) throw new Error(`Unknown tenant "${tenantId}".`);
    const next: DirectoryTenantPlacement = Object.freeze({
      ...existing,
      shardId: targetShardId,
      status,
      version: existing.version + 1,
      updatedAt: this.now(),
    });
    this.tenants.set(tenantId, next);
    for (const [key, entry] of this.accountTenants) {
      if (entry.tenantId === tenantId) {
        this.accountTenants.set(key, Object.freeze({ ...entry, shardId: targetShardId }));
      }
    }
    for (const [host, entry] of this.hosts) {
      if (entry.tenantId === tenantId) {
        this.hosts.set(host, Object.freeze({ ...entry, shardId: targetShardId }));
      }
    }
    this.notify();
    return next;
  }

  async indexAccountTenant(entry: DirectoryAccountTenant): Promise<void> {
    this.accountTenants.set(`${entry.accountId}\0${entry.tenantId}`, Object.freeze({ ...entry }));
  }

  async removeAccountTenant(accountId: string, tenantId: string): Promise<void> {
    this.accountTenants.delete(`${accountId}\0${tenantId}`);
  }

  async tenantsForAccount(accountId: string): Promise<readonly DirectoryAccountTenant[]> {
    const out: DirectoryAccountTenant[] = [];
    for (const entry of this.accountTenants.values()) {
      if (entry.accountId === accountId && entry.status === 'active') out.push(entry);
    }
    return Object.freeze(out);
  }

  async upsertHost(entry: DirectoryHostEntry): Promise<void> {
    if (!this.shards.has(entry.shardId)) throw new Error(`Unknown shard "${entry.shardId}".`);
    this.hosts.set(entry.host.toLowerCase(), Object.freeze({ ...entry, host: entry.host.toLowerCase() }));
    this.notify();
  }

  async removeHost(host: string): Promise<boolean> {
    const removed = this.hosts.delete(host.toLowerCase());
    if (removed) this.notify();
    return removed;
  }

  async getHost(host: string): Promise<DirectoryHostEntry | undefined> {
    return this.hosts.get(host.toLowerCase());
  }

  async listHosts(): Promise<readonly DirectoryHostEntry[]> {
    return Object.freeze([...this.hosts.values()].sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0)));
  }

  async putLookup(entry: DirectoryLookupEntry): Promise<void> {
    if (!this.shards.has(entry.shardId)) throw new Error(`Unknown shard "${entry.shardId}".`);
    this.lookups.set(`${entry.resource}\0${entry.lookupKey}`, Object.freeze({ ...entry }));
  }

  async getLookup(resource: string, lookupKey: string): Promise<DirectoryLookupEntry | undefined> {
    return this.lookups.get(`${resource}\0${lookupKey}`);
  }

  async removeLookup(resource: string, lookupKey: string): Promise<boolean> {
    return this.lookups.delete(`${resource}\0${lookupKey}`);
  }

  async router(): Promise<ShardRouter> {
    return createShardRouter({
      strategy: this.strategy,
      buckets: this.buckets,
      shards: [...this.shards.values()].map((node) => ({
        id: node.shardId,
        status: node.status,
        ...(node.buckets ? { buckets: node.buckets } : {}),
      })),
    });
  }

  onTopologyChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.listeners.clear();
  }
}

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

/**
 * Bounded in-process cache in front of a `ShardDirectory` so hot-path tenant
 * and lookup routing requires zero control-plane round trips, while still
 * invalidating instantly on `onTopologyChange` or `TenantMovedError`.
 */
export class CachedShardDirectory {
  private readonly tenantRoutes = new Map<string, CacheEntry<string | undefined>>();
  private readonly lookupRoutes = new Map<string, CacheEntry<DirectoryLookupEntry | undefined>>();
  private routerCache?: CacheEntry<ShardRouter>;
  private readonly unsubscribe: () => void;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(
    readonly underlying: ShardDirectory,
    options: { readonly ttlMs?: number; readonly maxEntries?: number; readonly now?: () => number } = {},
  ) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.maxEntries = options.maxEntries ?? 16_384;
    this.now = options.now ?? Date.now;
    this.unsubscribe = underlying.onTopologyChange(() => this.invalidateAll());
  }

  async shardForTenant(tenantId: string): Promise<string | undefined> {
    const at = this.now();
    const hit = this.tenantRoutes.get(tenantId);
    if (hit && hit.expiresAt > at) return hit.value;
    const shardId = await this.underlying.shardForTenant(tenantId);
    if (shardId !== undefined) {
      if (this.tenantRoutes.size >= this.maxEntries) {
        const oldest = this.tenantRoutes.keys().next().value;
        if (oldest !== undefined) this.tenantRoutes.delete(oldest);
      }
      this.tenantRoutes.set(tenantId, { value: shardId, expiresAt: at + this.ttlMs });
    }
    return shardId;
  }

  async getLookup(resource: string, lookupKey: string): Promise<DirectoryLookupEntry | undefined> {
    const key = `${resource}\0${lookupKey}`;
    const at = this.now();
    const hit = this.lookupRoutes.get(key);
    if (hit && hit.expiresAt > at) return hit.value;
    const found = await this.underlying.getLookup(resource, lookupKey);
    if (found !== undefined) {
      if (this.lookupRoutes.size >= this.maxEntries) {
        const oldest = this.lookupRoutes.keys().next().value;
        if (oldest !== undefined) this.lookupRoutes.delete(oldest);
      }
      this.lookupRoutes.set(key, { value: found, expiresAt: at + this.ttlMs });
    }
    return found;
  }

  async router(): Promise<ShardRouter> {
    const at = this.now();
    if (this.routerCache && this.routerCache.expiresAt > at) return this.routerCache.value;
    const built = await this.underlying.router();
    this.routerCache = { value: built, expiresAt: at + this.ttlMs };
    return built;
  }

  invalidateTenant(tenantId: string): void {
    this.tenantRoutes.delete(tenantId);
  }

  invalidateLookup(resource: string, lookupKey: string): void {
    this.lookupRoutes.delete(`${resource}\0${lookupKey}`);
  }

  invalidateAll(): void {
    this.tenantRoutes.clear();
    this.lookupRoutes.clear();
    this.routerCache = undefined;
  }

  async close(): Promise<void> {
    this.unsubscribe();
    this.invalidateAll();
    await this.underlying.close();
  }
}
