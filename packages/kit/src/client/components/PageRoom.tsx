/**
 * A page as a room. The page is a component (components/Page.tsx) and its pure
 * parts are components/pageModel.ts; page.js keeps the registry every module
 * asks — the config's pages, the suggested one every table has, the ones
 * this browser built. This is the walk's business in between: which
 * definition a link names, the root read off the address, the probe that
 * settles whether the record still exists, the plan the server writes for
 * the page, the crumb and the visit remembered for home.
 *
 * Four asks in a row, each a Query enabled by the one before, each keyed by
 * what it depends on and kept only while the room is up. Nothing paints
 * for an entry that is no longer the one on the walk: the key changed with
 * it, and the callbacks check the entry before touching it.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { currentEntry, go, humanName, pageView, primaryKey, renderCrumbs, rowLabel, state, tableView } from '../core.js';
import { shell } from '../shellMode.js';
import { deriveFilterNames } from '../filterbar.js';
import { forgetPage, rememberVisit } from '../pagemarks.js';
import { readdress, syncHash } from '../url.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { appListFor, appListQuery, type ListSpec } from './appListModel.js';
import { PageView } from './Page.js';
import { type PageEntry } from './pageModel.js';
import {
  captureRecordSurfaceOwner,
  RECORD_REFRESH_FAILED,
  usePageSurface,
  type RecordSurfacePage as Def,
  type RecordSurfaceAlternative as Others,
} from './recordSurface.js';
import { AppListRoom } from './Rooms.js';
import { FilterSection, TableRoom } from './TableRoom.js';
import { say } from '../copy/record/components/PageRoom.js';
import { RecordGone } from './RecordGone.js';
import { Delayed } from './Skeleton.js';
import { onDemand } from './onDemand.js';
import { workMark, workSince } from '../pendingWork.js';
import { shellRoot } from '../shellHost.js';

/* App mode reads pages in the app's words; the workbench reads them raw. */
/* Drawn only past the hold's cap, so it is a part of its own: no record's first page carries it. */
const PageSkeleton = onDemand(() => import('./PageSkeleton.js'), 'PageSkeleton', { quiet: true });

const spoken = (name: string): string => (shell().inApp() ? (humanName(name) as string) : name);
const connection = () => (state as { activeConnection?: string }).activeConnection ?? '';

export function PageRoom({ entry }: { entry: PageEntry }) {
  const [, resolved] = useState(0);
  const owner = connection();
  const schema = state.schema;
  // A routed lifetime still requires this exact walk entry. Explicit surfaces
  // supply their own lifetime predicate without changing the routed fence.
  const surfaceOwner = useMemo(() => captureRecordSurfaceOwner(() => currentEntry() === entry), [entry]);
  const surface = usePageSurface(surfaceOwner, entry);
  const { definition: def, page, base, needsResolution } = surface;
  useLayoutEffect(() => {
    if (!needsResolution || !base || currentEntry() !== entry || connection() !== owner || state.schema !== schema || !surface.isCurrent())
      return;
    /* A deep link names the page but not its table — the definition is the
       one source of that. Backfilled after commit, before mounting readers: the
       sidebar highlight, the crumb, and `openRecord`'s root-in-place guard. */
    entry.table = base.id;
    /* A link carries the root as text, because a single-column key is written
       as a bare value and only the base table says which column that is. */
    if (!entry.key && entry.rootBody !== undefined) {
      entry.key = entry.rootBody.includes('=')
        ? Object.fromEntries(
            entry.rootBody.split(',').map((pair) => {
              const [column, ...rest] = pair.split('=');
              return [column, rest.join('=')];
            }),
          )
        : { [(primaryKey(base) as string[])[0]]: entry.rootBody };
    }
    resolved((version) => version + 1);
    renderCrumbs();
  }, [entry, base, needsResolution, owner, schema, surface.isCurrent]);
  const rootRow = surface.rootRow;
  useEffect(() => {
    if (!rootRow || !base || currentEntry() !== entry || !surface.isCurrent()) return;
    const early = rowLabel(base, rootRow) as string | null;
    if (early && entry.label !== early) {
      entry.label = early;
      renderCrumbs();
    }
  }, [rootRow]); // eslint-disable-line react-hooks/exhaustive-deps
  const planned = surface.plan.data;
  /* `page` too: a suggested page asks its plan and root beside its definition, so both can land first, and a visit
     that waited only on them was never recorded once the definition came. */
  useEffect(() => {
    if (planned && rootRow && page && currentEntry() === entry && surface.isCurrent()) {
      rememberVisit({ pageId: page.id, name: page.name, base: page.base, key: entry.key, label: entry.label });
    }
  }, [planned, rootRow, page]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!surface.isCurrent()) return null;
  return (
    <div className="panel-pad">
      {surface.content && surface.refreshFailed && (
        <p role="alert" className="note">
          {RECORD_REFRESH_FAILED}
        </p>
      )}
      {def.isError && !page ? (
        <p className="note">{(def.error as Error).message}</p>
      ) : !page ? null : page.error ? (
        <>
          <div className="page-head">
            <h1 className="page-title">{page.name}</h1>
          </div>
          <div className="page-body">
            <p className="note">{page.error}</p>
          </div>
        </>
      ) : !base ? (
        <p className="note">{say('common.isNotATable', { base: page.base })}</p>
      ) : needsResolution ? null : (
        <Known entry={entry} page={page} base={base} surface={surface} />
      )}
    </div>
  );
}

function Known({
  entry,
  page,
  base,
  surface,
}: {
  entry: PageEntry;
  page: Def;
  base: TableMeta;
  surface: ReturnType<typeof usePageSurface>;
}) {
  const others = surface.others;
  /* The builder is the Workbench's (pagebuilder.js), reached through the shell: only the Workbench authors pages (PageHead's `authoring`). */
  const onLayout = () =>
    shell().editPage?.(page, {
      recordKey: entry.key,
      onSaved: (saved: { id: string; base: string }) => go(pageView(saved.id, saved.base, entry.key, entry.label), 'replace'),
      /* Deleting the page you are standing on has to go somewhere: the table it
       was about. Pinned or recently opened, it is neither now. */
      onDeleted: () => {
        forgetPage(page.id);
        go(tableView(page.base), 'replace');
      },
    });
  if (!others.data) return entry.key ? <Arriving page={page} /> : null;
  return entry.key ? (
    <WithRoot entry={entry} page={page} base={base} surface={surface} onLayout={onLayout} />
  ) : (
    <Rootless entry={entry} page={page} base={base} others={others.data} onLayout={onLayout} />
  );
}

/**
 * No record chosen: the list *is* the chooser. The app's list page in app
 * mode — tabs, named filters, chips, the lot — and the plain grid in the
 * workbench; a row click opens this record as a page, because the walk is
 * already in page view and `openRecord` keeps it there.
 */
function Rootless({
  entry,
  page,
  base,
  others,
  onLayout,
}: {
  entry: PageEntry;
  page: Def;
  base: TableMeta;
  others: Others[];
  onLayout: () => void;
}) {
  useEffect(() => {
    if (currentEntry() === entry && entry.label !== page.name) {
      entry.label = page.name;
      renderCrumbs();
    }
  }, [entry, page.name]);
  const spec = shell().inApp() ? (appListFor(base.id) as ListSpec) : null;
  return (
    <PageView
      entry={entry}
      page={page}
      base={base}
      plans={[]}
      others={others}
      onLabel={() => {}}
      onTab={() => {}}
      onLayout={onLayout}
      chooser={<Chooser entry={entry} base={base} spec={spec} />}
    />
  );
}

function Chooser({ entry, base, spec }: { entry: PageEntry & { chooserQuery?: string }; base: TableMeta; spec: ListSpec | null }) {
  const what = spoken(base.name);
  /* Redrawn in place on every tab click and filter: the chooser lives
     inside the page entry, and its questions must not move the walk. The
     query rides on the entry so the pager's re-render comes back to it —
     not in the URL: the link names the page, and the chooser is a moment. */
  const [query, setQuery] = useState<string>(entry.chooserQuery ?? (spec ? appListQuery(spec) : base.id));
  const draw = (next: string) => {
    entry.chooserQuery = next;
    setQuery(next);
  };
  const listEntry = { kind: 'table' as const, table: base.id, query };
  return (
    <>
      <p className="note page-empty">{say(/^[aeiou]/i.test(what) ? 'pickAnBelow' : 'pickABelow', { thing: what.toLowerCase() })}</p>
      <div className="page-root-list">
        {spec ? (
          <AppListRoom entry={listEntry} spec={spec} navigate={draw} />
        ) : (
          <>
            {/* The workbench chooser gets the named boxes too, the key columns
                  leading: the one lookup the old root bar guaranteed was "by id". */}
            <FilterSection
              entry={listEntry}
              navigate={draw}
              names={[...new Set([...(primaryKey(base) as string[]), ...(deriveFilterNames(base) as string[])])]}
            />
            <TableRoom entry={listEntry} chrome={false} interactive={false} />
          </>
        )}
      </div>
    </>
  );
}

/**
 * A record chosen. The root first, before any section: a page for a record
 * that is gone used to say so in one box while the metrics around it
 * rendered zeros. One pk-sized fetch settles existence, and brings the
 * label, so the crumb and the pill say the name before the sections
 * resolve. Then one planning call for the whole page, and a run per section.
 */
function WithRoot({
  entry,
  page,
  base,
  surface,
  onLayout,
}: {
  entry: PageEntry;
  page: Def;
  base: TableMeta;
  surface: ReturnType<typeof usePageSurface>;
  onLayout: () => void;
}) {
  const key = entry.key as Record<string, unknown>;
  const { probe, gone, plan, content } = surface;
  if (!probe.data) return <Arriving page={page} />;
  if (gone) {
    return (
      <div className="page-body">
        <RecordGone base={base} spoken={spoken(base.name)} />
      </div>
    );
  }
  if (plan.isError && !content) return <p className="note">{(plan.error as Error).message}</p>;
  if (!content) return <Arriving page={page} />;
  return (
    <Revealed>
      <PageView
        {...content}
        onLayout={onLayout}
        onLabel={(label) => {
          /* Written onto the entry as well as shown, so going away and coming
           back through the trail keeps the name rather than dropping to the
           key. Guarded on the entry still being the current one. */
          if (!label || currentEntry() !== entry || !surface.isCurrent()) return;
          /* A public record's slug is its name (publicAddress.ts): written once the
           name is known, however it came to be known — a crumb may have named
           the entry before the page did. */
          if (entry.label === label) {
            readdress();
            return;
          }
          entry.label = label;
          renderCrumbs();
          readdress();
          /* Recorded again now that the record has a name. */
          rememberVisit({ pageId: page.id, name: page.name, base: page.base, key, label });
        }}
        onTab={(tab) => {
          if (currentEntry() !== entry || !surface.isCurrent()) return;
          entry.tab = tab;
          syncHash();
        }}
      />
    </Revealed>
  );
}

/**
 * The record while its page is on its way: nothing drawn, and the page's
 * height held. Under a held screen (navigationHold.ts) it is never seen;
 * past the hold's cap it keeps what stands below (the footer) where the page
 * will push it, so the page that arrives moves nothing already on screen. A
 * name or a status drawn here from the row that opened it would move as the
 * real head arrives, taller, with its verbs: that is the layout shift this
 * holds off, so it says no words. Past the cap it draws the page's anatomy in
 * placeholders (PageSkeleton) inside the held height, replaced whole: an
 * empty pane under the crumbs read as a page that had failed, not one coming.
 */
function Arriving({ page }: { page: Def }) {
  return (
    <div className="page-arriving" aria-busy="true" style={{ minHeight: '100vh' }}>
      <Delayed ms={ARRIVING_SHAPE_MS}>
        <PageSkeleton sections={page.sections} />
      </Delayed>
    </div>
  );
}

/* Past the navigation hold's cap (navigationHold.ts, 1.5s) the pane is uncovered: only then is the page's shape worth
   drawing, and under the hold it is never seen, so it never shows on a page that arrives in time. */
const ARRIVING_SHAPE_MS = 1500;

/* Frames with nothing asked and nothing drawn before a page is complete: the navigation hold's count. */
const QUIET_FRAMES = 3;
/* The longest a page arriving uncovered is kept out of sight, as the hold's cap. */
const REVEAL_CAP = 1500;

/**
 * The record's page as it arrives, shown once it is complete. A section
 * draws when its own read answers, and the header's verbs when their
 * availability does: under the navigation hold (navigationHold.ts) or the
 * startup veil (startupHold.ts) none of that is seen. But each lets go at
 * its cap, and a page still arriving then drew in steps — a head a line
 * taller once its verbs came, sections growing under it — moving what was
 * already on screen (0.43 on the lender's loan when its read outlasted the
 * hold). So a page that is uncovered before it is complete is kept out of
 * sight, at Arriving's height, until nothing asked since it mounted is out,
 * no read is running and nothing is drawn into it for three frames, and is
 * then shown whole. Covered and complete, it changes nothing: no style is
 * written, so the hold sees nothing stir.
 */
export function Revealed({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const client = useQueryClient();
  useLayoutEffect(() => {
    const own = box.current;
    const pane = own?.closest('.content');
    if (!own) return;
    const root = shellRoot();
    const covered = () => Boolean(pane?.classList.contains('nav-holding')) || root.hasAttribute('data-starting');
    const mark = workMark();
    let hidden = false,
      done = false,
      quiet = 0,
      stirred = false,
      frame = 0;
    const hide = () => {
      if (hidden || done || covered()) return;
      hidden = true;
      own.style.visibility = 'hidden';
      own.style.minHeight = '100vh';
    };
    const finish = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(frame);
      clearTimeout(cap);
      drawn.disconnect();
      cover.disconnect();
      stop();
      if (hidden) {
        own.style.removeProperty('visibility');
        own.style.removeProperty('min-height');
      }
    };
    /* Told as a microtask, so a cover that lifts hides the page before the frame paints it. */
    const cover = new MutationObserver(hide);
    if (pane) cover.observe(pane, { attributes: true, attributeFilter: ['class'] });
    cover.observe(root, { attributes: true, attributeFilter: ['data-starting'] });
    const drawn = new MutationObserver(() => {
      stirred = true;
    });
    drawn.observe(own, { childList: true, subtree: true, characterData: true });
    const stop = client.getQueryCache().subscribe(() => {
      stirred = true;
    });
    const cap = setTimeout(finish, REVEAL_CAP);
    const watch = () => {
      const busy = stirred || workSince(mark) || client.isFetching() > 0;
      stirred = false;
      quiet = busy ? 0 : quiet + 1;
      if (quiet >= QUIET_FRAMES) {
        finish();
        return;
      }
      frame = requestAnimationFrame(watch);
    };
    hide();
    frame = requestAnimationFrame(watch);
    return finish;
  }, [client]);
  return (
    <div ref={box} className="page-revealed">
      {children}
    </div>
  );
}

export type { ReactNode };
