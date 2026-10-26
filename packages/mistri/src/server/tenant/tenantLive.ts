/**
 * Live sync on a tenant App: the deployment's private writer writes the
 * change rows, and its hub tells each member of the changes in their own
 * tenant alone.
 *
 * Every tenant write goes through the one private writer (tenantWriteSource.ts),
 * so it is bound here, where it is made, before it is published: each
 * tenant-owned table with the column that names its owner, which the capture
 * reads off each row inside the write, and every table scoped, since every
 * member reads under a scope (DESIGN-LIVE-SYNC §4). An entry whose owner the
 * capture cannot read — a global table's — names no tenant and reaches no
 * member: tenants share those tables read-only, and a member sees a change to
 * one at their next refresh.
 *
 * A database without the store is not refused: live sync is off for the App,
 * which the startup log says, and pages refresh as they did. Nor is it bound at
 * all for a tenant App that does not ask for it (`live: true`), and a resource
 * that says `live: false` is left out of the capture — except a tenant-owned
 * table a public form offers rows of as choices (`field.choice({ from })`):
 * its writes are captured, owner and all, whether or not the App asks, so the
 * cache of each tenant's choices hears of them (forms/choiceCache.ts
 * `tenantChoices`). Where the App does not ask, only those tables are.
 */
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { wakeListenUrl } from '../../adapters/events/postgresCommandEventWake.js';
import { postgresPoolDefaults } from '@mistriwork/engine/adapters/postgresPool.js';
import { bindLiveChanges } from '../stores/writeCaptures.js';
import { choiceSourceResources, liveSyncOn, type LiveState } from '../live/liveBinding.js';
import { bareTable } from '../../adapters/live/liveChange.js';
import { dropLiveHub, liveHubOf, type LiveHub } from '../live/liveHub.js';
import { liveStoreOf } from '../live/liveStore.js';
import type { AppDef } from '../../shared/app.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';

interface TenantLive {
  readonly adapter: Adapter;
  readonly hub?: LiveHub;
  readonly state: LiveState;
  /** The tenant-owned choice tables captured, bare: what a tenant's cached choices may be kept for. */
  readonly choices?: ReadonlySet<string>;
}

/* By App, source and connection: the writer an ownership snapshot names. */
const bound = new Map<string, TenantLive>();
const keyOf = (ownership: Pick<TenantOwnershipSnapshot, 'appId' | 'source'>) =>
  `${ownership.appId}\u0000${ownership.source.id}\u0000${ownership.source.connection}`;

/* What each tenant App asked of live sync, by its id: said before its writer is made (tenantEnrollment.ts). */
const wishes = new Map<string, { readonly live: boolean; readonly off: ReadonlySet<string>; readonly choices: ReadonlySet<string> }>();

/** Record a tenant App's choice: `live: true`, its resources that say `live: false`, and those its forms offer rows of
    as choices, by logical name. */
export function declareTenantAppLive(app: AppDef): void {
  wishes.set(app.id, {
    live: app.live === true,
    off: new Set(Object.entries(app.resources ?? {}).flatMap(([name, resource]) => (resource.live === false ? [name] : []))),
    choices: choiceSourceResources(app),
  });
}

/**
 * Bind the private writer to live sync, when its database holds the store.
 * `url` is the PostgreSQL writer's own, to hold LISTEN on; a transaction
 * pooler gets none, and the hub polls.
 */
export async function bindTenantLive(adapter: Adapter, ownership: TenantOwnershipSnapshot, url?: string): Promise<void> {
  const key = keyOf(ownership);
  if (!liveSyncOn()) {
    bound.set(key, { adapter, state: { state: 'off', reason: 'switched off' } });
    return;
  }
  const wish = wishes.get(ownership.appId);
  /* Each tenant's own choice tables: a global one names no tenant, so no tenant's entry could be told of its writes. */
  const choices = new Set(
    [...(wish?.choices ?? [])].flatMap((resource) =>
      ownership.ownership[resource]?.kind === 'tenant' && ownership.resources[resource] !== undefined
        ? [bareTable(ownership.resources[resource])]
        : [],
    ),
  );
  if (!wish || (!wish.live && !choices.size)) {
    bound.set(key, { adapter, state: { state: 'off', reason: 'not asked' } });
    return;
  }
  const store = liveStoreOf(adapter);
  if (!store) {
    bound.set(key, { adapter, state: { state: 'off', reason: 'unsupported' } });
    return;
  }
  if (!(await store.ready().catch(() => false))) {
    bound.set(key, { adapter, state: { state: 'off', reason: 'no store' } });
    return;
  }
  const owners = new Map<string, string>();
  for (const [resource, rule] of Object.entries(ownership.ownership))
    if (rule.kind === 'tenant' && ownership.resources[resource] !== undefined) owners.set(ownership.resources[resource], rule.column);
  const skip = new Set(
    [...wish.off].flatMap((resource) =>
      ownership.resources[resource] === undefined || choices.has(bareTable(ownership.resources[resource]))
        ? []
        : [ownership.resources[resource]],
    ),
  );
  bindLiveChanges(adapter, { owners, scoped: true, ...(skip.size ? { skip } : {}), ...(wish.live ? {} : { only: choices }) });
  const listen = url === undefined ? undefined : wakeListenUrl(url, postgresPoolDefaults().pooler);
  const hub = await liveHubOf(adapter, listen === undefined ? {} : { listen });
  bound.set(key, {
    adapter,
    ...(hub ? { hub } : {}),
    state: hub ? { state: 'on' } : { state: 'off', reason: 'no store' },
    ...(hub && choices.size ? { choices } : {}),
  });
}

/** The writer closed: its hub stops, and its streams end at their next read. */
export async function unbindTenantLive(adapter: Adapter, ownership: Pick<TenantOwnershipSnapshot, 'appId' | 'source'>): Promise<void> {
  const key = keyOf(ownership);
  if (bound.get(key)?.adapter === adapter) bound.delete(key);
  bindLiveChanges(adapter, undefined);
  await dropLiveHub(adapter);
}

/** The tenant-owned choice tables (bare) whose writes the hub of this ownership hears: empty where it hears none. */
export const tenantChoiceTables = (ownership: Pick<TenantOwnershipSnapshot, 'appId' | 'source'>): ReadonlySet<string> =>
  bound.get(keyOf(ownership))?.choices ?? new Set();

/** The hub of the writer this ownership names, while live sync is on there. */
export const tenantLiveHub = (ownership: Pick<TenantOwnershipSnapshot, 'appId' | 'source'>): LiveHub | undefined =>
  bound.get(keyOf(ownership))?.hub;
