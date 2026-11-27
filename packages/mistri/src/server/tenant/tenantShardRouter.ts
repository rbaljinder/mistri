/**
 * Multi-tenant cell shard router: routes tenant requests, account discovery,
 * host lookups, self-routing tokens (`via`, invitations, capability links),
 * sandbox co-location, and live tenant moves across independent shard cells.
 *
 * Each shard cell owns its own authoritative `tenant_tenant`,
 * `tenant_membership`, command journal, history, inbox, and live-sync tables so
 * reads and writes keep single-transaction fencing with zero 2PC. The control-
 * plane `ShardDirectory` holds only routing metadata and discovery indexes.
 */
import { decodeSelfRoutingToken, encodeSelfRoutingToken } from '@mistriwork/engine/shared/sharding.js';
import {
  CachedShardDirectory,
  TenantMovedError,
  type DirectoryAccountTenant,
  type DirectoryHostEntry,
  type DirectoryTenantPlacement,
  type ShardDirectory,
} from '../../adapters/sharding/shardDirectory.js';

interface TenantMoveHooks<Cell, Snapshot> {
  /** Freeze `tenantId` on the source cell (`status = 'migrating'` + version bump to fence active leases). */
  freezeOnSource(sourceCell: Cell, tenantId: string): Promise<void>;
  /** Unfreeze `tenantId` on the source cell if copy/import fails before directory cutover. */
  unfreezeOnSource(sourceCell: Cell, tenantId: string): Promise<void>;
  /** Read a consistent snapshot of the tenant's business rows and tenant-scoped runtime rows. */
  exportFromSource(sourceCell: Cell, tenantId: string): Promise<Snapshot>;
  /** Write the tenant snapshot into the target cell in a single shard-local transaction. */
  importToTarget(targetCell: Cell, tenantId: string, snapshot: Snapshot): Promise<void>;
  /** Activate the imported tenant on the target cell after the control-plane directory flips. */
  activateOnTarget(targetCell: Cell, tenantId: string): Promise<void>;
  /** Optional cleanup of retired tenant data on the source cell after activation. */
  retireOnSource?(sourceCell: Cell, tenantId: string): Promise<void>;
}

interface TenantShardRouterOptions<Cell> {
  readonly directory: ShardDirectory | CachedShardDirectory;
  /** Lazily open (or retrieve) the cell runtime for `shardId`. */
  readonly openCell: (shardId: string) => Promise<Cell>;
  /** Close one opened cell on shutdown. */
  readonly closeCell?: (shardId: string, cell: Cell) => Promise<void>;
}

interface TenantShardRouter<Cell> {
  readonly cache: CachedShardDirectory;
  readonly directory: ShardDirectory;
  /** Resolve the shard ID owning `tenantId` from the cached directory. */
  resolveShard(tenantId: string): Promise<string | undefined>;
  /** Lazily open and return the cell runtime for `shardId`. */
  cell(shardId: string): Promise<Cell>;
  /**
   * Execute `work` against the shard cell owning `tenantId`. If the cell throws
   * `TenantMovedError` (stale in-process route during a live move), invalidates
   * the cached route and retries once against the newly resolved shard.
   */
  forTenant<T>(tenantId: string, work: (cell: Cell, shardId: string) => Promise<T>): Promise<T>;
  /** Discover all active `(tenantId, shardId)` placements for `accountId` in one control-plane read. */
  discoverAccountTenants(accountId: string): Promise<readonly DirectoryAccountTenant[]>;
  /** Resolve a custom domain or subdomain to its `(tenantId, shardId)` placement. */
  resolveHost(host: string): Promise<DirectoryHostEntry | undefined>;
  /** Mint a self-routing token (`s.<shardId>.<opaque>`) for `via` addresses, invitations, or capability links. */
  mintRoutingToken(shardId: string, opaque: string): string;
  /** Decode a self-routing token (`s.<shardId>.<opaque>`) without querying the control plane. */
  decodeRoutingToken(raw: string): Readonly<{ shardId: string; token: string }> | undefined;
  /**
   * Place a newly created tenant on an active shard with available capacity,
   * invoke `createOnShard` on that cell, and persist its placement in the
   * control-plane directory.
   */
  openNewTenant<T>(
    input: { readonly tenantId: string; readonly displayName?: string | null; readonly preferredShardId?: string },
    createOnShard: (cell: Cell, shardId: string) => Promise<T>,
  ): Promise<{ readonly shardId: string; readonly placement: DirectoryTenantPlacement; readonly result: T }>;
  /**
   * Return the exact shard holding `sourceTenantId` so a sandbox clone stays on
   * the same shard and `cloneTenant` / `importTenant` remains single-transaction.
   */
  sandboxShardFor(sourceTenantId: string): Promise<string>;
  /**
   * Move `tenantId` from its current shard to `targetShardId`: freeze source ->
   * export -> import on target -> flip directory -> activate target -> retire source.
   * Restores source status if any step fails before directory cutover.
   */
  moveTenant<Snapshot>(
    tenantId: string,
    targetShardId: string,
    hooks: TenantMoveHooks<Cell, Snapshot>,
  ): Promise<{ readonly fromShardId: string; readonly toShardId: string; readonly placement: DirectoryTenantPlacement }>;
  /** Every shard ID whose cell has already been opened in this process. */
  openedShards(): readonly string[];
  close(): Promise<void>;
}

/**
 * Create a dialect-agnostic multi-tenant cell router backed by `ShardDirectory`.
 */
export function createTenantShardRouter<Cell>(options: TenantShardRouterOptions<Cell>): TenantShardRouter<Cell> {
  const cache = options.directory instanceof CachedShardDirectory ? options.directory : new CachedShardDirectory(options.directory);
  const directory = cache.underlying;
  const cells = new Map<string, Cell>();
  const opening = new Map<string, Promise<Cell>>();
  let closed = false;

  const cell = async (shardId: string): Promise<Cell> => {
    if (closed) throw new Error('Tenant shard router is closed.');
    const existing = cells.get(shardId);
    if (existing !== undefined) return existing;
    let pending = opening.get(shardId);
    if (!pending) {
      pending = (async () => {
        const opened = await options.openCell(shardId);
        if (closed) {
          await options.closeCell?.(shardId, opened);
          throw new Error('Tenant shard router closed while opening shard cell.');
        }
        cells.set(shardId, opened);
        return opened;
      })().finally(() => {
        opening.delete(shardId);
      });
      opening.set(shardId, pending);
    }
    return pending;
  };

  const resolveShard = (tenantId: string) => cache.shardForTenant(tenantId);

  const forTenant = async <T>(tenantId: string, work: (target: Cell, shardId: string) => Promise<T>): Promise<T> => {
    const firstShard = await resolveShard(tenantId);
    if (!firstShard) throw new Error(`Unknown tenant "${tenantId}".`);
    try {
      return await work(await cell(firstShard), firstShard);
    } catch (error) {
      if (!(error instanceof TenantMovedError)) throw error;
      cache.invalidateTenant(tenantId);
      const nextShard = await resolveShard(tenantId);
      if (!nextShard || nextShard === firstShard) throw error;
      return await work(await cell(nextShard), nextShard);
    }
  };

  const router: TenantShardRouter<Cell> = {
    cache,
    directory,
    resolveShard,
    cell,
    forTenant,
    discoverAccountTenants: (accountId) => directory.tenantsForAccount(accountId),
    resolveHost: (host) => directory.getHost(host),
    mintRoutingToken: (shardId, opaque) => encodeSelfRoutingToken(shardId, opaque),
    decodeRoutingToken: (raw) => decodeSelfRoutingToken(raw),

    async openNewTenant(input, createOnShard) {
      const shardId = input.preferredShardId ?? (await directory.pickShardForNewTenant());
      const targetCell = await cell(shardId);
      const result = await createOnShard(targetCell, shardId);
      const placement = await directory.placeTenant({
        tenantId: input.tenantId,
        shardId,
        status: 'active',
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      });
      cache.invalidateTenant(input.tenantId);
      return { shardId, placement, result };
    },

    async sandboxShardFor(sourceTenantId) {
      const shardId = await resolveShard(sourceTenantId);
      if (!shardId) throw new Error(`Cannot place sandbox: source tenant "${sourceTenantId}" has no shard placement.`);
      return shardId;
    },

    async moveTenant<Snapshot>(tenantId: string, targetShardId: string, hooks: TenantMoveHooks<Cell, Snapshot>) {
      const current = await directory.getTenant(tenantId);
      if (!current) throw new Error(`Unknown tenant "${tenantId}".`);
      if (current.shardId === targetShardId) {
        throw new Error(`Tenant "${tenantId}" is already placed on shard "${targetShardId}".`);
      }
      const fromShardId = current.shardId;
      const sourceCell = await cell(fromShardId);
      const targetCell = await cell(targetShardId);

      await directory.setTenantStatus(tenantId, 'migrating');
      cache.invalidateTenant(tenantId);
      let frozen = false;
      try {
        await hooks.freezeOnSource(sourceCell, tenantId);
        frozen = true;
        const snapshot = await hooks.exportFromSource(sourceCell, tenantId);
        await hooks.importToTarget(targetCell, tenantId, snapshot);
      } catch (error) {
        if (frozen) await hooks.unfreezeOnSource(sourceCell, tenantId).catch(() => {});
        await directory.setTenantStatus(tenantId, current.status).catch(() => {});
        cache.invalidateTenant(tenantId);
        throw error;
      }

      const placement = await directory.moveTenantPlacement(tenantId, targetShardId, 'active');
      cache.invalidateTenant(tenantId);
      await hooks.activateOnTarget(targetCell, tenantId);
      await hooks.retireOnSource?.(sourceCell, tenantId);
      return { fromShardId, toShardId: targetShardId, placement };
    },

    openedShards: () => Object.freeze([...cells.keys()]),

    async close() {
      if (closed) return;
      closed = true;
      const entries = [...cells.entries()];
      cells.clear();
      for (const [shardId, opened] of entries) {
        await options.closeCell?.(shardId, opened);
      }
      await cache.close();
    },
  };
  return Object.freeze(router);
}
