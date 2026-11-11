/**
 * Public command pages on a tenant App (`definePage({ public: true, commands })`): doors of the same kind as a public
 * form, whose signed-out submissions intake places as it places a form's — in the tenant whose public address the
 * visit carries, or with the platform for its triage. On an ordinary App the page's door is http/pageCommandRoutes.ts;
 * here it is tenantPublicHttp.ts, and the write is tenantIntake.ts's.
 *
 * What intake cannot run is said here, once, in plain words: startup and `mistri check` refuse it with these words
 * (tenantFeatureIntake.ts), and the runtime refuses the same shapes (tenantIntake.ts), so a page is never served that
 * would answer a visitor "Sign in to do that" or fail on submit.
 */
import type { AppCommandField } from '../../../schema/command.js';
import { isPublicCommandPage, type AppDef } from '../../shared/app.js';
import { getCommandEvents, type AnyBusinessCommand, type BusinessCommandRegistry } from '../commands/businessCommands.js';

/** The public command pages of an App, by view key, with the commands each names. */
export function tenantPublicPages(app: Pick<AppDef, 'views'>): ReadonlyMap<string, readonly string[]> {
  return new Map(
    Object.entries(app.views).flatMap(([key, view]) => (isPublicCommandPage(view) ? [[key, [...view.page.commands]] as const] : [])),
  );
}

/**
 * Why a public command cannot take a signed-out submission on a tenant App, in plain words (completing "it …"), or
 * nothing when it can. A public form's command and a public page's are held to the same rule: it inserts into a
 * tenant's tables or the platform's, never a global one; it runs no lookup, emits no event or effect, and belongs to
 * no realm of its own, since where it lands is decided per submission.
 */
export function intakeCommandProblem(
  command: AnyBusinessCommand | undefined,
  home: string,
  kindOf: (table: string) => string | undefined,
): string | undefined {
  if (!command || command.public !== true) return 'is not a public command';
  if (command.realm !== undefined) return `belongs to the ${command.realm} realm, and where a submission lands is decided per submission`;
  if (command.source !== home) return `writes the source "${command.source}", not the App's own "${home}"`;
  if (getCommandEvents(command) !== undefined) return 'emits events or effects';
  if (typeof command.lookup === 'function') return 'runs a lookup';
  if (command.sources !== undefined) return 'reads other sources';
  const shared = command.write.find((table) => !['tenant', 'platform'].includes(kindOf(table) ?? ''));
  if (shared !== undefined) return `writes "${shared}", which is neither a tenant's table nor the platform's`;
  return undefined;
}

const sourcedChoice = (field: AppCommandField): boolean =>
  (field.type === 'choice' || field.type === 'choices') && (field as { source?: unknown }).source !== undefined;

/** Each thing about the App's public command pages that tenant intake cannot serve, in plain words. A page's key is
    already a form's (a view key is its address), so a submission's evidence can name it as its door. */
export function tenantPageProblems(
  app: Pick<AppDef, 'views'>,
  registry: BusinessCommandRegistry | undefined,
  home: string,
  kindOf: (table: string) => string | undefined,
): string[] {
  const problems: string[] = [];
  for (const [key, commands] of tenantPublicPages(app)) {
    for (const id of commands) {
      const command = registry && Object.hasOwn(registry, id) ? registry[id] : undefined;
      const problem = intakeCommandProblem(command, home, kindOf);
      if (problem) {
        problems.push(
          `Public page "${key}" runs "${id}", which ${problem}: a tenant App cannot take that command's signed-out submissions.`,
        );
        continue;
      }
      /* A tenant's visitor reads a table's rows only through a door scoped to its place (forms/formChoices.ts), and a
         page has none: its picker would be empty. */
      const picker = command!.fields.find(sourcedChoice);
      if (picker)
        problems.push(
          `Public page "${key}" runs "${id}", whose field "${picker.name}" chooses from a table, which a signed-out page on a tenant App cannot list: give it fixed options.`,
        );
    }
  }
  return problems;
}
