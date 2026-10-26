/**
 * A move drawn before the server has it, for every host a reader arranges by
 * hand — a board's card to a lane or a place (BoardList), a calendar's record
 * to a day (CalendarList), a list's row to its place (useListOrder).
 *
 * A move is drawn the moment it is made: each record it touches is drawn
 * with the values the move will write (`begin`, synchronously, so a drag's
 * copy settles into the card's new place rather than its old one), and stays
 * so while its writes run. A write that is refused takes its move back
 * (`undo`), and the host says the server's sentence. A write that applies
 * leaves the record drawn as it is (`saved`) until the rows the host reads
 * say the same — the host writes them into its cache, or reads them again —
 * so the card never goes back to its old place in between, and never jumps
 * twice.
 *
 * Moves run one after another (`enqueue`): one made while another is saving
 * waits its turn rather than being dropped, and reads the board as the moves
 * before it left it. When the last is done, `idle` is told once, for the one
 * read again that settles every move.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

type Values = Record<string, unknown>;
type Phase = 'asking' | 'saving' | 'saved';
interface Layer {
  move: number;
  values: Values;
  phase: Phase;
}

/* A stored value and the one a move wrote agree as the page would say them: 1024 and "1024", null and nothing. */
const same = (a: unknown, b: unknown) => String(a ?? '') === String(b ?? '');

let moves = 0;

export function useOptimisticMoves<Row extends Record<string, unknown>>(
  rows: readonly Row[],
  idOf: (row: Row) => string | null,
  idle?: () => Promise<unknown> | void,
) {
  const [layers, setLayers] = useState<ReadonlyMap<string, readonly Layer[]>>(() => new Map());
  const chain = useRef<Promise<void>>(Promise.resolve());
  const waiting = useRef(0);
  const latestIdle = useRef(idle);
  latestIdle.current = idle;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const change = (edit: (next: Map<string, readonly Layer[]>) => void, now = false) => {
    if (!mounted.current) return;
    const update = () =>
      setLayers((current) => {
        const next = new Map(current);
        edit(next);
        return next;
      });
    if (now) flushSync(update);
    else update();
  };
  const each = (move: number, edit: (layer: Layer) => Layer | null) =>
    change((next) => {
      for (const [id, list] of next) {
        const kept = list.flatMap((layer) => (layer.move === move ? (edit(layer) ?? []) : [layer]));
        if (kept.length) next.set(id, kept);
        else next.delete(id);
      }
    });

  /* A saved record leaves the drawing once the rows read say what the move wrote. Nothing is named until a move is
     made: a list nobody moves pays nothing. */
  useEffect(() => {
    if (!layers.size) return;
    const base = new Map(rows.flatMap((row) => (idOf(row) === null ? [] : [[idOf(row)!, row] as const])));
    const agreed = [...layers].filter(
      ([id, list]) =>
        list.every((layer) => layer.phase === 'saved') &&
        base.has(id) &&
        list.every((layer) => Object.entries(layer.values).every(([column, value]) => same(base.get(id)![column], value))),
    );
    if (agreed.length) change((next) => agreed.forEach(([id]) => next.delete(id)));
  });

  /** The rows as the moves draw them: each record a move touches carries the values it will write. The same rows and
      moves draw the same objects, so a host that renders on its rows' identity renders once. */
  const latestId = useRef(idOf);
  latestId.current = idOf;
  const drawn = useMemo(
    () =>
      layers.size
        ? rows.map((row) => {
            const id = latestId.current(row);
            const list = id === null ? undefined : layers.get(id);
            return list ? (Object.assign({}, row, ...list.map((layer) => layer.values)) as Row) : row;
          })
        : (rows as Row[]),
    [rows, layers],
  );

  return {
    rows: drawn,
    /** Whether a record's move is still out: waiting on a form it opened, or being saved. */
    pending: (id: string): 'asking' | 'saving' | undefined => {
      const list = layers.get(id);
      if (!list) return undefined;
      return list.some((layer) => layer.phase === 'asking')
        ? 'asking'
        : list.some((layer) => layer.phase === 'saving')
          ? 'saving'
          : undefined;
    },
    /** Draw a move now: each record with the values it will write. Returns the move, for what happens to it next. */
    begin(writes: ReadonlyArray<readonly [string, Values]>, phase: 'asking' | 'saving' = 'saving'): number {
      const move = ++moves;
      change((next) => {
        for (const [id, values] of writes) next.set(id, [...(next.get(id) ?? []), { move, values, phase }]);
      }, true);
      return move;
    },
    /** The form a move opened was answered: the move is being saved. */
    saving: (move: number) => each(move, (layer) => ({ ...layer, phase: 'saving' })),
    /** A record the move wrote more of than it drew (a renumbered neighbor): drawn with those values too. */
    add: (move: number, writes: ReadonlyArray<readonly [string, Values]>) =>
      change((next) => {
        for (const [id, values] of writes) next.set(id, [...(next.get(id) ?? []), { move, values, phase: 'saving' }]);
      }),
    /** The move's writes applied: it stays drawn until the rows read agree. */
    saved: (move: number) => each(move, (layer) => ({ ...layer, phase: 'saved' })),
    /** The move did not apply, or was cancelled: its records go back. */
    undo: (move: number) => each(move, () => null),
    /** Run a move after those already waiting; when the last is done, `idle` reads the rows again, once. */
    enqueue(task: () => Promise<void>) {
      waiting.current += 1;
      chain.current = chain.current
        .then(task)
        .catch(() => undefined)
        .then(async () => {
          waiting.current -= 1;
          if (waiting.current > 0 || !mounted.current) return;
          await latestIdle.current?.();
          /* What the read said is the truth now: a saved move whose rows still disagree (a verb that put the record
             somewhere else) is let go, a frame after the read is drawn, so the drawing never goes back in between. */
          if (waiting.current === 0)
            setTimeout(
              () =>
                change((next) => {
                  for (const [id, list] of next) {
                    const kept = list.filter((layer) => layer.phase !== 'saved');
                    if (kept.length) next.set(id, kept);
                    else next.delete(id);
                  }
                }),
              32,
            );
        });
    },
    /** Moves waiting their turn or being saved. */
    busy: () => waiting.current > 0,
  };
}
