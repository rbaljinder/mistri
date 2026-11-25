/**
 * A dashboard's named-area layout grid (`areas`): reflows once per reader pick
 * when all tiles settle, hiding areas whose every section asked to be left out.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { gridTemplateAreas, layoutAreas, reflowLayout, type LayoutGrid } from '@mistriwork/engine/shared/dashLayout.js';

const NO_SECTIONS: ReadonlySet<number> = new Set();

/** What the grid acts on when sections ask to be left out: who asks, and who has been settled as gone. */
export interface DashboardAreaGate {
  report: (at: number, gone: boolean) => void;
  settled: ReadonlySet<number>;
}

/** A dashboard's layout drawn: one grid, an area for each name in the template, in reading order. */
export function LaidOut({
  layout,
  inArea,
  epoch,
  flow,
}: {
  layout: LayoutGrid;
  inArea: ReadonlyMap<string, number[]>;
  /** What the reader has picked, as one word: the grid is re-shaped once for each. */
  epoch: string;
  flow: (indices: number[], pairing: boolean, gate: DashboardAreaGate) => ReactNode[];
}) {
  /* Which sections ask to be left out is held here, and what the grid acts on is settled once per reader's pick. */
  const queries = useQueryClient();
  const asking = useIsFetching();
  const askedNow = useRef<ReadonlySet<number>>(NO_SECTIONS);
  const [asked, setAsked] = useState<ReadonlySet<number>>(NO_SECTIONS);
  const [settled, setSettled] = useState<ReadonlySet<number>>(NO_SECTIONS);
  const report = useCallback((at: number, gone: boolean) => {
    if (askedNow.current.has(at) === gone) return;
    const next = new Set(askedNow.current);
    if (gone) next.add(at);
    else next.delete(at);
    askedNow.current = next;
    setAsked(next);
  }, []);
  /* The areas are re-flowed once for each thing the reader picks, when every tile has its answer to it: until then the
     tiles keep their last answers (keepPreviousData) and the grid its last shape, so the change lands as one finished
     swap and not a move for every tile that answers. A live refresh is not a pick: a section that empties on one shows
     its empty line where it stands, and the grid is left alone until the reader's next pick. The timer lets the
     tiles' own effects, which start the questions and report the answers, run first. */
  const decided = useRef<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (queries.isFetching() > 0 || decided.current === epoch) return;
      decided.current = epoch;
      setSettled(askedNow.current);
    }, 0);
    return () => clearTimeout(timer);
  }, [queries, epoch, asking, asked]);
  /* In reading order, so the DOM is the order a reader and a keyboard go in whatever the template draws. */
  const areas = layoutAreas(layout);
  const away = new Set(areas.filter((area) => (inArea.get(area) ?? []).every((i) => settled.has(i))));
  const columns = layout[0]?.length ?? 1;
  const gate = { report, settled };
  return (
    <div
      className="dash-grid"
      data-columns={columns}
      style={{ '--dash-columns': columns, '--dash-template': gridTemplateAreas(reflowLayout(layout, away)) } as CSSProperties}
    >
      {areas.map((area) => (
        <div key={area} className="dash-area" style={{ '--area': area } as CSSProperties} hidden={away.has(area) || undefined}>
          {flow(inArea.get(area) ?? [], false, gate)}
        </div>
      ))}
    </div>
  );
}
