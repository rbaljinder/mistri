/**
 * Which commands a person's run must confirm provenance for (proposals.ts): those whose target some maker — the
 * assistant, a job, a decision or a flow — can also write. A mark exists only on a resource a maker wrote, so a
 * person's command on any other resource has nothing to confirm, and pays no statement and no savepoint for it.
 *
 * A maker writes through a command that is `approval: 'ai'` (proposed, then approved), a verb the assistant may run,
 * or one the App's jobs module declares: a job's, a decision's answer, an inbound endpoint's or mail's command, and,
 * since a workflow's steps are code, whatever its principal's roles grant. The module is noted when the App is loaded
 * (`noteMakerModule`, before the server listens), so the answer is the definition's from the first request, and never
 * waits on a job host to start. A command this module was never told about — one bound elsewhere — is answered
 * `true`: a needless confirm costs statements, a missed one leaves a field the person vouched for still marked as the
 * maker's.
 */
import type { AppDef } from '../../shared/app.js';
import { appCommandGrants } from '../../shared/appAccess.js';
import { logicalResource } from '../../shared/appModel.js';
import type { CapturedJobModule } from '../jobs/jobModule.js';
import type { AnyBusinessCommand, BusinessCommandRegistry } from './businessCommands.js';

/** Per App, what its jobs module lets a maker run: commands by id, and the roles a workflow's principal holds. */
const modules = new Map<string, Readonly<{ commands: ReadonlySet<string>; roles: ReadonlySet<string> }>>();
let noted = 0;

/** Note the App's jobs module as it is loaded: the commands its jobs, decisions, endpoints and mail run, and the roles
    its workflows run under. Noting the same declarations again changes nothing. */
export function noteMakerModule(appId: string, module: CapturedJobModule): void {
  const commands = new Set<string>(),
    roles = new Set<string>();
  for (const job of module.jobs.values()) commands.add(job.command.id);
  for (const decision of module.decisions?.values() ?? []) commands.add(decision.answer.command.id);
  for (const endpoint of module.inbound.values()) commands.add(endpoint.command.id);
  const mail = module.mail;
  for (const reference of [mail?.receive?.command, mail?.send?.claim, mail?.send?.record, mail?.links?.command, mail?.links?.reply])
    if (reference) commands.add(reference.id);
  for (const workflow of module.workflows.values()) for (const role of module.principals.get(workflow.runAs) ?? []) roles.add(role);
  const known = modules.get(appId);
  const same = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((item) => b.has(item));
  if (known && same(known.commands, commands) && same(known.roles, roles)) return;
  modules.set(appId, { commands, roles });
  noted++;
}

const commandId = (command: unknown): string | undefined =>
  typeof command === 'string' ? command : command && typeof command === 'object' ? (command as { id?: string }).id : undefined;

function makerCommands(app: AppDef, registry: BusinessCommandRegistry): Set<string> {
  const ids = new Set<string>();
  for (const [id, command] of Object.entries(registry)) if (command.approval === 'ai') ids.add(id);
  const assistant = app.assistant;
  if (assistant && assistant.tools.includes('run')) {
    const excluded = new Set(assistant.exclude);
    for (const [name, resource] of Object.entries(app.resources ?? {}))
      for (const action of resource.actions ?? []) {
        const id = commandId((action as { command?: unknown }).command);
        if (id !== undefined && !excluded.has(`${name}.${action.id}`)) ids.add(id);
      }
  }
  const module = modules.get(app.id);
  if (module) {
    for (const id of module.commands) ids.add(id);
    if (module.roles.size) for (const id of appCommandGrants(app, [...module.roles])) ids.add(id);
  }
  return ids;
}

/* Per command, one answer per registry it was bound under, so binding a registry again (an API owner binds per
   request) replaces its answer rather than adding one. */
const checks = new WeakMap<AnyBusinessCommand, Map<BusinessCommandRegistry, () => boolean>>();
const computed = new WeakMap<BusinessCommandRegistry, WeakMap<AppDef, { at: number; resources: ReadonlySet<string> }>>();

function makerResources(app: AppDef, registry: BusinessCommandRegistry): ReadonlySet<string> {
  const byApp = computed.get(registry) ?? new WeakMap();
  computed.set(registry, byApp);
  const known = byApp.get(app);
  if (known?.at === noted) return known.resources;
  const resources = new Set<string>();
  for (const id of makerCommands(app, registry)) {
    const command = Object.hasOwn(registry, id) ? registry[id] : undefined;
    if (command) resources.add(logicalResource(app, command.source, command.target));
  }
  byApp.set(app, { at: noted, resources });
  return resources;
}

/* Per App, the registry it was last bound with: For review is offered from it (reviewCommands). The last one only, as
   an API owner binds a registry per request and a map of them would keep every one. */
const lastBound = new Map<string, { app: AppDef; registry: BusinessCommandRegistry }>();
const reviewed = new WeakMap<BusinessCommandRegistry, { at: number; app: AppDef; commands: ReadonlySet<string> }>();

/**
 * The commands whose work comes to For review: those a maker proposes or writes through (an `approval: 'ai'`
 * command, an assistant's verb, a job's, a decision's answer). A reader granted one is offered the page; one granted
 * none never sees it. Empty for an App not bound yet.
 */
function reviewCommands(appId: string): ReadonlySet<string> {
  const bound = lastBound.get(appId);
  if (!bound) return new Set();
  const known = reviewed.get(bound.registry);
  if (known?.at === noted && known.app === bound.app) return known.commands;
  const commands = new Set([...makerCommands(bound.app, bound.registry)].filter((id) => Object.hasOwn(bound.registry, id)));
  reviewed.set(bound.registry, { at: noted, app: bound.app, commands });
  return commands;
}

/** Whether a reader granted `granted` is offered For review. */
export function offersReview(appId: string, granted: ReadonlySet<string>): boolean {
  for (const id of reviewCommands(appId)) if (granted.has(id)) return true;
  return false;
}

/** Note a bound registry's commands, each answering whether a maker can write its target's resource. */
export function bindMakerWrites(app: AppDef, registry: BusinessCommandRegistry): void {
  lastBound.set(app.id, { app, registry });
  for (const command of Object.values(registry)) {
    const resource = logicalResource(app, command.source, command.target);
    const answers = checks.get(command) ?? new Map<BusinessCommandRegistry, () => boolean>();
    answers.set(registry, () => makerResources(app, registry).has(resource));
    checks.set(command, answers);
  }
}

/** Whether a person's run of this command confirms the fields it writes: where any registry it is bound under says a
    maker writes its target. */
export function makerWrites(command: AnyBusinessCommand): boolean {
  const answers = checks.get(command);
  if (!answers) return true;
  for (const answer of answers.values()) if (answer()) return true;
  return false;
}
