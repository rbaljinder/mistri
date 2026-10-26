/** Normalized browser command occurrences, not grants or execution authority.
 * Preserve duplicates and declaration order for each consumer's diagnostics.
 * API references deliberately remain outside this existing-surface collector.
 * Wrappers are immutable; references point at the caller's normalized App.
 */
import { isFormView, type AppDef, type AppCommandAction, type AppFormView } from './appModel.js';

type Occurrence =
  | Readonly<{
      surface: 'action';
      resource: string;
      index: number;
      path: readonly string[];
      action: AppCommandAction;
      reference: AppCommandAction['command'];
    }>
  | Readonly<{
      surface: 'form';
      view: string;
      path: readonly string[];
      form: AppFormView;
      reference: AppFormView['command'];
    }>;

export function appCommandOccurrences(app: Pick<AppDef, 'resources' | 'views'>): readonly Occurrence[] {
  const occurrences: Occurrence[] = [];
  for (const [resource, block] of Object.entries(app.resources ?? {})) {
    for (const [index, action] of (block.actions ?? []).entries()) {
      if (!action.command) continue;
      occurrences.push(
        Object.freeze({
          surface: 'action',
          resource,
          index,
          path: Object.freeze(['resources', resource, 'actions', String(index), 'command']),
          action: action as AppCommandAction,
          reference: action.command,
        }),
      );
    }
  }
  for (const [view, form] of Object.entries(app.views)) {
    if (!isFormView(form)) continue;
    // A form saved on every step runs each step's command before its own, the submit.
    for (const [index, step] of (form.steps ?? []).entries()) {
      if (!step.command) continue;
      occurrences.push(
        Object.freeze({
          surface: 'form',
          view,
          path: Object.freeze(['views', view, 'steps', String(index), 'command']),
          form,
          reference: step.command,
        }),
      );
    }
    occurrences.push(
      Object.freeze({ surface: 'form', view, path: Object.freeze(['views', view, 'command']), form, reference: form.command }),
    );
  }
  return Object.freeze(occurrences);
}
