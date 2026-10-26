import {
  Refusal,
  type Adapter,
  type CountItem,
  type DeleteRequest,
  type TellRequest,
  type ScopedReads,
  type WriteTransaction,
} from '@mistriwork/engine/adapters/adapter.js';
import type { ViewDef } from '@mistriwork/engine/shared/view.js';
import { snapshotRowScope, type RowScope } from '@mistriwork/engine/shared/rowScope.js';
import { createAppResourcesOver, mapAppScopedReads, appResourceVerifiedCommandRunner, type AppResourceCatalog } from './appResources.js';
import type { VerifiedCommandRunner } from '../commands/verifiedCommandRunner.js';
import { runScopedTransactionFacade } from '../policy/scopedTransactionFacade.js';
import { createAppSourceCatalog, type AppResourceTarget, type AppSourceCatalog, type AppSourceDefinition } from './appSourceCatalog.js';
import { checkStitchedBreakdown, runStitchedView, stitchedCountView, type StitchedCatalog } from './appStitchedReads.js';
import type { DeclaredReference } from '@mistriwork/engine/shared/declaredReferences.js';
import {
  capturePublicPlacementAdmission,
  capturePublicPlacementOwner,
  capturePublicPlacementScope,
} from '../../adapters/commands/publicPlacementTransaction.js';
import { commandsOf } from '../stores/commandStores.js';

export interface AppAdapterSource extends AppSourceDefinition {
  adapter: Adapter;
  /** Defense in depth; the server must also apply app/table/role write scope. */
  writable?: boolean;
}

interface AppSourceRuntime extends AppSourceCatalog {
  adapter: Adapter;
  sourceFor(resource: string): AppResourceTarget;
  /** Accepts merged resource IDs, but refuses any operation on another connection. */
  forSource(source: string): Adapter;
  /** The same, by group: the connection the sources share (AppSourceDefinition.group). */
  forGroup(group: string): Adapter;
}

const verifiedRunners = new WeakMap<Adapter, VerifiedCommandRunner>();
/** Composite/unanchored adapters and caller-created copies have no runner. */
export const appSourceVerifiedCommandRunner = (adapter: Adapter): VerifiedCommandRunner | undefined => verifiedRunners.get(adapter);

/**
 * Dispatch through one adapter per connection, never a synthetic
 * cross-database engine. Sources that share a connection (each scoped to a
 * schema) are one group: one catalog in the App's resource names, one
 * transaction, joins in SQL. Sources on different connections stay apart.
 */
export function createAppSourceAdapter(
  sources: Record<string, AppAdapterSource>,
  defaultSource: string | undefined,
  /** Declared references from one source to another, in the App's names (appSourceCatalog.ts). */
  references: readonly DeclaredReference[] = [],
): AppSourceRuntime {
  const catalog = createAppSourceCatalog(sources, defaultSource, references);
  const sourceGroups = new Map(Object.entries(sources).map(([name, source]) => [name, source.group ?? name]));
  const stitching: StitchedCatalog = { schema: structuredClone(catalog.schema), sourceOf: (resource) => catalog.resolve(resource).source };
  const scopedSchema = structuredClone(catalog.schema);
  const local = new Map<string, { adapter: Adapter; physicalAdapter: Adapter; writable: boolean; scoped: AppResourceCatalog }>();
  for (const [group, groupCatalog] of catalog.groups) {
    const members = Object.entries(sources)
      .filter(([name]) => (sources[name].group ?? name) === group)
      .map(([, source]) => source);
    if (members.some((source) => source.adapter !== members[0].adapter || source.writable !== members[0].writable)) {
      throw new Error(`The sources of group "${group}" do not share one connection.`);
    }
    const detached = { ...groupCatalog, schema: structuredClone(groupCatalog.schema) };
    local.set(group, {
      adapter: createAppResourcesOver(members[0].adapter, detached).adapter,
      physicalAdapter: members[0].adapter,
      writable: members[0].writable === true,
      scoped: { ...groupCatalog, schema: structuredClone(groupCatalog.schema) },
    });
  }
  const unsupported = (group: string, operation: string): never => {
    throw new Refusal(`App source "${group}" does not support ${operation}.`);
  };
  const targetFor = (resource: string, anchor?: string, write = false) => {
    const target = catalog.resolve(resource);
    if (anchor && target.group !== anchor) {
      throw new Refusal(
        `Resource "${resource}" belongs to source "${target.source}", on another connection. Cross-source transactions are not supported.`,
      );
    }
    const group = local.get(target.group)!;
    if (write && !group.writable) throw new Refusal(`App source "${target.source}" is read-only.`);
    return { ...target, ...group };
  };
  const readOnly = (anchor: string): never => {
    throw new Refusal(
      `App source "${Object.keys(sources).find((name) => (sources[name].group ?? name) === anchor) ?? anchor}" is read-only.`,
    );
  };
  /* Counts for several resources, one statement per connection: the items
     are split by the connection their resource lives on, each connection
     counts its own together, and the answers return in the items' order. */
  const countedBySource = async (
    items: readonly CountItem[],
    anchor: string | undefined,
    each: (resource: string) => (items: readonly CountItem[]) => Promise<number[]>,
  ): Promise<number[]> => {
    const groups = new Map<string, number[]>();
    items.forEach((item, at) => {
      const group = targetFor(item.table, anchor).group;
      groups.set(group, [...(groups.get(group) ?? []), at]);
    });
    const counts = Array.from<number>({ length: items.length });
    await Promise.all(
      [...groups.values()].map(async (positions) => {
        const answered = await each(items[positions[0]].table)(positions.map((at) => items[at]));
        positions.forEach((at, i) => {
          counts[at] = answered[i];
        });
      }),
    );
    return counts;
  };
  const makeAdapter = (anchor?: string, placementSource?: string): Adapter => {
    const candidates = anchor ? [local.get(anchor)!] : [...local.values()];
    const supports = (operation: keyof Adapter) => candidates.some((group) => typeof group.adapter[operation] === 'function');
    const inGroup = (id: string) => catalog.resolve(id).group === anchor;
    const schema = anchor
      ? {
          ...catalog.groups.get(anchor)!.schema,
          tables: catalog.schema.tables.filter((table) => inGroup(table.id)),
          foreignKeys: catalog.schema.foreignKeys.filter((fk) => inGroup(fk.from.table) && inGroup(fk.to.table)),
        }
      : catalog.schema;
    const scopeSchema = anchor
      ? {
          ...scopedSchema,
          tables: scopedSchema.tables.filter((table) => inGroup(table.id)),
          foreignKeys: scopedSchema.foreignKeys.filter((fk) => inGroup(fk.from.table) && inGroup(fk.to.table)),
        }
      : scopedSchema;
    const adapter: Adapter = {
      // Composite dialect is presentation metadata only. Every execution below
      // reaches the selected connection's own adapter/compiler.
      dialect: schema.dialect,
      introspect: async () => schema,
      query: async (request) => targetFor(request.table, anchor).adapter.query(request),
      count: async (table, filter, limit) => targetFor(table, anchor).adapter.count(table, filter, limit),
      close: async () => {},
    };
    if (supports('scopeReads'))
      adapter.scopeReads = async (input) => {
        // An anchored capability accepts only its exact merged resource IDs.
        // Reject foreign rules rather than silently discarding their intent.
        const scope = snapshotRowScope(scopeSchema, input);
        const mapped = new Map<string, Record<string, RowScope[string]>>();
        const binders = new Map<string, NonNullable<Adapter['scopeReads']>>();
        for (const [name, group] of local) {
          if (anchor && name !== anchor) continue;
          if (!group.physicalAdapter.scopeReads) return unsupported(name, 'scoped reads');
          binders.set(name, group.physicalAdapter.scopeReads.bind(group.physicalAdapter));
          mapped.set(name, Object.create(null));
        }
        for (const [resource, rule] of Object.entries(scope)) {
          const target = targetFor(resource, anchor);
          mapped.get(target.group)![target.physicalTable] = rule;
        }
        // Keep one map per connection even when physical table IDs coincide.
        // All rules and capabilities have been checked before any connection binds.
        const bound = new Map<string, ScopedReads>();
        for (const [name, rules] of mapped) {
          const reads = await binders.get(name)!(Object.freeze(rules));
          bound.set(name, mapAppScopedReads(reads, local.get(name)!.scoped));
        }
        const reads = (resource: string) => bound.get(targetFor(resource, anchor).group)!;
        /* A stitched reference's second step is this same reader's, on the
         target's connection: its row scope, never the raw adapter. */
        const far = (edge: { to: { table: string } }) => (view: ViewDef) => reads(edge.to.table).runView(view);
        const scoped: ScopedReads = {
          query: async (request) => reads(request.table).query(request),
          count: async (table, filter, limit) => reads(table).count(table, filter, limit),
          runView: async (view, offset) =>
            anchor
              ? reads(view.base).runView(view, offset)
              : runStitchedView(stitching, view, offset, (local, at) => reads(local.base).runView(local, at), far),
          countView: async (view, limit) =>
            reads(view.base).countView(anchor ? view : await stitchedCountView(stitching, view, far), limit),
          runBreakdown: async (breakdown, offset) => {
            if (!anchor) checkStitchedBreakdown(stitching, breakdown);
            return reads(breakdown.base).runBreakdown(breakdown, offset);
          },
          countBreakdown: async (breakdown) => {
            if (!anchor) checkStitchedBreakdown(stitching, breakdown);
            return reads(breakdown.base).countBreakdown(breakdown);
          },
          countEach: (items, limit) =>
            countedBySource(items, anchor, (resource) => {
              const source = reads(resource);
              return (grouped) =>
                source.countEach
                  ? source.countEach(grouped, limit)
                  : Promise.all(grouped.map((item) => source.count(item.table, item.filter, limit)));
            }),
        };
        return Object.freeze(scoped);
      };
    if (supports('countEach'))
      adapter.countEach = (items, limit) =>
        countedBySource(items, anchor, (resource) => {
          const target = targetFor(resource, anchor).adapter;
          return (grouped) =>
            target.countEach
              ? target.countEach(grouped, limit)
              : Promise.all(grouped.map((item) => target.count(item.table, item.filter, limit)));
        });
    if (supports('estimateCount')) adapter.estimateCount = async (table) => targetFor(table, anchor).adapter.estimateCount?.(table);
    if (supports('profile'))
      adapter.profile = async (table, limits) => {
        const target = targetFor(table, anchor);
        if (!target.adapter.profile) return unsupported(target.source, 'column profiling');
        return target.adapter.profile(table, limits);
      };
    const viewOf = (view: ViewDef, offset?: number) => {
      const target = targetFor(view.base, anchor);
      if (!target.adapter.runView) return unsupported(target.source, 'views');
      return target.adapter.runView(view, offset);
    };
    const far = (edge: { to: { table: string } }) => (view: ViewDef) => viewOf({ ...view, base: edge.to.table });
    if (supports('runView'))
      adapter.runView = async (view, offset) => (anchor ? viewOf(view, offset) : runStitchedView(stitching, view, offset, viewOf, far));
    if (supports('countView'))
      adapter.countView = async (view, limit) => {
        const target = targetFor(view.base, anchor);
        if (!target.adapter.countView) return unsupported(target.source, 'view counts');
        return target.adapter.countView(anchor ? view : await stitchedCountView(stitching, view, far), limit);
      };
    if (supports('runBreakdown'))
      adapter.runBreakdown = async (breakdown, offset) => {
        const target = targetFor(breakdown.base, anchor);
        if (!anchor) checkStitchedBreakdown(stitching, breakdown);
        if (!target.adapter.runBreakdown) return unsupported(target.source, 'breakdowns');
        return target.adapter.runBreakdown(breakdown, offset);
      };
    if (supports('countBreakdown'))
      adapter.countBreakdown = async (breakdown, limit) => {
        const target = targetFor(breakdown.base, anchor);
        if (!anchor) checkStitchedBreakdown(stitching, breakdown);
        if (!target.adapter.countBreakdown) return unsupported(target.source, 'breakdown counts');
        return target.adapter.countBreakdown(breakdown, limit);
      };
    if (supports('insert'))
      adapter.insert = async (request) => {
        const target = targetFor(request.table, anchor, true);
        if (!target.adapter.insert) return unsupported(target.source, 'inserts');
        return target.adapter.insert(request);
      };
    if (supports('update'))
      adapter.update = async (request) => {
        const target = targetFor(request.table, anchor, true);
        if (!target.adapter.update) return unsupported(target.source, 'updates');
        return target.adapter.update(request);
      };
    if (supports('remove'))
      adapter.remove = async (request) => {
        const target = targetFor(request.table, anchor, true);
        if (!target.adapter.remove) return unsupported(target.source, 'deletes');
        return target.adapter.remove(request);
      };
    // No transaction on the composite: it cannot promise atomicity until a
    // connection is fixed. An anchored one is its connection's own facade,
    // which maps and checks every write of the callback before it reaches the
    // database, and refuses a resource of any other connection.
    if (!anchor) return adapter;
    const group = local.get(anchor)!;
    const facade = group.adapter;
    /* Every write of the callback is judged here first, so one naming
       another connection's resource is refused as such, before the
       facade's own mapping would call it merely unknown. */
    const anchoredRecords = (transaction: WriteTransaction): WriteTransaction => {
      const check = <T extends { table: string }>(request: T, write = true): T => {
        targetFor(request.table, anchor, write);
        return request;
      };
      return {
        ...(transaction.lockRecord ? { lockRecord: (request: DeleteRequest) => transaction.lockRecord!(check(request)) } : {}),
        query: (request) => transaction.query(check(request, false)),
        count: (table, filter) => {
          targetFor(table, anchor);
          return transaction.count(table, filter);
        },
        insert: (request) => transaction.insert(check(request)),
        update: (request) => transaction.update(check(request)),
        remove: (request) => transaction.remove(check(request)),
        ...(transaction.tell ? { tell: (request: TellRequest) => transaction.tell!(check(request, false)) } : {}),
      };
    };
    if (group.writable && facade.scopeTransaction)
      adapter.scopeTransaction = async (input, run) => {
        snapshotRowScope(scopeSchema, input);
        return facade.scopeTransaction!(input, (records, evidence) =>
          runScopedTransactionFacade(anchoredRecords(records), (tx) => run(tx, evidence)),
        );
      };
    if (group.writable && commandsOf(facade).scopeCommandTransaction)
      adapter.scopeCommandTransaction = async (input, run, events) => {
        snapshotRowScope(scopeSchema, input);
        return commandsOf(facade).scopeCommandTransaction!(
          input,
          (records, journal, evidence) => runScopedTransactionFacade(anchoredRecords(records), (tx) => run(tx, journal, evidence)),
          events,
        );
      };
    const place = commandsOf(facade).publicPlacementCommandTransaction?.bind(facade);
    const recoverPlacement = commandsOf(facade).publicPlacementReceipt?.bind(facade);
    if (group.writable && place)
      adapter.publicPlacementCommandTransaction = async (input, inputAdmission, run) => {
        const scope = snapshotRowScope(scopeSchema, capturePublicPlacementScope(input));
        const admission = capturePublicPlacementAdmission(inputAdmission);
        const source = placementSource ?? targetFor(admission.anchors[0].table, anchor).source;
        const sameSource = (table: string, write = false) => {
          if (targetFor(table, anchor, write).source !== source) throw new Refusal('Public placement requires one exact App source.');
        };
        // Even sources sharing a physical connection remain distinct enrollment
        // boundaries. Stable sourceIdentity is issuer evidence, not a URL/alias
        // inferred here; the issuer must bind it to this retained adapter.
        for (const table of Object.keys(scope)) sameSource(table);
        for (const eligibility of admission.anchors) sameSource(eligibility.table);
        const check = <T extends { table: string }>(request: T, write = true): T => {
          sameSource(request.table, write);
          return request;
        };
        return place(scope, admission, (records, journal, evidence) =>
          runScopedTransactionFacade(
            {
              query: (request) => records.query(check(request, false)),
              count: (table, filter) => {
                sameSource(table);
                return records.count(table, filter);
              },
              insert: (request) => records.insert(check(request)),
              update: (request) => records.update(check(request)),
              remove: (request) => records.remove(check(request)),
            },
            (tx) => run(tx, journal, evidence),
          ),
        );
      };
    if (recoverPlacement)
      adapter.publicPlacementReceipt = (owner, submission) => recoverPlacement(capturePublicPlacementOwner(owner), submission);
    if (facade.transaction)
      adapter.transaction = async (run) => {
        if (!group.writable) return readOnly(anchor);
        return facade.transaction!((records) => run(anchoredRecords(records)));
      };
    if (commandsOf(facade).commandTransaction)
      adapter.commandTransaction = async (run, events) => {
        if (!group.writable) return readOnly(anchor);
        return commandsOf(facade).commandTransaction!((records, journal) => run(anchoredRecords(records), journal), events);
      };
    const verified = appResourceVerifiedCommandRunner(facade);
    if (verified && group.writable)
      verifiedRunners.set(adapter, (verify, run, events) =>
        verified(verify, (records, journal) => runScopedTransactionFacade(anchoredRecords(records), (tx) => run(tx, journal)), events),
      );
    return adapter;
  };
  const anchored = new Map<string, Adapter>();
  const sourceAnchored = new Map<string, Adapter>();
  const forGroup = (group: string) => {
    if (!local.has(group)) throw new Refusal(`Unknown app source "${group}".`);
    let adapter = anchored.get(group);
    if (!adapter) {
      adapter = makeAdapter(group);
      anchored.set(group, adapter);
    }
    return adapter;
  };
  return {
    ...catalog,
    adapter: makeAdapter(),
    sourceFor: catalog.resolve,
    forGroup,
    forSource(source) {
      const group = sourceGroups.get(source);
      if (!group) throw new Refusal(`Unknown app source "${source}".`);
      let adapter = sourceAnchored.get(source);
      if (!adapter) {
        adapter = makeAdapter(group, source);
        sourceAnchored.set(source, adapter);
      }
      return adapter;
    },
  };
}
