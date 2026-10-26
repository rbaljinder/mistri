/**
 * The trail.
 *
 * It starts at the schema, and says so: a link opened deep — which is how
 * most links are opened — must offer a way back to the landing, and the
 * wordmark is not where anybody looks for one. A house rather than the
 * word, because the one thing in the trail that is not a step should not
 * look like one. Then one crumb per entry of the walk, the last of them
 * the current room; and at the end, the walk's own Back — up the trail,
 * not to whatever was looked at last, because a trail arrived at by
 * pasted link has crumbs and no browser history behind it.
 */
import { crumbNoteRef, crumbToolsRef } from './crumbSlot.js';
import { Fragment } from 'react';
import { backTo, findTable } from '../core.js';
import { shell } from '../shellMode.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { appCrumbLabel, appListFor, splitOf } from './appListModel.js';
import { dashboardAt, formAt } from './appRooms.js';
import { useWalk, type WalkEntry } from './walk.js';
import { say } from '../copy/shell/components/Crumbs.js';
import { Icon } from './Icon.js';
import { useMessageLanguage } from './useMessageLanguage.js';

/** What a crumb is called: the app's word for a list, a record's name, a page's. */
function nameOf(entry: WalkEntry): string {
  if (entry.kind === 'page' && !entry.table && entry.pageId) {
    const app = shell().app();
    const dashboard = app && dashboardAt(app, entry.pageId);
    if (dashboard) return dashboard.label;
    const form = app && formAt(app, entry.pageId);
    if (form) return form.label;
  }
  if (entry.kind === 'table' || entry.kind === 'breakdown') {
    const app =
      shell().inApp() && entry.kind === 'table'
        ? appCrumbLabel({ table: entry.table ?? '', query: entry.query ?? '', view: entry.view })
        : null;
    return app ?? entry.query ?? '';
  }
  return entry.label ?? (entry.table && shell().inApp() ? humanName(entry.table) : entry.table) ?? entry.pageId ?? '…';
}

/* A split's selected record is its list's selection: the list and the row
   beside it are one room, and one crumb. Drawn as two, the trail read "Inbox
   › Inbox" and offered a Back to the very list on screen. */
function splitSelection(stack: WalkEntry[]): boolean {
  const top = stack.at(-1);
  const list = stack.at(-2);
  if (!shell().inApp() || top?.kind !== 'row' || list?.kind !== 'table' || !list.table || list.table !== top.table) return false;
  return splitOf(appListFor(list.table, list.query, top.view ?? list.view)) !== undefined;
}

/* A room keeps its place in the address, and a place it pushes (a list
   chosen in the Pick walk) is a step Back returns from — but it is still the
   one room, so it is one crumb: the trail read "Pick walk › Pick walk". Of a
   run of steps in the same room, only the newest is drawn. */
const sameRoom = (entry: WalkEntry, next: WalkEntry | undefined): boolean =>
  Boolean(
    next && entry.kind === 'page' && next.kind === 'page' && !entry.table && !next.table && entry.pageId && entry.pageId === next.pageId,
  );

/* The home crumb is the schema in the browser and the App's home in an App,
   where a reader was told "Schema" for the App's own front room. */
function homeWords(): { title: string; 'aria-label': string } {
  const name = shell().inApp() ? (shell().app() as { name?: string } | null)?.name : undefined;
  if (shell().inApp()) {
    const said = name ? say('appHome', { app: name }) : say('home');
    return { title: said, 'aria-label': said };
  }
  return { title: say('theSchemaYourWork'), 'aria-label': say('common.schema') };
}

export function Crumbs({ onHome }: { onHome: () => void }) {
  const walked = useWalk();
  /* Said again when a visitor's language arrives with the App. */
  useMessageLanguage();
  // Indices stay the walk's own: only the selected row is left off the end.
  const stack = splitSelection(walked) ? walked.slice(0, -1) : walked;
  const previous = stack.length > 1 ? stack[stack.length - 2] : null;
  /* A public reader's record page names itself in its heading straight
     below: the trail ends at the list it came from, which stays a link. */
  const top = stack[stack.length - 1];
  const trail =
    shell().publicVisitor() && stack.length > 1 && top && (top.kind === 'row' || top.kind === 'page') && top.table
      ? stack.slice(0, -1)
      : stack;
  // Each crumb keeps its index in the walk, which is where it goes back to.
  const shown = trail.map((entry, index) => ({ entry, index })).filter(({ entry, index }) => !sameRoom(entry, trail[index + 1]));
  return (
    <nav className="crumbs" aria-label={say('trail')}>
      <button type="button" className="crumb-home" {...homeWords()} onClick={onHome}>
        <svg
          viewBox="0 0 16 16"
          width="17"
          height="17"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2 7.2 8 2.4l6 4.8" />
          <path d="M3.4 6.6V13a.6.6 0 0 0 .6.6h8a.6.6 0 0 0 .6-.6V6.6" />
        </svg>
      </button>
      {shown.map(({ entry, index: i }) => {
        const last = i === stack.length - 1;
        /* A row crumb names its table when the walk has changed table —
           which is exactly what following a foreign key does. A page crumb
           is a record crumb drawn as a page, on the same rule. */
        const previousTable = i > 0 ? stack[i - 1].table : null;
        const named = entry.kind === 'row' || entry.kind === 'page';
        /* A dashboard's or a form's page crumb has no table, and `undefined` is not the first crumb's `null`: without
           the table itself the trail drew an empty step before the title. */
        const showsTable = named && entry.label != null && !!entry.table && entry.table !== previousTable;
        /* In an App the table is its own step of the trail, said in the resource's label ("Properties"), with the
           separator every step has; the Workbench keeps the table's own name as a qualifier of the record. */
        const tableWord = entry.table
          ? shell().inApp()
            ? appCrumbLabel({ table: entry.table, query: '', view: entry.view }) ||
              humanName((findTable(entry.table) as { name?: string } | undefined)?.name ?? entry.table) ||
              entry.table
            : entry.table
          : '';
        const ownStep = showsTable && shell().inApp();
        const content = (
          <>
            {showsTable && !ownStep && (
              <span className="crumb-table" title={entry.table}>
                {tableWord}
              </span>
            )}
            {nameOf(entry)}
          </>
        );
        return (
          <Fragment key={i}>
            {ownStep && (
              <>
                <span className="sep">›</span>
                <span className="crumb-table-step">{tableWord}</span>
              </>
            )}
            <span className="sep">›</span>
            {last ? (
              <span className="current">{content}</span>
            ) : (
              <button type="button" onClick={() => backTo(i)}>
                {content}
              </button>
            )}
          </Fragment>
        );
      })}
      {/* A list's title, count and star land here; its verbs, at the end. */}
      <span className="crumb-note" ref={crumbNoteRef} />
      {/* The walk's Back repeats the trail's own last step; a public reader has
          the trail and the browser's Back, and one more button is chrome. */}
      {previous && !shell().publicVisitor() && (
        <button
          type="button"
          className="crumb-back"
          title={say('back', { previous: nameOf(previous) })}
          onClick={() => backTo(stack.length - 2)}
        >
          <Icon name="caret-left" size={16} />
          <span>{say('common.back')}</span>
        </button>
      )}
      <div className="crumb-tools" ref={crumbToolsRef} />
    </nav>
  );
}
