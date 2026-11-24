/**
 * The small parts a form is drawn from: the help tip, the progress bar, a step's heading, the fixed action bar, the
 * review group and a row of columns. Props only: every word and every picture arrives as a prop, and none of them
 * knows a field, a step or an address. Preview: @mistriwork/ui is Preview at 1.0.
 */
import type { CSSProperties, ReactNode, Ref } from 'react';
import { Button } from './Button.js';
import { HelpTip } from './internal/HelpTip.js';
import { slotted } from './internal/uiKitContext.js';

/** Props for the `HelpTip` press-activated label tooltip button. */
export interface HelpTipProps {
  /** The tip's text. */
  text: ReactNode;
  /** What the button is called ("More information"); the caller's word. */
  label: string;
  /** The mark on the button; without one, an "i". */
  icon?: ReactNode;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
}

/** Props for the `ProgressBar` linear step progress indicator. */
export interface ProgressBarProps {
  value: number;
  max: number;
  /** The bottom of the range, announced as `aria-valuemin`: 0 by default, 1 for "step 1 of 5". */
  min?: number;
  /** What the bar is called to assistive technology ("Step 3 of 12"). Leave it out, with `decorative`, to hide the bar. */
  label?: string;
  ariaLabel?: string;
  decorative?: boolean;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

/** How far along: a filled track. It is information that moves often, so the fill is not animated. */
function DefaultProgressBar({ value, max, min = 0, label, ariaLabel, decorative, className, ref }: ProgressBarProps): ReactNode {
  return (
    <div
      ref={ref}
      data-slot="progress-track"
      data-kind="bar"
      className={className || undefined}
      {...(decorative
        ? { 'aria-hidden': true }
        : {
            role: 'progressbar',
            'aria-label': ariaLabel ?? label,
            'aria-valuemin': min,
            'aria-valuemax': max,
            'aria-valuenow': value,
          })}
    >
      <span data-slot="progress-indicator" style={{ width: `${max > 0 ? Math.min(100, (value / max) * 100) : 0}%` }} />
    </div>
  );
}

/** Props for the `StepHeader` wizard step heading block. */
export interface StepHeaderProps {
  title: ReactNode;
  /** The heading's level: 1 (the room's own) by default, 2 where the form sits in a dialog that has its title. */
  level?: 1 | 2;
  /** The heading's id, for a region that is named by it. */
  id?: string;
  lead?: ReactNode;
  /** A decorative glyph before the title. */
  mark?: ReactNode;
  className?: string;
  ref?: Ref<HTMLElement>;
}

/** A step's title and the quiet lead under it. */
function DefaultStepHeader({ title, lead, mark, level = 1, id, className, ref }: StepHeaderProps): ReactNode {
  const Heading = level === 1 ? 'h1' : 'h2';
  return (
    <header ref={ref} data-slot="step-header" className={className || undefined}>
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

/** Props for the `ActionBar` form footer action strip. */
export interface ActionBarProps {
  /** Another class on the bar, for the form that draws it. */
  className?: string;
  back?: { label: ReactNode; onClick: () => void; icon?: ReactNode };
  primary: { label: ReactNode; onClick: () => void; disabled?: boolean; loading?: boolean; loadingLabel?: ReactNode; icon?: ReactNode };
  ref?: Ref<HTMLElement>;
}

/** The bar fixed to the foot of its container: Back as a quiet word, and a filled primary that takes the rest of the width. */
function DefaultActionBar({ back, primary, className, ref }: ActionBarProps): ReactNode {
  return (
    <footer ref={ref} data-slot="action-bar" className={className || undefined}>
      {back ? (
        <Button variant="ghost" size="lg" onClick={back.onClick}>
          {back.icon}
          {back.label}
        </Button>
      ) : null}
      <Button
        variant="primary"
        size="lg"
        disabled={primary.disabled}
        loading={primary.loading}
        loadingLabel={primary.loadingLabel}
        onClick={primary.onClick}
      >
        {primary.label}
        {primary.icon}
      </Button>
    </footer>
  );
}

/** Props for the `Columns` responsive form column layout. */
export interface ColumnsProps {
  cols?: string;
  children: ReactNode;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

/** Fields side by side; `cols` is a grid template such as "1fr 1.8fr". */
function DefaultColumns({ cols, children, className, ref }: ColumnsProps): ReactNode {
  return (
    <div
      ref={ref}
      data-slot="columns"
      data-kind={cols ? 'template' : undefined}
      className={className || undefined}
      style={cols ? ({ '--form-columns': cols } as CSSProperties) : undefined}
    >
      {children}
    </div>
  );
}

/** Props for the `ReviewList` labelled form summary group. */
export interface ReviewListProps {
  label: string;
  children: ReactNode;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

/** The editable review: earlier steps' fields drawn again in one labelled group. */
function DefaultReviewList({ label, children, className, ref }: ReviewListProps): ReactNode {
  return (
    <div ref={ref} data-slot="review-list" data-kind="group" role="group" aria-label={label} className={className || undefined}>
      {children}
    </div>
  );
}

export { HelpTip };

/** Static linear progress bar for multi-step forms and completion ratios. */
export const ProgressBar = slotted('ProgressBar', DefaultProgressBar);

/** Focusable step heading with optional lead subtitle and decorative mark. */
export const StepHeader = slotted('StepHeader', DefaultStepHeader);

/** Sticky or bottom-anchored form footer pairing a quiet Back action with a primary submit button. */
export const ActionBar = slotted('ActionBar', DefaultActionBar);

/** Responsive multi-column grid container for adjacent form fields. */
export const Columns = slotted('Columns', DefaultColumns);

/** Accessible labelled group for reviewing and editing earlier form step answers. */
export const ReviewList = slotted('ReviewList', DefaultReviewList);
