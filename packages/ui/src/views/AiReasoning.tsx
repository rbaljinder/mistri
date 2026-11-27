/** Collapsible AI reasoning / thinking trace built on UI SDK Collapsible and ScrollArea. */
'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../Icon.js';
import { cx } from '../internal/cx.js';
import { Collapsible } from '../primitives/layout.js';
import { ScrollArea } from '../ScrollArea.js';
import type { AiReasoningTrace } from './AiProposalAndChip.js';

/** Localized strings for `AiReasoning`. */
export interface AiReasoningWords {
  thinking?: string;
  thought?: string;
  thoughtFor?: (duration: string) => string;
  redacted?: string;
  regionLabel?: string;
}

const DEFAULT_WORDS: Required<AiReasoningWords> = {
  thinking: 'Thinking…',
  thought: 'Reasoning',
  thoughtFor: (duration) => `Thought for ${duration}`,
  redacted: 'Reasoning hidden by model provider.',
  regionLabel: 'Model reasoning',
};

function formatReasoningDuration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Props for the `AiReasoning` collapsible reasoning surface. */
export interface AiReasoningProps {
  /** Reasoning text to display when rendering a single trace directly. */
  text?: string;
  /** Structured trace object (alternative to passing `text` / `streaming` / `durationMs`). */
  trace?: AiReasoningTrace;
  /** Whether reasoning tokens are still arriving. */
  streaming?: boolean;
  /** Elapsed thinking time in milliseconds. */
  durationMs?: number;
  /** Provider returned redacted thinking content. */
  redacted?: boolean;
  /** Optional short summary label shown in the collapsed header. */
  summary?: string;
  /** Controlled open state. */
  open?: boolean;
  /** Uncontrolled initial open state (defaults to open while streaming when `defaultOpen` is omitted? False by default to stay quiet). */
  defaultOpen?: boolean;
  /** Called whenever the disclosure opens or closes. */
  onOpenChange?: (open: boolean) => void;
  /** Collapse automatically once `streaming` finishes unless the reader toggled it by hand. */
  autoCollapse?: boolean;
  /** Maximum height of the expanded reasoning scroll region. */
  maxHeight?: string;
  /** Localized strings overriding English defaults. */
  words?: AiReasoningWords;
  className?: string;
}

/** Quiet, token-styled collapsible reasoning / thinking trace over UI SDK Collapsible and ScrollArea. */
export function AiReasoning({
  text: textProp,
  trace,
  streaming: streamingProp,
  durationMs: durationProp,
  redacted: redactedProp,
  summary: summaryProp,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  autoCollapse = true,
  maxHeight = '14rem',
  words: givenWords,
  className,
}: AiReasoningProps) {
  const words = { ...DEFAULT_WORDS, ...givenWords };
  const text = trace?.text ?? textProp ?? '';
  const streaming = trace?.streaming ?? streamingProp ?? false;
  const durationMs = trace?.durationMs ?? durationProp;
  const redacted = trace?.redacted ?? redactedProp ?? false;
  const summary = trace?.summary ?? summaryProp;

  const [internalOpen, setInternalOpen] = useState<boolean>(defaultOpen);
  const userToggledRef = useRef(false);
  const wasStreamingRef = useRef(streaming);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const isOpen = controlledOpen ?? internalOpen;

  /* When a live reasoning trace finishes streaming, quietly fold it back unless the reader opened or closed it by hand. */
  useEffect(() => {
    if (autoCollapse && wasStreamingRef.current && !streaming && !userToggledRef.current) {
      if (controlledOpen === undefined) setInternalOpen(false);
      onOpenChange?.(false);
    }
    wasStreamingRef.current = streaming;
  }, [autoCollapse, streaming, controlledOpen, onOpenChange]);

  /* Keep the newest reasoning lines in view while streaming into an open pane. */
  useLayoutEffect(() => {
    if (!isOpen || !streaming) return;
    const viewport = bodyRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [isOpen, streaming, text]);

  const durationText = formatReasoningDuration(durationMs);
  const heading = summary ? summary : streaming ? words.thinking : durationText ? words.thoughtFor(durationText) : words.thought;

  const handleOpenChange = (next: boolean) => {
    userToggledRef.current = true;
    if (controlledOpen === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };

  if (redacted && !text.trim()) {
    return (
      <div data-slot="ai-reasoning" data-redacted="" className={cx('nx-ai-reasoning nx-ai-reasoning-redacted', className)}>
        <span className="nx-ai-reasoning-head">
          <Icon name="brain" size={13} className="nx-ai-reasoning-icon" />
          <span className="nx-ai-reasoning-label">{words.redacted}</span>
          {durationText ? <span className="nx-ai-reasoning-duration">{durationText}</span> : null}
        </span>
      </div>
    );
  }

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cx('nx-ai-reasoning', className)}
      data-slot="ai-reasoning"
      data-streaming={streaming ? '' : undefined}
    >
      <Collapsible.Trigger className="nx-ai-reasoning-trigger nx-focusable">
        <span className="nx-ai-reasoning-chevron" aria-hidden="true">
          {isOpen ? <Icon name="caret-down" size={11.5} /> : <Icon name="caret-right" size={11.5} />}
        </span>
        <Icon name="brain" size={13} className="nx-ai-reasoning-icon" />
        <span className="nx-ai-reasoning-label" aria-live={streaming ? 'polite' : undefined}>
          {heading}
        </span>
        {!streaming && durationText && summary ? <span className="nx-ai-reasoning-duration">{durationText}</span> : null}
      </Collapsible.Trigger>
      <Collapsible.Panel className="nx-ai-reasoning-panel">
        <div ref={bodyRef} className="nx-ai-reasoning-body-wrap">
          <ScrollArea ariaLabel={words.regionLabel} maxHeight={maxHeight} className="nx-ai-reasoning-scroll">
            <div className="nx-ai-reasoning-body">
              {text}
              {redacted ? <p className="nx-ai-reasoning-redacted-note">{words.redacted}</p> : null}
            </div>
          </ScrollArea>
        </div>
      </Collapsible.Panel>
    </Collapsible>
  );
}
