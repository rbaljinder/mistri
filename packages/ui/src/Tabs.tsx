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
  onValueChange?: (value: string) => void;
  className?: string;
  /** The tablist's accessible name, where the tabs need one ("Settings sections"). */
  ariaLabel?: string;
}

export function Tabs({ tabs, value, defaultValue, onValueChange, className, ariaLabel }: TabsProps) {
  return (
    <BaseTabs.Root
      className={['ui-tabs', className].filter(Boolean).join(' ')}
      value={value}
      defaultValue={defaultValue ?? tabs.find((tab) => !tab.disabled)?.value}
      onValueChange={onValueChange}
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
