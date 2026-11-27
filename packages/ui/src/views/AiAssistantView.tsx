/** Conversational AI copilot prompt composer and streaming assistant thread panel with tool-call traces and citations. */
'use client';

import {
  type ComponentProps,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Icon } from '../Icon.js';
import { cx, isEmptyStateSpec, type EmptyStateSpec } from '../internal/cx.js';
import { Button, IconButton } from '../primitives/actions.js';
import { SkeletonCard } from '../primitives/feedback.js';
import { Collapsible } from '../primitives/layout.js';
import { Popover } from '../primitives/overlays.js';
import { Select, type SelectOption } from '../primitives/selection.js';
import { AiModeSwitcher, type AiSurfaceWords } from './AiAssistantSurface.js';
import { AiReasoning, type AiReasoningWords } from './AiReasoning.js';
import {
  AiProposalCard,
  type AiCitation,
  type AiContextAttachment,
  type AiEffortLevel,
  type AiGeneratedBlock,
  type AiMessage,
  type AiModelOption,
  type AiPresentationMode,
  type AiReasoningTrace,
  type AiStarterPrompt,
  type AiToolCall,
} from './AiProposalAndChip.js';

function formatDurationMs(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms)) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function renderContextIcon(kind: AiContextAttachment['kind']): ReactNode {
  switch (kind) {
    case 'table':
      return <Icon name="database" size={12} weight="bold" />;
    case 'file':
      return <Icon name="file-code" size={12} weight="bold" />;
    case 'query':
      return <Icon name="terminal" size={12} weight="bold" />;
    case 'record':
    default:
      return <Icon name="hash" size={12} weight="bold" />;
  }
}

/* What is drawn as a reference inside a sentence: a mention ("@ana", "@table:orders") and a record's code ("WO-101").
   Each must stand on its own. A mention does not begin in the middle of a word, so the "@example.com" of an email
   address is not one; a code is not part of a longer hyphenated or alphanumeric name ("UTF-16LE"), and is not one of
   the standards that are written the same way: "SHA-256" and "UTF-16" were being marked up as records. */
const INLINE_MENTION = /(?<![\w.@-])@[a-zA-Z0-9_]+(?:[:.-][a-zA-Z0-9_]+)*/;
const INLINE_RECORD = /(?<![\w-])[A-Z]{2,5}-\d{2,6}(?![\w-])/;
const INLINE_TOKENS = new RegExp(`(\`[^\`]+\`|${INLINE_MENTION.source}|${INLINE_RECORD.source})`, 'g');
const STANDARD_NAMES = new Set('AES ASCII CP CRC DES ECMA ES HTTP IEEE ISO MD PKCS RFC RSA SHA SSL TLS UCS UTC UTF'.split(' '));

function renderInlineRichText(text: string): ReactNode {
  /* Split on a capturing pattern, the pieces alternate: plain text at the even places, a match at the odd ones. Only
     a match is ever dressed, so plain text that happens to begin with "@" or a backtick is left as it is. */
  const tokens = text.split(INLINE_TOKENS);
  return tokens.map((part, idx) => {
    if (!part) return null;
    const matched = idx % 2 === 1;
    if (matched && part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={idx} className="nx-ai-inline-code">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (matched && (part.startsWith('@') || !STANDARD_NAMES.has(part.slice(0, part.indexOf('-'))))) {
      return (
        <span key={idx} className="nx-ai-inline-ref">
          {part}
        </span>
      );
    }
    return <Fragment key={idx}>{part}</Fragment>;
  });
}

/* ============================================================================
 * 3. AiPromptComposer
 * ========================================================================== */

const EMPTY_CONTEXT_SUGGESTIONS: ReadonlyArray<AiContextAttachment> = [];

const EFFORT_LABELS: Record<AiEffortLevel, string> = {
  low: 'Low effort',
  medium: 'Medium effort',
  high: 'High effort',
};

/** Props for the `AiPromptComposer` component. */
export interface AiPromptComposerProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  attachments?: ReadonlyArray<AiContextAttachment>;
  defaultAttachments?: ReadonlyArray<AiContextAttachment>;
  availableContexts?: ReadonlyArray<AiContextAttachment>;
  onRemoveAttachment?: (id: string) => void;
  onAddAttachment?: (item: AiContextAttachment) => void;
  /** Selected reasoning effort level when effort selection is enabled. */
  effort?: AiEffortLevel;
  /** Offered effort levels (renders a compact effort selector in the composer bar). */
  efforts?: ReadonlyArray<AiEffortLevel>;
  onEffortChange?: (effort: AiEffortLevel) => void;
  isGenerating?: boolean;
  disabled?: boolean;
  onSubmit?: (prompt: string, attachments: AiContextAttachment[]) => void;
  onStop?: () => void;
  footerStart?: ReactNode;
  className?: string;
}

/** Multi-line AI prompt input bar with attachable workspace context pills and stop/send controls. */
export function AiPromptComposer({
  value,
  defaultValue = '',
  onValueChange,
  placeholder = 'Ask a question…',
  attachments,
  defaultAttachments = EMPTY_CONTEXT_SUGGESTIONS,
  availableContexts = EMPTY_CONTEXT_SUGGESTIONS,
  onRemoveAttachment,
  onAddAttachment,
  effort,
  efforts,
  onEffortChange,
  isGenerating = false,
  disabled = false,
  onSubmit,
  onStop,
  footerStart,
  className,
}: AiPromptComposerProps) {
  const [internalText, setInternalText] = useState(defaultValue);
  const [internalAttachments, setInternalAttachments] = useState<AiContextAttachment[]>(() => [...defaultAttachments]);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const currentText = value ?? internalText;
  const activeAttachments = useMemo(() => (attachments ? [...attachments] : internalAttachments), [attachments, internalAttachments]);

  const syncTextareaHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const nextHeight = Math.min(156, Math.max(38, el.scrollHeight));
    el.style.height = `${nextHeight}px`;
  }, []);

  useEffect(() => {
    syncTextareaHeight();
  }, [currentText, syncTextareaHeight]);

  const setText = (next: string) => {
    if (value === undefined) setInternalText(next);
    onValueChange?.(next);
  };

  const handleRemoveContext = (id: string) => {
    if (attachments === undefined) {
      setInternalAttachments((prev) => prev.filter((item) => item.id !== id));
    }
    onRemoveAttachment?.(id);
  };

  const handleAddContext = (item: AiContextAttachment) => {
    if (attachments === undefined) {
      setInternalAttachments((prev) => (prev.some((existing) => existing.id === item.id) ? prev : [...prev, item]));
    }
    onAddAttachment?.(item);
    setContextMenuOpen(false);
  };

  const triggerSubmit = () => {
    const trimmed = currentText.trim();
    if (!trimmed || disabled || isGenerating) return;
    onSubmit?.(trimmed, activeAttachments);
    setText('');
    if (textareaRef.current) {
      textareaRef.current.style.height = '38px';
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      triggerSubmit();
    }
  };

  const unattachedChoices = availableContexts.filter((candidate) => !activeAttachments.some((attached) => attached.id === candidate.id));

  return (
    <div
      data-slot="ai-prompt-composer"
      data-generating={isGenerating ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      className={cx('nx-ai-composer', className)}
    >
      {activeAttachments.length > 0 || availableContexts.length > 0 ? (
        <div className="nx-ai-composer-context">
          {activeAttachments.map((ctxItem) => (
            <span key={ctxItem.id} className="nx-ai-context-chip">
              <span className="nx-ai-context-chip-icon">{renderContextIcon(ctxItem.kind)}</span>
              <span className="nx-ai-context-chip-label">{ctxItem.label}</span>
              <button
                type="button"
                onClick={() => handleRemoveContext(ctxItem.id)}
                aria-label={`Remove ${ctxItem.label}`}
                className="nx-ai-context-chip-remove nx-focusable"
              >
                <Icon name="x" size={10.5} weight="bold" />
              </button>
            </span>
          ))}

          {availableContexts.length > 0 ? (
            <Popover
              open={contextMenuOpen}
              onOpenChange={setContextMenuOpen}
              side="top"
              align="start"
              sideOffset={6}
              className="nx-ai-context-popover"
              trigger={
                <button type="button" disabled={disabled} className="nx-ai-context-add nx-focusable">
                  <Icon name="plus" size={11} weight="bold" />
                  <span>Context</span>
                </button>
              }
            >
              <div className="nx-ai-context-menu">
                <div className="nx-ai-context-menu-title">Attach workspace context</div>
                {unattachedChoices.length === 0 ? (
                  <div className="nx-ai-context-menu-empty">All suggested items attached</div>
                ) : (
                  unattachedChoices.map((choice) => (
                    <button
                      key={choice.id}
                      type="button"
                      onClick={() => handleAddContext(choice)}
                      className="nx-ai-context-option nx-focusable"
                    >
                      <span className="nx-ai-context-option-icon">{renderContextIcon(choice.kind)}</span>
                      <span className="nx-ai-context-option-label">{choice.label}</span>
                      {choice.detail ? <span className="nx-ai-context-option-detail">{choice.detail}</span> : null}
                    </button>
                  ))
                )}
              </div>
            </Popover>
          ) : null}
        </div>
      ) : null}

      <textarea
        ref={textareaRef}
        rows={1}
        value={currentText}
        disabled={disabled}
        placeholder={placeholder}
        aria-label="Prompt input"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        className="nx-ai-composer-input"
      />

      <div className="nx-ai-composer-bar">
        <div className="nx-ai-composer-hints">
          {efforts && efforts.length > 0 ? (
            <div className="nx-ai-effort-picker">
              <Select<AiEffortLevel>
                size="xs"
                value={effort ?? efforts[0] ?? null}
                onValueChange={(next) => {
                  if (next) onEffortChange?.(next);
                }}
                options={efforts.map((level) => ({
                  value: level,
                  label: EFFORT_LABELS[level],
                  textLabel: EFFORT_LABELS[level],
                }))}
                ariaLabel="Reasoning effort"
                triggerClassName="nx-ai-effort-trigger"
              />
            </div>
          ) : null}
          {footerStart ?? (
            <span className="nx-ai-composer-shortcut">
              <kbd className="nx-kbd">↵</kbd> Send
              <span className="nx-ai-dot-sep" aria-hidden="true">
                ·
              </span>
              <kbd className="nx-kbd">⇧↵</kbd> Newline
            </span>
          )}
        </div>

        <div className="nx-ai-composer-actions">
          {isGenerating ? (
            <Button variant="secondary" size="xs" leadingIcon={<Icon name="stop" size={12} weight="bold" />} onClick={onStop}>
              Stop
            </Button>
          ) : (
            <Button
              variant="primary"
              size="xs"
              disabled={!currentText.trim() || disabled}
              trailingIcon={<Icon name="paper-plane-tilt" size={12} weight="bold" />}
              onClick={triggerSubmit}
            >
              Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================================================
 * Internal Sub-Blocks: ToolCallsAccordion & MessageItem
 * ========================================================================== */

function ToolCallSteps({ toolCalls }: { toolCalls: ReadonlyArray<AiToolCall> }) {
  const hasRunningOrError = toolCalls.some((tc) => tc.status !== 'done');
  const [groupExpanded, setGroupExpanded] = useState<boolean>(() => hasRunningOrError || toolCalls.length <= 2);
  const [expandedDetailIds, setExpandedDetailIds] = useState<Record<string, boolean>>({});

  const totalDuration = toolCalls.reduce((acc, tc) => acc + (tc.durationMs ?? 0), 0);
  const allDone = toolCalls.every((tc) => tc.status === 'done');
  const anyError = toolCalls.some((tc) => tc.status === 'error');
  const anyRunning = toolCalls.some((tc) => tc.status === 'running');

  const toggleDetail = (id: string) => {
    setExpandedDetailIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <Collapsible open={groupExpanded} onOpenChange={setGroupExpanded} className="nx-ai-tools">
      <Collapsible.Trigger className="nx-ai-tools-summary nx-focusable">
        <span className="nx-ai-tools-chevron" aria-hidden="true">
          {groupExpanded ? <Icon name="caret-down" size={11.5} /> : <Icon name="caret-right" size={11.5} />}
        </span>
        <Icon name="terminal" size={13} className="nx-ai-tools-icon" />
        <span className="nx-ai-tools-label">
          {anyRunning
            ? `Running ${toolCalls.length} ${toolCalls.length === 1 ? 'tool step' : 'tool steps'}…`
            : anyError
              ? `Executed ${toolCalls.length} ${toolCalls.length === 1 ? 'step' : 'steps'} (with error)`
              : `Executed ${toolCalls.length} ${toolCalls.length === 1 ? 'tool step' : 'tool steps'}`}
        </span>
        {allDone && totalDuration > 0 ? <span className="nx-ai-tools-duration">{formatDurationMs(totalDuration)}</span> : null}
      </Collapsible.Trigger>

      <Collapsible.Panel className="nx-ai-tools-list">
        {toolCalls.map((tc) => {
          const hasDetails = Boolean(tc.query || tc.output);
          const detailOpen = Boolean(expandedDetailIds[tc.id]);
          const durationText = formatDurationMs(tc.durationMs);

          return (
            <div key={tc.id} data-status={tc.status} className="nx-ai-tool-item">
              <div
                className={cx('nx-ai-tool-row', hasDetails && 'nx-ai-tool-row-expandable')}
                onClick={hasDetails ? () => toggleDetail(tc.id) : undefined}
              >
                <span className="nx-ai-tool-status" data-status={tc.status} aria-hidden="true">
                  {tc.status === 'running' ? (
                    <span className="nx-spinner nx-ai-tool-spinner" />
                  ) : tc.status === 'error' ? (
                    <Icon name="warning" size={13} weight="bold" />
                  ) : (
                    <Icon name="check-circle" size={13} weight="bold" />
                  )}
                </span>
                <code className="nx-ai-tool-name">{tc.name}</code>
                {tc.summary ? <span className="nx-ai-tool-summary">{tc.summary}</span> : null}
                {durationText ? <span className="nx-ai-tool-duration">{durationText}</span> : null}
                {hasDetails ? (
                  <button
                    type="button"
                    aria-expanded={detailOpen}
                    aria-label={detailOpen ? `Hide ${tc.name} payload` : `Inspect ${tc.name} payload`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleDetail(tc.id);
                    }}
                    className="nx-ai-tool-toggle nx-focusable"
                  >
                    {detailOpen ? <Icon name="caret-down" size={11} /> : <Icon name="caret-right" size={11} />}
                  </button>
                ) : null}
              </div>

              {hasDetails && detailOpen ? (
                <div className="nx-ai-tool-detail">
                  {tc.query ? <pre className="nx-ai-tool-code">{tc.query}</pre> : null}
                  {tc.output ? <div className="nx-ai-tool-output">{tc.output}</div> : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </Collapsible.Panel>
    </Collapsible>
  );
}

/* ============================================================================
 * 4. AiAssistantPanel
 * ========================================================================== */

const EMPTY_STARTER_PROMPTS: ReadonlyArray<AiStarterPrompt> = [];
const EMPTY_AI_MODELS: ReadonlyArray<AiModelOption> = [];

/** Props for the `AiAssistantPanel` component. */
export interface AiAssistantPanelProps extends Omit<ComponentProps<'section'>, 'title' | 'onChange' | 'aria-label' | 'inlist'> {
  title?: ReactNode;
  subtitle?: ReactNode;
  assistantLabel?: string;
  models?: ReadonlyArray<AiModelOption>;
  model?: string;
  defaultModel?: string;
  onModelChange?: (model: string) => void;
  /** Selected reasoning effort level when `efforts` is supplied. */
  effort?: AiEffortLevel;
  /** Offered effort levels in the composer bar. */
  efforts?: ReadonlyArray<AiEffortLevel>;
  onEffortChange?: (effort: AiEffortLevel) => void;
  /** Default reasoning trace display policy: `'collapsed'`, `'expanded'`, or `'hidden'`. */
  reasoningVisibility?: 'collapsed' | 'expanded' | 'hidden';
  /** Localized strings for `AiReasoning`. */
  reasoningWords?: AiReasoningWords;
  /** Active presentation mode (enables header mode switcher when `onPresentationChange` is set). */
  presentation?: AiPresentationMode;
  /** Presentation modes offered in the header switcher. */
  presentations?: ReadonlyArray<Exclude<AiPresentationMode, 'inline' | 'page'>>;
  onPresentationChange?: (mode: Exclude<AiPresentationMode, 'inline' | 'page'>) => void;
  restoreMode?: 'sidebar' | 'floating';
  /** Optional handler to open the dedicated full-page assistant route. */
  onOpenPage?: () => void;
  /** Optional close button handler rendered in the header. */
  onClose?: () => void;
  /** Stretch to fill its parent surface (`sidebar`, `floating`, `fullscreen`, `page`) without a fixed max-height. */
  fill?: boolean;
  /** Extra controls rendered in the panel header. */
  headerActions?: ReactNode;
  /** Localized strings for mode switcher and close buttons. */
  surfaceWords?: AiSurfaceWords;
  messages?: ReadonlyArray<AiMessage>;
  defaultMessages?: ReadonlyArray<AiMessage>;
  starterPrompts?: ReadonlyArray<AiStarterPrompt>;
  empty?: EmptyStateSpec | ReactNode;
  ariaLabel?: string;
  attachments?: ReadonlyArray<AiContextAttachment>;
  defaultAttachments?: ReadonlyArray<AiContextAttachment>;
  availableContexts?: ReadonlyArray<AiContextAttachment>;
  composerPlaceholder?: string;
  isGenerating?: boolean;
  /** Renderer for structured generative UI blocks attached to assistant messages. */
  renderBlock?: (block: AiGeneratedBlock, context: { presentation: AiPresentationMode }) => ReactNode;
  onSendMessage?: (prompt: string, context: AiContextAttachment[], model: string) => void;
  onSendPrompt?: (prompt: string, context: AiContextAttachment[], model: string) => void;
  onStopGenerating?: () => void;
  onNewThread?: () => void;
  onClear?: () => void;
  onRegenerate?: (messageId: string) => void;
  onCitationClick?: (citation: AiCitation) => void;
  onAcceptProposal?: (proposalId: string, messageId: string) => void;
  onDismissProposal?: (proposalId: string, messageId: string) => void;
}

/** Streaming conversational AI copilot panel with reasoning traces, tool-call traces, generative UI blocks, citations, and proposals. */
export function AiAssistantPanel(rawProps: AiAssistantPanelProps) {
  const {
    title = 'Assistant',
    subtitle,
    assistantLabel,
    models = EMPTY_AI_MODELS,
    model,
    defaultModel,
    onModelChange,
    effort,
    efforts,
    onEffortChange,
    reasoningVisibility = 'collapsed',
    reasoningWords,
    presentation = 'inline',
    presentations,
    onPresentationChange,
    restoreMode,
    onOpenPage,
    onClose,
    fill = false,
    headerActions,
    surfaceWords,
    messages,
    defaultMessages = [],
    starterPrompts = EMPTY_STARTER_PROMPTS,
    empty,
    ariaLabel,
    attachments,
    defaultAttachments,
    availableContexts,
    composerPlaceholder = 'Ask a question…',
    isGenerating = false,
    renderBlock,
    onSendMessage,
    onSendPrompt,
    onStopGenerating,
    onNewThread,
    onClear,
    onRegenerate,
    onCitationClick,
    onAcceptProposal,
    onDismissProposal,
    className,
    ...props
  } = rawProps;
  const legacyProps = props as unknown as {
    emptyTitle?: ReactNode;
    emptyDescription?: ReactNode;
    'aria-label'?: string;
  };
  const forwardedProps = { ...props };
  delete (forwardedProps as Record<string, unknown>).emptyTitle;
  delete (forwardedProps as Record<string, unknown>).emptyDescription;

  const [internalModel, setInternalModel] = useState<string | undefined>(() => defaultModel ?? models?.[0]?.value);
  const [internalMessages, setInternalMessages] = useState<AiMessage[]>(() => [...defaultMessages]);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);

  const activeModel = model ?? internalModel;
  const activeMessages = messages ?? internalMessages;

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const modelOptions = useMemo<SelectOption<string>[]>(
    () =>
      (models ?? EMPTY_AI_MODELS).map((m) => ({
        value: m.value,
        label: m.label,
        textLabel: m.label,
        description: m.provider,
      })),
    [models],
  );

  /* The thread follows its newest words only while the reader is at the bottom of it. Whether they are is noted as
     they scroll; once they have scrolled up to read, nothing here moves the page under them, and scrolling back
     down takes the thread up again. */
  const pinnedToEnd = useRef(true);
  const noteScroll = () => {
    const container = streamRef.current;
    if (!container) return;
    pinnedToEnd.current = container.scrollHeight - container.scrollTop - container.clientHeight <= 24;
  };
  const followEnd = () => {
    const container = streamRef.current;
    if (container && pinnedToEnd.current) container.scrollTop = container.scrollHeight;
  };

  /* Followed on every change to the messages, not only to their number: a reply that streams in is one message
     growing, and by its count alone the thread stayed where the reply began while the text ran on below the fold. */
  useLayoutEffect(followEnd, [activeMessages, isGenerating]);

  /* And on growth that is not a change of `messages` at all: content a host renders as its own component streams by
     that component's updates, which only the DOM shows. */
  useEffect(() => {
    const container = streamRef.current;
    if (!container || typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(followEnd);
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  const handleModelSelect = (next: string | null) => {
    if (!next) return;
    if (model === undefined) setInternalModel(next);
    onModelChange?.(next);
  };

  const dispatchPrompt = (promptText: string, ctxItems: AiContextAttachment[]) => {
    // Sending is the reader's own return to the end of the thread: their message, and its reply, are shown.
    pinnedToEnd.current = true;
    if (messages === undefined) {
      const userTurn: AiMessage = {
        id: `msg-user-${Date.now()}`,
        role: 'user',
        content: promptText,
        plainText: promptText,
        timestamp: 'Just now',
        context: ctxItems,
      };
      setInternalMessages((prev) => [...prev, userTurn]);
    }
    const resolvedModel = activeModel ?? '';
    onSendMessage?.(promptText, ctxItems, resolvedModel);
    onSendPrompt?.(promptText, ctxItems, resolvedModel);
  };

  const handleClearThread = () => {
    if (messages === undefined) {
      setInternalMessages([]);
    }
    onClear?.();
  };

  const handleNewThread = () => {
    if (messages === undefined) {
      setInternalMessages([]);
    }
    onNewThread?.();
  };

  const handleCopyMessage = (msg: AiMessage) => {
    const raw = msg.plainText ?? (typeof msg.content === 'string' ? msg.content : '');
    if (raw && typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(raw);
    }
    setCopiedMessageId(msg.id);
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => {
      setCopiedMessageId((current) => (current === msg.id ? null : current));
    }, 1500);
  };

  const emptyHeading = isEmptyStateSpec(empty) ? empty.title : (legacyProps.emptyTitle ?? 'How can I help?');
  const emptySub = isEmptyStateSpec(empty) ? empty.body : legacyProps.emptyDescription;

  const isFill = fill || presentation !== 'inline';
  const normalizeReasoning = (value: AiMessage['reasoning']): ReadonlyArray<AiReasoningTrace> =>
    !value ? [] : Array.isArray(value) ? (value as ReadonlyArray<AiReasoningTrace>) : [value as AiReasoningTrace];

  return (
    <section
      aria-label={ariaLabel ?? legacyProps['aria-label'] ?? (typeof title === 'string' ? title : 'Assistant')}
      data-slot="ai-assistant-panel"
      data-presentation={presentation}
      data-fill={isFill ? '' : undefined}
      className={cx('nx-ai-panel', isFill && 'nx-ai-panel-fill', className)}
      {...forwardedProps}
    >
      {/* Header */}
      <header className="nx-ai-panel-header">
        <div className="nx-ai-panel-brand">
          <span className="nx-ai-panel-emblem" aria-hidden="true">
            <Icon name="sparkle" size={14} weight="bold" />
          </span>
          <div className="nx-ai-panel-titles">
            <h3 className="nx-ai-panel-title">{title}</h3>
            {subtitle ? <span className="nx-ai-panel-subtitle">{subtitle}</span> : null}
          </div>
        </div>

        <div className="nx-ai-panel-controls">
          {modelOptions.length > 0 ? (
            <div className="nx-ai-model-picker">
              <Select<string>
                size="xs"
                value={activeModel ?? null}
                onValueChange={(val) => handleModelSelect(val)}
                options={modelOptions}
                ariaLabel="Select AI model"
                triggerClassName="nx-ai-model-trigger"
              />
            </div>
          ) : null}
          {headerActions}
          <IconButton
            variant="ghost"
            size="xs"
            ariaLabel="New thread"
            title="New thread"
            icon={<Icon name="plus" size={14} weight="bold" />}
            onClick={handleNewThread}
          />
          <IconButton
            variant="ghost"
            size="xs"
            ariaLabel="Clear thread"
            title="Clear conversation"
            disabled={activeMessages.length === 0}
            icon={<Icon name="trash" size={14} />}
            onClick={handleClearThread}
          />
          {onPresentationChange || onOpenPage ? (
            <AiModeSwitcher
              presentation={presentation}
              presentations={presentations}
              onPresentationChange={onPresentationChange}
              restoreMode={restoreMode}
              onOpenPage={onOpenPage}
              words={surfaceWords}
            />
          ) : null}
          {onClose ? (
            <IconButton
              variant="ghost"
              size="xs"
              ariaLabel={surfaceWords?.close ?? 'Close assistant'}
              title={surfaceWords?.close ?? 'Close assistant'}
              icon={<Icon name="x" size={14} weight="bold" />}
              onClick={onClose}
            />
          ) : null}
        </div>
      </header>

      {/* Message Stream or Empty Starter State */}
      <div ref={streamRef} className="nx-ai-panel-stream" onScroll={noteScroll}>
        {activeMessages.length === 0 ? (
          <div className="nx-ai-empty">
            {empty !== undefined && !isEmptyStateSpec(empty) ? (
              empty
            ) : (
              <div className="nx-ai-empty-hero">
                <span className="nx-ai-empty-icon" aria-hidden="true">
                  <Icon name="sparkle" size={20} weight="bold" />
                </span>
                <h4 className="nx-ai-empty-title">{emptyHeading}</h4>
                {emptySub ? <p className="nx-ai-empty-description">{emptySub}</p> : null}
                {isEmptyStateSpec(empty) && empty.action ? <div className="nx-ai-empty-action">{empty.action}</div> : null}
              </div>
            )}

            {starterPrompts.length > 0 ? (
              <div className="nx-ai-starters" role="list" aria-label="Starter prompts">
                {starterPrompts.map((starter) => (
                  <button
                    key={starter.id}
                    type="button"
                    role="listitem"
                    onClick={() => dispatchPrompt(starter.prompt, attachments ? [...attachments] : [])}
                    className="nx-ai-starter-card nx-focusable"
                  >
                    <div className="nx-ai-starter-top">
                      <span className="nx-ai-starter-icon" aria-hidden="true">
                        {starter.icon ?? <Icon name="sparkle" size={13} weight="bold" />}
                      </span>
                      {starter.category ? <span className="nx-ai-starter-category">{starter.category}</span> : null}
                      <Icon name="arrow-right" size={12} className="nx-ai-starter-arrow" />
                    </div>
                    <div className="nx-ai-starter-title">{starter.title}</div>
                    <div className="nx-ai-starter-prompt">{starter.prompt}</div>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="nx-ai-thread" role="log" aria-live="polite">
            {activeMessages.map((msg) => {
              const roleAuthor = msg.role === 'user' ? 'You' : (assistantLabel ?? 'Assistant');
              if (msg.role === 'user') {
                return (
                  <article key={msg.id} data-role="user" aria-label={roleAuthor} className="nx-ai-turn nx-ai-turn-user">
                    <div className="nx-ai-user-bubble">
                      {msg.context && msg.context.length > 0 ? (
                        <div className="nx-ai-user-context">
                          {msg.context.map((ctxItem) => (
                            <span key={ctxItem.id} className="nx-ai-user-context-pill">
                              {renderContextIcon(ctxItem.kind)}
                              <span>{ctxItem.label}</span>
                            </span>
                          ))}
                        </div>
                      ) : null}
                      <div className="nx-ai-turn-body">
                        {typeof msg.content === 'string' ? renderInlineRichText(msg.content) : msg.content}
                      </div>
                    </div>
                    {msg.timestamp ? <span className="nx-ai-turn-time">{msg.timestamp}</span> : null}
                  </article>
                );
              }

              const isCopied = copiedMessageId === msg.id;
              const reasoningTraces = reasoningVisibility === 'hidden' ? [] : normalizeReasoning(msg.reasoning);

              return (
                <article
                  key={msg.id}
                  data-role="assistant"
                  data-streaming={msg.streaming ? '' : undefined}
                  className="nx-ai-turn nx-ai-turn-assistant"
                >
                  <div className="nx-ai-assistant-meta">
                    <span className="nx-ai-assistant-avatar" aria-hidden="true">
                      <Icon name="sparkle" size={12} weight="bold" />
                    </span>
                    <span className="nx-ai-assistant-author">{roleAuthor}</span>
                    {msg.model ? <span className="nx-ai-assistant-model">{msg.model}</span> : null}
                    {msg.timestamp ? <span className="nx-ai-turn-time">{msg.timestamp}</span> : null}
                  </div>

                  {reasoningTraces.length > 0 ? (
                    <div className="nx-ai-reasoning-list">
                      {reasoningTraces.map((trace) => (
                        <AiReasoning key={trace.id} trace={trace} defaultOpen={reasoningVisibility === 'expanded'} words={reasoningWords} />
                      ))}
                    </div>
                  ) : null}

                  {msg.toolCalls && msg.toolCalls.length > 0 ? <ToolCallSteps toolCalls={msg.toolCalls} /> : null}

                  <div className="nx-ai-assistant-body">
                    {typeof msg.content === 'string' ? renderInlineRichText(msg.content) : msg.content}
                    {msg.streaming ? <span className="nx-ai-cursor" aria-hidden="true" /> : null}
                  </div>

                  {msg.blocks && msg.blocks.length > 0 ? (
                    <div className="nx-ai-turn-blocks" data-slot="ai-blocks">
                      {msg.blocks.map((block) => (
                        <div
                          key={block.id}
                          className="nx-ai-block-frame"
                          data-block-kind={block.kind}
                          data-status={block.status ?? 'ready'}
                        >
                          {block.status === 'loading' ? (
                            <SkeletonCard lines={3} />
                          ) : renderBlock ? (
                            renderBlock(block, { presentation })
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {msg.citations && msg.citations.length > 0 ? (
                    <div className="nx-ai-citations" aria-label="Sources">
                      {msg.citations.map((cit, idx) => (
                        <button
                          key={cit.id}
                          type="button"
                          title={cit.snippet ?? cit.source}
                          onClick={() => onCitationClick?.(cit)}
                          className="nx-ai-citation-pill nx-focusable"
                        >
                          <span className="nx-ai-citation-num">{idx + 1}</span>
                          <Icon name="link" size={11} />
                          <span className="nx-ai-citation-label">{cit.label}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {msg.proposals && msg.proposals.length > 0 ? (
                    <div className="nx-ai-turn-proposals">
                      {msg.proposals.map((prop) => (
                        <AiProposalCard
                          key={prop.id}
                          id={prop.id}
                          title={prop.title}
                          targetLabel={prop.targetLabel}
                          changes={prop.changes}
                          confidence={prop.confidence}
                          rationale={prop.rationale}
                          evidence={prop.evidence}
                          status={prop.status}
                          onAccept={() => onAcceptProposal?.(prop.id, msg.id)}
                          onDismiss={() => onDismissProposal?.(prop.id, msg.id)}
                        />
                      ))}
                    </div>
                  ) : null}

                  <div className="nx-ai-assistant-actions">
                    <button
                      type="button"
                      onClick={() => handleCopyMessage(msg)}
                      aria-label={isCopied ? 'Copied response' : 'Copy response'}
                      className="nx-ai-action-btn nx-focusable"
                    >
                      {isCopied ? (
                        <>
                          <Icon name="check" size={12} weight="bold" />
                          <span>Copied</span>
                        </>
                      ) : (
                        <>
                          <Icon name="copy" size={12} />
                          <span>Copy</span>
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => onRegenerate?.(msg.id)}
                      aria-label="Regenerate response"
                      className="nx-ai-action-btn nx-focusable"
                    >
                      <Icon name="arrow-clockwise" size={12} />
                      <span>Regenerate</span>
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer Composer */}
      <footer className="nx-ai-panel-footer">
        <AiPromptComposer
          attachments={attachments}
          defaultAttachments={defaultAttachments}
          availableContexts={availableContexts}
          effort={effort}
          efforts={efforts}
          onEffortChange={onEffortChange}
          placeholder={composerPlaceholder}
          isGenerating={isGenerating}
          onSubmit={dispatchPrompt}
          onStop={onStopGenerating}
        />
      </footer>
    </section>
  );
}
