/** Captured command/event graph used both for epoch registration and routing. */
import { isProxy } from 'node:util/types';
import type { CommandEventJson, CommandEventManifest } from '../../adapters/events/commandEventTypes.js';
import { captureEventDeliveryPolicy, type EventDeliveryPolicy, type EventDeliveryRoute } from '../../adapters/events/eventDeliveryTypes.js';
import { getCommandEvents, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import { isBusinessEvent, type BusinessEvent } from '../commands/businessEvents.js';
import { digest, ensure, identifier, integer, list, normalizeReference, record, type EpochReference } from './contracts.js';
import { captureExperimentConversion, type CapturedExperimentConversion, type ExperimentConversion } from './declarations.js';

declare const registryBrand: unique symbol;
export interface ExperimentConversionRegistry {
  readonly ids: readonly string[];
  readonly [registryBrand]: true;
}
interface Emitter {
  readonly id: string;
  readonly version: number;
  readonly source: string;
  readonly manifest: CommandEventManifest;
}
interface CapturedRegistry {
  readonly conversions: ReadonlyMap<string, CapturedExperimentConversion>;
  readonly events: ReadonlyMap<string, BusinessEvent<Record<string, CommandEventJson>>>;
  readonly emitters: ReadonlyMap<string, Emitter>;
}
const registries = new WeakMap<object, CapturedRegistry>();
const eventIdentity = (name: string, version: number): string => JSON.stringify([name, version]);

export function createExperimentConversionRegistry(input: {
  readonly conversions: readonly ExperimentConversion[];
  readonly commands: BusinessCommandRegistry;
  /** Handles for additional facts in a routed command's complete manifest. */
  readonly events?: readonly BusinessEvent<Record<string, CommandEventJson>>[];
}): ExperimentConversionRegistry {
  ensure(!isProxy(input));
  const raw = record(input, ['conversions', 'commands', 'events']);
  const conversions = new Map<string, CapturedExperimentConversion>();
  const events = new Map<string, BusinessEvent<Record<string, CommandEventJson>>>();
  const addEvent = (event: BusinessEvent<Record<string, CommandEventJson>>) => {
    ensure(isBusinessEvent(event));
    const key = eventIdentity(event.name, event.version);
    ensure(!events.has(key) || events.get(key) === event, 'Ambiguous event definition handles.');
    events.set(key, event);
  };
  for (const item of list(raw.conversions, 256)) {
    const conversion = captureExperimentConversion(item as ExperimentConversion);
    ensure(!conversions.has(conversion.id), 'Duplicate conversion ID.');
    conversions.set(conversion.id, conversion);
    addEvent(conversion.on);
  }
  ensure(conversions.size > 0);
  for (const event of list(raw.events ?? [], 256)) addEvent(event as BusinessEvent<Record<string, CommandEventJson>>);
  ensure(!isProxy(raw.commands) && raw.commands !== null && typeof raw.commands === 'object');
  const commands = record(raw.commands, Object.keys(raw.commands));
  ensure(Object.keys(commands).length <= 256);
  const emitters = new Map<string, Emitter>();
  for (const [id, candidate] of Object.entries(commands)) {
    const command = candidate as BusinessCommandRegistry[string],
      captured = getCommandEvents(command);
    if (!captured) continue;
    ensure(command.realm !== 'platform', 'Platform commands have no supported conversion source.');
    for (const conversion of conversions.values())
      if (captured.expectation.some((event) => event.name === conversion.on.name && event.version === conversion.on.version)) {
        ensure(
          (conversion.unit.kind === 'visitor') === (command.public === true),
          'Conversion unit must match private actor or public intake emitter.',
        );
      }
    const manifest = Object.freeze(captured.expectation.map((event) => Object.freeze({ name: event.name, version: event.version })));
    // Every event in a selected source's batch needs a genuine parser, including
    // explicitly ignored non-conversion facts; publisher ordering stays intact.
    ensure(
      manifest.every((event) => events.has(eventIdentity(event.name, event.version))),
      'Missing event handle for command manifest.',
    );
    emitters.set(
      id,
      Object.freeze({ id: identifier(id), version: integer(command.version, 1), source: identifier(command.source), manifest }),
    );
  }
  for (const conversion of conversions.values())
    ensure(
      [...emitters.values()].some((emitter) =>
        emitter.manifest.some((event) => event.name === conversion.on.name && event.version === conversion.on.version),
      ),
      'Conversion has no registered command emitter.',
    );
  const handle = Object.freeze({ ids: Object.freeze([...conversions.keys()].sort()) });
  registries.set(handle, { conversions, events, emitters });
  return handle as ExperimentConversionRegistry;
}
function capturedRegistry(registry: ExperimentConversionRegistry): CapturedRegistry {
  const value = registries.get(registry);
  ensure(value, 'Unregistered conversion graph.');
  return value;
}
export function registeredConversion(registry: ExperimentConversionRegistry, id: string): CapturedExperimentConversion {
  const conversion = capturedRegistry(registry).conversions.get(identifier(id));
  ensure(conversion, 'Unknown conversion declaration.');
  return conversion;
}
export function registeredConversionEvent(registry: ExperimentConversionRegistry, name: string, version: number) {
  const event = capturedRegistry(registry).events.get(eventIdentity(name, version));
  ensure(event, 'Unknown business event.');
  return event;
}
/** Generates routes from genuine registered command manifests, never from an
 * incoming envelope. One destination is bound to one evaluation tenant/realm. */
export function experimentDeliveryPolicy(
  registry: ExperimentConversionRegistry,
  input: {
    readonly epoch: EpochReference;
    readonly source: EventDeliveryPolicy['source'];
    readonly serviceId: string;
    readonly commandIds: readonly string[];
    readonly evaluationTenantId: string | null;
    readonly limits: EventDeliveryPolicy['limits'];
  },
): EventDeliveryPolicy {
  const graph = capturedRegistry(registry),
    commands = list(input.commandIds, 64).map(identifier);
  ensure(commands.length > 0 && new Set(commands).size === commands.length);
  const routes: EventDeliveryRoute[] = commands.map((id) => {
    const emitter = graph.emitters.get(id);
    ensure(emitter && emitter.source === input.source.sourceId, 'Foreign command event source.');
    return input.evaluationTenantId === null
      ? { scope: 'app', commandId: id, commandVersion: emitter.version, manifest: emitter.manifest }
      : {
          scope: 'tenant',
          tenantId: identifier(input.evaluationTenantId),
          commandId: id,
          commandVersion: emitter.version,
          manifest: emitter.manifest,
        };
  });
  const captured = captureEventDeliveryPolicy({
    source: input.source,
    serviceId: input.serviceId,
    destinationId: 'pending',
    routes,
    limits: input.limits,
  });
  const reference = normalizeReference(input.epoch);
  // Outbox ACK state is per destination. Reusing it for another epoch or changed
  // conversion routing would silently reuse old delivery decisions.
  const destinationId = `experiment-${digest([
    'mistri.experiments.destination.v1',
    reference,
    captured.source,
    captured.serviceId,
    captured.routes,
    captured.limits,
  ])}`;
  return Object.freeze({ ...captured, destinationId });
}
export function validateExperimentDeliveryPolicy(
  registry: ExperimentConversionRegistry,
  policy: EventDeliveryPolicy,
  epoch: EpochReference,
  tenantId: string | null,
): void {
  const expected = experimentDeliveryPolicy(registry, {
    ...policy,
    epoch,
    commandIds: policy.routes.map((route) => route.commandId),
    evaluationTenantId: tenantId,
  });
  ensure(JSON.stringify(expected) === JSON.stringify(policy), 'Destination policy differs from the registered emitter manifest/realm.');
}
