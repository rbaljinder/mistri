/**
 * A record page in one request (shared/recordReads.ts says why).
 *
 * `POST /api/pages/compose` takes what `/api/pages/plan` takes — the page,
 * by name or as itself, and the record's key — with the reader's page size
 * for related lists (`rows`) and the tab it opens on (`tab`). It plans the
 * page, then asks every read the sections it draws will send: the record's
 * row once for every section that reads it, each related list's first page
 * and totals, each figure, each timeline and custom read, each `when`, the
 * record's history and which of its commands are available. Each is asked
 * of the route the section's own request reaches, on this request's source —
 * one admission, one session, one row-policy context, the same grants, row
 * scope and hidden columns — through `post`, which is the dispatcher's own,
 * into a reply held in memory. What a signed-out visitor or a row policy may
 * not ask on its own is not asked here either.
 *
 * The answer is the plan, as `/api/pages/plan` answers it, and beside it
 * each read that succeeded with the request it answers. A read that failed
 * is left out: the section asks it itself, and is refused in its own words.
 */
import type { ServerResponse } from 'node:http';
import { findTable, type TableMeta } from '../../shared/schema.js';
import { validatePage, type PageDef } from '../../shared/page.js';
import {
  RECORD_COMPOSE_PATH,
  recordPageReads,
  rowBody,
  whenBody,
  type ReadAsk,
  type ReadPlan,
  type ReadSection,
} from '../../shared/recordReads.js';
import { canonicalText } from '../../shared/recordReadKeys.js';
import { CapturedReply } from './captured.js';
import { HttpError, send } from './reply.js';
import type { RequestContext, ResolvedSource } from './context.js';

export const COMPOSE_PATH = RECORD_COMPOSE_PATH;

/** One read the page asked, and its answer. */
interface ComposedRead extends ReadAsk {
  readonly status: number;
  readonly reply: unknown;
}

/** How many related rows a reader may ask for a page: the sizes the list offers (client relatedRows.ts), and no more. */
const MOST_ROWS = 50;
/** Commands asked about at once, as the availability route takes them. */
const MOST_CHECKS = 16;

/** The resources of the App a page is drawn in, as far as composing its reads needs them. */
export type ComposeResources = Record<
  string,
  {
    recordLabel?: string | false;
    defined?: Record<string, { per?: string }>;
    actions?: Array<{ when?: string; command?: { id: string; version: number; target: string } }>;
  }
>;

/** One availability check of a record's command, as `/api/commands/availability` takes it. */
interface CommandCheck {
  readonly command: string;
  readonly commandVersion: number;
  readonly keys: Record<string, unknown>[];
}

/** What a product decides of a composed page. The database browser asks every part, has no App, and runs no commands. */
export interface ComposeHooks {
  /** Whether this request's reader may ask `path` on its own: the gate's and the row policy's rule for that route. */
  mayAsk(ctx: RequestContext, path: string): boolean;
  /** The App's resources as this reader is served them, or none. */
  resources(ctx: RequestContext, source: ResolvedSource): ComposeResources;
  /** A table's suggested page (`suggested:<table>`). */
  suggested(source: ResolvedSource, table: string): PageDef | null;
  /** Which of the record's commands are available to this reader: the availability route's answer, or none. */
  availability?(ctx: RequestContext, checks: CommandCheck[]): Promise<{ status: number; body: unknown } | undefined>;
}

const failed = (answer: { status: number; body: unknown } | undefined) =>
  !answer ||
  answer.status >= 400 ||
  Boolean(
    answer.body &&
    typeof answer.body === 'object' &&
    ('error' in answer.body ||
      ('errors' in answer.body &&
        Array.isArray((answer.body as { errors: unknown }).errors) &&
        (answer.body as { errors: unknown[] }).errors.length > 0)),
  );

export async function composeRecordPage({
  ctx,
  source,
  body,
  post,
  hooks,
}: {
  ctx: RequestContext;
  source: ResolvedSource;
  body: Record<string, unknown>;
  post: (reply: ServerResponse, path: string, body: Record<string, unknown>) => Promise<void>;
  hooks: ComposeHooks;
}): Promise<void> {
  const { res, identity } = ctx;
  const key = body.key;
  const rows = body.rows ?? 10;
  const tab = body.tab;
  if (
    !key ||
    typeof key !== 'object' ||
    Array.isArray(key) ||
    typeof rows !== 'number' ||
    !Number.isInteger(rows) ||
    rows < 1 ||
    rows > MOST_ROWS ||
    (tab !== undefined && (typeof tab !== 'string' || tab.length > 512)) ||
    (typeof body.page !== 'string' && (!body.page || typeof body.page !== 'object' || Array.isArray(body.page)))
  ) {
    throw new HttpError(400, 'A composed record page names a page, a record key and a page size.');
  }
  /* A part asked on the page's behalf: through the route its section's own
     request reaches, answered into memory. What that route would refuse, or
     throw, leaves the part out. */
  const ask = async (path: string, given: Record<string, unknown>) => {
    if (!hooks.mayAsk(ctx, path)) return undefined;
    const reply = new CapturedReply();
    try {
      await post(reply.asResponse(), path, given);
    } catch {
      return undefined;
    }
    return reply.answer();
  };
  const record = key as Record<string, unknown>;
  const resources = hooks.resources(ctx, source);
  const names = {
    schema: source.schema,
    app: ctx.appConfigured,
    recordLabel: (table: string) => resources[table]?.recordLabel,
    defined: (table: string) => resources[table]?.defined,
  };
  const options = { rows, history: true, ...(tab === undefined ? {} : { tab: tab as string }) };

  /* What the page reads that its plan does not decide — the record's row,
     its history, its verbs, each `when` — is asked beside the plan, from
     the page as the plan will find it; the lists and figures the plan
     builds are asked once it comes. Should the plan's page not be that
     page after all, the early answers are dropped and asked again. */
  const reading = (page: PlannedPage, base: TableMeta, plans: readonly ReadPlan[], started: Array<[ReadAsk, Promise<Answer>]> = []) => {
    const answered: ComposedRead[] = [];
    const keep = (asked: ReadAsk, answer: { status: number; body: unknown } | undefined) => {
      if (!failed(answer)) answered.push({ ...asked, status: answer!.status, reply: answer!.body });
    };
    const { row, parts, reads } = recordPageReads(names, page, base, plans, record, options);
    /* The record's fixed edits ask their `when` of the row, as a section does. */
    const actions = resources[base.id]?.actions ?? [];
    for (const when of new Set(actions.flatMap((action) => (!action.command && action.when ? [action.when] : [])))) {
      reads.push({ path: '/api/run', body: whenBody(base, record, when) });
    }
    const whole = async () => {
      const asked = { path: '/api/view/run', body: rowBody(page.id, base, record, row, 'row') };
      const answer = await ask(asked.path, asked.body);
      if (!failed(answer)) return keep(asked, answer);
      /* One column this reader may not read refuses the whole row: each reader of it is asked alone, as it would ask. */
      await Promise.all(
        parts.map(async ({ part, columns }) => {
          const alone = { path: '/api/view/run', body: rowBody(page.id, base, record, columns, part) };
          keep(alone, await ask(alone.path, alone.body));
        }),
      );
    };
    const commands = actions.flatMap((action) => (action.command && action.command.target === base.id ? [action.command] : []));
    const checks = [...new Map(commands.map((command) => [command.id, command])).values()]
      .slice(0, MOST_CHECKS)
      .map((command) => ({ command: command.id, commandVersion: command.version, keys: [record] }));
    const availability = async () => {
      if (!checks.length || identity.id === undefined || !hooks.availability || !hooks.mayAsk(ctx, '/api/commands/availability')) return;
      const asked = { path: '/api/commands/availability', body: { checks } };
      keep(asked, await hooks.availability(ctx, checks));
    };
    const begun = new Map(started.map(([asked, answer]) => [readKey(asked), answer]));
    /* The page's own row first, its verbs last: they are advice, and wait behind what is shown. */
    const done = Promise.all([
      whole(),
      ...reads.map(async (asked) => keep(asked, await (begun.get(readKey(asked)) ?? ask(asked.path, asked.body)))),
      availability(),
    ]);
    return { reads: new Set(reads.map((asked) => readKey(asked))), done: done.then(() => answered) };
  };

  const expected = expectedPage(ctx, source, body.page, hooks);
  const expectedBase = expected && (findTable(source.schema, expected.base) as TableMeta | undefined);
  /* The history is asked first: it is the longest chain (its store is
     attested, then read), and a reader pool is a queue. Then the plan, which
     the lists wait on; then the rest. */
  const history =
    expected && expectedBase
      ? recordPageReads(names, expected, expectedBase, [], record, options)
          .reads.filter((asked) => asked.path === '/api/record-history')
          .map((asked) => [asked, ask(asked.path, asked.body)] as [ReadAsk, Promise<Answer>])
      : [];
  const planning = ask('/api/pages/plan', { page: body.page, key });
  const early = expected && expectedBase ? reading(expected, expectedBase, [], history) : undefined;
  const plan = await planning;
  const planned = failed(plan) ? undefined : (plan!.body as { page: PlannedPage; plans: ReadPlan[] });
  const base = planned && (findTable(source.schema, planned.page.base) as TableMeta | undefined);
  /* No plan, no page: the client asks the plan itself, and is told why in
     the plan's own words. What was asked beside it is dropped, once it has
     settled: every read ends inside the request (and the row policy's
     context) that asked it. */
  if (!planned || !base) {
    await Promise.allSettled([early?.done, ...history.map(([, answer]) => answer)]);
    return send(res, 200, { planned: false });
  }
  const kept = early && canonicalText(expected) === canonicalText(planned.page) ? early : undefined;
  if (early && !kept) await early.done;
  let answered: ComposedRead[];
  if (kept) {
    /* Only what the plan adds: its lists, figures, timelines and custom reads. */
    const { reads } = recordPageReads(names, planned.page, base, planned.plans, record, options);
    const later = reads.filter((asked) => !kept.reads.has(readKey(asked)));
    const more = await Promise.all(later.map(async (asked) => ({ asked, answer: await ask(asked.path, asked.body) })));
    answered = [
      ...(await kept.done),
      ...more.flatMap(({ asked, answer }) => (failed(answer) ? [] : [{ ...asked, status: answer!.status, reply: answer!.body }])),
    ];
  } else answered = await reading(planned.page, base, planned.plans).done;
  send(res, 200, { planned: true, page: planned.page, plans: planned.plans, reads: answered });
}

type Answer = { status: number; body: unknown } | undefined;
type PlannedPage = { id: string; base: string; sections: ReadSection[]; listTabs?: boolean };

const readKey = (asked: ReadAsk) => `${asked.path}\u0000${canonicalText(asked.body)}`;

/**
 * The page the plan will find, found as `/api/pages/plan` finds it
 * (authoringRoutes.ts): given whole, the table's suggested page, or the
 * connection's configured page by name — validated against this schema.
 * Only to ask the page's own reads beside the plan; the plan still decides,
 * and an answer read for any other page is dropped.
 */
function expectedPage(ctx: RequestContext, source: ResolvedSource, asked: unknown, hooks: ComposeHooks): PlannedPage | undefined {
  const name = ctx.registry.list().find((c) => c.id === source.connectionId)?.name;
  const found =
    typeof asked === 'object' && asked !== null
      ? (asked as PageDef)
      : String(asked ?? '').startsWith('suggested:')
        ? hooks.suggested(source, String(asked).slice('suggested:'.length))
        : ctx.configPages.find(
            (page) =>
              page.id === String(asked ?? '') && (!page.connection || page.connection === source.connectionId || page.connection === name),
          );
  if (!found || typeof found.base !== 'string' || !Array.isArray(found.sections)) return undefined;
  const page = validatePage(source.schema, found);
  return page.error ? undefined : (page as unknown as PlannedPage);
}
