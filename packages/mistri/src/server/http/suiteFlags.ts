/** Suite-native composition of one control database and independently owned
 * target authority. The host router, not a body or Console App, selects targets. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { appHome, type AddressMount } from '@mistriwork/engine/shared/mount.js';
import type { SuiteHost } from './suite.js';
import type { Bound } from '@mistriwork/engine/server/http/trust.js';
import { getTenantHostIntent } from './tenantHosts.js';
import { openFlagDeployment, type FlagDeploymentTarget, type FlagRequestReadPort } from '../flags/deployment.js';
import { createFlagHttp } from '../flags/http.js';
import { FlagManagementDenied } from '../flags/store.js';
import type { ConsoleTargetOwner } from '../console/services.js';
import type { ConsoleOperationsOwner } from '../console/operations.js';
import { openPostgresExperimentStore } from '../experiments/storePostgres.js';
import { createExperimentRuntime } from '../experiments/runtime.js';
import { createAssignmentReceiptProvider } from '../experiments/assignmentReceipt.js';
import { createExperimentVisitorIdentity } from '../experiments/visitorIdentity.js';
import { createExperimentHttp } from '../experiments/http.js';
import { identifyEpoch, type ExperimentStore } from '../experiments/contracts.js';
import { openExperimentProducerHost, experimentSourcePolicy, type ExperimentSourceConfiguration } from '../experiments/producerHost.js';
import type { ExperimentRequestPort } from '../experiments/requestPort.js';
import type { AppFlagCatalog } from '../flags/appCatalog.js';
import type { ExperimentConversionRegistry } from '../experiments/conversionRegistry.js';

export interface SuiteFlagsOptions {
  readonly suiteId: string;
  readonly store: string;
  readonly environment: string;
  readonly deploymentId: string;
  readonly bound: Bound;
  readonly consoleEnabled?: boolean;
  readonly experiments?: {
    readonly store: string;
    readonly deploymentId: string;
    readonly assignmentKey: string;
    readonly targets: ReadonlyMap<string, { readonly graph: AppFlagCatalog; readonly conversions: ExperimentConversionRegistry }>;
    readonly secureCookies: boolean;
    readonly sources: readonly ExperimentSourceConfiguration[];
  };

  /** Only a real Console owner may occupy this reserved route. Until attached,
   * console.enabled refuses startup instead of serving an unprotected shell. */
  readonly openConsole?: (input: {
    mount: string;
    target(appId: string): FlagDeploymentTarget;
    targets: readonly ConsoleTargetOwner[];
    operations: readonly ConsoleOperationsOwner[];
  }) => Promise<{
    route(req: IncomingMessage, res: ServerResponse): Promise<void>;
    start(): void;
    stop(): Promise<void>;
    close(): Promise<void>;
  }>;
}

export async function openSuiteFlags(input: SuiteFlagsOptions, hosts: ReadonlyMap<string, SuiteHost>, mount: AddressMount) {
  const { suiteId, store, environment, deploymentId, consoleEnabled, openConsole } = input;
  if (consoleEnabled && !openConsole) throw new Error('Console is enabled but no Console owner is attached.');
  let retired = false,
    closing: Promise<void> | undefined;
  const stopped = new Set<string>();
  const work = new Map<string, Set<Promise<unknown>>>(),
    bodies = new Map<string, Set<IncomingMessage>>();
  const watched = new WeakSet<IncomingMessage>();
  const active = (id: string) => {
    if (retired || stopped.has(id)) throw new FlagManagementDenied();
  };
  const experimentTargets = new Map(input.experiments?.targets ?? []);
  let experimentStore: ExperimentStore | undefined;
  const producers: Awaited<ReturnType<typeof openExperimentProducerHost>>[] = [];
  const sourceAuthorities: { close(): void }[] = [];
  const experimentPorts = new Map<string, ExperimentRequestPort>();
  if (input.experiments) {
    experimentStore = await openPostgresExperimentStore({
      url: input.experiments.store,
      binding: { suiteId, deploymentId: input.experiments.deploymentId },
    });
    try {
      for (const [appId, declared] of experimentTargets) {
        if (!hosts.has(appId)) throw new Error('Experiment target is not mounted.');
        const runtime = createExperimentRuntime({ appId, environment, ...declared, store: experimentStore });
        const key = Buffer.from(input.experiments.assignmentKey, 'base64url');
        const receipts = createAssignmentReceiptProvider({
          appId,
          environment,
          binding: experimentStore.binding,
          catalog: declared.graph.catalog,
          key,
        });
        const visitors = createExperimentVisitorIdentity({
          appId,
          environment,
          binding: experimentStore.binding,
          key,
          mount: appHome(mount, appId).replace(/\/$/, ''),
          secure: input.experiments.secureCookies,
        });
        experimentPorts.set(appId, Object.freeze({ runtime, receipts, visitors, store: experimentStore }));
      }
    } catch (error) {
      await experimentStore.close();
      throw error;
    }
  }
  const targets = [...hosts].flatMap(([id, host]) => {
    if (!host.flagTargetFactory) return [];
    const target = host.flagTargetFactory();
    if (target.appId !== id) throw new Error('Flag target does not match its mounted App.');
    const current = target.assertCurrent;
    work.set(id, new Set());
    bodies.set(id, new Set());
    const experiment = experimentPorts.get(id);
    const resolveEpoch = (tenantId: string | null, flagId: string) => {
      const source = input.experiments?.sources.find(
        (source) => source.appId === id && source.flagId === flagId && source.tenantId === tenantId,
      );
      return experiment!.runtime.declaration(flagId, {
        controlTenantId: source?.controlTenantId === undefined ? tenantId : source.controlTenantId,
        evaluationTenantId: tenantId,
      });
    };
    const experimentEvidence = experiment && { store: experiment.store, epochs: [], resolveEpoch };
    return [
      {
        ...target,
        ...(experimentEvidence ? { experimentEvidence } : {}),
        assertCurrent() {
          active(id);
          current();
        },
      },
    ];
  });
  const deployment = await openFlagDeployment({ suiteId, storeUrl: store, environment, deploymentId, targets }).catch(async (error) => {
    await experimentStore?.close();
    throw error;
  });
  const handlers = new Map(
    targets.map((target) => [
      target.appId,
      {
        base: `${appHome(mount, target.appId).replace(/\/$/, '')}/api/flags`,
        experimentsBase: `${appHome(mount, target.appId).replace(/\/$/, '')}/api/experiments`,
        experimentDispatch: createExperimentHttp({
          target: deployment.target(target.appId),
          bound: input.bound,
          mount: appHome(mount, target.appId).replace(/\/$/, ''),
        }),
        dispatch: createFlagHttp({
          target: deployment.target(target.appId),
          bound: input.bound,
          mount: appHome(mount, target.appId).replace(/\/$/, ''),
        }),
      },
    ]),
  );
  const track = <T>(id: string, promise: Promise<T>, req?: IncomingMessage) => {
    const pending = work.get(id)!;
    pending.add(promise);
    if (req) {
      bodies.get(id)!.add(req);
      if (!watched.has(req)) {
        watched.add(req);
        req.once('error', () => {});
      }
    }
    const finish = () => {
      pending.delete(promise);
      if (req) bodies.get(id)!.delete(req);
    };
    void promise.then(finish, finish);
    return promise;
  };
  const targetPorts = new Map(
    targets.map((owner) => {
      const target = deployment.target(owner.appId);
      return [
        owner.appId,
        Object.freeze<FlagDeploymentTarget>({
          ...target,
          readPort: Object.freeze<FlagRequestReadPort>({
            ...target.readPort,
            ...(experimentPorts.has(owner.appId) ? { experiments: experimentPorts.get(owner.appId)! } : {}),
            readRequestScopes(scope) {
              active(owner.appId);
              return track(owner.appId, target.readPort.readRequestScopes(scope));
            },
          }),
          withRequest(request, accountId, current, work) {
            active(owner.appId);
            return track(owner.appId, target.withRequest(request, accountId, current, work), request);
          },
        }),
      ];
    }),
  );
  let consoleOwner: Awaited<ReturnType<NonNullable<SuiteFlagsOptions['openConsole']>>> | undefined;
  const consoleId = 'mistri-console',
    consoleMount = `${mount.base}/_mistri/console`;
  try {
    for (const [id, target] of targetPorts) hosts.get(id)?.attachFlagRuntime?.(target.readPort, () => active(id));
    if (input.experiments)
      for (const source of input.experiments.sources) {
        const experiment = experimentPorts.get(source.appId),
          declared = experimentTargets.get(source.appId);
        if (!experiment || !declared) throw new Error('Experiment source target is unavailable.');
        const epoch = await experiment.store.readEpoch(
          identifyEpoch(
            experiment.store.binding,
            experiment.runtime.declaration(source.flagId, {
              controlTenantId: source.controlTenantId === undefined ? source.tenantId : source.controlTenantId,
              evaluationTenantId: source.tenantId,
            }),
          ),
        );
        const policy = experimentSourcePolicy(source, epoch, declared.conversions);
        const native = source.tenantId === null ? undefined : hosts.get(source.appId)?.experimentConversionAuthority?.({ epoch, policy });
        if (declared.graph.tenantApp && !native) throw new Error('Tenant experiment source requires its native service authority.');
        if (native) sourceAuthorities.push(native);
        producers.push(
          await openExperimentProducerHost({
            source,
            epoch,
            registry: declared.conversions,
            store: experiment.store,
            authorize: async (request) => {
              active(source.appId);
              const proof = native ? await native.authorize(request) : async () => {};
              return async () => {
                active(source.appId);
                await proof();
                active(source.appId);
              };
            },
          }),
        );
      }
    if (consoleEnabled) {
      work.set(consoleId, new Set());
      bodies.set(consoleId, new Set());
      consoleOwner = await openConsole!({
        mount: consoleMount,
        // Every App with its own sign-in, flags or not: each answers only to its own grants.
        operations: Object.freeze(
          [...hosts].flatMap(([appId, host]) => (host.consoleOperations ? [Object.freeze({ ...host.consoleOperations, appId })] : [])),
        ),
        target: (appId) => {
          active(appId);
          return targetPorts.get(appId) ?? deployment.target(appId);
        },
        targets: Object.freeze(
          targets.map((owner) => {
            const host = hosts.get(owner.appId)!,
              observe = host.flagScopeProof?.(environment),
              scopes = host.flagScopes;
            return Object.freeze<ConsoleTargetOwner>({
              target: targetPorts.get(owner.appId)!,
              auth: owner.auth,
              name: host.flagName ?? owner.appId,
              tenantApp: owner.tenantApp,
              flags: Object.freeze(
                Object.fromEntries(
                  Object.entries(owner.catalog.flags).map(([id, flag]) => [
                    id,
                    Object.freeze({ type: flag.type, ...(flag.variants ? { variants: flag.variants } : {}) }),
                  ]),
                ),
              ),
              ...(experimentPorts.has(owner.appId)
                ? (() => {
                    const experiment = experimentPorts.get(owner.appId)!,
                      target = targetPorts.get(owner.appId)!;
                    const reference = (tenantId: string | null, flagId: string) => {
                      const source = input.experiments?.sources.find(
                        (source) => source.appId === owner.appId && source.flagId === flagId && source.tenantId === tenantId,
                      );
                      return identifyEpoch(
                        experiment.store.binding,
                        experiment.runtime.declaration(flagId, {
                          controlTenantId: source?.controlTenantId === undefined ? tenantId : source.controlTenantId,
                          evaluationTenantId: tenantId,
                        }),
                      );
                    };
                    return {
                      experimentFlags: Object.freeze(Object.keys(experimentTargets.get(owner.appId)!.graph.experiments)),
                      experiment: async (request: IncomingMessage, accountId: string, tenantId: string | null, flagId: string) => {
                        const epoch = reference(tenantId, flagId);
                        const read = () =>
                          target.withRequest(
                            request,
                            accountId,
                            () => active(owner.appId),
                            (session) => session.results({ tenantId, flagId, epochFingerprint: epoch.fingerprint }),
                          );
                        const result = await read();
                        const { canDecide } = await target.withRequest(
                          request,
                          accountId,
                          () => active(owner.appId),
                          (session) => session.experimentCapabilities({ tenantId, flagId }),
                        );
                        return {
                          result,
                          canDecide: canDecide && epoch.declaration.scope.controlTenantId === tenantId,
                          proof: {
                            assertCurrent: () => active(owner.appId),
                            reobserve: async () => {
                              await read();
                            },
                          },
                        };
                      },
                      decide: (
                        request: IncomingMessage,
                        accountId: string,
                        tenantId: string | null,
                        flagId: string,
                        decision: Parameters<NonNullable<ConsoleTargetOwner['decide']>>[4],
                        beforeCommit: () => Promise<void>,
                      ) =>
                        target.withRequest(
                          request,
                          accountId,
                          () => active(owner.appId),
                          (session) => session.decide({ ...decision, tenantId, flagId }, beforeCommit),
                        ),
                      lifecycle: (
                        request: IncomingMessage,
                        accountId: string,
                        tenantId: string | null,
                        flagId: string,
                        command: Parameters<NonNullable<ConsoleTargetOwner['lifecycle']>>[4],
                        beforeCommit: () => Promise<void>,
                      ) => {
                        const declared = experimentTargets.get(owner.appId)!.graph.experiments[flagId];
                        if (!declared) throw new FlagManagementDenied();
                        return target.withRequest(
                          request,
                          accountId,
                          () => active(owner.appId),
                          (session) =>
                            session.change(
                              {
                                tenantId,
                                flagId,
                                expectedRevision: command.expectedRevision,
                                reason: command.reason,
                                ...(command.operation === 'pause'
                                  ? { operation: 'kill' as const }
                                  : {
                                      operation: 'set' as const,
                                      override: {
                                        rollout: declared.eligibility.rollout ?? 100,
                                        experiment: { version: declared.version, weights: declared.allocation },
                                      },
                                    }),
                              },
                              beforeCommit,
                            ),
                        );
                      },
                    };
                  })()
                : {}),
              tenantScopes:
                scopes &&
                (async (request, accountId) => {
                  active(owner.appId);
                  const choices = await track(owner.appId, scopes(request, accountId), request);
                  active(owner.appId);
                  return choices;
                }),
              scopeProof:
                observe &&
                (async (request, accountId, tenantId) => {
                  active(owner.appId);
                  const proof = await track(owner.appId, observe(request, accountId, tenantId), request);
                  active(owner.appId);
                  if (!proof) return null;
                  return Object.freeze({
                    assertCurrent() {
                      active(owner.appId);
                      proof.assertCurrent();
                    },
                    async reobserve() {
                      active(owner.appId);
                      await track(
                        owner.appId,
                        Promise.resolve().then(() => proof.reobserve()),
                        request,
                      );
                      active(owner.appId);
                      proof.assertCurrent();
                    },
                  });
                }),
            });
          }),
        ),
      });
    }
  } catch (error) {
    await Promise.allSettled(producers.map((producer) => producer.close()));
    sourceAuthorities.forEach((owner) => owner.close());
    await deployment.close();
    await experimentStore?.close();
    throw error;
  }
  const stopTarget = (id: string) => {
    stopped.add(id);
    for (const req of bodies.get(id) ?? []) if (!req.complete) req.destroy(new Error('Flag target is stopping.'));
    return Promise.allSettled([...(work.get(id) ?? [])]).then(() => {});
  };
  return Object.freeze({
    start() {
      if (retired) throw new FlagManagementDenied();
      consoleOwner?.start();
      for (const producer of producers) producer.start();
    },
    /** Private native target port, shared by Console and other trusted owners. */
    target(appId: string): FlagDeploymentTarget {
      active(appId);
      const port = targetPorts.get(appId);
      if (!port) throw new FlagManagementDenied();
      return port;
    },
    /** Undefined means the child owns this path. Every selected flag path is
     * consumed here, including refusals, so it cannot fall into a second gate. */
    route(appId: string, req: IncomingMessage, res: ServerResponse): Promise<void> | undefined {
      const route = handlers.get(appId),
        path = req.url?.split('?')[0];
      if (route && (path === route.experimentsBase || path?.startsWith(`${route.experimentsBase}/`))) {
        if (!experimentPorts.has(appId)) return undefined;
        if (retired || stopped.has(appId)) {
          res.writeHead(503).end();
          return Promise.resolve();
        }
        if (path === `${route.experimentsBase}/exposures` || path === `${route.experimentsBase}/visitor`) {
          const values = hosts.get(appId)?.flagValuesRoute;
          return values
            ? track(
                appId,
                values(req, res).then(() => {}),
                req,
              )
            : undefined;
        }
        return track(
          appId,
          route.experimentDispatch(req, res).then(() => {}),
          req,
        );
      }
      if (!route || (path !== route.base && !path?.startsWith(`${route.base}/`))) return undefined;
      if (path === `${route.base}/evaluate` && !retired && !stopped.has(appId)) {
        const values = hosts.get(appId)?.flagValuesRoute;
        // Tenant values enter the child's canonical lease transport.
        return values
          ? track(
              appId,
              values(req, res).then(() => {}),
              req,
            )
          : undefined;
      }
      if (getTenantHostIntent(req) || retired || stopped.has(appId)) {
        res.writeHead(403, { 'cache-control': 'no-store' }).end(JSON.stringify({ error: 'Flag access is unavailable.' }));
        return Promise.resolve();
      }
      return track(
        appId,
        route.dispatch(req, res).then(() => {}),
        req,
      );
    },
    routeConsole(req: IncomingMessage, res: ServerResponse): Promise<void> | undefined {
      const path = req.url?.split('?')[0];
      if (!consoleOwner || (path !== consoleMount && !path?.startsWith(`${consoleMount}/`))) return undefined;
      if (getTenantHostIntent(req) || retired) {
        res.writeHead(403).end();
        return Promise.resolve();
      }
      return track(consoleId, consoleOwner.route(req, res), req);
    },
    /** Private same-store atomic reader for the source/runtime owner. This is
     * never a transport handler, session proof or resource-access capability. */
    readPort(appId: string): FlagRequestReadPort {
      active(appId);
      const port = deployment.target(appId).readPort;
      return Object.freeze<FlagRequestReadPort>({
        ...port,
        readRequestScopes: (scope) => {
          active(appId);
          return track(appId, port.readRequestScopes(scope));
        },
      });
    },
    stopTarget,
    close(): Promise<void> {
      retired = true;
      return (closing ??= (async () => {
        const outcomes = await Promise.allSettled([...(consoleOwner ? [consoleOwner.stop()] : []), ...[...work.keys()].map(stopTarget)]);
        sourceAuthorities.forEach((owner) => owner.close());
        const producerOutcomes = await Promise.allSettled(producers.map((producer) => producer.close()));
        const release = [...producerOutcomes, ...(await Promise.allSettled([deployment.close()]))];
        if (experimentStore) release.push(...(await Promise.allSettled([experimentStore.close()])));
        if (consoleOwner) release.push(...(await Promise.allSettled([consoleOwner.close()])));
        const errors = [...outcomes, ...release].filter((result) => result.status === 'rejected').map((result) => result.reason);
        if (errors.length) throw new AggregateError(errors, 'Suite flag retirement failed.');
      })());
    },
  });
}
export type SuiteFlags = Awaited<ReturnType<typeof openSuiteFlags>>;
