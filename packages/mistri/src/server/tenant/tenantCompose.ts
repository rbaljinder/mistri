/**
 * A tenant App's record page in one request (shared/recordReads.ts says why;
 * server/http/recordCompose.ts is the ordinary App's). The tenant host plans
 * the page and asks each part on the one context the request holds — one
 * admission, one attestation of the lease, each read in the snapshot its own
 * operation takes, under the context's grants, row scope and served catalog —
 * through the host's own read route, the route each part's own request
 * reaches (tenantHttp.ts `route`).
 *
 * A context that refuses one read refuses the rest of the invocation (the
 * first failure decides, tenantReadRuntime.ts), so the record's row is read
 * whole or not at all here, and a page that fails composes nothing: its
 * client asks the plan and each part alone, and hears each refusal in its
 * own words.
 */
import { findTable, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import {
  recordPageReads,
  rowBody,
  whenBody,
  type ReadAsk,
  type ReadPlan,
  type ReadSection,
} from '@mistriwork/engine/shared/recordReads.js';

/** One part of the page and its answer, as the ordinary App's compose carries them. */
interface ComposedRead extends ReadAsk {
  readonly status: number;
  readonly reply: unknown;
}
type Resources = Record<
  string,
  {
    recordLabel?: string | false;
    defined?: Record<string, { per?: string }>;
    actions?: Array<{ when?: string; command?: { id: string; version: number; target: string } }>;
  }
>;

/** How many related rows a reader may ask for, as the ordinary compose takes it. */
const MOST_ROWS = 50;
const MOST_CHECKS = 16;

/** Whether a compose's own fields are ones it can use: a page size and the tab it opens on. */
export function composeInputValid(input: Record<string, unknown>): boolean {
  const rows = input.rows ?? 10;
  return (
    typeof rows === 'number' &&
    Number.isInteger(rows) &&
    rows >= 1 &&
    rows <= MOST_ROWS &&
    (input.tab === undefined || (typeof input.tab === 'string' && input.tab.length <= 512)) &&
    Boolean(input.key) &&
    typeof input.key === 'object' &&
    !Array.isArray(input.key)
  );
}

const failed = (answer: { status: number; body: unknown }) =>
  answer.status >= 400 ||
  Boolean(
    answer.body &&
    typeof answer.body === 'object' &&
    ('error' in answer.body ||
      ('errors' in answer.body &&
        Array.isArray((answer.body as { errors: unknown }).errors) &&
        (answer.body as { errors: unknown[] }).errors.length > 0)),
  );

export async function composeTenantRecordPage(options: {
  schema: DatabaseSchema;
  planned: { page: unknown; plans: unknown };
  key: Record<string, unknown>;
  rows: unknown;
  tab: unknown;
  /** The App as this context is served it (projectTenantMetadata): its record names and its verbs. */
  app: { resources?: unknown } | null | undefined;
  ask: (path: string, body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;
}): Promise<{
  planned: true;
  page: unknown;
  plans: unknown;
  reads: ComposedRead[];
  checks: Array<{ command: string; commandVersion: number; keys: Array<Record<string, unknown>> }>;
}> {
  const { schema, planned, key } = options;
  const page = planned.page as { id: string; base: string; sections: ReadSection[]; listTabs?: boolean };
  const plans = planned.plans as ReadPlan[];
  const base = findTable(schema, page.base) as TableMeta | undefined;
  if (!base) return { planned: true, page: planned.page, plans: planned.plans, reads: [], checks: [] };
  const resources = (options.app?.resources ?? {}) as Resources;
  const names = {
    schema,
    app: true,
    recordLabel: (table: string) => resources[table]?.recordLabel,
    defined: (table: string) => resources[table]?.defined,
  };
  const rows = typeof options.rows === 'number' ? options.rows : 10;
  const { row, reads } = recordPageReads(names, page, base, plans, key, {
    rows,
    history: true,
    ...(typeof options.tab === 'string' ? { tab: options.tab } : {}),
  });
  const actions = resources[base.id]?.actions ?? [];
  for (const when of new Set(actions.flatMap((action) => (!action.command && action.when ? [action.when] : [])))) {
    reads.push({ path: '/api/run', body: whenBody(base, key, when) });
  }
  /* The history first: its store is attested and then read, the longest chain. */
  const ordered = [
    ...reads.filter((asked) => asked.path === '/api/record-history'),
    { path: '/api/view/run', body: rowBody(page.id, base, key, row, 'row') },
    ...reads.filter((asked) => asked.path !== '/api/record-history'),
  ];
  const answered: ComposedRead[] = [];
  await Promise.all(
    ordered.map(async (asked) => {
      const answer = await options.ask(asked.path, asked.body);
      if (!failed(answer)) answered.push({ ...asked, status: answer.status, reply: answer.body });
    }),
  );
  const commands = actions.flatMap((action) => (action.command && action.command.target === base.id ? [action.command] : []));
  const checks = [...new Map(commands.map((command) => [command.id, command])).values()]
    .slice(0, MOST_CHECKS)
    .map((command) => ({ command: command.id, commandVersion: command.version, keys: [key] }));
  return { planned: true, page: planned.page, plans: planned.plans, reads: answered, checks };
}
