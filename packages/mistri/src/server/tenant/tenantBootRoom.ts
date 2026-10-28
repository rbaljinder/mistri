/*
 * The room a tenant page's boot asks for (tenantHttp.ts, `TENANT_BOOT_PATH`): its reads and batches, planned as an
 * ordinary App's first page plans them (http/firstPaintRooms.ts), each asked once however many plans name it.
 */
import { BREAKDOWN_BATCH } from '@mistriwork/engine/server/resourceReadHttp.js';
import { COUNT_EACH_MAX } from '@mistriwork/engine/shared/reads.js';
import type { FirstPaintItemKind } from '@mistriwork/engine/shared/firstPaint.js';
import { naturalRecordReads, roomReads, type RoomInput } from '../http/firstPaintRooms.js';

/* The batches a boot asks, at most as many items in one as its client sends in one (engine http/firstPaint.ts). */
const BOOT_BATCH_MOST: Readonly<Record<string, number>> = { '/api/breakdowns': BREAKDOWN_BATCH, '/api/counts': COUNT_EACH_MAX };

/**
 * A tenant page's boot asking the reads of the room at its address (tenantHttp.ts, `TENANT_BOOT_PATH`), planned as
 * an ordinary App's first page plans them (http/firstPaintRooms.ts): each read through `ask`, which asks a read once
 * however often it is named, and each batch in the chunks its client sends, through `one`, once per chunk, with every
 * item it answers given to `item`. The boot plans a room twice — from the App as its context is offered it, so the
 * room's reads leave beside the App's own, and then from the payload it is answered with — and each plan asks only
 * what the other has not.
 */
export function bootRoom(
  ask: (method: 'GET' | 'POST', target: string, body?: Record<string, unknown>) => Promise<unknown>,
  one: (target: string, body: Record<string, unknown>) => Promise<{ body: unknown } | undefined>,
  item: (kind: FirstPaintItemKind, key: unknown, body: unknown) => void,
): (room: RoomInput) => Promise<void> {
  const batches = new Map<string, Promise<void>>();
  return async (room) => {
    const plan = roomReads(room);
    /* A record its natural key addresses is found by it first, and its own reads asked once it is. */
    const natural = naturalRecordReads(room);
    await Promise.all([
      ...plan.reads.map((read) => ask(read.method, read.target, read.body)),
      ...(natural?.reads ?? []).map((read) => ask(read.method, read.target, read.body)),
      natural &&
        ask(natural.find.method, natural.find.target, natural.find.body).then((rows) =>
          Promise.all(natural.found(rows).reads.map((read) => ask(read.method, read.target, read.body))),
        ),
      ...plan.batches.flatMap((batch) => {
        const most = BOOT_BATCH_MOST[batch.path] ?? 1;
        const chunks: Array<typeof batch.items> = [];
        for (let at = 0; at < batch.items.length; at += most) chunks.push(batch.items.slice(at, at + most));
        return chunks.map((chunk) => {
          const body = { ...batch.body, items: chunk.map((each) => each.sent) };
          const key = `${batch.path} ${JSON.stringify(body)}`;
          let answered = batches.get(key);
          if (!answered)
            batches.set(
              key,
              (answered = one(batch.path, body).then((answer) => {
                const results = (answer?.body as { results?: unknown } | undefined)?.results;
                if (!Array.isArray(results) || results.length !== chunk.length) return;
                chunk.forEach((each, index) => {
                  const value = batch.unwrap ? batch.unwrap(results[index]) : results[index];
                  if (value !== undefined) item((each.kind ?? batch.kind) as FirstPaintItemKind, each.key, value);
                });
              })),
            );
          return answered;
        });
      }),
    ]);
  };
}
