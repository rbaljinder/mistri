/** Private server declarations exported beside the command registry. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import { createExperimentConversionRegistry } from './conversionRegistry.js';
import type { ExperimentConversion } from './declarations.js';
import { ensure } from './contracts.js';

export async function loadExperimentConversions(file: string, commands: BusinessCommandRegistry) {
  ensure(file.length > 0, 'Experiments require an explicit commands module.');
  const loaded = await import(pathToFileURL(resolve(file)).href);
  ensure(Array.isArray(loaded.experimentConversions), 'Export experimentConversions from the commands module.');
  return createExperimentConversionRegistry({ commands, conversions: loaded.experimentConversions as readonly ExperimentConversion[] });
}
