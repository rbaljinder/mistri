// Which commands an App serves, and whether it needs a command registry to start.
import { isFormView, type AppDef } from './appModel.js';

/** The id of every command the resources' actions and tag pickers reference, once each, in declaration order. */
export function resourceCommandIds(app: Pick<AppDef, 'resources'>): string[] {
  const ids = new Set<string>();
  for (const resource of Object.values(app.resources ?? {})) {
    for (const action of resource.actions ?? []) if (action.command) ids.add(action.command.id);
    // A picker's commands are offered on the record as an action's are, with no action of their own.
    if (resource.tags?.add && resource.tags.remove) ids.add(resource.tags.add.id).add(resource.tags.remove.id);
  }
  return [...ids];
}

/**
 * The id of every command the App serves a signed-in reader: each its
 * resources' actions reference, then each its signed-in forms run. A form's
 * command names no record, so no action offers it, and a component that names
 * it (`useCommand`) finds it here, granted, rather than not at all. A public
 * form's command runs only through its public route, under no role.
 */
export function servedCommandIds(app: Pick<AppDef, 'resources' | 'views'>): string[] {
  const ids = new Set(resourceCommandIds(app));
  for (const view of Object.values(app.views ?? {})) if (isFormView(view) && view.public !== true) ids.add(view.command.id);
  return [...ids];
}

/**
 * The App uses server commands: an action runs one, or a role is granted
 * one. Such an App starts only with its command registry (`--commands`).
 */
export function appUsesCommands(app: Pick<AppDef, 'resources' | 'auth'> & { api?: AppDef['api'] }): boolean {
  return (
    appUsesCommandsOfItsOwn(app) ||
    // An API's generic writes run on the command journal.
    Boolean(app.api && Object.values(app.api.resources).some((resource) => resource.create || resource.update || resource.delete))
  );
}

/**
 * The App uses commands it wrote — an action, a grant, an import, an event
 * feed (which reads the commands' events) — as opposed to the generic writes
 * its API synthesizes, which run with no commands module at all.
 */
export function appUsesCommandsOfItsOwn(app: Pick<AppDef, 'resources' | 'auth'> & { api?: AppDef['api'] }): boolean {
  return (
    resourceCommandIds(app).length > 0 ||
    Object.values(app.resources ?? {}).some((resource) => Boolean(resource.import?.command)) ||
    Object.values(app.auth?.roles ?? {}).some((role) => Boolean(role.commands?.length)) ||
    Boolean(app.api?.events.length)
  );
}
