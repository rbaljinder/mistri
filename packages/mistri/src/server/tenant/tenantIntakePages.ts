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
import { isPublicCommandPage, logicalResource, type AppDef } from '../../shared/app.js';
import { tenantPublicForms } from './tenantIntakeModel.js';
import { formCommands } from '../../shared/appSavedForms.js';
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
 * tenant's tables or the platform's, never a global one; it emits no event or effect, mints no link, and belongs to no realm of its
 * own, since where it lands is decided per submission. Its lookup, when it has one, reads as the visitor reads
 * (intakeLookupProblem).
 */
export function intakeCommandProblem(
  app: Pick<AppDef, 'auth' | 'sources'>,
  command: AnyBusinessCommand | undefined,
  home: string,
  kindOf: (table: string) => string | undefined,
): string | undefined {
  if (!command || command.public !== true) return 'is not a public command';
  if (command.realm !== undefined) return `belongs to the ${command.realm} realm, and where a submission lands is decided per submission`;
  if (command.source !== home) return `writes the source "${command.source}", not the App's own "${home}"`;
  if (getCommandEvents(command) !== undefined) return 'emits events or effects';
  const lookup = intakeLookupProblem(app, command, home);
  if (lookup !== undefined) return lookup;
  const minting = intakeLinkProblem(command);
  if (minting !== undefined) return minting;
  const shared = command.write.find((table) => !['tenant', 'platform'].includes(kindOf(table) ?? ''));
  if (shared !== undefined) return `writes "${shared}", which is neither a tenant's table nor the platform's`;
  return undefined;
}

/* `link(`, bare as a destructured context member or as `context.link(`/`ctx.link(`: what a handler's text shows of a
   mint. A mint through a helper elsewhere is not seen, and the run refuses it all the same (links/linkMint.ts). */
const HANDLER_MINTS = /(?<![\w$.])link\s*\(|\b(?:context|ctx)\s*\.\s*link\s*\(/;
/* Comments and string literals, which may say `link(` without calling it: taken out before the text is read. */
const COMMENTS_AND_STRINGS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g;

/**
 * Why a public command that mints a capability link cannot run on a tenant App's intake, or nothing. A link is held to
 * the tenant whose row it names, and a signed-out submission is placed by an address (or lands with the platform's
 * triage) and mints on no existing record of a tenant: a link is minted there only by a member or a service, on one
 * existing record of their own tenant (businessCommandAuthorization.ts). Said from the handler's own text.
 */
function intakeLinkProblem(command: AnyBusinessCommand): string | undefined {
  if (command.public !== true || typeof command.handle !== 'function') return undefined;
  let text: string;
  try {
    text = Function.prototype.toString.call(command.handle);
  } catch {
    return undefined;
  }
  return HANDLER_MINTS.test(text.replace(COMMENTS_AND_STRINGS, ' '))
    ? 'mints a capability link (link(…)), which a tenant App only lets a member or a service do, on an existing record of their own tenant'
    : undefined;
}

/**
 * Why a public command's lookup cannot run on a tenant App's intake, in plain words (completing "it …"), or nothing.
 * The lookup is data the applicant sees, so it reads under `auth.public` — what a visitor may read, in the tenant the
 * submission landed in (tenantIntake.ts) — never under the command's own read list. So the App must say `auth.public`,
 * every table looked up must be one it opens, and none one it opens only by a record's key (`byKey`): a lookup is a
 * query, and a query over such a table would list it. It reads the App's own source, which is the tenant's; it calls
 * no integration, since a stranger's submission would spend the tenant's calls; and it names its sources, since a
 * lookup that reads none has no visitor's read to be given.
 */
function intakeLookupProblem(app: Pick<AppDef, 'auth' | 'sources'>, command: AnyBusinessCommand, home: string): string | undefined {
  if (command.integrations !== undefined) return 'calls integrations from its lookup';
  if (typeof command.lookup !== 'function') return command.sources !== undefined ? 'reads other sources' : undefined;
  if (command.sources === undefined) return 'runs a lookup that names no "sources" to read';
  const opened = app.auth?.public;
  for (const [source, locals] of Object.entries(command.sources)) {
    if (source !== home) return `looks up the source "${source}", not the App's own "${home}"`;
    for (const local of locals) {
      const table = logicalResource(app, source, local);
      if (!opened)
        return `looks up "${table}", but the App declares no "auth.public": a signed-out submission's lookup reads what a visitor may`;
      if (opened.byKey?.includes(table))
        return `looks up "${table}", which "auth.public" opens only by a record's key ("byKey"): a lookup would list it`;
      if (!opened.read.includes(table))
        return `looks up "${table}", which "auth.public" does not open: a signed-out submission's lookup reads what a visitor may`;
    }
  }
  return undefined;
}

/** Each public form whose command's lookup intake cannot run, in plain words, for startup and `mistri check`: what
    else a form's command may not do is refused where intake binds, but a lookup's reason is the author's to fix. */
export function tenantFormLookupProblems(
  app: Pick<AppDef, 'views' | 'auth' | 'sources'>,
  registry: BusinessCommandRegistry | undefined,
  home: string,
): string[] {
  const problems: string[] = [];
  for (const [key, form] of tenantPublicForms(app)) {
    for (const { id } of formCommands(form)) {
      const command = registry && Object.hasOwn(registry, id) ? registry[id] : undefined;
      const problem = command ? (intakeLookupProblem(app, command, home) ?? intakeLinkProblem(command)) : undefined;
      if (problem)
        problems.push(
          `Public form "${key}" runs "${id}", which ${problem}: a tenant App cannot take that command's signed-out submissions.`,
        );
    }
  }
  return problems;
}

const sourcedChoice = (field: AppCommandField): boolean =>
  (field.type === 'choice' || field.type === 'choices') && (field as { source?: unknown }).source !== undefined;

/** Each thing about the App's public command pages that tenant intake cannot serve, in plain words. A page's key is
    already a form's (a view key is its address), so a submission's evidence can name it as its door. */
export function tenantPageProblems(
  app: Pick<AppDef, 'views' | 'auth' | 'sources'>,
  registry: BusinessCommandRegistry | undefined,
  home: string,
  kindOf: (table: string) => string | undefined,
): string[] {
  const problems: string[] = [];
  for (const [key, commands] of tenantPublicPages(app)) {
    for (const id of commands) {
      const command = registry && Object.hasOwn(registry, id) ? registry[id] : undefined;
      const problem = intakeCommandProblem(app, command, home, kindOf);
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
