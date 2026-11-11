/**
 * Shared list-empty contract and projection.
 *
 * Ownership: the App DSL owns validation and authored copy; clients consume
 * the resulting AppListEmpty shape for list and related-list rendering.
 */
import { allowKeys, isRecord } from './model.js';
import type { AppListEmpty } from './listPresentations.js';
import { parseCaption } from './appMessages.js';
import { parseLinkTo } from './appLinks.js';

/** Read the shared empty-list copy used by list views and related sections. */
export function parseListEmpty(raw: unknown, at: string): AppListEmpty {
  const here = `${at}, "empty"`;
  if (!isRecord(raw)) throw new Error(`${here} must be an object with a "title".`);
  allowKeys(raw, ['title', 'description', 'action'], here, { message: 'is now "description": the sentence under the title' });
  const title = parseCaption(raw.title, `${here} needs a non-empty "title"`);
  const description = raw.description === undefined ? undefined : parseCaption(raw.description, `${here}, "description"`);
  const result: AppListEmpty = { title, ...(description === undefined ? {} : { description }) };
  if (raw.action === undefined) return result;
  if (!isRecord(raw.action)) throw new Error(`${here}, "action" must be an object with "label" and "to".`);
  const actionAt = `${here}, "action"`;
  allowKeys(raw.action, ['label', 'to'], actionAt);
  const label = parseCaption(raw.action.label, `${actionAt} needs a non-empty "label"`);
  const to = typeof raw.action.to === 'string' || isRecord(raw.action.to) ? parseLinkTo(raw.action.to, `${actionAt}, "to"`) : undefined;
  if (!to || !('view' in to))
    throw new Error(`${actionAt} needs a "to": the key of a list, a dashboard or a signed-in form view, or { view, tab }.`);
  return { ...result, action: { label, ...to } };
}

/** The authored shape again, for a definition written back out. */
export function listEmptyConfig(empty: AppListEmpty) {
  return {
    title: empty.title,
    ...(empty.description === undefined ? {} : { description: empty.description }),
    ...(empty.action
      ? {
          action: {
            label: empty.action.label,
            to: empty.action.tab ? { view: empty.action.view, tab: empty.action.tab } : empty.action.view,
          },
        }
      : {}),
  };
}
