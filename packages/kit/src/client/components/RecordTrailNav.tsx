/**
 * Where a record sits in the list it was opened from, and the way to its
 * neighbors: "3 of 20" between Previous and Next beside the record's name,
 * and J (next) / K (previous) from the keyboard while it is on screen.
 *
 * The keys are the ones file lists and mail readers use for the same move;
 * single letters, so they stand aside for a text field, a dialog over the
 * page, and any modifier, as the page's other single keys do (app.js). A
 * step replaces the record in the walk rather than adding one, so Back
 * returns to the list, not through every record read on the way. Nothing
 * animates (docs/design.md: keyboard navigation moves nothing), and the
 * position is a polite live region, so the new place is said.
 *
 * The step and the controls are shared with the glance and the record
 * dialog (PeekPanel, RecordModal): one page reader, one guard against a
 * late page, one set of buttons, on every surface that steps.
 */
import { useEffect, useRef, useState } from 'react';
import { api, currentEntry, findTable, go, keyOf, rowLabel } from '../core.js';
import { canStep, stepTrail, stepWithin, trailPosition, type RecordTrail, type TrailPageReader } from '../recordTrail.js';
import { say } from '../copy/record/components/RecordTrailNav.js';
import { Icon } from './Icon.js';
import { addHostListener, removeHostListener } from '../shellHost.js';

interface TrailEntry {
  kind: string;
  table: string;
  key?: Record<string, unknown>;
  label?: string | null;
  trail?: RecordTrail;
}

/** One page of the list's own question, as the records a step can land on. */
const readPage: TrailPageReader = async (tableId, list, offset) => {
  const table = findTable(tableId);
  const data = (await api('/api/run', { q: list.query, limit: list.limit, offset, count: 'none' })) as {
    rows?: Array<Record<string, unknown>>;
  };
  if (!table || !Array.isArray(data?.rows)) return [];
  return data.rows.flatMap((row) => {
    const key = keyOf(table, row) as Record<string, unknown> | null;
    const label = rowLabel(table, row) as string | null;
    return key ? [{ key, ...(label ? { label } : {}) }] : [];
  });
};

/**
 * A step along a trail. `land` puts the next record in front of the reader;
 * `stillHere` says whether the surface that asked is still the one on
 * screen, so a page that arrives after the reader has moved on lands nowhere.
 * A step within the page reads nothing and lands at once.
 */
export function useTrailStep(trail: RecordTrail | undefined, land: (next: RecordTrail) => void, stillHere: () => boolean) {
  const [reading, setReading] = useState(false);
  const busy = useRef(false);
  const step = async (by: 1 | -1) => {
    if (!trail || busy.current || !canStep(trail, by)) return;
    const within = stepWithin(trail, by);
    if (within) {
      land(within);
      return;
    }
    busy.current = true;
    setReading(true);
    try {
      const next = await stepTrail(trail, by, readPage);
      if (next && stillHere()) land(next);
    } catch {
      /* A page that cannot be read leaves the reader where they are; the buttons stay. */
    } finally {
      busy.current = false;
      setReading(false);
    }
  };
  return { step, reading };
}

/** "3 of 20" between Previous and Next — or "3" where the list has no total. */
export function TrailSteps({
  trail,
  reading,
  onStep,
  onPointerDown,
}: {
  trail: RecordTrail;
  reading: boolean;
  onStep: (by: 1 | -1) => void;
  /** The record dialog settles an autosave before the pointer's click moves it on. */
  onPointerDown?: () => void;
}) {
  const { at, of } = trailPosition(trail);
  return (
    <nav className="record-trail" aria-label={say('recordsInThisList')} aria-busy={reading || undefined}>
      <span className="step-control">
        <button
          type="button"
          className="step-button record-trail-step"
          aria-label={say('previousRecord')}
          title={say('previousRecordK')}
          aria-keyshortcuts="K"
          disabled={!canStep(trail, -1)}
          onPointerDown={onPointerDown}
          onClick={() => onStep(-1)}
        >
          <Icon name="caret-left" size={16} />
        </button>
        <span className="step-position record-trail-at" aria-live="polite">
          {of === undefined ? `${at}` : say('atOfOf', { at, of })}
        </span>
        <button
          type="button"
          className="step-button record-trail-step"
          aria-label={say('nextRecord')}
          title={say('nextRecordJ')}
          aria-keyshortcuts="J"
          disabled={!canStep(trail, 1)}
          onPointerDown={onPointerDown}
          onClick={() => onStep(1)}
        >
          <Icon name="caret-right" size={16} />
        </button>
      </span>
    </nav>
  );
}

/** A key the page's single-letter shortcuts must not take: typing, a dialog over the page, or a modifier. */
export function takesSingleKeys(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return false;
  const active = document.activeElement as HTMLElement | null;
  if (active && (/^(input|textarea|select)$/i.test(active.tagName) || active.isContentEditable)) return false;
  return !active?.closest?.('[role="dialog"], dialog[open], .help-panel, .palette, .conn-manager');
}

/** Any walk entry: a record page's or a row's, a split's detail included. Draws nothing where the record was not opened from a list. */
export function RecordTrailNav({ entry }: { entry: object }) {
  const walk = entry as TrailEntry;
  const trail = walk.trail;
  const { step, reading } = useTrailStep(
    trail,
    (next) => {
      const record = next.records[next.index];
      go({ ...walk, key: record.key, label: record.label, trail: next }, 'replace');
    },
    () => currentEntry() === entry,
  );
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    if (!trail) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.key !== 'j' && event.key !== 'k') || !takesSingleKeys(event)) return;
      event.preventDefault();
      void stepRef.current(event.key === 'j' ? 1 : -1);
    };
    addHostListener(document, 'keydown', onKey);
    return () => removeHostListener(document, 'keydown', onKey);
  }, [trail]);
  if (!trail) return null;
  return <TrailSteps trail={trail} reading={reading} onStep={(by) => void step(by)} />;
}
