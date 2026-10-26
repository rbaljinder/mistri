/**
 * A record page's plan and every read its sections will ask, in one request
 * (shared/recordReads.ts). The reads are kept for the sections to find
 * (composedReads.ts); the plan is what the room draws from.
 *
 * A press on a row or a link to a record starts it (recordPress.ts), so
 * the request is on its way while the button is still down, and the room
 * that opens takes the one already running instead of asking again.
 */
import { api } from './core.js';
import { ownedBy } from './requestIdentity.js';
import { relatedRows } from './relatedRows.js';
import { composedEpoch, composing, holdComposed, type ComposedRead } from './composedReads.js';
import { sessionIdentity } from './sessionIdentity.js';
import { RECORD_COMPOSE_PATH } from '@mistriwork/engine/shared/recordReads.js';
import { canonicalText } from '@mistriwork/engine/shared/recordReadKeys.js';
import type { PageDef } from '@mistriwork/engine/shared/page.js';
import type { SectionPlan } from './components/pageModel.js';

interface Planned {
  page?: PageDef;
  plans?: SectionPlan[];
}

/* A compose begun by a press, until the room it opens takes it; a press
   that opened nothing lets it go. */
const begun = new Map<string, { work: Promise<Planned>; until: number; taken?: boolean }>();
const KEPT = 10_000;

const identityOf = (connection: string, page: string | PageDef, key: Record<string, unknown>, tab: string | undefined) =>
  canonicalText([connection, sessionIdentity().epoch, page, key, tab ?? null, relatedRows()]);

function send(connection: string, page: string | PageDef, key: Record<string, unknown>, tab: string | undefined): Promise<Planned> {
  // Taken before the request leaves: a write sent or answered while it is out makes its answers the past.
  const since = composedEpoch();
  const work = (async (): Promise<Planned> => {
    let reply: { planned?: boolean; page?: PageDef; plans?: SectionPlan[]; reads?: ComposedRead[] } | undefined;
    try {
      reply = (await api(
        RECORD_COMPOSE_PATH as '/api/pages/plan',
        { ...ownedBy(connection), page, key, rows: relatedRows(), ...(tab === undefined ? {} : { tab }) } as never,
      )) as typeof reply;
    } catch {
      reply = undefined;
    }
    /* No plan came with it: the plan is asked alone, and says in its own words why it cannot be made. */
    if (!reply?.planned)
      return (await api('/api/pages/plan', { ...ownedBy(connection), page: page as never, key: key as never })) as Planned;
    holdComposed(connection, reply.reads ?? [], since);
    return { page: reply.page, plans: reply.plans };
  })();
  composing(connection, work);
  return work;
}

/** The page's plan, with its reads kept for the sections it draws on `tab`: the one a press began, or a new one. */
export function composeRecordPage(
  connection: string,
  page: string | PageDef,
  key: Record<string, unknown>,
  tab?: string,
): Promise<Planned> {
  const id = identityOf(connection, page, key, tab);
  const early = begun.get(id);
  /* Taken once: the room's next read of its plan (a tab coming back) is a
     fresh one. Kept, taken, until it expires, so a press that lingers (its
     focus, its Enter) does not begin the page it just opened again. */
  if (early && !early.taken && early.until > Date.now()) {
    early.taken = true;
    return early.work;
  }
  return send(connection, page, key, tab);
}

/** Begin a record page's compose ahead of the navigation that will ask for it. */
export function beginRecordPage(connection: string, page: string, key: Record<string, unknown>): void {
  const id = identityOf(connection, page, key, undefined);
  const now = Date.now();
  for (const [kept, entry] of begun) if (entry.until <= now) begun.delete(kept);
  if (begun.has(id)) return;
  const work = send(connection, page, key, undefined);
  work.catch(() => {
    begun.delete(id);
  });
  begun.set(id, { work, until: now + KEPT });
}
