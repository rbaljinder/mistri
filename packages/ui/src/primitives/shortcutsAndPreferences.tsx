/** Keyboard shortcut keycaps, searchable shortcuts modal, and reader accessibility preference controls. */
'use client';

import * as React from 'react';
import { createLocalStorage, createPreference, type Preference, type PreferenceLike } from '@ui-sdk/core';
import { Preferences, usePreference } from '@ui-sdk/react/preferences';
import { formatShortcut, shortcuts, useShortcut as useSdkShortcut, useShortcutHint } from '@ui-sdk/react/shortcuts';
import { fuzzyScore } from '@ui-sdk/react/text-match';
import { Icon } from '../Icon.js';
import { Modal } from '../Modal.js';
import { cx, type ControlSize } from '../internal/cx.js';
import { Button } from './actions.js';
import { Switch } from './selection.js';
import { HighlightMatch } from './systemPrimitives.js';

/* ============================================================================
 * 3. ShortcutKey & ShortcutsModal (@ui-sdk/react/shortcuts)
 * ========================================================================== */

/** Props for the `ShortcutKey` component. */
export interface ShortcutKeyProps extends Omit<React.ComponentProps<'span'>, 'children' | 'onChange' | 'aria-label' | 'inlist'> {
  /** Shortcut chord string such as `'mod+k'`, `'mod+shift+z'`, `'g then i'`, or `'?'`. */
  keys: string;
  size?: ControlSize;
  variant?: 'elevated' | 'subtle' | 'plain';
  ariaLabel?: string;
}

function splitFormattedChord(formatted: string, rawKeys: string): Array<{ type: 'key' | 'sep'; value: string }> {
  // Handle multi-step sequences such as "G then I"
  if (/\bthen\b/i.test(rawKeys)) {
    const steps = rawKeys.split(/\s+then\s+/i);
    const tokens: Array<{ type: 'key' | 'sep'; value: string }> = [];
    steps.forEach((step, idx) => {
      if (idx > 0) tokens.push({ type: 'sep', value: 'then' });
      const formattedStep = formatShortcut(step.trim());
      for (const part of splitSingleChord(formattedStep)) {
        tokens.push({ type: 'key', value: part });
      }
    });
    return tokens;
  }

  return splitSingleChord(formatted).map((value) => ({ type: 'key', value }));
}

function splitSingleChord(formatted: string): string[] {
  if (formatted.includes('+') && formatted.length > 1) {
    return formatted
      .split('+')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // Split compact Apple symbol glyphs like "⌘⇧Z" into ["⌘", "⇧", "Z"]
  const appleGlyphs = new Set(['⌘', '⇧', '⌥', '⌃', '⏎', '⌫', '⌦', '⎋', '⇥', '↑', '↓', '←', '→']);
  const chars = [...formatted];
  if (chars.length > 1 && chars.some((ch) => appleGlyphs.has(ch))) {
    const out: string[] = [];
    let rest = '';
    for (const ch of chars) {
      if (appleGlyphs.has(ch)) {
        if (rest) {
          out.push(rest);
          rest = '';
        }
        out.push(ch);
      } else {
        rest += ch;
      }
    }
    if (rest) out.push(rest);
    return out;
  }
  return [formatted];
}

/** Platform-aware keyboard shortcut keycap chord badge. */
export function ShortcutKey({
  keys,
  size = 'sm',
  variant = 'elevated',
  ariaLabel,
  className,
  ...rest
}: ShortcutKeyProps): React.JSX.Element {
  const legacyAriaLabel = (rest as Record<string, unknown>)['aria-label'] as string | undefined;
  const hint = useShortcutHint(keys);
  const parts = React.useMemo(() => splitFormattedChord(hint.text, keys), [hint.text, keys]);

  return (
    <span
      aria-label={ariaLabel ?? legacyAriaLabel}
      aria-keyshortcuts={hint.ariaKeyshortcuts}
      data-slot="shortcut-key"
      data-size={size}
      data-variant={variant}
      className={cx('nx-shortcut-chord', className)}
      {...rest}
    >
      {parts.map((part, idx) =>
        part.type === 'sep' ? (
          <span key={idx} className="nx-shortcut-chord-sep">
            {part.value}
          </span>
        ) : (
          <kbd key={idx} className="nx-shortcut-cap">
            {part.value}
          </kbd>
        ),
      )}
    </span>
  );
}

/** Single keyboard shortcut row displayed inside `ShortcutsModal`. */
export interface ShortcutItem {
  keys: string;
  description: string;
  scope?: string;
}

/** Grouped keyboard shortcut category in `ShortcutsModal`. */
export interface ShortcutSection {
  title: string;
  description?: React.ReactNode;
  shortcuts: ReadonlyArray<ShortcutItem>;
}

/** Props for the `ShortcutsModal` component. */
export interface ShortcutsModalProps {
  /** Categorized shortcut sections to display. */
  sections: ReadonlyArray<ShortcutSection>;
  /** Controlled open state. */
  open?: boolean;
  /** Initial uncontrolled open state. */
  defaultOpen?: boolean;
  /** Called when open state changes. */
  onOpenChange?: (open: boolean) => void;
  /**
   * Key binding registered via `useShortcut` to open/toggle the modal.
   * Pass `null` to disable global trigger binding.
   * @default '?'
   */
  triggerKey?: string | null;
  /** Optional trigger element rendered inline to open the shortcuts modal on click. */
  trigger?: React.ReactNode;
  /** Modal title. Defaults to `'Keyboard Shortcuts'`. */
  title?: React.ReactNode;
  /** Modal subtitle. */
  description?: React.ReactNode;
  /** Include live shortcuts registered via `useShortcut` that carry a `description`. */
  includeRegistered?: boolean;
  /** Show a live search filter bar inside the modal. Defaults to `true`. */
  searchable?: boolean;
  /** Modal width preset. Defaults to `'lg'`. */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  words?: {
    close?: string;
    filterPlaceholder?: string;
    filterLabel?: string;
    clearFilter?: string;
    done?: string;
  };
  className?: string;
}

/** Searchable keyboard shortcuts reference modal with optional global `?` trigger. */

export function ShortcutsModal({
  sections,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  triggerKey = '?',
  trigger,
  title = 'Keyboard Shortcuts',
  description = 'Navigate, edit, and run commands without leaving the keyboard.',
  includeRegistered = false,
  searchable = true,
  size = 'lg',
  words,
  className,
}: ShortcutsModalProps): React.JSX.Element {
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const [query, setQuery] = React.useState('');

  const isOpen = controlledOpen !== undefined ? controlledOpen : internalOpen;

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) {
        setInternalOpen(next);
      }
      if (!next) {
        setQuery('');
      }
      onOpenChange?.(next);
    },
    [controlledOpen, onOpenChange],
  );

  useSdkShortcut(
    triggerKey,
    () => {
      setOpen(!isOpen);
    },
    { description: 'Toggle keyboard shortcuts reference' },
  );

  const mergedSections = React.useMemo<ShortcutSection[]>(() => {
    if (!includeRegistered || !isOpen) {
      return [...sections];
    }
    const existingKeys = new Set(sections.flatMap((sec) => sec.shortcuts.map((s) => s.keys.toLowerCase())));
    const liveItems = shortcuts.list().flatMap((info): ShortcutItem[] => {
      if (!info.description || existingKeys.has(info.keys.toLowerCase())) {
        return [];
      }
      return [
        {
          keys: info.keys,
          description: info.description,
          scope: info.scope,
        },
      ];
    });

    if (liveItems.length === 0) return [...sections];
    return [
      ...sections,
      {
        title: 'Active Page Shortcuts',
        shortcuts: liveItems,
      },
    ];
  }, [includeRegistered, isOpen, sections]);

  const filteredSections = React.useMemo<ShortcutSection[]>(() => {
    const trimmed = query.trim();
    if (!trimmed) return mergedSections;

    return mergedSections
      .map((sec) => {
        const titleMatches = fuzzyScore(sec.title, trimmed) > 0.35;
        const matchedShortcuts = sec.shortcuts.filter(
          (item) =>
            titleMatches ||
            fuzzyScore(item.description, trimmed) > 0.25 ||
            fuzzyScore(item.keys, trimmed) > 0.3 ||
            fuzzyScore(formatShortcut(item.keys), trimmed) > 0.3,
        );
        return {
          ...sec,
          shortcuts: matchedShortcuts,
        };
      })
      .filter((sec) => sec.shortcuts.length > 0);
  }, [mergedSections, query]);

  return (
    <>
      {trigger !== undefined ? (
        React.isValidElement(trigger) ? (
          React.cloneElement(trigger as React.ReactElement<{ onClick?: () => void }>, {
            onClick: () => setOpen(true),
          })
        ) : (
          <button type="button" data-slot="button" className="nx-dialog-trigger" onClick={() => setOpen(true)}>
            {trigger}
          </button>
        )
      ) : null}
      {isOpen ? (
        <Modal
          onClose={() => setOpen(false)}
          closeLabel={words?.close ?? 'Close dialog'}
          className={cx('nx-dialog-content nx-shortcuts-modal', className)}
        >
          <div data-size={size}>
            <div className="nx-dialog-header">
              <div className="nx-dialog-header-copy">
                <h2 className="nx-dialog-title">
                  <span className="nx-shortcuts-modal-heading">
                    <Icon name="keyboard" size={18} weight="bold" className="nx-shortcuts-modal-icon" />
                    <span>{title}</span>
                  </span>
                </h2>
                {description !== undefined ? <p className="nx-dialog-description">{description}</p> : null}
              </div>
            </div>
            <div className="nx-dialog-body nx-shortcuts-modal-body">
              {searchable ? (
                <div className="nx-shortcuts-search">
                  <Icon name="magnifying-glass" size={14} className="nx-shortcuts-search-icon" />
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={words?.filterPlaceholder ?? 'Filter shortcuts by action or key…'}
                    aria-label={words?.filterLabel ?? 'Filter keyboard shortcuts'}
                    className="nx-shortcuts-search-input"
                  />
                  {query ? (
                    <button
                      type="button"
                      onClick={() => setQuery('')}
                      aria-label={words?.clearFilter ?? 'Clear filter'}
                      className="nx-shortcuts-search-clear nx-focusable"
                    >
                      <Icon name="x" size={12} weight="bold" />
                    </button>
                  ) : null}
                </div>
              ) : null}

              {filteredSections.length === 0 ? (
                <div className="nx-shortcuts-empty">
                  No keyboard shortcuts match <strong>&ldquo;{query}&rdquo;</strong>.
                </div>
              ) : (
                <div className="nx-shortcuts-grid">
                  {filteredSections.map((section) => (
                    <section key={section.title} className="nx-shortcuts-section">
                      <header className="nx-shortcuts-section-header">
                        <h3 className="nx-shortcuts-section-title">{section.title}</h3>
                        {section.description ? <p className="nx-shortcuts-section-desc">{section.description}</p> : null}
                      </header>
                      <div className="nx-shortcuts-list">
                        {section.shortcuts.map((item) => (
                          <div key={`${section.title}-${item.keys}-${item.description}`} className="nx-shortcuts-row">
                            <div className="nx-shortcuts-row-copy">
                              <HighlightMatch text={item.description} query={query} className="nx-shortcuts-row-label" />
                              {item.scope ? <span className="nx-shortcuts-scope-badge">{item.scope}</span> : null}
                            </div>
                            <ShortcutKey keys={item.keys} size="sm" />
                          </div>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </div>
            {triggerKey ? (
              <div className="nx-dialog-footer">
                <div className="nx-shortcuts-modal-footer">
                  <span className="nx-shortcuts-modal-tip">
                    Press <ShortcutKey keys={triggerKey} size="xs" /> anywhere to toggle this guide
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>
                    {words?.done ?? 'Done'}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </>
  );
}

/* ============================================================================
 * 4. PreferencesPanel (@ui-sdk/react/preferences)
 * ========================================================================== */

/** Motion preference state managed by `PreferencesPanel`. */
export type MotionPreferenceValue = 'full' | 'reduced';
/** Contrast preference state managed by `PreferencesPanel`. */
export type ContrastPreferenceValue = 'standard' | 'more';
/** Keyboard shortcut hint visibility state managed by `PreferencesPanel`. */
export type KeyboardHintsPreferenceValue = 'visible' | 'hidden';

const motionPreference: Preference<MotionPreferenceValue> = createPreference({
  values: ['full', 'reduced'] as const,
  defaultValue: 'full',
  attribute: 'data-nx-motion',
  global: true,
  storage: createLocalStorage('nx-pref-motion'),
});

const contrastPreference: Preference<ContrastPreferenceValue> = createPreference({
  values: ['standard', 'more'] as const,
  defaultValue: 'standard',
  attribute: 'data-nx-contrast',
  global: true,
  storage: createLocalStorage('nx-pref-contrast'),
});

const keyboardHintsPreference: Preference<KeyboardHintsPreferenceValue> = createPreference({
  values: ['visible', 'hidden'] as const,
  defaultValue: 'visible',
  attribute: 'data-nx-kbd-hints',
  global: true,
  storage: createLocalStorage('nx-pref-kbd-hints'),
});

const DEFAULT_UI_PREFERENCES: readonly PreferenceLike[] = [motionPreference, contrastPreference, keyboardHintsPreference];

/** Custom switch row descriptor appended to `PreferencesPanel`. */
export interface PreferenceCustomToggle {
  id: string;
  label: React.ReactNode;
  description?: React.ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}

/** Props for the `PreferencesPanel` component. */
export interface PreferencesPanelProps extends Omit<React.ComponentProps<'div'>, 'title' | 'onChange' | 'aria-label' | 'inlist'> {
  title?: React.ReactNode;
  description?: React.ReactNode;
  ariaLabel?: string;
  /** Controlled override for Reduced Motion toggle. */
  reducedMotion?: boolean;
  onReducedMotionChange?: (reduced: boolean) => void;
  /** Controlled override for High Contrast toggle. */
  highContrast?: boolean;
  onHighContrastChange?: (highContrast: boolean) => void;
  /** Controlled override for Keyboard Shortcut Hints toggle. */
  showKeyboardHints?: boolean;
  onShowKeyboardHintsChange?: (visible: boolean) => void;
  /** Additional custom preference switches appended to the panel. */
  extraToggles?: ReadonlyArray<PreferenceCustomToggle>;
  /** Show Reset to defaults action in header. Defaults to `true`. */
  showReset?: boolean;
  onReset?: () => void;
}

function syncRootAttribute(attribute: `data-${string}`, value: string) {
  if (typeof globalThis.document !== 'undefined') {
    globalThis.document.documentElement.setAttribute(attribute, value);
  }
}

/** Reader accessibility and ergonomics preferences card for motion, contrast, and shortcut hints. */
export function PreferencesPanel({
  title = 'Interface Preferences',
  description = 'Accessible motion, contrast, and keyboard hint controls persisted across sessions.',
  ariaLabel,
  reducedMotion: controlledReducedMotion,
  onReducedMotionChange,
  highContrast: controlledHighContrast,
  onHighContrastChange,
  showKeyboardHints: controlledShowHints,
  onShowKeyboardHintsChange,
  extraToggles,
  showReset = true,
  onReset,
  className,
  ...rest
}: PreferencesPanelProps): React.JSX.Element {
  const legacyAriaLabel = (rest as Record<string, unknown>)['aria-label'] as string | undefined;
  const motionState = usePreference(motionPreference);
  const contrastState = usePreference(contrastPreference);
  const hintsState = usePreference(keyboardHintsPreference);

  const isReducedMotion = controlledReducedMotion ?? motionState.value === 'reduced';
  const isHighContrast = controlledHighContrast ?? contrastState.value === 'more';
  const isHintsVisible = controlledShowHints ?? hintsState.value === 'visible';

  React.useEffect(() => {
    syncRootAttribute('data-nx-motion', isReducedMotion ? 'reduced' : 'full');
  }, [isReducedMotion]);

  React.useEffect(() => {
    syncRootAttribute('data-nx-contrast', isHighContrast ? 'more' : 'standard');
  }, [isHighContrast]);

  React.useEffect(() => {
    syncRootAttribute('data-nx-kbd-hints', isHintsVisible ? 'visible' : 'hidden');
  }, [isHintsVisible]);

  const handleMotionToggle = React.useCallback(
    (checked: boolean) => {
      const next: MotionPreferenceValue = checked ? 'reduced' : 'full';
      if (controlledReducedMotion === undefined) {
        motionPreference.set(next);
      }
      syncRootAttribute('data-nx-motion', next);
      onReducedMotionChange?.(checked);
    },
    [controlledReducedMotion, onReducedMotionChange],
  );

  const handleContrastToggle = React.useCallback(
    (checked: boolean) => {
      const next: ContrastPreferenceValue = checked ? 'more' : 'standard';
      if (controlledHighContrast === undefined) {
        contrastPreference.set(next);
      }
      syncRootAttribute('data-nx-contrast', next);
      onHighContrastChange?.(checked);
    },
    [controlledHighContrast, onHighContrastChange],
  );

  const handleHintsToggle = React.useCallback(
    (checked: boolean) => {
      const next: KeyboardHintsPreferenceValue = checked ? 'visible' : 'hidden';
      if (controlledShowHints === undefined) {
        keyboardHintsPreference.set(next);
      }
      syncRootAttribute('data-nx-kbd-hints', next);
      onShowKeyboardHintsChange?.(checked);
    },
    [controlledShowHints, onShowKeyboardHintsChange],
  );

  const isNonDefault = isReducedMotion || isHighContrast || !isHintsVisible;

  const handleReset = React.useCallback(() => {
    handleMotionToggle(false);
    handleContrastToggle(false);
    handleHintsToggle(true);
    onReset?.();
  }, [handleMotionToggle, handleContrastToggle, handleHintsToggle, onReset]);

  return (
    <Preferences
      preferences={DEFAULT_UI_PREFERENCES}
      aria-label={ariaLabel ?? legacyAriaLabel}
      data-slot="preferences-panel"
      className={cx('nx-preferences-panel', className)}
      {...rest}
    >
      <div className="nx-preferences-card">
        {(title || description || showReset) && (
          <div className="nx-preferences-header">
            <div className="nx-preferences-header-copy">
              {title ? (
                <div className="nx-preferences-title-row">
                  <Icon name="sliders" size={16} weight="bold" className="nx-preferences-icon" />
                  <h3 className="nx-preferences-title">{title}</h3>
                </div>
              ) : null}
              {description ? <p className="nx-preferences-description">{description}</p> : null}
            </div>
            {showReset ? (
              <Button size="xs" variant="ghost" disabled={!isNonDefault && !onReset} onClick={handleReset}>
                Reset defaults
              </Button>
            ) : null}
          </div>
        )}

        <div className="nx-preferences-rows">
          <div className="nx-preferences-item">
            <Switch
              checked={isReducedMotion}
              onCheckedChange={handleMotionToggle}
              controlPosition="end"
              label={
                <span className="nx-preferences-item-label">
                  <Icon name="lightning" size={14} weight="bold" />
                  <span>Reduce motion</span>
                </span>
              }
              description="Minimize spring animations, drawer transitions, and micro-movements."
              wrapperClassName="nx-preferences-switch-row"
            />
          </div>

          <div className="nx-preferences-item">
            <Switch
              checked={isHighContrast}
              onCheckedChange={handleContrastToggle}
              controlPosition="end"
              label="Increase border & ink contrast"
              description="Strengthen control hairlines, focus outlines, and secondary text legibility."
              wrapperClassName="nx-preferences-switch-row"
            />
          </div>

          <div className="nx-preferences-item">
            <Switch
              checked={isHintsVisible}
              onCheckedChange={handleHintsToggle}
              controlPosition="end"
              label={
                <span className="nx-preferences-item-label">
                  <span>Keyboard shortcut hints</span>
                  <ShortcutKey keys="mod+k" size="xs" />
                </span>
              }
              description="Display inline keycap badges beside buttons, menus, and toolbars."
              wrapperClassName="nx-preferences-switch-row"
            />
          </div>

          {extraToggles?.map((item) => (
            <div key={item.id} className="nx-preferences-item">
              <Switch
                checked={item.checked}
                onCheckedChange={item.onCheckedChange}
                disabled={item.disabled}
                controlPosition="end"
                label={item.label}
                description={item.description}
                wrapperClassName="nx-preferences-switch-row"
              />
            </div>
          ))}
        </div>
      </div>
    </Preferences>
  );
}
