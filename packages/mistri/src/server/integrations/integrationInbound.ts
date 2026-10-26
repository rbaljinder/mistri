/**
 * An integration's webhooks, lowered onto an inbound endpoint (jobs/inboundHost.ts):
 * `defineIntegration({ webhooks })` with the App's mapping
 * (`integrations.webhooks` in its jobs module) compiles to the same endpoint
 * a `defineInbound` does, served by the same host at
 * `POST {mount}/api/inbound/<name>` — `…/<name>/<tenant>` on a tenant App,
 * where each tenant gives its provider its own address and its own secrets.
 *
 * What the lowering supplies is only what a provider decides:
 *  - the secrets are the tenant's own, entered on the settings screen
 *    (sealed in the integrations store), and a tenant that has not set them
 *    is the same 404 as an address that names nothing;
 *  - the signature is read by the package's `verify`, which answers the
 *    provider's event (its id, type, time and data) or nothing; its time is
 *    held to the five minutes providers' own libraries hold;
 *  - the event's id is the sender's id: a replay, or a provider's retry,
 *    answers the command's receipt, and consent is recorded once;
 *  - an event the App does not map is 202; an `optOut`/`optIn` event records
 *    the recipient's consent (core's, read before every channel send); a
 *    mapped event runs its command as the mapping's principal with the
 *    payload as input, named by no record.
 * Everything else — size, time window, replay, the answer, the span — is the
 * inbound host's, so there is one implementation of it to secure.
 */
import type { IncomingMessage } from 'node:http';
import type { InboundEndpoint, InboundPlan, InboundReading } from '../jobs/inboundHost.js';
import type { JobCommandReference } from '../jobs/jobModule.js';
import { channelHolder } from './integrationChannels.js';
import type { IntegrationEvent } from './integrationModule.js';
import type { IntegrationRuntime } from './integrationRuntime.js';

/** How far a delivery's own time may be from ours: five minutes, as providers' own libraries hold it. */
const INTEGRATION_WEBHOOK_WINDOW_MS = 5 * 60_000;

/* The package's answer, read as data: anything that is not an event of the contract's shape verifies nothing. */
function eventOf(value: unknown): IntegrationEvent | undefined {
  const event = value as Partial<IntegrationEvent> | null;
  if (!event || typeof event !== 'object') return undefined;
  if (typeof event.id !== 'string' || !event.id || event.id.length > 256) return undefined;
  if (typeof event.type !== 'string' || !event.type || event.type.length > 128) return undefined;
  if (typeof event.at !== 'number' || !Number.isFinite(event.at)) return undefined;
  return Object.freeze({ id: event.id, type: event.type, at: event.at, data: event.data });
}

/** The headers as a package reads them: lowercased names, one string each. */
function headersOf(headers: IncomingMessage['headers']): Readonly<Record<string, string | undefined>> {
  const read: Record<string, string | undefined> = {};
  for (const [header, value] of Object.entries(headers)) read[header] = Array.isArray(value) ? value.join(', ') : value;
  return Object.freeze(read);
}

/**
 * Each integration the App uses that sends webhooks, as an inbound endpoint
 * named after it. `commands` pins each mapped command at the version the
 * registry holds, as a defineInbound's is pinned.
 */
export function integrationEndpoints(
  runtime: IntegrationRuntime,
  commands: Readonly<Record<string, { readonly version: number }>>,
): InboundEndpoint[] {
  const endpoints: InboundEndpoint[] = [];
  for (const [name, integration] of runtime.declared.use) {
    const webhooks = integration.webhooks;
    if (!webhooks) continue;
    const mapping = runtime.declared.webhooks.get(name);
    const channel = integration.channel?.name;
    endpoints.push(
      Object.freeze({
        name,
        windowMs: INTEGRATION_WEBHOOK_WINDOW_MS,
        secrets: (tenant: string) => runtime.secrets(tenant, name),
        verify(
          delivery: Readonly<{ headers: IncomingMessage['headers']; body: Buffer }>,
          secrets: Readonly<Record<string, string>>,
          now: number,
        ) {
          const event = eventOf(
            webhooks.verify(Object.freeze({ headers: headersOf(delivery.headers), body: delivery.body }), Object.freeze({ secrets, now })),
          );
          return event ? Object.freeze({ at: event.at, payload: event }) : undefined;
        },
        read(payload: unknown): InboundReading {
          const event = payload as IntegrationEvent;
          return Object.freeze({
            key: event.id,
            plan(): InboundPlan {
              const declared = [...webhooks.events].find(([, definition]) => definition.type === event.type);
              // Providers send many events; one the package does not name is no one's.
              if (!declared) return Object.freeze({ status: 202 });
              const [eventName, definition] = declared;
              const data = definition.payload.parse(event.data) as Record<string, unknown>;
              const consent = (
                [
                  [definition.optOut, 'out'],
                  [definition.optIn, 'in'],
                ] as const
              ).filter(([key]) => key && channel && typeof data[key] === 'string');
              const record = consent.length
                ? async (tenant: string, at: number) => {
                    for (const [key, state] of consent)
                      await runtime.store.setConsent({
                        app: runtime.appId,
                        tenant,
                        channel: channel!,
                        holder: channelHolder(data[key!] as string, channel!),
                        state,
                        source: `${name}:${eventName}`,
                        at,
                      });
                  }
                : undefined;
              const command = mapping?.events.get(eventName);
              if (!command)
                return Object.freeze({ ...(record ? { record } : {}), status: definition.optOut || definition.optIn ? 204 : 202 });
              const reference: JobCommandReference = Object.freeze({
                id: command,
                version: Object.hasOwn(commands, command) ? commands[command].version : 1,
              });
              return Object.freeze({
                ...(record ? { record } : {}),
                run: Object.freeze({ command: reference, runAs: mapping!.runAs, input: data }),
              });
            },
          });
        },
        receipts: (tenant: string) => `integration:${name}:${tenant}`,
      }),
    );
  }
  return endpoints;
}
