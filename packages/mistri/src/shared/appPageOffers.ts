/**
 * A free-form page that declares a command draws its own button for it, so the declaration is the offer: a targeted
 * command it names and no action carries gets a hidden action (`header: false`, never drawn on a record's bar) on its
 * target's resource. Everything that finds a command by its action then finds this one — prepare and execute on the
 * server, the page's `useCommand` in the browser, `check`'s unoffered advice — and who may run it stays what it always
 * was: the role grants, which the page's declaration is not. A command that names no record is served by id already.
 */
import { humanName } from '@mistriwork/engine/shared/model.js';
import type { AppAction, AppDef } from './appModel.js';
import { appCommandOccurrences, pageCommandIds } from './appCommandOccurrences.js';
import { importCommandOccurrences } from './appImport.js';
import { parseCommandReference, registeredCommand } from './command.js';

/** An action's id is a word a JS key needs no quotes for: a command's name, said as one. */
const actionId = (command: string) => command.replace(/[^A-Za-z0-9_]+(.)?/g, (_, next: string | undefined) => (next ?? '').toUpperCase());

export function offerPageCommands(app: AppDef): void {
  const pageRuns = pageCommandIds(app);
  if (!pageRuns.size || !app.resources) return;
  const offered = new Set<string>([
    ...appCommandOccurrences(app).map((occurrence) => occurrence.reference.id),
    ...importCommandOccurrences(app).map((occurrence) => occurrence.reference.id),
    ...(app.api?.commands ?? []).map((exposure) => exposure.command.id),
  ]);
  for (const id of pageRuns) {
    const entry = registeredCommand(id);
    if (!entry || offered.has(id) || entry.targets === 'none' || entry.public === true) continue;
    const reference = parseCommandReference(id, `a page's commands`);
    const owner = app.resources[reference.target];
    if (!owner) continue;
    const taken = new Set((owner.actions ?? []).map((action) => action.id));
    let name = actionId(id) || 'run';
    while (taken.has(name)) name = `${name}_`;
    const action = { id: name, label: entry.label ?? humanName(id), header: false, command: reference } as unknown as AppAction;
    app.resources[reference.target] = { ...owner, actions: [...(owner.actions ?? []), action] };
  }
}
