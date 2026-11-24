/**
 * Collapsible first-run setup checklists and step-by-step spotlight tours for
 * workspace onboarding.
 */
'use client';

import { type ComponentProps, type ReactNode, useMemo, useState } from 'react';
import { Icon } from '../Icon.js';
import { cx } from '../internal/cx.js';
import { Button } from '../primitives/actions.js';
import { Badge } from '../primitives/display.js';
import { Popover } from '../primitives/overlays.js';

/* ============================================================================
 * 7. OnboardingChecklist (Collapsible First-Run Checklist + SVG Progress Ring)
 * ========================================================================== */

/** Setup task step rendered in `OnboardingChecklist`. */
export interface OnboardingStep {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  completed?: boolean;
  estimatedTime?: string;
  actionLabel?: string;
  detailNote?: ReactNode;
}

/** Props for the `OnboardingChecklist` component. */
export interface OnboardingChecklistProps extends Omit<ComponentProps<'section'>, 'title' | 'onChange' | 'aria-label' | 'inlist'> {
  title?: ReactNode;
  subtitle?: ReactNode;
  steps?: ReadonlyArray<OnboardingStep>;
  completedIds?: ReadonlyArray<string>;
  defaultCompletedIds?: ReadonlyArray<string>;
  collapsed?: boolean;
  defaultCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  dismissed?: boolean;
  ariaLabel?: string;
  onToggleStep?: (stepId: string, completed: boolean) => void;
  onStepAction?: (stepId: string) => void;
  onDismiss?: () => void;
}

const EMPTY_ONBOARDING_STEPS: ReadonlyArray<OnboardingStep> = [];

/** Collapsible first-run setup checklist card with circular progress ring and expandable step actions. */
export function OnboardingChecklist({
  title = 'Getting started',
  subtitle,
  steps = EMPTY_ONBOARDING_STEPS,
  completedIds,
  defaultCompletedIds,
  collapsed,
  defaultCollapsed = false,
  onCollapsedChange,
  dismissed,
  ariaLabel,
  onToggleStep,
  onStepAction,
  onDismiss,
  className,
  ...props
}: OnboardingChecklistProps) {
  const legacyAriaLabel = (props as Record<string, unknown>)['aria-label'] as string | undefined;
  const [internalCompleted, setInternalCompleted] = useState<Set<string>>(() => {
    if (defaultCompletedIds) return new Set(defaultCompletedIds);
    return new Set(steps.filter((s) => s.completed).map((s) => s.id));
  });
  const [internalCollapsed, setInternalCollapsed] = useState(defaultCollapsed);
  const [internalDismissed, setInternalDismissed] = useState(false);
  const [expandedStepId, setExpandedStepId] = useState<string | null>(() => {
    const firstIncomplete = steps.find((s) => !s.completed);
    return firstIncomplete?.id ?? steps[0]?.id ?? null;
  });

  const isDismissed = dismissed ?? internalDismissed;
  const isCollapsed = collapsed ?? internalCollapsed;

  const activeCompletedSet = useMemo(() => (completedIds ? new Set(completedIds) : internalCompleted), [completedIds, internalCompleted]);

  if (isDismissed) return null;

  const totalCount = steps.length;
  const completedCount = steps.filter((s) => activeCompletedSet.has(s.id)).length;
  const progressRatio = totalCount > 0 ? completedCount / totalCount : 0;
  const allComplete = totalCount > 0 && completedCount === totalCount;

  /* Circular SVG Ring geometry (r = 13 -> circumference ≈ 81.68) */
  const radius = 13;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - progressRatio);

  const toggleCollapse = () => {
    const next = !isCollapsed;
    if (collapsed === undefined) setInternalCollapsed(next);
    onCollapsedChange?.(next);
  };

  const handleToggleStep = (stepId: string) => {
    const nextCompleted = !activeCompletedSet.has(stepId);
    if (completedIds === undefined) {
      setInternalCompleted((prev) => {
        const clone = new Set(prev);
        if (nextCompleted) {
          clone.add(stepId);
        } else {
          clone.delete(stepId);
        }
        return clone;
      });
    }
    onToggleStep?.(stepId, nextCompleted);
  };

  const handleDismiss = () => {
    if (dismissed === undefined) setInternalDismissed(true);
    onDismiss?.();
  };

  return (
    <section
      aria-label={ariaLabel ?? legacyAriaLabel}
      data-slot="onboarding-checklist"
      data-complete={allComplete ? '' : undefined}
      className={cx('nx-checklist-card', className)}
      {...props}
    >
      <div className="nx-checklist-header">
        <button type="button" aria-expanded={!isCollapsed} onClick={toggleCollapse} className="nx-checklist-header-main nx-focusable">
          {/* SVG Circular Progress Ring */}
          <span className="nx-checklist-ring-wrap" aria-hidden="true">
            <svg width="34" height="34" viewBox="0 0 34 34" className="nx-checklist-ring-svg">
              <circle cx="17" cy="17" r={radius} strokeWidth="3" fill="none" className="nx-checklist-ring-track" />
              <circle
                cx="17"
                cy="17"
                r={radius}
                strokeWidth="3"
                fill="none"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
                transform="rotate(-90 17 17)"
                className="nx-checklist-ring-fill"
              />
            </svg>
            <span className="nx-checklist-ring-center">
              {allComplete ? <Icon name="check" size={12} weight="bold" /> : `${Math.round(progressRatio * 100)}%`}
            </span>
          </span>

          <div className="nx-checklist-titles">
            <div className="nx-checklist-title-row">
              <h3 className="nx-checklist-title">{title}</h3>
              <span className="nx-checklist-progress-pill">
                {completedCount} of {totalCount} completed
              </span>
            </div>
            {subtitle ? <p className="nx-checklist-subtitle">{subtitle}</p> : null}
          </div>

          <span className="nx-checklist-chevron" aria-hidden="true">
            {isCollapsed ? <Icon name="caret-right" size={14} /> : <Icon name="caret-down" size={14} />}
          </span>
        </button>

        <Button variant="ghost" size="xs" onClick={handleDismiss}>
          Dismiss
        </Button>
      </div>

      {!isCollapsed && steps.length > 0 ? (
        <div className="nx-checklist-steps" role="list">
          {steps.map((step) => {
            const isDone = activeCompletedSet.has(step.id);
            const isExpanded = expandedStepId === step.id;

            return (
              <div
                key={step.id}
                role="listitem"
                data-completed={isDone ? '' : undefined}
                data-expanded={isExpanded ? '' : undefined}
                className="nx-checklist-step"
              >
                <div className="nx-checklist-step-row">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={isDone}
                    aria-label={`Mark "${typeof step.title === 'string' ? step.title : step.id}" as ${isDone ? 'incomplete' : 'complete'}`}
                    onClick={() => handleToggleStep(step.id)}
                    className="nx-checklist-check nx-focusable"
                  >
                    {isDone ? <Icon name="check" size={11.5} weight="bold" /> : null}
                  </button>

                  <button
                    type="button"
                    aria-expanded={isExpanded}
                    onClick={() => setExpandedStepId((current) => (current === step.id ? null : step.id))}
                    className="nx-checklist-step-trigger nx-focusable"
                  >
                    <span className="nx-checklist-step-title">{step.title}</span>
                    {step.estimatedTime && !isDone ? <span className="nx-checklist-step-time">{step.estimatedTime}</span> : null}
                    <span className="nx-checklist-step-caret" aria-hidden="true">
                      {isExpanded ? <Icon name="caret-down" size={12} /> : <Icon name="caret-right" size={12} />}
                    </span>
                  </button>
                </div>

                {isExpanded && (step.description || (!isDone && step.actionLabel)) ? (
                  <div className="nx-checklist-step-body">
                    {step.description ? <p className="nx-checklist-step-desc">{step.description}</p> : null}
                    {step.detailNote ? <div className="nx-checklist-step-note">{step.detailNote}</div> : null}
                    {!isDone && step.actionLabel ? (
                      <div className="nx-checklist-step-cta">
                        <Button
                          variant="primary"
                          size="xs"
                          trailingIcon={<Icon name="arrow-right" size={11.5} weight="bold" />}
                          onClick={() => {
                            onStepAction?.(step.id);
                            handleToggleStep(step.id);
                          }}
                        >
                          {step.actionLabel}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

/* ============================================================================
 * 8. SpotlightTour (Guided Multi-Step Feature Spotlight Card / Popover)
 * ========================================================================== */

/** Step card descriptor in `SpotlightTour`. */
export interface SpotlightTourStep {
  id: string;
  title: ReactNode;
  description: ReactNode;
  badge?: string;
  shortcut?: string;
  targetLabel?: string;
  media?: ReactNode;
}

/** Props for the `SpotlightTour` component. */
export interface SpotlightTourProps extends Omit<ComponentProps<'div'>, 'title' | 'onChange' | 'aria-label' | 'inlist'> {
  steps?: ReadonlyArray<SpotlightTourStep>;
  step?: number;
  defaultStep?: number;
  onStepChange?: (stepIndex: number) => void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  allowRestart?: boolean;
  ariaLabel?: string;
  onFinish?: () => void;
  onSkip?: () => void;
}

const EMPTY_TOUR_STEPS: ReadonlyArray<SpotlightTourStep> = [];

/** Guided multi-step feature spotlight card or anchored popover tour. */
export function SpotlightTour({
  steps = EMPTY_TOUR_STEPS,
  step,
  defaultStep = 0,
  onStepChange,
  open,
  defaultOpen = true,
  onOpenChange,
  trigger,
  side = 'bottom',
  align = 'start',
  allowRestart = false,
  ariaLabel,
  onFinish,
  onSkip,
  className,
  ...props
}: SpotlightTourProps) {
  const legacyAriaLabel = (props as Record<string, unknown>)['aria-label'] as string | undefined;
  const [internalStep, setInternalStep] = useState(defaultStep);
  const [internalOpen, setInternalOpen] = useState(defaultOpen);

  const isOpen = open ?? internalOpen;
  const total = steps.length;
  const activeIdx = total > 0 ? Math.max(0, Math.min(total - 1, step ?? internalStep)) : 0;
  const currentStep = steps[activeIdx];
  const isLast = activeIdx >= total - 1;

  const goToStep = (nextIdx: number) => {
    const clamped = Math.max(0, Math.min(total - 1, nextIdx));
    if (step === undefined) setInternalStep(clamped);
    onStepChange?.(clamped);
  };

  const setOpenState = (nextOpen: boolean) => {
    if (open === undefined) setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };

  const handleSkip = () => {
    setOpenState(false);
    onSkip?.();
  };

  const handleNextOrFinish = () => {
    if (isLast) {
      setOpenState(false);
      onFinish?.();
    } else {
      goToStep(activeIdx + 1);
    }
  };

  if (total === 0 || !currentStep) return null;

  if (!isOpen && trigger === undefined) {
    if (!allowRestart) return null;
    return (
      <div className="nx-tour-restart-bar">
        <Icon name="compass" size={14} />
        <span>Feature spotlight completed</span>
        <Button
          variant="soft"
          size="xs"
          onClick={() => {
            goToStep(0);
            setOpenState(true);
          }}
        >
          Restart tour
        </Button>
      </div>
    );
  }

  const cardInner = (
    <div aria-label={ariaLabel ?? legacyAriaLabel} data-slot="spotlight-tour" className={cx('nx-tour-card', className)} {...props}>
      <div className="nx-tour-top">
        <div className="nx-tour-badges">
          <span className="nx-tour-beacon" aria-hidden="true">
            <Icon name="sparkle" size={11} weight="bold" />
          </span>
          {currentStep.badge ? (
            <Badge tone="accent" pill>
              {currentStep.badge}
            </Badge>
          ) : null}
          {currentStep.targetLabel ? <code className="nx-tour-target">{currentStep.targetLabel}</code> : null}
          {currentStep.shortcut ? <kbd className="nx-kbd">{currentStep.shortcut}</kbd> : null}
        </div>

        <button type="button" onClick={handleSkip} className="nx-tour-skip nx-focusable">
          Skip tour
        </button>
      </div>

      {currentStep.media ? <div className="nx-tour-media">{currentStep.media}</div> : null}

      <div className="nx-tour-body">
        <h4 className="nx-tour-title">{currentStep.title}</h4>
        <p className="nx-tour-description">{currentStep.description}</p>
      </div>

      <div className="nx-tour-footer">
        <div className="nx-tour-progress">
          <div className="nx-tour-dots" role="tablist" aria-label="Tour steps">
            {steps.map((s, idx) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={idx === activeIdx}
                aria-label={`Step ${idx + 1}: ${typeof s.title === 'string' ? s.title : s.id}`}
                data-active={idx === activeIdx ? '' : undefined}
                data-visited={idx < activeIdx ? '' : undefined}
                onClick={() => goToStep(idx)}
                className="nx-tour-dot nx-focusable"
              />
            ))}
          </div>
          <span className="nx-tour-counter">
            {activeIdx + 1} / {total}
          </span>
        </div>

        <div className="nx-tour-actions">
          <Button variant="ghost" size="xs" disabled={activeIdx === 0} onClick={() => goToStep(activeIdx - 1)}>
            Previous
          </Button>
          <Button
            variant="primary"
            size="xs"
            trailingIcon={isLast ? <Icon name="check" size={12} weight="bold" /> : <Icon name="arrow-right" size={12} weight="bold" />}
            onClick={handleNextOrFinish}
          >
            {isLast ? 'Finish' : 'Next'}
          </Button>
        </div>
      </div>
    </div>
  );

  if (trigger !== undefined) {
    return (
      <Popover
        open={isOpen}
        onOpenChange={setOpenState}
        trigger={trigger}
        side={side}
        align={align}
        sideOffset={8}
        arrow
        className="nx-tour-popover"
      >
        {cardInner}
      </Popover>
    );
  }

  return cardInner;
}
