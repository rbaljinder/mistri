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
import { causeText } from '../observe/failureCause.js';
import { settledReporter } from './integrationSettled.js';
import type { JobCommandBinding } from '../jobs/jobCommands.js';
import type { PublicLinkRender } from '../links/publicLink.js';

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
    /** How a public link in a held message is said. */
    publicLinks?: PublicLinkRender;
    /** Where `integrations.settled`'s command runs: its version, the module's principals and the job binding. */
    settled?: Readonly<{
      version: number;
      principals: ReadonlyMap<string, readonly string[]>;
      bind: (runAs: string) => Promise<JobCommandBinding>;
    }>;
  }>,
): Promise<AppIntegrations> {
  const { appId, declared } = options;
  const now = options.now ?? Date.now;
  const store: IntegrationStore = await openIntegrationStore(options.target);
  const runtime = createIntegrationRuntime({
    appId,
    declared,
    store,
    now,
    ...(options.publicLinks ? { publicLinks: options.publicLinks } : {}),
  });
  const withdraw = registerIntegrationRuntime(runtime);
  const sent = channelTransports(runtime);
  const reporter = options.settled
    ? settledReporter({ runtime, ...options.settled, bind: (_tenant, runAs) => options.settled!.bind(runAs) })
    : undefined;
  // What the channels decided, then what the App is told of it (integrations.settled).
  const channels = Object.freeze({
    sendDue: async () => {
      const moved = await sent.sendDue();
      return (reporter ? await reporter.report() : false) || moved;
    },
    transport: sent.transport,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let stopping = false;
  let woken = false;
  let running: Promise<unknown> | undefined;
  const loop = () => {
    timer = undefined;
    if (stopping) return;
    woken = false;
    running = channels
      .sendDue()
      .catch((cause) => console.error(`mistri: held channel messages could not be sent; they are tried again shortly: ${causeText(cause)}`))
      .finally(() => {
        running = undefined;
        if (!stopping && started) timer = setTimeout(loop, woken ? 0 : HELD_MS);
      });
  };
  const wake = () => {
    if (!started || stopping || !reporter) return;
    if (running) {
      woken = true;
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(loop, 0);
  };
  const wakingTransport: typeof channels.transport = (channel, routed) => {
    const inner = channels.transport(channel, routed);
    if (!inner) return undefined;
    return async (publication) => {
      const outcome = await inner(publication);
      if (outcome === 'accepted') wake();
      return outcome;
    };
  };
  return Object.freeze({
    runtime,
    channel: wakingTransport,
    sendDue: () => channels.sendDue(),
    start() {
      started = true;
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
