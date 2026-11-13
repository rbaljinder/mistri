/**
 * Tabs: one panel at a time, chosen from a row. Over Base UI's Tabs, which
 * gives it the tablist, the arrow-key walk between tabs and the panel that
 * belongs to the chosen one; a disabled tab is skipped by that walk, never
 * a dead end. Controlled with `value`/`onValueChange`, uncontrolled with
 * `defaultValue`. Panels are the tab's own children, not a second render
 * the caller keeps in step.
 */
import type { ReactNode } from 'react';
import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import { fromBaseUi, type ChangeDetails } from './changeDetails.js';
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
  /** `select` when a person chose the tab; Base UI's `disabled`, `missing` or `initial` when the chosen tab went away. */
  onValueChange?: (value: string, details: ChangeDetails<'select' | 'disabled' | 'missing' | 'initial'>) => void;
  className?: string;
  /** The tablist's accessible name ("Settings sections"). Give one: a tab list without a name is read as "tab list" and
      nothing more, and the conformance check (`checkPatterns`) reports it. */
  ariaLabel?: string;
}

function DefaultTabs({ tabs, value, defaultValue, onValueChange, className, ariaLabel }: TabsProps) {
  return (
    <BaseTabs.Root
      className={['ui-tabs', className].filter(Boolean).join(' ')}
      value={value}
      defaultValue={defaultValue ?? tabs.find((tab) => !tab.disabled)?.value}
      onValueChange={onValueChange && ((next, details) => onValueChange(next as string, fromBaseUi(details, 'select')))}
    >
      <BaseTabs.List className="ui-tabs-list" aria-label={ariaLabel}>
        {tabs.map((tab) => (
          <BaseTabs.Tab key={tab.value} className="ui-tab" value={tab.value} disabled={tab.disabled}>
            {tab.label}
          </BaseTabs.Tab>
        ))}
      </BaseTabs.List>
      {tabs.map((tab) => (
        <BaseTabs.Panel key={tab.value} className="ui-tab-panel" value={tab.value}>
          {tab.children}
        </BaseTabs.Panel>
      ))}
    </BaseTabs.Root>
  );
}

/* Slotted (UiKit.tsx): an App's control kit may draw its own in place of the default, with the same props. */
export const Tabs = slotted('Tabs', DefaultTabs, { onValueChange: [1, 'select'] });
