/**
 * The small parts a form is drawn from: the help tip, the progress bar, a step's heading, the fixed action bar, the
 * review group and a row of columns. Props only: every word and every picture arrives as a prop, and none of them
 * knows a field, a step or an address. Preview: @mistriwork/ui is Preview at 1.0.
 */
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Button } from './Button.js';

export interface HelpTipProps {
  /** The tip's text. */
  text: ReactNode;
  /** What the button is called ("More information"); the caller's word. */
  label: string;
  /** The mark on the button; without one, an "i". */
  icon?: ReactNode;
}

/** The "i" beside a label: a button that opens its text under it. Escape and a press elsewhere close it. */
export function HelpTip({ text, label, icon }: HelpTipProps): ReactNode {
  const [open, setOpen] = useState(false);
  const tipId = useId();
  const root = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (e: Event): void => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return (
    <span className="help-tip" ref={root}>
      <button
        type="button"
        className="help-tip-button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? tipId : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      >
        {icon ?? <span aria-hidden="true">i</span>}
      </button>
      {open ? (
        <span role="tooltip" id={tipId} className="help-tip-text">
          {text}
        </span>
      ) : null}
    </span>
  );
}

export interface ProgressBarProps {
  value: number;
  max: number;
  /** The bottom of the range, announced as `aria-valuemin`: 0 by default, 1 for "step 1 of 5". */
  min?: number;
  /** What the bar is called to assistive technology ("Step 3 of 12"). Leave it out, with `decorative`, to hide the bar. */
  label?: string;
  decorative?: boolean;
}

/** How far along: a filled track. It is information that moves often, so the fill is not animated. */
export function ProgressBar({ value, max, min = 0, label, decorative }: ProgressBarProps): ReactNode {
  return (
    <div
      className="progress-bar"
      {...(decorative
        ? { 'aria-hidden': true }
        : { role: 'progressbar', 'aria-label': label, 'aria-valuemin': min, 'aria-valuemax': max, 'aria-valuenow': value })}
    >
      <span className="progress-bar-fill" style={{ width: `${max > 0 ? Math.min(100, (value / max) * 100) : 0}%` }} />
    </div>
  );
}

export interface StepHeaderProps {
  title: ReactNode;
  /** The heading's level: 1 (the room's own) by default, 2 where the form sits in a dialog that has its title. */
  level?: 1 | 2;
  /** The heading's id, for a region that is named by it. */
  id?: string;
  lead?: ReactNode;
  /** A decorative glyph before the title. */
  mark?: ReactNode;
}

/** A step's title and the quiet lead under it. */
export function StepHeader({ title, lead, mark, level = 1, id }: StepHeaderProps): ReactNode {
  const Heading = level === 1 ? 'h1' : 'h2';
  return (
    <header className="step-header">
      <Heading className="step-title" id={id} tabIndex={-1}>
        {mark ? (
          <span className="step-mark" aria-hidden="true">
            {mark}
          </span>
        ) : null}
        {title}
      </Heading>
      {lead ? <p className="step-lead">{lead}</p> : null}
    </header>
  );
}

export interface ActionBarProps {
  /** Another class on the bar, for the form that draws it. */
  className?: string;
  back?: { label: ReactNode; onClick: () => void; icon?: ReactNode };
  primary: { label: ReactNode; onClick: () => void; disabled?: boolean; busy?: boolean; busyLabel?: ReactNode; icon?: ReactNode };
}

/** The bar fixed to the foot of its container: Back as a quiet word, and a filled primary that takes the rest of the width. */
export function ActionBar({ back, primary, className }: ActionBarProps): ReactNode {
  return (
    <footer className={className ? `action-bar ${className}` : 'action-bar'}>
      {back ? (
        <Button intent="quiet" size="large" className="action-bar-back" onClick={back.onClick}>
          {back.icon}
          {back.label}
        </Button>
      ) : null}
      <Button
        intent="primary"
        size="large"
        className="action-bar-primary"
        disabled={primary.disabled}
        busy={primary.busy}
        busyLabel={primary.busyLabel}
        onClick={primary.onClick}
      >
        {primary.label}
        {primary.icon}
      </Button>
    </footer>
  );
}

/** Fields side by side; `cols` is a grid template such as "1fr 1.8fr". A row stacks where its fields no longer fit. */
export function Columns({ cols, children }: { cols?: string; children: ReactNode }): ReactNode {
  return (
    <div className="form-columns" style={cols ? ({ '--form-columns': cols } as CSSProperties) : undefined}>
      {children}
    </div>
  );
}

/** The editable review: earlier steps' fields drawn again in one labelled group. */
export function ReviewList({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="review-list" role="group" aria-label={label}>
      {children}
    </div>
  );
}
