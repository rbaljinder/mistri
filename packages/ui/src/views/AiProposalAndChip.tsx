/** AI copilot data models, field-diff proposal cards, and inline decision chips. */
'use client';

import { type ComponentProps, type ReactNode, type Ref, useState } from 'react';
import { Icon } from '../Icon.js';
import { cx } from '../internal/cx.js';
import { Button } from '../primitives/actions.js';
import { AiBadge, Badge } from '../primitives/display.js';
import { Popover } from '../primitives/overlays.js';

/* ============================================================================
 * Types & Models
 * ========================================================================== */

/** Identifier string for an AI model option in `AiAssistantView`. */
export type AiModelId = 'claude-sonnet' | 'gemini-pro' | 'gpt-5' | (string & {});

/** Selectable AI model descriptor in `AiAssistantView`. */
export interface AiModelOption {
  value: string;
  label: string;
  provider?: string;
  badge?: string;
}

/** Execution lifecycle status of an `AiToolCall`. */
export type AiToolCallStatus = 'running' | 'done' | 'error';

/** Tool invocation trace rendered inside an assistant `AiMessage`. */
export interface AiToolCall {
  id: string;
  name: string;
  status: AiToolCallStatus;
  summary?: string;
  durationMs?: number;
  query?: string;
  output?: string;
}

/** Source citation chip attached to an assistant `AiMessage`. */
export interface AiCitation {
  id: string;
  label: string;
  source?: string;
  href?: string;
  snippet?: string;
}

/** Proposed field value change in an `AiProposalCard`. */
export interface AiFieldChange {
  field: string;
  from?: string;
  to: string;
}

/** Supporting evidence entry displayed on an `AiProposalCard`. */
export interface AiEvidenceItem {
  id?: string;
  label: string;
  detail?: string;
}

/** Review status of an `AiProposalCard`. */
export type AiProposalStatus = 'pending' | 'accepted' | 'dismissed';

/** Structured record-mutation proposal payload attached to an `AiMessage`. */
export interface AiProposalData {
  id: string;
  title: ReactNode;
  targetLabel?: string;
  changes: ReadonlyArray<AiFieldChange>;
  confidence?: number | string;
  rationale?: ReactNode;
  evidence?: ReadonlyArray<string | AiEvidenceItem>;
  status?: AiProposalStatus;
}

/** Pinned context entity attached to an assistant conversation or composer. */
export interface AiContextAttachment {
  id: string;
  label: string;
  kind?: 'table' | 'record' | 'file' | 'query';
  detail?: string;
}

/** Suggested starter prompt card shown in an empty `AiAssistantView`. */
export interface AiStarterPrompt {
  id: string;
  title: string;
  prompt: string;
  category?: string;
  icon?: ReactNode;
}

/** Author role of an `AiMessage` in `AiAssistantView`. */
export type AiMessageRole = 'user' | 'assistant';

/** Reasoning effort level supported by an assistant model. */
export type AiEffortLevel = 'low' | 'medium' | 'high';

/** Presentation surface mode for `AiAssistantSurface` and `AiAssistantPanel`. */
export type AiPresentationMode = 'inline' | 'sidebar' | 'floating' | 'fullscreen' | 'page';

/** Model reasoning / thinking trace attached to an assistant `AiMessage`. */
export interface AiReasoningTrace {
  id: string;
  text: string;
  streaming?: boolean;
  durationMs?: number;
  redacted?: boolean;
  summary?: string;
}

/** Structured generative UI block rendered inside an assistant `AiMessage`. */
export interface AiGeneratedBlock {
  id: string;
  kind: string;
  title?: string;
  status?: 'loading' | 'ready' | 'error';
  payload?: unknown;
}

/** Conversation message entry rendered in `AiAssistantView`. */
export interface AiMessage {
  id: string;
  role: AiMessageRole;
  content: ReactNode;
  plainText?: string;
  timestamp?: string;
  model?: string;
  streaming?: boolean;
  context?: ReadonlyArray<AiContextAttachment>;
  reasoning?: AiReasoningTrace | ReadonlyArray<AiReasoningTrace>;
  toolCalls?: ReadonlyArray<AiToolCall>;
  blocks?: ReadonlyArray<AiGeneratedBlock>;
  citations?: ReadonlyArray<AiCitation>;
  proposals?: ReadonlyArray<AiProposalData>;
}

/* ============================================================================
 * Formatting Helpers
 * ========================================================================== */

function formatConfidenceLabel(confidence: number | string | undefined): string | null {
  if (confidence === undefined || confidence === null || confidence === '') return null;
  if (typeof confidence === 'string') {
    return confidence.includes('%') || confidence.toLowerCase().includes('match') ? confidence : `${confidence}% match`;
  }
  const pct = confidence <= 1 && confidence > 0 ? Math.round(confidence * 100) : Math.round(confidence);
  return `${pct}% match`;
}

/* ============================================================================
 * 1. AiProposalCard
 * ========================================================================== */

/** Props for the `AiProposalCard` component. */
export interface AiProposalCardProps extends Omit<ComponentProps<'div'>, 'id' | 'title' | 'onChange' | 'aria-label' | 'inlist'> {
  id?: string;
  title: ReactNode;
  targetLabel?: string;
  changes: ReadonlyArray<AiFieldChange>;
  confidence?: number | string;
  rationale?: ReactNode;
  evidence?: ReadonlyArray<string | AiEvidenceItem>;
  status?: AiProposalStatus;
  defaultStatus?: AiProposalStatus;
  acceptLabel?: string;
  dismissLabel?: string;
  allowUndo?: boolean;
  ariaLabel?: string;
  onAccept?: (id?: string) => void;
  onDismiss?: (id?: string) => void;
  onUndo?: (id?: string) => void;
}

/** AI field-diff proposal review card with confidence badge, evidence pills, and accept/dismiss/undo actions. */
export function AiProposalCard({
  id,
  title,
  targetLabel,
  changes,
  confidence,
  rationale,
  evidence,
  status,
  defaultStatus = 'pending',
  acceptLabel = 'Accept',
  dismissLabel = 'Dismiss',
  allowUndo = true,
  ariaLabel,
  onAccept,
  onDismiss,
  onUndo,
  className,
  ...props
}: AiProposalCardProps) {
  const legacyAriaLabel = (props as Record<string, unknown>)['aria-label'] as string | undefined;
  const [internalStatus, setInternalStatus] = useState<AiProposalStatus>(defaultStatus);
  const currentStatus = status ?? internalStatus;
  const confidenceText = formatConfidenceLabel(confidence);

  const handleAccept = () => {
    if (status === undefined) setInternalStatus('accepted');
    onAccept?.(id);
  };

  const handleDismiss = () => {
    if (status === undefined) setInternalStatus('dismissed');
    onDismiss?.(id);
  };

  const handleUndo = () => {
    if (status === undefined) setInternalStatus('pending');
    onUndo?.(id);
  };

  return (
    <div
      aria-label={ariaLabel ?? legacyAriaLabel}
      data-slot="ai-proposal-card"
      data-status={currentStatus}
      className={cx('nx-ai-proposal', className)}
      {...props}
    >
      <div className="nx-ai-proposal-head">
        <div className="nx-ai-proposal-title-row">
          <AiBadge label="Proposal" />
          {targetLabel ? <span className="nx-ai-proposal-target">{targetLabel}</span> : null}
          <h4 className="nx-ai-proposal-title">{title}</h4>
        </div>
        <div className="nx-ai-proposal-meta">
          {confidenceText ? (
            <Badge tone={currentStatus === 'accepted' ? 'good' : 'accent'} pill>
              {confidenceText}
            </Badge>
          ) : null}
        </div>
      </div>

      {rationale !== undefined && currentStatus !== 'dismissed' ? <p className="nx-ai-proposal-rationale">{rationale}</p> : null}

      {changes.length > 0 && currentStatus !== 'dismissed' ? (
        <div className="nx-ai-proposal-changes" role="list" aria-label="Proposed field mutations">
          {changes.map((change, idx) => (
            <div key={`${change.field}-${idx}`} role="listitem" className="nx-ai-diff-row">
              <span className="nx-ai-diff-field">{change.field}</span>
              <div className="nx-ai-diff-values">
                <span className="nx-ai-diff-from" data-empty={change.from === undefined ? '' : undefined}>
                  {change.from ?? 'unset'}
                </span>
                <Icon name="arrow-right" size={12} weight="bold" className="nx-ai-diff-arrow" />
                <span className="nx-ai-diff-to" data-accepted={currentStatus === 'accepted' ? '' : undefined}>
                  {change.to}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {evidence && evidence.length > 0 && currentStatus !== 'dismissed' ? (
        <div className="nx-ai-proposal-evidence">
          <span className="nx-ai-evidence-label">Evidence</span>
          <div className="nx-ai-evidence-pills">
            {evidence.map((item, idx) => {
              const normalized: AiEvidenceItem = typeof item === 'string' ? { label: item } : item;
              return (
                <span key={normalized.id ?? `${normalized.label}-${idx}`} title={normalized.detail} className="nx-ai-evidence-pill">
                  <Icon name="file-text" size={11} />
                  <span>{normalized.label}</span>
                  {normalized.detail ? <span className="nx-ai-evidence-detail">{normalized.detail}</span> : null}
                </span>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="nx-ai-proposal-footer">
        {currentStatus === 'pending' ? (
          <>
            <span className="nx-ai-proposal-hint">
              {changes.length} {changes.length === 1 ? 'field mutation' : 'field mutations'} staged
            </span>
            <div className="nx-ai-proposal-actions">
              <Button variant="ghost" size="xs" onClick={handleDismiss}>
                {dismissLabel}
              </Button>
              <Button variant="primary" size="xs" leadingIcon={<Icon name="check" size={12} weight="bold" />} onClick={handleAccept}>
                {acceptLabel}
              </Button>
            </div>
          </>
        ) : currentStatus === 'accepted' ? (
          <>
            <span className="nx-ai-proposal-state" data-tone="good">
              <Icon name="check-circle" size={14} weight="bold" />
              <span>Changes accepted &amp; applied</span>
            </span>
            {allowUndo ? (
              <Button variant="ghost" size="xs" leadingIcon={<Icon name="arrow-counter-clockwise" size={12} />} onClick={handleUndo}>
                Undo
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <span className="nx-ai-proposal-state" data-tone="muted">
              <Icon name="x" size={13} weight="bold" />
              <span>Proposal dismissed</span>
            </span>
            {allowUndo ? (
              <Button variant="ghost" size="xs" onClick={handleUndo}>
                Restore
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/* ============================================================================
 * 2. DecisionChip (Inline AI Provenance Chip + Popover)
 * ========================================================================== */

/** Review state of an inline `DecisionChip`. */
export type DecisionChipStatus = 'suggested' | 'accepted' | 'reverted';

/** Props for the `DecisionChip` component. */
export interface DecisionChipProps {
  value: ReactNode;
  previousValue?: ReactNode;
  field?: string;
  confidence?: number | string;
  reason: ReactNode;
  model?: string;
  source?: string;
  status?: DecisionChipStatus;
  defaultStatus?: DecisionChipStatus;
  onAccept?: () => void;
  onRevert?: () => void;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
}

/** Inline AI provenance chip that opens a rationale and accept/revert popover. */
export function DecisionChip({
  value,
  previousValue,
  field,
  confidence,
  reason,
  model,
  source,
  status,
  defaultStatus = 'suggested',
  onAccept,
  onRevert,
  className,
  ref,
}: DecisionChipProps) {
  const [open, setOpen] = useState(false);
  const [internalStatus, setInternalStatus] = useState<DecisionChipStatus>(defaultStatus);
  const currentStatus = status ?? internalStatus;
  const confidenceLabel = formatConfidenceLabel(confidence);

  const displayedValue = currentStatus === 'reverted' && previousValue !== undefined ? previousValue : value;

  const handleAccept = () => {
    if (status === undefined) setInternalStatus('accepted');
    onAccept?.();
    setOpen(false);
  };

  const handleRevert = () => {
    if (status === undefined) setInternalStatus('reverted');
    onRevert?.();
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="start"
      sideOffset={6}
      className="nx-decision-popover"
      trigger={
        <button
          ref={ref}
          type="button"
          data-slot="decision-chip"
          data-status={currentStatus}
          className={cx('nx-decision-chip nx-focusable', className)}
        >
          <span className="nx-decision-chip-icon" aria-hidden="true">
            {currentStatus === 'accepted' ? (
              <Icon name="check" size={11.5} weight="bold" />
            ) : currentStatus === 'reverted' ? (
              <Icon name="arrow-counter-clockwise" size={11.5} weight="bold" />
            ) : (
              <Icon name="sparkle" size={11.5} weight="bold" />
            )}
          </span>
          <span className="nx-decision-chip-value">{displayedValue}</span>
          {confidenceLabel && currentStatus === 'suggested' ? (
            <span className="nx-decision-chip-conf">{confidenceLabel.replace(' match', '')}</span>
          ) : null}
        </button>
      }
    >
      <div className="nx-decision-card">
        <div className="nx-decision-card-head">
          <div className="nx-decision-card-badges">
            {model ? <AiBadge label={model} /> : null}
            {field ? <span className="nx-decision-field">{field}</span> : null}
          </div>
          {confidenceLabel ? (
            <Badge tone={currentStatus === 'accepted' ? 'good' : currentStatus === 'reverted' ? 'neutral' : 'accent'} pill>
              {confidenceLabel}
            </Badge>
          ) : null}
        </div>

        <div className="nx-decision-card-body">
          <div className="nx-decision-reason-label">Why this was suggested</div>
          <p className="nx-decision-reason-copy">{reason}</p>

          {previousValue !== undefined ? (
            <div className="nx-decision-comparison">
              <span className="nx-ai-diff-from">{previousValue}</span>
              <Icon name="arrow-right" size={11} weight="bold" className="nx-ai-diff-arrow" />
              <span className="nx-ai-diff-to">{value}</span>
            </div>
          ) : null}

          {source ? (
            <div className="nx-decision-source">
              <Icon name="database" size={11.5} />
              <span>Source: {source}</span>
            </div>
          ) : null}
        </div>

        <div className="nx-decision-card-footer">
          <span className="nx-decision-status-note">
            {currentStatus === 'accepted'
              ? 'Accepted by user'
              : currentStatus === 'reverted'
                ? 'Reverted to prior value'
                : 'AI suggested value'}
          </span>
          <div className="nx-decision-card-actions">
            <Button
              variant="ghost"
              size="xs"
              leadingIcon={<Icon name="arrow-counter-clockwise" size={12} />}
              disabled={currentStatus === 'reverted'}
              onClick={handleRevert}
            >
              Revert
            </Button>
            <Button
              variant="primary"
              size="xs"
              leadingIcon={<Icon name="check" size={12} weight="bold" />}
              disabled={currentStatus === 'accepted'}
              onClick={handleAccept}
            >
              Accept
            </Button>
          </div>
        </div>
      </div>
    </Popover>
  );
}
