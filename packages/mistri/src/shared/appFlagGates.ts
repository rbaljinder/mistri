/** Closed scalar command gates; declaring a condition never adds command authority. */
import type { AppFlagGate } from '../../schema/command.js';
import { captureFlagDeclaration, flagDeclarationName, flagDeclarationObject } from './appExperiments.js';
import type { FlagCatalog } from './appFlags.js';

/** Capture the same closed scalar contract as server command registration.
 * A catalog check permits booleans or explicitly enumerated scalar variants. */
export function normalizeAppFlagGate(input: unknown, catalog?: FlagCatalog): AppFlagGate {
  const raw = flagDeclarationObject(captureFlagDeclaration(input), ['flag', 'is']);
  const flag = flagDeclarationName(raw.flag),
    value = raw.is;
  if (!(typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number'))
    throw new Error('enabledBy.is must be a finite scalar.');
  if (catalog) {
    const definition = Object.hasOwn(catalog.flags, flag) ? catalog.flags[flag] : undefined;
    if (
      !definition ||
      definition.type === 'object' ||
      typeof value !== definition.type ||
      (definition.type !== 'boolean' && !definition.variants?.some((variant) => variant === value))
    ) {
      throw new Error(`enabledBy must name a declared boolean or scalar variant: ${flag}.`);
    }
  }
  return Object.freeze({ flag, is: value });
}
