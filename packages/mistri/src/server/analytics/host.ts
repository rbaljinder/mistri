/**
 * One App's analytics, opened at startup: the attested store, the ingest that
 * decides what may enter it, the beacon route, the recorder for its commands'
 * outcomes, and the loop that delivers to its sinks. Closing it stops the
 * loop first and then closes the store.
 *
 * Sinks run here on a timer, not through the App's job runner: a suite App
 * need not have a jobs store, and the position the store keeps makes a
 * missed tick harmless. `analyticsSinkJob` is the same delivery as a job for
 * an App that does keep one.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { analyticsCatalog, type AnalyticsCatalog } from '../../shared/appAnalytics.js';
import type { AppDef } from '../../shared/appModel.js';
import { registerCommandAnalytics } from '../commands/businessCommandExecution.js';
import type { Webhook } from '../commands/commandEffects.js';
import type { Bound } from '@mistriwork/engine/server/http/trust.js';
import { createAnalyticsBeaconHttp } from './beaconHttp.js';
import type { AnalyticsConfiguration } from './config.js';
import { createAnalyticsIngest, type AnalyticsIngest, type AnalyticsUnit } from './ingest.js';
import { createHttpAnalyticsSink, deliverAnalyticsBatch, type AnalyticsSink } from './sinkHttp.js';
import { createPresetAnalyticsSink } from './sinkPresets.js';
import { openAnalyticsStore, type AnalyticsStore } from './store.js';

export interface AnalyticsHost {
  readonly store: AnalyticsStore;
  readonly ingest: AnalyticsIngest;
  /** The beacon route: true when it answered the request. */
  readonly beacon: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  /** Start delivering to the configured sinks. */
  start(): void;
  close(): Promise<void>;
}

export async function openAnalyticsHost(options: {
  readonly configuration: AnalyticsConfiguration;
  readonly app: { readonly app: AppDef; readonly pages: ReadonlyArray<{ id: string }> };
  readonly environment: string;
  /** Where the App is served: the beacon is `{mount}/_mistri/analytics`. */
  readonly mount: string;
  readonly bound: Bound;
  /** The signed-in account of this request, from the verified session; null for none. */
  readonly subject: (req: IncomingMessage) => Promise<string | null>;
  /** The visitor of this request, from the AN2 cookie, when the deployment issues one. */
  readonly visitor?: (req: IncomingMessage) => string | null;
  /** The App's webhook connections, by name. */
  readonly webhook: (name: string) => Webhook | undefined;
  /** Where a preset's `${KEY}` is read; the process's environment unless the deployment carries its own. */
  readonly variables?: NodeJS.ProcessEnv;
  readonly sinkIntervalMs?: number;
  /** How long a row rests before a sink is sent it, so a slower writer's lower id is not passed over. */
  readonly settleMs?: number;
  readonly onSinkError?: (sink: string, message: string) => void;
}): Promise<AnalyticsHost> {
  const { configuration, app } = options,
    declaration = app.app.analytics;
  if (!declaration) throw new Error(`Analytics is configured for App "${app.app.id}", which declares no \`analytics\`.`);
  const catalog: AnalyticsCatalog = analyticsCatalog(app.app, app.pages);
  const sinks: AnalyticsSink[] = configuration.sinks.map((sink) => {
    if (sink.preset) {
      const variables = options.variables ?? process.env;
      const key = sink.key?.replace(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/, (_, name: string) => {
        const value = variables[name];
        if (!value) throw new Error(`Analytics sink "${sink.id}" reads its key from \${${name}}, which is not set.`);
        return value;
      });
      return createPresetAnalyticsSink({
        id: sink.id,
        batch: sink.batch,
        preset: sink.preset,
        source: `${app.app.id}.${configuration.deploymentId}`,
        ...(key === undefined ? {} : { key }),
        ...(sink.endpoint === undefined ? {} : { endpoint: sink.endpoint }),
        ...(sink.measurementId === undefined ? {} : { measurementId: sink.measurementId }),
        ...(sink.format === undefined ? {} : { format: sink.format }),
      });
    }
    const webhook = sink.connection === undefined ? undefined : options.webhook(sink.connection);
    if (!webhook)
      throw new Error(`Analytics sink "${sink.id}" names connection "${sink.connection}", which is not a webhook connection of this App.`);
    return createHttpAnalyticsSink({ id: sink.id, batch: sink.batch, webhook });
  });
  const store = await openAnalyticsStore({
    url: configuration.store,
    binding: { appId: app.app.id, deploymentId: configuration.deploymentId },
  });
  const ingest = createAnalyticsIngest({ store, declaration, catalog, environment: options.environment });
  const beacon = createAnalyticsBeaconHttp({
    mount: options.mount,
    bound: options.bound,
    ingest,
    async resolveUnit(req): Promise<AnalyticsUnit | null> {
      const subject = await options.subject(req);
      if (subject) return { kind: 'subject', id: subject };
      const visitor = options.visitor?.(req);
      return visitor ? { kind: 'visitor', id: visitor } : null;
    },
  });
  const unregister = declaration.collect?.includes('commands')
    ? registerCommandAnalytics(app.app.id, (event) => {
        // Telemetry never decides a command's outcome: a failed write is dropped here, not thrown into it.
        void ingest
          .recordAction({ command: event.command, outcome: event.outcome, unit: event.unit ? { kind: 'subject', id: event.unit } : null })
          .catch(() => {});
      })
    : () => {};
  let timer: ReturnType<typeof setInterval> | undefined,
    draining: Promise<void> = Promise.resolve();
  const reported = new Map<string, string>();
  const drain = () =>
    (draining = draining.then(async () => {
      for (const sink of sinks) {
        try {
          for (let batch = 0; batch < 20; batch++) {
            const result = await deliverAnalyticsBatch(store, sink, {
              now: Date.now(),
              ...(options.settleMs === undefined ? {} : { settleMs: options.settleMs }),
            });
            if (result.status === 'rejected') throw new Error('The sink refused a batch; it will be sent again.');
            if (result.status === 'empty') break;
          }
          reported.delete(sink.id);
        } catch (error) {
          const message = (error as Error).message;
          if (reported.get(sink.id) !== message) {
            reported.set(sink.id, message);
            options.onSinkError?.(sink.id, message);
          }
        }
      }
    }));
  return Object.freeze({
    store,
    ingest,
    beacon,
    start() {
      if (sinks.length && !timer) {
        timer = setInterval(() => {
          void drain();
        }, options.sinkIntervalMs ?? 5000);
        timer.unref();
      }
    },
    async close() {
      unregister();
      if (timer) clearInterval(timer);
      await draining.catch(() => {});
      await store.close();
    },
  });
}

/** Put the beacon in front of a server's own request listeners, as the flag values route is. */
export function bindAnalyticsServer(server: Server, host: AnalyticsHost): void {
  const listeners = server.listeners('request');
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    void host
      .beacon(req, res)
      .then((handled) => {
        if (!handled) for (const listener of listeners) listener.call(server, req, res);
      })
      .catch(() => {
        if (!res.headersSent) res.writeHead(503).end();
        else res.destroy();
      });
  });
}
