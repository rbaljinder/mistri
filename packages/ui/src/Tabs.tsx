/**
 * Tabs: one panel at a time, chosen from a row. Over UI SDK's Tabs, which
 * gives it the tablist, the arrow-key walk between tabs and the panel that
 * belongs to the chosen one; a disabled tab is skipped by that walk, never
 * a dead end. Controlled with `value`/`onValueChange`, uncontrolled with
 * `defaultValue`. Panels are the tab's own children, not a second render
 * the caller keeps in step.
 */
import type { ReactNode, Ref } from 'react';
import { Tabs as TabSet, TabsIndicator, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs';
import type { ChangeDetails } from './changeDetails.js';
import { cx } from './internal/cx.js';
import { useSurfaceSeam } from './internal/surfaceSeam.js';
import { told } from './internal/told.js';
import { slotted } from './internal/uiKitContext.js';

/** Visual tab strip style variant for `Tabs`. */
export type TabsVariant = 'line' | 'underline' | 'enclosed' | 'pills';

/** Tab item definition supporting either `value` or `key` identifier and `children` or `content` panel body. */
export type TabItem<T extends string = string> = {
  label: ReactNode;
  children?: ReactNode;
  content?: ReactNode;
  icon?: ReactNode;
  count?: ReactNode;
  disabled?: boolean;
} & ({ value: T; key?: T } | { key: T; value?: T });

/** Alias for `TabItem` used by composite views and navigation surfaces. */
export type TabItemDefinition<T extends string = string> = TabItem<T>;

/** Props for the `Tabs` component. */
export interface TabsProps<T extends string = string> {
  tabs?: readonly TabItem<T>[];
  items?: readonly TabItem<T>[];
  value?: T;
  defaultValue?: T;
  /** Optional URL query parameter name synchronized through the host surface seam. */
  param?: string;
  /** Optional page grid column width span when rendered as a page block. */
  width?: 'full' | 'half' | 'third' | 'two-thirds';
  /** `select` when a person chose the tab; `disabled`, `missing` or `initial` when the chosen tab went away. */
  onValueChange?: (value: T, details: ChangeDetails<'select' | 'disabled' | 'missing' | 'initial'>) => void;
  variant?: TabsVariant;
  orientation?: 'horizontal' | 'vertical';
  activationMode?: 'automatic' | 'manual';
  fitted?: boolean;
  className?: string;
  /** The tablist's accessible name ("Settings sections"). */
  ariaLabel?: string;
  children?: ReactNode;
  ref?: Ref<HTMLDivElement>;
}

function resolveTabId<T extends string>(tab: TabItem<T>): T {
  return (tab.value ?? tab.key) as T;
}

function DefaultTabs<T extends string = string>({
  tabs,
  items,
  value,
  defaultValue,
  param,
  width,
  onValueChange,
  variant,
  orientation = 'horizontal',
  activationMode,
  fitted = false,
  className,
  ariaLabel,
  children,
  ref,
}: TabsProps<T>) {
  const seam = useSurfaceSeam();
  const urlParam = seam?.useUrlParam ? seam.useUrlParam(param) : undefined;
  const list = tabs ?? items ?? [];
  const firstEnabled = list.find((tab) => !tab.disabled);
  const fallbackValue = defaultValue ?? (firstEnabled ? resolveTabId(firstEnabled) : undefined);

  const paramValue =
    param && urlParam
      ? urlParam[0] !== undefined && list.some((t) => !t.disabled && resolveTabId(t) === urlParam[0])
        ? (urlParam[0] as T)
        : fallbackValue
      : undefined;

  const controlledValue = value ?? paramValue;
  const hasRichVariant = variant !== undefined || fitted || list.some((t) => t.icon !== undefined || t.count !== undefined);

  return (
    <TabSet
      ref={ref}
      className={cx(hasRichVariant ? 'nx-tabs' : undefined, className)}
      orientation={orientation}
      activation={activationMode}
      data-variant={variant}
      data-width={width}
      value={controlledValue}
      defaultValue={controlledValue === undefined ? fallbackValue : undefined}
      onValueChange={
        onValueChange || (param && urlParam)
          ? (next, details) => {
              if (next === null) return;
              const str = String(next) as T;
              if (param && urlParam) {
                urlParam[1](str === fallbackValue ? undefined : str);
              }
              onValueChange?.(str, told('select', details));
            }
          : undefined
      }
    >
      {list.length > 0 ? (
        <>
          <TabsList
            aria-label={ariaLabel}
            className={hasRichVariant ? 'nx-tabs-list' : undefined}
            data-variant={variant}
            data-fitted={fitted ? '' : undefined}
          >
            {list.map((tab) => {
              const id = resolveTabId(tab);
              return (
                <TabsTab key={id} value={id} disabled={tab.disabled} className={hasRichVariant ? 'nx-tabs-tab' : undefined}>
                  {tab.icon ? (
                    <span className="nx-tab-icon" aria-hidden="true">
                      {tab.icon}
                    </span>
                  ) : null}
                  <span>{tab.label}</span>
                  {tab.count !== undefined && tab.count !== null ? <span className="nx-tabs-count">{tab.count}</span> : null}
                </TabsTab>
              );
            })}
            <TabsIndicator className={hasRichVariant ? 'nx-tabs-indicator' : undefined} />
          </TabsList>
          {list.map((tab) => {
            const id = resolveTabId(tab);
            const panelBody = tab.children ?? tab.content;
            if (panelBody === undefined) return null;
            return (
              <TabsPanel key={id} value={id} data-kind="kit" className={hasRichVariant ? 'nx-tabs-panel' : undefined}>
                {panelBody}
              </TabsPanel>
            );
          })}
          {children}
        </>
      ) : (
        children
      )}
    </TabSet>
  );
}

/** Accessible tabbed panel switcher with arrow-key roving focus, indicator bar, and optional URL query param sync. */
export const Tabs = slotted('Tabs', DefaultTabs, { onValueChange: [1, 'select'] }) as typeof DefaultTabs;
