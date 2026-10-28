import type { Condition } from '@mistriwork/engine/adapters/adapter.js';
import {
  isRowScopeSnapshot,
  ROW_SCOPE_LIMITS,
  snapshotRowScope,
  type RowScope,
  type RowScopeFilter,
} from '@mistriwork/engine/shared/rowScope.js';
import { captureTenantData, denyTenant, isCapturedTenantData, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { parseTenantSelector, type TenantMembershipEvidence } from './tenantMembership.js';
import { captureTenantOwnership, type TenantOwnershipSnapshot } from './tenantOwnership.js';
import { PLATFORM_EVIDENCE_KEYS, type PlatformMembershipEvidence } from './tenantPlatform.js';
import { capturePublicEvidence, type TenantPublicEvidence } from './tenantPublicRead.js';

interface Size {
  nodes: number;
  characters: number;
}
/** Only visits captured data. Count repeated values as repeated snapshot work. */
function size(value: unknown): Size {
  let nodes = 1,
    characters = typeof value === 'string' ? value.length : 0;
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const nested = size(child);
      nodes += nested.nodes;
      characters += nested.characters + (Array.isArray(value) ? 0 : key.length);
    }
  }
  return { nodes, characters };
}

interface Plan {
  id: string;
  left: Condition[][];
  right: Condition[][];
  tenant: Condition[];
  binary: string[];
}

/* The two layers a request's runtime composes come from the policy and the App's grants (tenantReadRuntime.ts), as
   captured tenant data rather than row scope snapshots: each request snapshotted both again — a copy and a check of
   every resource — and so composed afresh, and every read it bound composed again over that fresh composition (a
   field report: a tenth of a large App's request CPU). Captured data is frozen plain data the server made, that
   nothing can change (evidence.ts isCapturedTenantData), so its snapshot is kept with it, and handed to
   snapshotRowScope again, which takes it as it is against a catalog it was checked against and checks it afresh
   against any other. Anything else is snapshotted every time, as before. */
const layerSnapshots = new WeakMap<object, RowScope>();
function snapshotLayer(schema: TenantOwnershipSnapshot['schema'], layer: RowScope): RowScope {
  const kept = layerSnapshots.get(layer);
  if (kept) return snapshotRowScope(schema, kept);
  const made = snapshotRowScope(schema, layer);
  if (made !== layer && isCapturedTenantData(layer) && isRowScopeSnapshot(made)) layerSnapshots.set(layer, made);
  return made;
}

/* A composition, by what it is composed of: the ownership snapshot, the two
   layers and the tenant. A request composes its scope once, and then every
   read it makes composes it again with every row allowed (tenantReadSource.ts
   `bind`), each a pass over every resource and a fresh snapshot to check. The
   answer depends on nothing else, and all four are frozen data nothing can
   change — the layers row scope snapshots (shared/rowScope.ts), never a
   caller's object — so the composition is kept with them and goes when they
   do. A layer handed in as anything else is composed afresh, as before. */
const compositions = new WeakMap<TenantOwnershipSnapshot, WeakMap<object, WeakMap<object, Map<string, RowScope>>>>();
/** Test-only: how many scopes were composed rather than reused. */
export const composeCounters = { composed: 0 };

/** Private compiler data, NOT admission or a reader capability. The caller must
 * obtain evidence through the issuer, hold its exact source/catalog, and enforce
 * fresh lifetime/membership revalidation before releasing buffered read results.
 * In particular this helper neither checks the clock nor grants global writes. */
export function composeTenantReadScope(
  ownership: TenantOwnershipSnapshot,
  evidence: TenantMembershipEvidence,
  membershipRows: RowScope,
  authoredRows: RowScope,
): RowScope {
  try {
    // Server capture rejects proxies without running their reflection traps.
    const input = captureTenantData({ ownership, evidence, membershipRows, authoredRows });
    const owned = captureTenantOwnership(input.ownership);
    const member = input.evidence;
    tenantRecord(member, [
      'appId',
      'accountId',
      'tenantId',
      'source',
      'deployment',
      'membershipId',
      'membershipVersion',
      'tenantVersion',
      'roles',
      'verifiedAt',
      'validUntil',
    ]);
    tenantRecord(member.source, ['id', 'connection']);
    if (member.appId !== owned.appId || member.source.id !== owned.source.id || member.source.connection !== owned.source.connection)
      return denyTenant();
    const tenantId = parseTenantSelector([member.tenantId]);
    const membership = snapshotLayer(owned.schema, input.membershipRows);
    const authored = snapshotLayer(owned.schema, input.authoredRows);
    /* Kept only where both layers are snapshots checked against this ownership's catalog, given as snapshots or
       made once from captured data (snapshotLayer): then their identities are their contents, and so is the
       tenant's id. */
    const keep = isRowScopeSnapshot(membership) && isRowScopeSnapshot(authored);
    let byMember = compositions.get(owned);
    if (keep && !byMember) compositions.set(owned, (byMember = new WeakMap()));
    let byAuthored = keep ? byMember!.get(membership) : undefined;
    if (keep && !byAuthored) byMember!.set(membership, (byAuthored = new WeakMap()));
    let byTenant = keep ? byAuthored!.get(authored) : undefined;
    if (keep && !byTenant) byAuthored!.set(authored, (byTenant = new Map()));
    const known = byTenant?.get(tenantId);
    if (known) return known;
    composeCounters.composed++;
    const result: Record<string, boolean | RowScopeFilter> = Object.create(null);
    const plans: Plan[] = [];
    let nodes = 1,
      characters = 0,
      conditions = 0;
    const budget = () => {
      if (nodes > ROW_SCOPE_LIMITS.nodes || characters > ROW_SCOPE_LIMITS.characters || conditions > ROW_SCOPE_LIMITS.conditions)
        denyTenant();
    };
    for (const [id, rule] of Object.entries(owned.ownership)) {
      const a = membership[id] ?? false,
        b = authored[id] ?? false;
      characters += id.length;
      // A platform-owned table is false in every tenant context, before either
      // policy layer is consulted: no membership or authored scope reopens it.
      if (rule.kind === 'platform' || a === false || b === false) {
        result[id] = false;
        nodes++;
        budget();
        continue;
      }
      if (rule.kind === 'global' && a === true && b === true) {
        result[id] = true;
        nodes++;
        budget();
        continue;
      }
      const tenant: Condition[] = rule.kind === 'tenant' ? [{ column: rule.column, op: '=', value: tenantId }] : [];
      // SQLite makes the tenant predicate byte-exact with COLLATE BINARY. A
      // PostgreSQL row scope carries no collation override (snapshotRowScope
      // refuses one there): its tenant sources attest that every ownership
      // column is text or varchar under a deterministic collation, where `=`
      // is already byte-exact, and the column's own indexes stay usable.
      const exact = owned.schema.dialect === 'sqlite' ? tenant.map((condition) => condition.column) : [];
      const binary = [...new Set([...exact, ...(a === true ? [] : (a.binary ?? [])), ...(b === true ? [] : (b.binary ?? []))])];
      if (binary.length > ROW_SCOPE_LIMITS.array) return denyTenant();
      // A newly imposed collation can widen != or range conditions. Refuse an
      // ambiguous intersection, rather than silently reinterpret either layer.
      for (const policy of [a, b]) {
        if (
          policy !== true &&
          policy.groups.some((group) =>
            group.some((condition) => binary.includes(condition.column) && !policy.binary?.includes(condition.column)),
          )
        )
          return denyTenant();
      }
      const left = a === true ? [[]] : a.groups,
        right = b === true ? [[]] : b.groups;
      const products = left.length * right.length;
      if (products > ROW_SCOPE_LIMITS.array) return denyTenant();
      const leftSize = size(left),
        rightSize = size(right),
        tenantSize = size(tenant);
      // Preflight the entire OR-of-AND expansion, including duplicated IN values
      // and string/key characters, before allocating any product groups.
      conditions +=
        right.length * left.reduce((n, group) => n + group.length, 0) +
        left.length * right.reduce((n, group) => n + group.length, 0) +
        products * tenant.length;
      nodes +=
        2 +
        products * tenantSize.nodes +
        right.length * (leftSize.nodes - 1 - left.length) +
        left.length * (rightSize.nodes - 1 - right.length);
      characters +=
        'groups'.length + products * tenantSize.characters + right.length * leftSize.characters + left.length * rightSize.characters;
      if (binary.length) {
        nodes += 1 + binary.length;
        characters += 'binary'.length + binary.reduce((n, name) => n + name.length, 0);
      }
      budget();
      plans.push({ id, left, right, tenant, binary });
    }
    for (const { id, left, right, tenant, binary } of plans) {
      const groups = left.flatMap((a) => right.map((b) => [...tenant, ...a, ...b]));
      result[id] = { groups, ...(binary.length ? { binary } : {}) };
    }
    const composed = snapshotRowScope(owned.schema, result);
    byTenant?.set(tenantId, composed);
    return composed;
  } catch (error) {
    return denyTenant(error);
  }
}

/** The platform context's scope: every table under the platform policy's rows
 * (`resolvePlatformRows`), with no tenant predicate — the realm reads across
 * tenants — and a table the policy does not name is denied. Only platform
 * evidence composes here; tenant evidence has no `realm` and fails closed.
 * Like the tenant composer, compiler data only: never admission or a reader.
 *
 * `outsideSources` names the App's platform-only sources, whose tables the
 * policy names by their qualified `source.table` spelling because that is what
 * the platform realm's startup check asks of it. This composer speaks for one
 * source, so an entry belonging to another source is not this scope's business
 * and is left out — with the App's own names passed in rather than read off
 * the string before the dot, so a table of this source whose own name contains
 * a dot can never be mistaken for a reference to another one. Nothing else is
 * dropped: an id matching neither this source's schema nor a declared source
 * is still refused, because a typed table name that quietly became a no-op is
 * the failure this rule exists to avoid. Narrowing here can only ever remove
 * what a command may read.
 */
export function composePlatformReadScope(
  ownership: TenantOwnershipSnapshot,
  evidence: PlatformMembershipEvidence,
  platformRows: RowScope,
  outsideSources: readonly string[] = [],
): RowScope {
  try {
    const input = captureTenantData({ ownership, evidence, platformRows, outsideSources });
    const owned = captureTenantOwnership(input.ownership);
    const member = input.evidence;
    tenantRecord(member, PLATFORM_EVIDENCE_KEYS);
    tenantRecord(member.source, ['id', 'connection']);
    if (
      member.realm !== 'platform' ||
      member.appId !== owned.appId ||
      member.source.id !== owned.source.id ||
      member.source.connection !== owned.source.connection
    )
      return denyTenant();
    if (!Array.isArray(input.outsideSources)) return denyTenant();
    const outside = new Set<string>();
    for (const name of input.outsideSources) {
      // A name that is not one, or this very source, would widen or narrow by accident.
      if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) return denyTenant();
      if (name !== owned.source.id) outside.add(name);
    }
    const mine: Record<string, boolean | RowScopeFilter> = Object.create(null);
    for (const [id, rule] of Object.entries(input.platformRows)) {
      const dot = id.indexOf('.');
      if (dot > 0 && outside.has(id.slice(0, dot))) continue;
      mine[id] = rule;
    }
    const rows = snapshotRowScope(owned.schema, mine);
    const result: Record<string, boolean | RowScopeFilter> = Object.create(null);
    for (const id of Object.keys(owned.ownership)) result[id] = rows[id] ?? false;
    return snapshotRowScope(owned.schema, result);
  } catch (error) {
    return denyTenant(error);
  }
}

/**
 * The visitor's scope: each tenant-owned table the policy's `resolvePublicRows`
 * names, narrowed to the placed tenant — ANDed onto every one of its groups,
 * never in their place — and each global table as the callback says. A
 * platform-owned table, and any table the callback leaves out, is false.
 * Byte-exact on SQLite, as the tenant read scope is. Compiler data only:
 * never admission or a reader.
 */
export function composePublicReadScope(ownership: TenantOwnershipSnapshot, evidence: TenantPublicEvidence, rows: RowScope): RowScope {
  try {
    const owned = captureTenantOwnership(ownership);
    const value = capturePublicEvidence(evidence, owned);
    const named = snapshotRowScope(owned.schema, rows);
    const sqlite = owned.schema.dialect === 'sqlite';
    const result: Record<string, boolean | RowScopeFilter> = Object.create(null);
    for (const [id, rule] of Object.entries(owned.ownership)) {
      const scope = named[id] ?? false;
      if (rule.kind === 'platform' || scope === false) {
        result[id] = false;
        continue;
      }
      if (rule.kind === 'global') {
        result[id] = scope;
        continue;
      }
      // A collation the callback did not ask for could widen its own != or range conditions on the owner column.
      if (
        scope !== true &&
        scope.groups.some((group) => group.some((c) => c.column === rule.column)) &&
        sqlite &&
        !scope.binary?.includes(rule.column)
      )
        return denyTenant();
      const mine = { column: rule.column, op: '=' as const, value: value.tenantId };
      const binary = [...new Set([...(scope === true ? [] : (scope.binary ?? [])), ...(sqlite ? [rule.column] : [])])];
      result[id] = {
        groups: scope === true ? [[mine]] : scope.groups.map((group) => [...group, mine]),
        ...(binary.length ? { binary } : {}),
      };
    }
    return snapshotRowScope(owned.schema, result);
  } catch (error) {
    return denyTenant(error);
  }
}
