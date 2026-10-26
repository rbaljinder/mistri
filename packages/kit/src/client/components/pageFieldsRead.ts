/**
 * A page's fields sections read their record together.
 *
 * Each fields section names its own columns, and each used to read the root
 * row for them alone: a record page with a headline, contact details, an
 * address and two more groups sent five reads of one row, each paying a
 * tenant request's whole admission and fences, all in the same moment. The
 * sections that ask in the same tick for the same record through the same
 * connection now share one read of every column any of them named, and each
 * is handed exactly the part it asked for — its columns, its resolved
 * descriptions, its row — so a section cannot tell the difference.
 *
 * Nothing is kept: the batch is the callers of one tick, never a cache, so a
 * refetch after an edit reads the row again (together, when the sections
 * refetch together). A shared read that fails, or answers with the language's
 * errors, is asked again a section at a time: one section naming a column this
 * reader may not see must break that section only, as it did alone.
 */
import type { HttpFilter } from '@mistriwork/engine/shared/resourceHttp.js';
/* Exactly what a section would have been answered alone: the rule a composed page's row answers by too. */
import { rowPart } from '@mistriwork/engine/shared/recordReadKeys.js';

interface ViewReply {
  view: { columns: Array<{ path: string }> } & Record<string, unknown>;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  resolved?: Array<{ path: string; name?: string }>;
}
type Reply = ViewReply | { errors: Array<{ message: string }> };
/** What a section's read is: the same request it would have sent alone. */
interface FieldsRead {
  /** Where the read goes: the page's connection, and the owner scope it asks under. */
  readonly owner: string;
  readonly pageId: string;
  readonly base: { id: string; name: string };
  readonly filter: HttpFilter<'path'>;
  readonly columns: readonly string[];
}
/** The one request a batch sends: a view of the root row. */
interface FieldsBody {
  count: 'none';
  view: { id: string; name: string; base: string; columns: Array<{ path: string }>; filter: HttpFilter<'path'>; limit: 1 };
}
type Send = (body: FieldsBody) => Promise<Reply>;
interface Waiting {
  read: FieldsRead;
  send: Send;
  resolve: (reply: Reply) => void;
  reject: (error: unknown) => void;
}

let waiting: Waiting[] = [];

const bodyFor = (read: FieldsRead, columns: readonly string[]): FieldsBody => ({
  count: 'none',
  view: {
    id: `page:${read.pageId}:fields`,
    name: read.base.name,
    base: read.base.id,
    columns: columns.map((path) => ({ path })),
    filter: read.filter,
    limit: 1,
  },
});

/** One section's read, answered with the others of this tick where they read the same row. */
export function readPageFields(read: FieldsRead, send: Send): Promise<Reply> {
  return new Promise<Reply>((resolve, reject) => {
    if (!waiting.length) queueMicrotask(flush);
    waiting.push({ read, send, resolve, reject });
  });
}

const alone = (item: Waiting) => item.send(bodyFor(item.read, item.read.columns)).then(item.resolve, item.reject);

function flush() {
  const batch = waiting;
  waiting = [];
  const groups = new Map<string, Waiting[]>();
  for (const item of batch) {
    const key = JSON.stringify([item.read.owner, item.read.pageId, item.read.base.id, item.read.filter]);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  for (const group of groups.values()) {
    if (group.length === 1) {
      void alone(group[0]);
      continue;
    }
    const columns = [...new Set(group.flatMap((item) => item.read.columns))];
    void group[0]
      .send(bodyFor(group[0].read, columns))
      .then((reply) => {
        if (!reply || typeof reply !== 'object' || !('view' in reply) || !Array.isArray(reply.rows)) throw new Error('unshared');
        for (const item of group) item.resolve(rowPart(reply, item.read.columns));
      })
      .catch(() => {
        for (const item of group) void alone(item);
      });
  }
}
