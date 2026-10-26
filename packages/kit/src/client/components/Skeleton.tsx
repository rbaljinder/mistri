/**
 * Placeholders shaped like the thing that is coming.
 *
 * Nothing appears immediately: most queries here finish in single-digit
 * milliseconds, and a skeleton that flashes for 40ms reads as a glitch.
 * `Delayed` mounts its children only once the wait has lasted long enough
 * to be real. The shape is derived, not invented: the grid placeholder uses
 * the table's own column count and the page size; the record placeholder
 * uses the record's own layout.
 */
import { memo, useEffect, useState, type ReactNode } from 'react';
import { say } from '../copy/shell/components/Skeleton.js';

/** How long a wait has to last before it is worth showing anything. */
const SKELETON_DELAY = 140;

export function Delayed({ ms = SKELETON_DELAY, children }: { ms?: number; children: ReactNode }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(timer);
  }, [ms]);
  return shown ? <>{children}</> : null;
}

/** One shimmering block. Width is a percentage so rows look uneven, as text is.
    An element, not a component: a dashboard waiting on ten tiles drew some
    3,500 of them, each redrawn as every tile answered. */
export function bar(width: number, height = 12, key?: number) {
  return <span key={key} className="sk-bar" style={{ width: `${width}%`, height: `${height}px` }} aria-hidden="true" />;
}

/* Deterministic widths: the same skeleton twice looks the same, and a
   sequence that varies reads as text rather than as a pattern. */
const WIDTHS = [82, 54, 71, 45, 63, 88, 38, 76, 59, 67];
export const widthAt = (i: number) => WIDTHS[i % WIDTHS.length];

/* Memoized: its two numbers are all it draws from, and a room redrawing
   around a wait (a dashboard, as each tile answers) need not redraw it. */
export const GridSkeleton = memo(function GridSkeleton({ columns, rows }: { columns: number; rows: number }) {
  // Bounded: a forty-column table does not need forty bars to say "a table is coming".
  const across = Math.min(Math.max(columns, 3), 8);
  const down = Math.min(Math.max(rows, 3), 12);
  return (
    <div className="sk-grid" style={{ '--sk-cols': across } as React.CSSProperties} role="status" aria-label={say('loadingRows')}>
      <div className="sk-row sk-head">{Array.from({ length: across }, (_, i) => bar(40 + ((i * 17) % 30), 8, i))}</div>
      {Array.from({ length: down }, (_, r) => (
        <div key={r} className="sk-row">
          {Array.from({ length: across }, (_, c) => bar(widthAt(r * across + c), undefined, c))}
        </div>
      ))}
    </div>
  );
});

/** A record, before its fields arrive: the section shapes of the layout about to be drawn. */
export function RecordSkeleton({ sections }: { sections: Array<{ title?: string; count: number }> }) {
  return (
    <div className="sk-record" role="status" aria-label={say('loadingRecord')}>
      {sections.map((section, s) => (
        <section key={s} className="sk-section">
          {section.title && bar(14, 9)}
          <div className="sk-fields">
            {Array.from({ length: section.count }, (_, i) => (
              <div key={i} className="sk-field">
                {bar(38, 10)}
                {bar(widthAt(i), 12)}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** The Related list, before its counts arrive. */
export const RelatedSkeleton = memo(function RelatedSkeleton({ count }: { count: number }) {
  return (
    <div className="sk-related" role="status" aria-label={say('counting')}>
      {Array.from({ length: Math.min(Math.max(count, 1), 8) }, (_, i) => (
        <div key={i} className="sk-related-item">
          {bar(100, 14)}
          <span className="sk-related-names">
            {bar(widthAt(i), 11)}
            {bar(widthAt(i + 3) * 0.7, 8)}
          </span>
        </div>
      ))}
    </div>
  );
});
