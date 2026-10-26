/**
 * `[command-unoffered]`: a command that names a record and that nothing
 * offers. Preparing a targeted command looks up the reference an action, a
 * form, an import or an API exposure made (businessCommandLoader.ts); a
 * command with none has no form to prepare and answers 403 `forbidden`, though
 * every role may be granted it.
 */
import { appCommandOccurrences } from '../../shared/appCommandOccurrences.js';
import { importCommandOccurrences } from '../../shared/appImport.js';
import type { AppDef } from '../../shared/app.js';
import { flowCommandOf } from '../commands/flowCommandBrand.js';
import { genericWriteOf } from '../commands/genericWriteBrand.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';

/**
 * `runByServices`: the commands jobs, workflows, inbound endpoints and webhooks run
 * as service principals. They prepare nothing, so offering none is right.
 */
export function unofferedCommandWarnings(
  app: AppDef,
  commands: BusinessCommandRegistry | undefined,
  runByServices: ReadonlySet<string> = new Set(),
): string[] {
  if (!commands) return [];
  const offered = new Set<string>([
    ...appCommandOccurrences(app).map((occurrence) => occurrence.reference.id),
    ...importCommandOccurrences(app).map((occurrence) => occurrence.reference.id),
    // An exposed command is called through the API (and its MCP tools) without a button.
    ...(app.api?.commands ?? []).map((exposure) => exposure.command.id),
  ]);
  for (const resource of Object.values(app.resources ?? {})) {
    const machine = resource.machine;
    for (const edge of machine?.edges ?? []) if (edge.command) offered.add(edge.command);
    for (const state of machine?.states ?? []) for (const timer of state.after ?? []) if (timer.command) offered.add(timer.command);
  }
  return Object.entries(commands).flatMap(([id, command]) => {
    if ((command.targets ?? 'one') === 'none' || command.public === true) return [];
    if (offered.has(id) || runByServices.has(id) || genericWriteOf(command) || flowCommandOf(command)) return [];
    return [
      `command "${id}" names a record and no action, form, import or API exposure offers it [command-unoffered]: ` +
        `preparing it is refused with 403 forbidden. Offer it on "${command.target}" ` +
        `(actions: [action('…', { command: '${id}' })]), expose it in api.commands, or take it out of the registry.`,
    ];
  });
}
