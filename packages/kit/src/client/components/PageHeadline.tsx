/**
 * A record's headline, for a page that offers the record to someone: the
 * first field as the figure — a price, in its display rule — the rest as a
 * row of facts under their captions, and one or two calls to action that
 * open one of the App's views (the inquiry form, say). It sits under the
 * record's name, so what a reader decides on is above the fold.
 *
 * The figure's earlier value (`was`) is struck through beside it while it
 * stands above the figure — a reduced price — and is not drawn otherwise. A
 * fact with no value is left out, never said as "Caption —".
 *
 * A second, smaller figure (`subfigure`) may follow the first — an estimate,
 * a unit price — and a line of small print (`note`) says what the figures
 * assume. A call to action that opens a public form may start the form
 * filled: from this record's fields (`prefill`, so the visitor never copies
 * a reference by hand) and with the author's words (`defaults`). They are
 * where the form starts, carried in its address, never what it sends.
 *
 * A list or dashboard is found among the rooms the App serves this reader;
 * a public form is asked of the public forms route once, only when an
 * action names something no room is. An action that names neither is not
 * drawn: a button to nowhere is worse than none.
 *
 * A public form is the App's front door for someone with no account: it
 * runs under a public principal and writes what a visitor may. A signed-in
 * reader works the App's own rooms (the staff who read a listing take a
 * viewing in the Viewings list), so the form is not offered to them as the
 * way to reach out about a record they already hold.
 */
import { useMessageLanguage } from './useMessageLanguage.js';
import { useQuery } from '@tanstack/react-query';
import { api, columnDisplay, columnLabel, state } from '../core.js';
import { centsTogether, type DisplayRule } from './valueModel.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import type { ColumnMeta } from '@mistriwork/engine/shared/schema.js';
import type { PageHeadlineAction } from '@mistriwork/engine/shared/pageModel.js';
import { Value } from './Value.js';
import { formLink, viewLink, type ViewLink } from './viewLink.js';
import { useState } from 'react';
import { shell } from '../shellMode.js';
import { sessionIdentity } from '../sessionIdentity.js';

interface PageHeadlineProps {
  tableId: string;
  row: Record<string, unknown>;
  /** The figure first, then the facts. */
  paths: readonly string[];
  column: (path: string) => ColumnMeta | undefined;
  actions: ReadonlyArray<PageHeadlineAction>;
  /** A second figure under the first. */
  subfigure?: string;
  /** The figure's earlier value, struck through beside it when it is set and higher. */
  was?: string;
  /** Small print under the actions. */
  note?: string;
}

/** A public form's address with the inputs the action fills: the record's own values, then the author's words. */
export function prefilledFormLink(link: ViewLink, action: PageHeadlineAction, row: Record<string, unknown>): ViewLink {
  const params = new URLSearchParams();
  for (const [input, path] of Object.entries(action.prefill ?? {})) {
    const value = row[path];
    if (value !== null && value !== undefined && String(value) !== '') params.set(input, String(value));
  }
  for (const [input, text] of Object.entries(action.defaults ?? {})) params.set(input, text);
  const query = params.toString();
  return query ? { ...link, href: `${link.href}?${query}` } : link;
}

/** A value the headline has: not null, not missing, not blank. */
const hasValue = (value: unknown) => value !== null && value !== undefined && String(value).trim() !== '';

/** The earlier value is said only where it is a figure above the one in hand: a reduction, never a rise or a repeat. */
export function wasShown(row: Record<string, unknown>, figure: string | undefined, was: string | undefined): boolean {
  if (!figure || !was || !hasValue(row[was]) || !hasValue(row[figure])) return false;
  const [then, now] = [Number(row[was]), Number(row[figure])];
  return Number.isFinite(then) && Number.isFinite(now) && then > now;
}

export function PageHeadline({ tableId, row, paths, column, actions, subfigure, was, note }: PageHeadlineProps) {
  useMessageLanguage();
  const caption = (path: string) => (columnLabel(tableId, path) as string | null) ?? humanName(path.split('.').pop() ?? path);
  const [figure, ...facts] = paths;
  /* A call to action into another App of the suite, and a public form over the record, are the App framework's:
     the shell's to draw (shellMode.ts), and not drawn where it has none. */
  const { TargetAction, FormDialog } = shell().slots;
  const rooms = actions.map((action) => ('view' in action ? viewLink(action.view) : undefined));
  const signedIn = sessionIdentity().mode === 'authenticated';
  const forms = useQuery({
    queryKey: ['public-forms', state.activeConnection ?? ''],
    enabled: !signedIn && actions.some((action, index) => 'view' in action && !rooms[index]),
    staleTime: Infinity,
    queryFn: async () => new Set(((await api('/api/forms')) as { forms?: Array<{ id: string }> }).forms?.map((form) => form.id) ?? []),
  });
  const links = actions.map((action, index) => {
    if ('to' in action) return { action, kind: action.intent ?? (index === 0 ? 'primary' : 'secondary') };
    const form =
      !signedIn && !rooms[index] && forms.data?.has(action.view) ? prefilledFormLink(formLink(action.view), action, row) : undefined;
    const link = rooms[index] ?? form;
    /* `open: 'modal'` draws the form over this record instead of leaving for
       its page: a public form, or a signed-in form this reader is served (its room's address still opens it on its
       own). A list or a dashboard is only ever a room. */
    const asked = form ?? (rooms[index] && action.open === 'modal' ? prefilledFormLink(rooms[index]!, action, row) : undefined);
    const dialog =
      action.open === 'modal' && asked && FormDialog ? { view: action.view, prefill: asked.href.split('?')[1] ?? '' } : undefined;
    return link ? { label: action.label, link, dialog, kind: action.intent ?? (index === 0 ? 'primary' : 'secondary') } : null;
  });
  const [asking, setAsking] = useState<{ view: string; prefill: string } | null>(null);
  const second = subfigure !== undefined && hasValue(row[subfigure]);
  const earlier = wasShown(row, figure, was);
  const shownFacts = facts.filter((path) => hasValue(row[path]));
  /* The figure, the price it was and the facts in one money form (centsTogether), as a record's fields are. */
  const cents = centsTogether(
    [figure, earlier ? was : undefined, second ? subfigure : undefined, ...shownFacts]
      .filter((path): path is string => path !== undefined)
      .map((path) => [columnDisplay(tableId, column(path)?.name ?? '') as DisplayRule | null, row[path]] as const),
  );
  return (
    <div className="page-headline">
      {figure !== undefined && (
        <p className="page-headline-figure">
          <span className="visually-hidden">{caption(figure)}: </span>
          <Value col={column(figure)} value={row[figure]} tableId={tableId} compact row={row} cents={cents} />
          {earlier && (
            <>
              {' '}
              <s className="page-headline-was">
                <span className="visually-hidden">{caption(was!)}: </span>
                <Value col={column(was!)} value={row[was!]} tableId={tableId} compact cents={cents} />
              </s>
            </>
          )}
        </p>
      )}
      {second && (
        <p className="page-headline-sub">
          <span className="page-headline-sub-caption">{caption(subfigure!)}</span>{' '}
          <Value col={column(subfigure!)} value={row[subfigure!]} tableId={tableId} compact cents={cents} />
        </p>
      )}
      {links.some(Boolean) && (
        <div className="page-headline-actions">
          {links.map((entry, index) =>
            !entry ? null : 'action' in entry && entry.action ? (
              TargetAction && (
                <TargetAction
                  key={index}
                  label={entry.action.label}
                  to={entry.action.to}
                  row={row}
                  className={`page-headline-action is-${entry.kind}`}
                />
              )
            ) : (
              /* Still a link: its address is the form's own page, so a new tab,
               a middle click or a copied link all still work. A plain click
               opens the dialog instead. */
              <a
                key={index}
                className={`page-headline-action is-${entry.kind}`}
                href={entry.link!.href}
                onClick={
                  entry.dialog
                    ? (event) => {
                        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                        event.preventDefault();
                        setAsking(entry.dialog!);
                      }
                    : entry.link!.onClick
                }
              >
                {entry.label}
              </a>
            ),
          )}
        </div>
      )}
      {shownFacts.length > 0 && (
        <dl className="page-headline-facts">
          {shownFacts.map((path) => (
            <div key={path}>
              <dt>{caption(path)}</dt>
              <dd>
                <Value col={column(path)} value={row[path]} tableId={tableId} compact cents={cents} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {note && <p className="page-headline-note">{note}</p>}
      {asking && FormDialog && <FormDialog view={asking.view} prefill={asking.prefill} onClose={() => setAsking(null)} />}
    </div>
  );
}
