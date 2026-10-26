/**
 * An App's integrations on a server without tenants (`mistri serve`, a
 * suite member), opened by commandHost.ts beside its effects and inbound
 * endpoints: the store beside the commands' source, the runtime their
 * lookups call through (tenant '' throughout), the channels the effect host
 * sends through, and the loop that sends what quiet hours held. Its webhooks
 * are inbound endpoints (integrationInbound.ts), served by the App's one
 * inbound host over this runtime.
 */
import { openIntegrationStore, type IntegrationStore } from '../../adapters/integrations/integrationStore.js';
import type { StoreTarget } from '../commands/appCommandEvents.js';
import type { EventPublicationTransport } from '../events/eventPublisher.js';
import { channelTransports } from './integrationChannels.js';
import type { CapturedIntegrations } from './integrationDeclaration.js';
import { createIntegrationRuntime, registerIntegrationRuntime, type IntegrationRuntime } from './integrationRuntime.js';

/* Held messages are looked at every half minute: quiet hours end on the minute, and nobody waits on a held text. */
const HELD_MS = 30_000;

export interface AppIntegrations {
  readonly runtime: IntegrationRuntime;
  /** A channel destination's transport, for the effect host. */
  channel(destination: string, routed: ReadonlySet<string>): EventPublicationTransport | undefined;
  /** Send what quiet hours held and is now due, once. */
  sendDue(): Promise<boolean>;
  start(): void;
  stop(): Promise<void>;
}

export async function openAppIntegrations(
  options: Readonly<{
    appId: string;
    declared: CapturedIntegrations;
    target: StoreTarget;
    now?: () => number;
  }>,
): Promise<AppIntegrations> {
  const { appId, declared } = options;
  const now = options.now ?? Date.now;
  const store: IntegrationStore = await openIntegrationStore(options.target);
  const runtime = createIntegrationRuntime({ appId, declared, store, now });
  const withdraw = registerIntegrationRuntime(runtime);
  const channels = channelTransports(runtime);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  let running: Promise<unknown> | undefined;
  const loop = () => {
    if (stopping) return;
    running = channels
      .sendDue()
      .catch(() => console.error('mistri: held channel messages could not be sent; they are tried again shortly.'))
      .finally(() => {
        running = undefined;
        if (!stopping) timer = setTimeout(loop, HELD_MS);
      });
  };
  return Object.freeze({
    runtime,
    channel: channels.transport,
    sendDue: () => channels.sendDue(),
    start() {
      if (!timer && !running && !stopping) timer = setTimeout(loop, HELD_MS);
    },
    async stop() {
      stopping = true;
      if (timer) clearTimeout(timer);
      await running;
      withdraw();
      await store.close();
    },
  });
}
