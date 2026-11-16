/**
 * Tabs: one panel at a time, chosen from a row. Over UI SDK's Tabs, which
 * gives it the tablist, the arrow-key walk between tabs and the panel that
 * belongs to the chosen one; a disabled tab is skipped by that walk, never
 * a dead end. Controlled with `value`/`onValueChange`, uncontrolled with
 * `defaultValue`. Panels are the tab's own children, not a second render
 * the caller keeps in step.
 */
import type { ReactNode } from 'react';
import { Tabs as TabSet, TabsIndicator, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs';
import type { ChangeDetails } from './changeDetails.js';
import { told } from './internal/told.js';
import { slotted } from './internal/uiKitContext.js';

export interface TabItem {
  value: string;
  label: ReactNode;
  children: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  tabs: readonly TabItem[];
  value?: string;
  defaultValue?: string;
  /** `select` when a person chose the tab; `disabled`, `missing` or `initial` when the chosen tab went away. */
  onValueChange?: (value: string, details: ChangeDetails<'select' | 'disabled' | 'missing' | 'initial'>) => void;
  className?: string;
  /** The tablist's accessible name ("Settings sections"). Give one: a tab list without a name is read as "tab list" and
      nothing more, and the conformance check (`checkPatterns`) reports it. */
  ariaLabel?: string;
}

function DefaultTabs({ tabs, value, defaultValue, onValueChange, className, ariaLabel }: TabsProps) {
  return (
    <TabSet
      className={className}
      value={value}
      defaultValue={value === undefined ? (defaultValue ?? tabs.find((tab) => !tab.disabled)?.value) : undefined}
      onValueChange={onValueChange && ((next, details) => next !== null && onValueChange(String(next), told('select', details)))}
    >
      <TabsList aria-label={ariaLabel}>
        {tabs.map((tab) => (
          <TabsTab key={tab.value} value={tab.value} disabled={tab.disabled}>
            {tab.label}
          </TabsTab>
        ))}
        <TabsIndicator />
      </TabsList>
      {tabs.map((tab) => (
        <TabsPanel key={tab.value} value={tab.value} data-kind="kit">
          {tab.children}
        </TabsPanel>
      ))}
    </TabSet>
  );
}

/* Slotted (UiKit.tsx): an App's control kit may draw its own in place of the default, with the same props. */
export const Tabs = slotted('Tabs', DefaultTabs, { onValueChange: [1, 'select'] });
