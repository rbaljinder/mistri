/**
 * The small parts a form is drawn from: the help tip, the progress bar, a step's heading, the fixed action bar, the
 * review group and a row of columns. Props only: every word and every picture arrives as a prop, and none of them
 * knows a field, a step or an address. Preview: @mistriwork/ui is Preview at 1.0.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Button } from './Button.js';
import { HelpTip } from './internal/HelpTip.js';
import { slotted } from './internal/uiKitContext.js';

export interface HelpTipProps {
  /** The tip's text. */
  text: ReactNode;
  /** What the button is called ("More information"); the caller's word. */
  label: string;
  /** The mark on the button; without one, an "i". */
  icon?: ReactNode;
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
function DefaultProgressBar({ value, max, min = 0, label, decorative }: ProgressBarProps): ReactNode {
  return (
    <div
      data-slot="progress-track"
      data-kind="bar"
      {...(decorative
        ? { 'aria-hidden': true }
        : { role: 'progressbar', 'aria-label': label, 'aria-valuemin': min, 'aria-valuemax': max, 'aria-valuenow': value })}
    >
      {/* A share of the whole, not of the range: on step 1 of 5 a fifth is filled, as a reader counts it. */}
      <span data-slot="progress-indicator" style={{ width: `${max > 0 ? Math.min(100, (value / max) * 100) : 0}%` }} />
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

/** A step's title and the quiet lead under it. The heading takes the keyboard when the step changes, so the next key
    is about it. */
function DefaultStepHeader({ title, lead, mark, level = 1, id }: StepHeaderProps): ReactNode {
  const Heading = level === 1 ? 'h1' : 'h2';
  return (
    <header data-slot="step-header">
      <Heading id={id} tabIndex={-1}>
        {mark ? (
          <span data-slot="step-mark" aria-hidden="true">
            {mark}
          </span>
        ) : null}
        {title}
      </Heading>
      {lead ? <p data-slot="step-lead">{lead}</p> : null}
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
function DefaultActionBar({ back, primary, className }: ActionBarProps): ReactNode {
  return (
    <footer data-slot="action-bar" className={className || undefined}>
      {back ? (
        <Button intent="quiet" size="large" onClick={back.onClick}>
          {back.icon}
          {back.label}
        </Button>
      ) : null}
      <Button
        intent="primary"
        size="large"
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

/** Fields side by side; `cols` is a grid template such as "1fr 1.8fr". A row stacks where its fields no longer fit:
    the template is handed to the stylesheet as a property and not written as the grid itself, so it can. */
function DefaultColumns({ cols, children }: { cols?: string; children: ReactNode }): ReactNode {
  return (
    <div
      data-slot="columns"
      data-kind={cols ? 'template' : undefined}
      style={cols ? ({ '--form-columns': cols } as CSSProperties) : undefined}
    >
      {children}
    </div>
  );
}

/** The editable review: earlier steps' fields drawn again in one labelled group. */
function DefaultReviewList({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div data-slot="review-list" data-kind="group" role="group" aria-label={label}>
      {children}
    </div>
  );
}

/* Slotted (UiKit.tsx): an App's control kit may draw its own in place of the default, with the same props. The "i"
   beside a label is a button that opens its text under it; Escape and a press elsewhere close it. Its default is
   drawn in a module of its own (internal/HelpTip.tsx), which a field's frame also draws from. */
export { HelpTip };
export const ProgressBar = slotted('ProgressBar', DefaultProgressBar);
export const StepHeader = slotted('StepHeader', DefaultStepHeader);
export const ActionBar = slotted('ActionBar', DefaultActionBar);
export const Columns = slotted('Columns', DefaultColumns);
export const ReviewList = slotted('ReviewList', DefaultReviewList);
