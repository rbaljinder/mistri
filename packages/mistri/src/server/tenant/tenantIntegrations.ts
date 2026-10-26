/**
 * A tenant deployment's outbound and its integrations, opened by the host
 * beside its job host (tenantAuthenticatedHttp.ts):
 *
 *  - the effect host: every command's `post(...)` and `send(...)`, delivered
 *    after commit from the tenant event store, each delivery as the tenant
 *    it was written for (tenantFeatureEffects.ts derives and attests it);
 *  - with integrations (the jobs module's `integrations`): the store and
 *    runtime its commands' lookups call through, each tenant's own secrets;
 *    the signed webhooks, lowered onto inbound endpoints
 *    (integrationInbound.ts) at `/api/inbound/<name>/<tenant>` and served by
 *    the inbound host, whose mapped events run as the mapping's service
 *    principal through the same fenced, per-tenant binding a job's attempt
 *    has (tenantJobs.ts `deliver`), so an event for a tenant that is not
 *    active runs nothing and one tenant's delivery never reaches another's
 *    rows; the channels, and
 *    the loop that sends what quiet hours held; and the settings screen's
 *    reads and saves, one tenant's at a time.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { openIntegrationStore, type IntegrationStore } from '../../adapters/integrations/integrationStore.js';
import type { StoreTarget } from '../commands/appCommandEvents.js';
import { CHANNEL_DESTINATION_PREFIX, type Webhook } from '../commands/commandEffects.js';
import { openEffectHost, type EffectHost } from '../effects/effectHost.js';
import { channelTransports } from '../integrations/integrationChannels.js';
import {
  createIntegrationRuntime,
  readIntegrationSettings,
  registerIntegrationRuntime,
  saveIntegrationSettings,
  type IntegrationRuntime,
  type IntegrationSettings,
} from '../integrations/integrationRuntime.js';
import { integrationEndpoints } from '../integrations/integrationInbound.js';
import { createInboundHost, InboundNoTenant, type InboundHost } from '../jobs/inboundHost.js';
import type { ReadinessCheckInput } from '../operations/operations.js';
import { openWebhook, type WebhookServiceConfig } from '../webhooks.js';
import { tenantEffectDeployment } from './tenantFeatureEffects.js';
import { captureTenantEnrollment, type TenantEnrollment } from './tenantEnrollment.js';
import { tenantIntegrationRuntime } from './tenantJobs.js';

/* Held messages are looked at every half minute: quiet hours end on the minute, and nobody waits on a held text. */
const HELD_MS = 30_000;

export interface TenantIntegrations {
  /** The webhook routes, before any session: true when the request was one. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /** The settings screen, for a member of the tenant (undefined when the App lists no integrations). */
  readonly settings?: Readonly<{
    editors: readonly string[];
    read(tenant: string): Promise<IntegrationSettings>;
    save(tenant: string, by: string, body: unknown): Promise<void>;
  }>;
  /** Deliver what is due once (effects, then held messages): what a test drives instead of the loop. */
  tick(): Promise<boolean>;
  readiness(): readonly ReadinessCheckInput[];
  start(): void;
  stop(): Promise<void>;
}

/** Open them, or undefined when the deployment has neither effects nor integrations. */
export async function openTenantIntegrations<Request = IncomingMessage>(
  options: Readonly<{
    enrollment: TenantEnrollment<Request>;
    /** The config file's webhook connections, by name, as a single-App server reads them. */
    webhookConfig: (name: string) => WebhookServiceConfig | undefined;
    /** Where the deployment is reached, for the webhook address the settings screen shows. */
    webhookBase?: string;
    now?: () => number;
    warn?: (message: string) => void;
  }>,
): Promise<TenantIntegrations | undefined> {
  const captured = captureTenantEnrollment(options.enrollment);
  const { app, registry, source, events } = captured;
  const now = options.now ?? captured.clock;
  const deployment = tenantEffectDeployment(app.id, events.storeId, registry);
  const owned = tenantIntegrationRuntime(options.enrollment);
  if (!deployment && !owned) return undefined;
  const target: StoreTarget = 'path' in source ? { sqlite: source.path } : { postgres: source.url };
  let store: IntegrationStore | undefined;
  let runtime: IntegrationRuntime | undefined;
  let withdraw: (() => void) | undefined;
  let effects: EffectHost | undefined;
  try {
    if (owned) {
      store = await openIntegrationStore(target);
      runtime = createIntegrationRuntime({ appId: app.id, declared: owned.integrations, store, now });
      withdraw = registerIntegrationRuntime(runtime);
    }
    const channels = runtime ? channelTransports(runtime) : undefined;
    if (deployment) {
      const webhooks = new Map<string, Webhook>();
      for (const { webhook } of deployment.destinations) {
        if (webhook.startsWith(CHANNEL_DESTINATION_PREFIX)) {
          if (!channels) throw new Error(`A command sends on ${webhook}, and the jobs module lists no integrations to send it through.`);
          continue;
        }
        const config = options.webhookConfig(webhook);
        if (!config)
          throw new Error(
            `A command posts to webhook "${webhook}", which the config file does not name. Add a "kind": "webhook" connection called "${webhook}".`,
          );
        webhooks.set(webhook, openWebhook(config));
      }
      effects = await openEffectHost({
        deployment,
        target,
        webhooks,
        ...(channels ? { channels: channels.transport } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
    }
    let webhookRoutes: InboundHost | undefined;
    if (runtime && owned) {
      const { deliver, principals, commands } = owned;
      webhookRoutes = createInboundHost({
        endpoints: integrationEndpoints(runtime, commands),
        appId: app.id,
        principals,
        tenants: true,
        deliveries: runtime.store,
        now,
        ...(options.warn ? { warn: options.warn } : {}),
        bind: async ({ endpoint, tenant }) => {
          try {
            return await deliver(`integration:${endpoint}`, tenant);
          } catch {
            throw new InboundNoTenant();
          }
        },
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopping = false;
    let running: Promise<unknown> | undefined;
    const sendDue = async () => (channels ? channels.sendDue() : false);
    const loop = () => {
      if (stopping) return;
      running = sendDue()
        .catch(() => options.warn?.('held channel messages could not be sent; they are tried again shortly.'))
        .finally(() => {
          running = undefined;
          if (!stopping) timer = setTimeout(loop, HELD_MS);
        });
    };
    const base = (options.webhookBase ?? '').replace(/\/+$/, '');
    const live = runtime;
    return Object.freeze({
      handle: async (req: IncomingMessage, res: ServerResponse, url: URL) => (webhookRoutes ? webhookRoutes.handle(req, res, url) : false),
      ...(live && owned
        ? {
            settings: Object.freeze({
              editors: owned.integrations.editors,
              read: (tenant: string) => readIntegrationSettings(live, tenant, (name) => `${base}/api/inbound/${name}/${tenant}`),
              save: (tenant: string, by: string, body: unknown) => saveIntegrationSettings(live, tenant, by, body),
            }),
          }
        : {}),
      async tick() {
        const moved = effects ? await effects.tick() : false;
        return (await sendDue()) || moved;
      },
      readiness: () => effects?.readiness() ?? [],
      start() {
        effects?.start();
        if (channels && !timer && !running) timer = setTimeout(loop, HELD_MS);
      },
      async stop() {
        stopping = true;
        if (timer) clearTimeout(timer);
        await running;
        await effects?.stop();
        withdraw?.();
        await store?.close();
      },
    });
  } catch (error) {
    await effects?.stop().catch(() => {});
    withdraw?.();
    await store?.close().catch(() => {});
    throw error;
  }
}
