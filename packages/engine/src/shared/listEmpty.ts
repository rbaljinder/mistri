/**
 * Shared list-empty contract and projection.
 *
 * Ownership: the App DSL owns validation and authored copy; clients consume
 * the resulting AppListEmpty shape for list and related-list rendering.
 */
import { allowKeys, isRecord } from './model.js';
import type { AppListEmpty, AppListLink } from './listPresentations.js';
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
  return { ...result, action: parseListLink(raw.action, `${here}, "action"`) };
}

/** A list's `{ label, to }` to another room: its empty state's action, and the link at its head (a list view's
    `link`). One shape, so the two read as one thing; where `to` may go is judged where the App is whole
    (appDestinations.ts). */
export function parseListLink(raw: unknown, at: string): AppListLink {
  if (!isRecord(raw)) throw new Error(`${at} must be an object with "label" and "to".`);
  allowKeys(raw, ['label', 'to'], at);
  const label = parseCaption(raw.label, `${at} needs a non-empty "label"`);
  const to = typeof raw.to === 'string' || isRecord(raw.to) ? parseLinkTo(raw.to, `${at}, "to"`) : undefined;
  if (!to || !('view' in to))
    throw new Error(`${at} needs a "to": the key of a list, a dashboard or a signed-in form view, or { view, tab }.`);
  return { label, ...to };
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
