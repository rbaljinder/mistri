/**
 * Line-numbered monospace code and JSON editors with tab indentation, copy controls,
 * and inline JSON parse diagnostics.
 */
'use client';

import * as React from 'react';
import { Icon } from '../Icon.js';
import { cx } from '../internal/cx.js';
import { FieldControlBridge, wrapWithField, type FieldFrameProps } from './fieldShell.js';

/* ============================================================================
 * 4. CodeEditor & JsonEditor (Line-Numbered Monospace + Tab Indent + JSON Lint)
 * ========================================================================== */

/** Supported syntax identifier for `CodeEditor`. */
export type CodeLanguage = 'json' | 'sql' | 'typescript' | 'javascript' | 'shell' | 'yaml' | 'html' | 'css' | 'plaintext' | (string & {});

/** Props for the `CodeEditor` component. */
export interface CodeEditorProps extends FieldFrameProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (code: string) => void;
  language?: CodeLanguage;
  /** Optional filename badge displayed in the editor header bar. */
  filename?: string;
  /** Show synchronized 1-indexed line numbers in the left gutter. Defaults to `true`. */
  lineNumbers?: boolean;
  /** Spaces inserted when pressing `Tab` (and removed on `Shift+Tab`). Defaults to `2`. */
  tabSize?: number;
  /** Show copy-to-clipboard button in the header bar. Defaults to `true`. */
  copyable?: boolean;
  /** Soft-wrap long lines instead of horizontal scrolling. Defaults to `true`. */
  wrapLines?: boolean;
  /** 1-indexed line number to highlight with an error indicator in the gutter. */
  errorLine?: number | null;
  /** Custom status/actions rendered inside the top-right header bar before Copy. */
  headerActions?: React.ReactNode;
  /** Custom status content rendered in the bottom bar alongside cursor `Ln, Col`. */
  statusFooter?: React.ReactNode;
  placeholder?: string;
  minHeight?: number | string;
  maxHeight?: number | string;
  readOnly?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  name?: string;
  ariaLabel?: string;
  ariaDescribedBy?: string;
  words?: { copyCode?: string; copiedCode?: string; copy?: string; copied?: string; leaveHint?: string };
  className?: string;
  fieldClassName?: string;
  ref?: React.Ref<HTMLTextAreaElement>;
}

/** Line-numbered monospace code editor with Tab/Shift+Tab indentation (Escape, then Tab, leaves it) and clipboard copy. */
export function CodeEditor(props: CodeEditorProps): React.JSX.Element {
  const {
    value,
    defaultValue = '',
    onValueChange,
    language = 'plaintext',
    filename,
    lineNumbers = true,
    tabSize = 2,
    copyable = true,
    wrapLines = true,
    errorLine = null,
    headerActions,
    statusFooter,
    placeholder,
    minHeight = 180,
    maxHeight,
    readOnly = false,
    disabled = false,
    invalid,
    id,
    name,
    ariaLabel,
    ariaDescribedBy,
    words,
    label,
    hint,
    description,
    error,
    optional,
    required,
    labelTrailing,
    className,
    fieldClassName,
    ref,
  } = props;
  const legacyProps = props as unknown as {
    onChange?: (code: string) => void;
    'aria-label'?: string;
    'aria-describedby'?: string;
  };
  const onChange = legacyProps.onChange;
  const explicitAriaLabel = ariaLabel ?? legacyProps['aria-label'];
  const explicitAriaDescribedBy = ariaDescribedBy ?? legacyProps['aria-describedby'];
  const [internalCode, setInternalCode] = React.useState<string>(() => value ?? defaultValue);
  const [copied, setCopied] = React.useState(false);
  const [cursorPos, setCursorPos] = React.useState<{ line: number; col: number }>({
    line: 1,
    col: 1,
  });

  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const setTextareaRef = React.useCallback(
    (node: HTMLTextAreaElement | null) => {
      textareaRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
    },
    [ref],
  );
  const gutterRef = React.useRef<HTMLDivElement | null>(null);
  const copyTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const code = value !== undefined ? value : internalCode;
  const isInvalid = invalid ?? (Boolean(error) || errorLine !== null);

  const lineCount = React.useMemo(() => Math.max(1, code.split('\n').length), [code]);

  const updateCode = React.useCallback(
    (next: string) => {
      if (value === undefined) {
        setInternalCode(next);
      }
      onValueChange?.(next);
      onChange?.(next);
    },
    [value, onValueChange, onChange],
  );

  const syncCursorMetrics = (el: HTMLTextAreaElement) => {
    const pos = el.selectionStart ?? 0;
    const before = el.value.slice(0, pos);
    const lines = before.split('\n');
    const line = lines.length;
    const col = (lines[lines.length - 1]?.length ?? 0) + 1;
    setCursorPos((prev) => (prev.line === line && prev.col === col ? prev : { line, col }));
  };

  /* Tab indents here, so the keyboard needs another way out or focus can never leave (WCAG 2.1.2). Escape arms the
     next Tab to move focus as it does anywhere else; any other key, or leaving, disarms it. */
  const leaveOnTab = React.useRef(false);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      leaveOnTab.current = true;
      return;
    }
    if (event.key === 'Shift') return;
    const leaving = leaveOnTab.current;
    leaveOnTab.current = false;
    if (event.key !== 'Tab' || leaving || readOnly || disabled) return;
    event.preventDefault();

    const el = event.currentTarget;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const indent = ' '.repeat(Math.max(1, tabSize));
    const current = el.value;

    const hasMultilineSelection = start !== end && current.slice(start, end).includes('\n');

    if (!event.shiftKey && !hasMultilineSelection) {
      const next = current.slice(0, start) + indent + current.slice(end);
      const nextCaret = start + indent.length;
      updateCode(next);
      globalThis.requestAnimationFrame(() => {
        if (!textareaRef.current) return;
        textareaRef.current.selectionStart = nextCaret;
        textareaRef.current.selectionEnd = nextCaret;
        syncCursorMetrics(textareaRef.current);
      });
      return;
    }

    // Block indent / outdent across touched lines
    const lineStart = current.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    const lineEndIdx = current.indexOf('\n', end);
    const blockEnd = lineEndIdx === -1 ? current.length : lineEndIdx;
    const block = current.slice(lineStart, blockEnd);
    const blockLines = block.split('\n');

    let firstLineDelta = 0;
    let totalDelta = 0;

    const transformed = blockLines.map((ln, idx) => {
      if (event.shiftKey) {
        let removed = 0;
        if (ln.startsWith('\t')) {
          removed = 1;
        } else {
          while (removed < tabSize && ln[removed] === ' ') {
            removed += 1;
          }
        }
        if (idx === 0) firstLineDelta = -removed;
        totalDelta -= removed;
        return ln.slice(removed);
      }
      if (idx === 0) firstLineDelta = indent.length;
      totalDelta += indent.length;
      return indent + ln;
    });

    const next = current.slice(0, lineStart) + transformed.join('\n') + current.slice(blockEnd);
    const nextStart = Math.max(lineStart, start + firstLineDelta);
    const nextEnd = Math.max(nextStart, end + totalDelta);

    updateCode(next);
    globalThis.requestAnimationFrame(() => {
      if (!textareaRef.current) return;
      textareaRef.current.selectionStart = nextStart;
      textareaRef.current.selectionEnd = nextEnd;
      syncCursorMetrics(textareaRef.current);
    });
  };

  const handleCopy = () => {
    if (!code || typeof navigator === 'undefined' || !navigator.clipboard) return;
    void navigator.clipboard.writeText(code);
    setCopied(true);
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
  };

  const minHeightCss = typeof minHeight === 'number' ? `${minHeight}px` : minHeight;
  const maxHeightCss = maxHeight !== undefined ? (typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight) : undefined;
  const leaveHintId = React.useId();
  const trapsTab = !readOnly && !disabled;
  const fallbackAriaLabel = explicitAriaLabel ?? (typeof label === 'string' ? label : (filename ?? `${language} code editor`));

  const editorFrame = (
    <FieldControlBridge id={id} ariaLabel={fallbackAriaLabel} ariaDescribedBy={explicitAriaDescribedBy} invalid={isInvalid}>
      {(fieldAttrs) => (
        <div
          data-slot="code-editor"
          data-language={language}
          data-wrap={wrapLines ? '' : undefined}
          data-invalid={fieldAttrs['aria-invalid'] ? '' : undefined}
          data-disabled={disabled ? '' : undefined}
          data-readonly={readOnly ? '' : undefined}
          className={cx('nx-code-editor', className)}
        >
          <div className="nx-code-header">
            <div className="nx-code-header-start">
              {filename ? <span className="nx-code-filename">{filename}</span> : null}
              <span className="nx-code-lang-pill">{language.toUpperCase()}</span>
            </div>

            <div className="nx-code-header-end">
              {headerActions}
              {copyable ? (
                <button
                  type="button"
                  onClick={handleCopy}
                  disabled={!code || disabled}
                  aria-label={copied ? (words?.copiedCode ?? 'Copied code') : (words?.copyCode ?? 'Copy code')}
                  className="nx-code-action-btn nx-focusable"
                >
                  {copied ? (
                    <>
                      <Icon name="check" size={13} weight="bold" />
                      <span>{words?.copied ?? 'Copied'}</span>
                    </>
                  ) : (
                    <>
                      <Icon name="copy" size={13} />
                      <span>{words?.copy ?? 'Copy'}</span>
                    </>
                  )}
                </button>
              ) : null}
            </div>
          </div>

          <div
            className="nx-code-body"
            style={
              {
                '--code-min-h': minHeightCss,
                ...(maxHeightCss ? { maxHeight: maxHeightCss } : {}),
              } as React.CSSProperties
            }
          >
            {lineNumbers ? (
              <div ref={gutterRef} aria-hidden="true" className="nx-code-gutter">
                {Array.from({ length: lineCount }, (_, idx) => {
                  const ln = idx + 1;
                  return (
                    <span
                      key={ln}
                      data-active={cursorPos.line === ln ? '' : undefined}
                      data-error={errorLine === ln ? '' : undefined}
                      className="nx-code-line-num"
                    >
                      {ln}
                    </span>
                  );
                })}
              </div>
            ) : null}

            <textarea
              ref={setTextareaRef}
              id={fieldAttrs.id}
              name={name}
              value={code}
              onChange={(e) => {
                updateCode(e.target.value);
                syncCursorMetrics(e.target);
              }}
              onKeyDown={handleKeyDown}
              onBlur={() => {
                leaveOnTab.current = false;
              }}
              onClick={(e) => syncCursorMetrics(e.currentTarget)}
              onKeyUp={(e) => syncCursorMetrics(e.currentTarget)}
              onScroll={(e) => {
                if (gutterRef.current) {
                  gutterRef.current.scrollTop = e.currentTarget.scrollTop;
                }
              }}
              placeholder={placeholder}
              readOnly={readOnly}
              disabled={disabled}
              required={required}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              wrap={wrapLines ? 'soft' : 'off'}
              aria-label={fieldAttrs['aria-label']}
              aria-labelledby={fieldAttrs['aria-labelledby']}
              aria-describedby={
                trapsTab ? [fieldAttrs['aria-describedby'], leaveHintId].filter(Boolean).join(' ') : fieldAttrs['aria-describedby']
              }
              aria-invalid={fieldAttrs['aria-invalid'] || undefined}
              className="nx-code-textarea"
            />
            {trapsTab ? (
              <span id={leaveHintId} className="nx-sr-only">
                {words?.leaveHint ?? 'Tab indents. Press Escape, then Tab, to leave the editor.'}
              </span>
            ) : null}
          </div>

          <div className="nx-code-footer">
            <div className="nx-code-footer-status">{statusFooter}</div>
            <div className="nx-code-footer-cursor">
              <span>
                Ln {cursorPos.line}, Col {cursorPos.col}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {lineCount} {lineCount === 1 ? 'line' : 'lines'}
              </span>
            </div>
          </div>
        </div>
      )}
    </FieldControlBridge>
  );

  return wrapWithField(editorFrame, {
    label,
    hint,
    description,
    error,
    optional,
    required,
    labelTrailing,
    name,
    disabled,
    invalid: isInvalid,
    fieldClassName,
  });
}

/** Diagnostic result emitted by `JsonEditor` when its source changes. */
export interface JsonValidationResult {
  valid: boolean;
  empty: boolean;
  line: number | null;
  column: number | null;
  message: string | null;
}

function validateJsonSource(source: string, allowEmpty = true): JsonValidationResult {
  const trimmed = source.trim();
  if (!trimmed) {
    return allowEmpty
      ? { valid: true, empty: true, line: null, column: null, message: null }
      : {
          valid: false,
          empty: true,
          line: 1,
          column: 1,
          message: 'JSON value is required',
        };
  }

  try {
    JSON.parse(source);
    return { valid: true, empty: false, line: null, column: null, message: null };
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : 'Invalid JSON syntax';
    const lcMatch = /line\s+(\d+)\s+column\s+(\d+)/i.exec(rawMsg);
    if (lcMatch) {
      const line = Number.parseInt(lcMatch[1] ?? '1', 10);
      const column = Number.parseInt(lcMatch[2] ?? '1', 10);
      return {
        valid: false,
        empty: false,
        line,
        column,
        message: rawMsg,
      };
    }

    const posMatch = /position\s+(\d+)/i.exec(rawMsg);
    if (posMatch) {
      const offset = Math.min(source.length, Math.max(0, Number.parseInt(posMatch[1] ?? '0', 10)));
      const prefix = source.slice(0, offset);
      const splitLines = prefix.split('\n');
      const line = splitLines.length;
      const column = (splitLines[splitLines.length - 1]?.length ?? 0) + 1;
      return {
        valid: false,
        empty: false,
        line,
        column,
        message: `${rawMsg} (line ${line}, col ${column})`,
      };
    }

    const totalLines = source.split('\n').length;
    return {
      valid: false,
      empty: false,
      line: totalLines,
      column: 1,
      message: rawMsg,
    };
  }
}

/** Props for the `JsonEditor` component. */
export interface JsonEditorProps extends Omit<CodeEditorProps, 'language' | 'errorLine'> {
  /** Treat an empty editor string as valid until text is typed. Defaults to `true`. */
  allowEmpty?: boolean;
  /** Pretty-print indentation spaces used by the `Format` button. Defaults to `2`. */
  formatIndent?: number;
  /** Notifies caller whenever JSON validity changes. */
  onValidationChange?: (result: JsonValidationResult) => void;
}

/** Monospace JSON editor with live parse validation, line-error gutter markers, and pretty-print formatting. */
export function JsonEditor(props: JsonEditorProps): React.JSX.Element {
  const {
    value,
    defaultValue = '',
    onValueChange,
    allowEmpty = true,
    formatIndent = 2,
    onValidationChange,
    headerActions,
    statusFooter,
    placeholder = '{\n  "key": "value"\n}',
    readOnly = false,
    disabled = false,
    ...rest
  } = props;
  const onChange = (props as unknown as { onChange?: (code: string) => void }).onChange;
  const [internalJson, setInternalJson] = React.useState<string>(() => value ?? defaultValue);
  const activeJson = value !== undefined ? value : internalJson;

  const validation = React.useMemo(() => validateJsonSource(activeJson, allowEmpty), [activeJson, allowEmpty]);

  const onValidationRef = React.useRef(onValidationChange);
  onValidationRef.current = onValidationChange;

  React.useEffect(() => {
    onValidationRef.current?.(validation);
  }, [validation]);

  const commitJson = React.useCallback(
    (next: string) => {
      if (value === undefined) {
        setInternalJson(next);
      }
      onValueChange?.(next);
      onChange?.(next);
    },
    [value, onValueChange, onChange],
  );

  const handleFormat = () => {
    if (!activeJson.trim() || !validation.valid || readOnly || disabled) return;
    try {
      const parsed: unknown = JSON.parse(activeJson);
      const formatted = JSON.stringify(parsed, null, formatIndent);
      commitJson(formatted);
    } catch {
      // Ignored if unparseable
    }
  };

  const jsonHeaderControls = (
    <>
      {!validation.empty ? (
        validation.valid ? (
          <span data-valid="" className="nx-json-badge">
            <Icon name="check-circle" size={13} weight="bold" />
            <span>Valid JSON</span>
          </span>
        ) : (
          <span data-invalid="" className="nx-json-badge">
            <Icon name="warning" size={13} weight="bold" />
            <span>{validation.line ? `Invalid · Line ${validation.line}` : 'Invalid JSON'}</span>
          </span>
        )
      ) : null}

      {!readOnly ? (
        <button
          type="button"
          onClick={handleFormat}
          disabled={disabled || validation.empty || !validation.valid}
          title="Pretty-print JSON"
          className="nx-code-action-btn nx-focusable"
        >
          <Icon name="brackets-curly" size={13} weight="bold" />
          <span>Format</span>
        </button>
      ) : null}

      {headerActions}
    </>
  );

  const jsonStatusFooter =
    !validation.valid && validation.message ? (
      <span role="alert" className="nx-json-error-message">
        <Icon name="warning" size={13} weight="bold" />
        <span>{validation.message}</span>
      </span>
    ) : (
      statusFooter
    );

  return (
    <CodeEditor
      {...rest}
      language="json"
      value={activeJson}
      onValueChange={commitJson}
      tabSize={formatIndent}
      errorLine={!validation.valid ? validation.line : null}
      headerActions={jsonHeaderControls}
      statusFooter={jsonStatusFooter}
      placeholder={placeholder}
      readOnly={readOnly}
      disabled={disabled}
    />
  );
}
