/** Server-only declarations: a business event handle, never a browser field map. */
import { isProxy } from 'node:util/types';
import type { CommandEventJson } from '../../adapters/events/commandEventTypes.js';
import { isBusinessEvent, type BusinessEvent } from '../commands/businessEvents.js';
import { ensure, identifier, record } from './contracts.js';

declare const conversionBrand: unique symbol;
export interface ExperimentConversion {
  readonly id: string;
  readonly [conversionBrand]: true;
}
export interface CapturedExperimentConversion {
  readonly id: string;
  readonly on: BusinessEvent<Record<string, CommandEventJson>>;
  readonly unit: { readonly kind: 'subject'; readonly source: 'actor' } | { readonly kind: 'visitor'; readonly source: 'public-intake' };
}
const definitions = new WeakMap<object, CapturedExperimentConversion>();

/** Actor means the journal-built envelope actor, confirmed as a native subject
 * by the source owner at delivery. No payload field can declare its own origin.
 * Public intake uses the same-transaction verified visitor audit envelope,
 * never the event payload. No identity stitching is performed.
 */
export function defineExperimentConversion<Payload extends Record<string, CommandEventJson>>(input: {
  readonly id: string;
  readonly on: BusinessEvent<Payload>;
  readonly unit: { readonly kind: 'subject'; readonly source: 'actor' } | { readonly kind: 'visitor'; readonly source: 'public-intake' };
}): ExperimentConversion {
  ensure(!isProxy(input));
  const raw = record(input, ['id', 'on', 'unit']);
  ensure(!isProxy(raw.unit));
  const unit = record(raw.unit, ['kind', 'source']);
  ensure(
    (unit.kind === 'subject' && unit.source === 'actor') || (unit.kind === 'visitor' && unit.source === 'public-intake'),
    'Conversion requires verified actor or public-intake provenance.',
  );
  ensure(isBusinessEvent(raw.on), 'Conversion requires a defineEvent-issued handle.');
  const id = identifier(raw.id),
    result = Object.freeze({ id });
  definitions.set(
    result,
    Object.freeze({
      id,
      on: raw.on,
      unit: Object.freeze(
        unit.kind === 'subject'
          ? { kind: 'subject' as const, source: 'actor' as const }
          : { kind: 'visitor' as const, source: 'public-intake' as const },
      ),
    }),
  );
  return result as ExperimentConversion;
}
export function captureExperimentConversion(value: ExperimentConversion): CapturedExperimentConversion {
  const definition = value && typeof value === 'object' && definitions.get(value);
  ensure(definition, 'Unregistered experiment conversion.');
  return definition;
}
