/**
 * The header's New menu (`ui.shell.new`): every way to make
 * something, in one place by the header, so the menu beside it can list
 * places only.
 *
 *   ui: { shell: { new: [{ view: 'tickets' }, { command: 'raiseChange', label: 'Change', icon: 'git-branch' }] } }
 *
 * A long menu groups its lines under headings, `{ label: 'Service desk',
 * children: [...] }`, a nav group's shape; parsing flattens a group onto its entries (`group`), and
 * the menu draws each run of one group's lines under its heading.
 *
 * A `view` entry names a list, whose New form it opens, or a signed-in form;
 * a `command` entry names a command a signed-in form runs, and opens that
 * form. Either is a reference: a form only the New menu opens is not refused
 * as unreferenced (appViews.ts).
 *
 * Three steps, one per side. The App is checked once, as it loads
 * (`checkShellNew`): every name is a view or a form's command a New can open.
 * Each reader is served the entries whose view they were served
 * (`servedShellNew`), each a view key with the command it runs beside it. And
 * the browser lists, of those, the ones this reader may use
 * (`newMenuEntries`): a list whose table they may add to, a form whose
 * command they are granted. No entry left, no button.
 */
import { isFormView, type AppShellNew } from './appModel.js';
import type { ServedShellNew } from '@mistriwork/engine/shared/servedApp.js';
export { newMenuEntries, type NewMenuEntry, type ServedShellNew } from '@mistriwork/engine/shared/servedApp.js';

type Views = Readonly<Record<string, object>>;

const formRunning = (views: Views, command: string): string[] =>
  Object.entries(views).flatMap(([key, view]) => (isFormView(view) && !view.public && view.command.id === command ? [key] : []));

/** Refuses an entry a New cannot open: an unknown view, a dashboard, a public form, a command no signed-in form runs. */
export function checkShellNew(entries: readonly AppShellNew[], views: Views, at: string): void {
  entries.forEach((entry, i) => {
    const here = entry.group === undefined ? `${at}[${i}]` : `${at}, group "${entry.group}",`;
    if ('view' in entry) {
      const view = views[entry.view];
      if (!view) throw new Error(`${here} names view "${entry.view}", which is not one of this App's views.`);
      if (isFormView(view) ? view.public : !('table' in view) || 'sections' in view) {
        throw new Error(
          `${here} names view "${entry.view}", which is ${isFormView(view) ? 'a public form' : 'a dashboard'}. ` +
            "A New opens a list's New form or a signed-in form.",
        );
      }
      return;
    }
    const forms = formRunning(views, entry.command);
    if (!forms.length) {
      throw new Error(
        `${here} names command "${entry.command}", which no signed-in form runs. A New opens a form: add one ` +
          `(commandForm({ command: ${JSON.stringify(entry.command)} })), or name a list with { view }.`,
      );
    }
    if (forms.length > 1) {
      throw new Error(
        `${here} names command "${entry.command}", which the forms "${forms.join('", "')}" both run. Name the one it opens: { view: "${forms[0]}" }.`,
      );
    }
  });
}

/** The entries whose view this reader was served, each a view key with its form's command. */
export function servedShellNew(entries: readonly AppShellNew[] | undefined, views: Views): ServedShellNew[] {
  return (entries ?? []).flatMap((entry) => {
    const key = 'view' in entry ? entry.view : formRunning(views, entry.command)[0];
    const view = key === undefined ? undefined : views[key];
    if (!view) return [];
    const command = isFormView(view) ? view.command.id : undefined;
    return [
      {
        view: key!,
        ...(command === undefined ? {} : { command }),
        ...(entry.label === undefined ? {} : { label: entry.label }),
        ...(entry.icon === undefined ? {} : { icon: entry.icon }),
        ...(entry.group === undefined ? {} : { group: entry.group }),
      },
    ];
  });
}
