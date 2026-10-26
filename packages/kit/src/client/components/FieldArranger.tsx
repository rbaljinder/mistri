/**
 * Arranging a group of fields: which ones, and in what order. Drag to
 * reorder, Alt+arrows for the keyboard, × to take one off, a pool of the
 * rest to add from, and — when there are other groups — a way to send a
 * field to one of them. Controlled: the parent owns the list and hears
 * every change. The vanilla twin in `arrange.js` serves the page builder
 * until that room crosses over.
 */
import { useEffect, useRef, useState } from 'react';
import { say } from '../copy/record/components/FieldArranger.js';

interface OtherGroup {
  title: string;
  receive: (name: string) => void;
}
interface FieldArrangerProps {
  all: string[];
  chosen: string[];
  columns?: number;
  /** What a field is taken off — "page", "layout". */
  noun?: string;
  /** The panel's own label, or null where whatever it sits in already says what these are. */
  heading?: string | null;
  label?: (name: string) => string;
  typeOf?: (name: string) => string;
  onChange: (next: string[]) => void;
  /** Identity of this group, for cross-group drags. */
  owner?: unknown;
  others?: OtherGroup[];
  /** Redraw everything after a hand-over: two groups change and the other one may be open. */
  onSend?: () => void;
}

/** The field being dragged between groups, or null. */
let carried: { name: string; owner: unknown; take: () => void } | null = null;
export const carriedField = () => carried;

export function FieldArranger({
  all,
  chosen,
  columns = 1,
  noun = 'layout',
  heading = say('fields'),
  label = (n) => n,
  typeOf = () => '',
  onChange,
  owner,
  others = [],
  onSend,
}: FieldArrangerProps) {
  const list = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [sending, setSending] = useState<number | null>(null);
  const [focusAt, setFocusAt] = useState(-1);
  useEffect(() => {
    if (focusAt < 0) return;
    (list.current?.children[focusAt] as HTMLElement | undefined)?.focus();
    setFocusAt(-1);
  }, [focusAt, chosen]);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= chosen.length || from === to) return;
    const next = [...chosen];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
    setFocusAt(to);
  };
  const remove = (i: number) => onChange(chosen.filter((_, at) => at !== i));
  const handOver = (name: string, i: number, other: OtherGroup) => {
    onChange(chosen.filter((_, at) => at !== i));
    other.receive(name);
    setSending(null);
    onSend?.();
  };
  const sendTo = (name: string, i: number) => {
    if (others.length === 1) {
      handOver(name, i, others[0]);
      return;
    }
    /* More than one candidate, so it is a choice — made in the row rather than in a dialog, which would cover the thing being arranged. */
    setSending(i);
  };
  const rest = all.filter((n) => !chosen.includes(n));
  return (
    <div className="pb-panel">
      <div className="pb-panel-head">
        {heading ? <span className="pb-label">{heading}</span> : null}
        <span className="pb-field-count">{say('ofDragToArrange', { chosenCount: chosen.length, allCount: all.length })}</span>
        <span className="pb-spacer" />
        <button type="button" className="ghost" title={say('everyFieldInTheTables')} onClick={() => onChange([...all])}>
          {say('common.all')}
        </button>
        <button type="button" className="ghost" onClick={() => onChange([])}>
          {say('none')}
        </button>
      </div>
      <div ref={list} className="pb-arrange" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {chosen.length ? (
          chosen.map((name, i) => (
            <div
              key={name}
              className={`pb-arrange-row${dragging === i ? ' dragging' : ''}`}
              draggable
              tabIndex={0}
              role="listitem"
              aria-label={say('position', { name, i: i + 1, chosenCount: chosen.length })}
              onDragStart={(e) => {
                setDragging(i);
                /* Also offered to every other group's row: reordering inside this list and carrying to another group are the same grip. */
                carried = { name, owner, take: () => onChange(chosen.filter((n) => n !== name)) };
                e.dataTransfer.effectAllowed = 'move';
                /* Firefox will not start a drag without something on the transfer; the payload is never read. */
                e.dataTransfer.setData('text/plain', name);
              }}
              onDragEnd={() => {
                setDragging(null);
                carried = null;
              }}
              onDragOver={(e) => {
                if (dragging === null || dragging === i) return;
                e.preventDefault();
                const next = [...chosen];
                const [item] = next.splice(dragging, 1);
                next.splice(i, 0, item);
                setDragging(i);
                onChange(next);
              }}
              onDrop={(e) => e.preventDefault()}
              onKeyDown={(e) => {
                if (!e.altKey) return;
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  move(i, i - 1);
                }
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  move(i, i + 1);
                }
              }}
            >
              <span className="pb-grip" aria-hidden="true">
                ∷
              </span>
              <span className="pb-field-name" title={name}>
                {label(name)}
              </span>
              <span className="pb-field-type">{typeOf(name)}</span>
              {others.length ? (
                <button
                  type="button"
                  className="ghost pb-send"
                  title={say('moveThisFieldToAnother')}
                  aria-label={say('moveToAnotherGroup', { name })}
                  onClick={() => sendTo(name, i)}
                >
                  →
                </button>
              ) : null}
              <button
                type="button"
                className="ghost pb-remove"
                title={say('takeThisFieldOff', { noun })}
                aria-label={say('remove', { name })}
                onClick={() => remove(i)}
              >
                ×
              </button>
              {sending === i ? (
                <div className="pb-send-menu">
                  {others.map((other, k) => (
                    <button key={other.title} type="button" className="ghost" autoFocus={k === 0} onClick={() => handOver(name, i, other)}>
                      {other.title}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ))
        ) : (
          <p className="note">{say('noFieldsInThisGroup')}</p>
        )}
      </div>
      <div className="pb-pool">
        <span className="pb-label">{rest.length ? say('common.add') : say('everyField', { noun })}</span>
        {rest.map((name) => (
          /* Named for what pressing it does: the visible text is the field's own name, which reads as a label to anyone hearing the page one element at a time. */
          <button
            key={name}
            type="button"
            className="ghost pb-add-field"
            title={say('addToThisGroup', { name })}
            aria-label={say('add', { name })}
            onClick={() => onChange([...chosen, name])}
          >
            {label(name)}
          </button>
        ))}
      </div>
    </div>
  );
}
