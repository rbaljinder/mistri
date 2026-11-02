/**
 * Where an App's own buttons go, judged once. A destination inside the App is a room: a list, a dashboard or a
 * signed-in form view. A dashboard's note and banner action, a record page's note, a list's and a related list's
 * empty action and nav all name one by its view key, and all are judged here, so a form one of them may open is a
 * form each of them may open (a field report: a banner refused the signed-in form the App's own `openForm` opened).
 *
 * A public form and the landing are served outside the App, at their own addresses: the landing's call to action
 * links a public form, and home sends a signed-out visitor to the landing. Some surfaces open fewer rooms by what
 * they are for, and say so where they are parsed: the New menu makes something (a list's New form or a signed-in
 * form, appNewMenu.ts), and a metric's drill and a first run's step open a list on its rows (appDashSections.ts).
 *
 * Validity is the App's; who may follow one is each reader's. A reader is served the rooms their roles open (a
 * view's `roles`, a form's command grant, a list's table), and every surface draws its action only where its
 * destination is among them (appPayload.ts `withAvailableEmptyActions`, pageEmptyActions.ts), as nav and the New
 * menu list only served rooms: the same rule whichever surface starts the navigation. `mistri check` names a
 * destination some role who opens the source cannot open (appRoleChecks.ts `appDestinationWarnings`), so the action
 * that disappears for them is said once and not found by signing in as each role.
 */
import { isFormView } from './appModel.js';

/** What a view key names, as a destination reads it. */
export type DestinationKind = 'list' | 'dashboard' | 'form' | 'public form' | 'landing';

/** The rooms a destination may open, as a sentence names them. */
const ROOMS = 'a list, a dashboard or a signed-in form view';

/** Whether a view of this kind is a room an App's action may open. */
export const isRoom = (kind: DestinationKind | undefined): kind is 'list' | 'dashboard' | 'form' =>
  kind === 'list' || kind === 'dashboard' || kind === 'form';

/** A served view's kind: a form (public or signed-in), a dashboard, or a list. */
export function servedViewKind(view: object | undefined): DestinationKind | undefined {
  if (!view) return undefined;
  if (isFormView(view)) return view.public === true ? 'public form' : 'form';
  if ('sections' in view) return 'dashboard';
  if ('table' in view) return 'list';
  return undefined;
}

/** A served view by key, never one borrowed from Object.prototype. */
export function servedView<V extends object>(views: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.hasOwn(views, key) ? views[key] : undefined;
}

/**
 * The refusal of a destination that is not a room, or undefined for one that is. `at` names the surface ("views
 * "home", section 2, note action"); the sentence is the same on every surface.
 */
export function destinationProblem(at: string, view: string, kind: DestinationKind | undefined): string | undefined {
  if (isRoom(kind)) return undefined;
  const why =
    kind === 'public form'
      ? ": a public form is served at its own address, outside the App, and is the landing's to link"
      : kind === 'landing'
        ? ': the landing is where home sends a signed-out visitor'
        : '';
  return `${at} names "${view}", which is not ${ROOMS}${why}.`;
}
