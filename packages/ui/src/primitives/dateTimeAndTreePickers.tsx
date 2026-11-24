/**
 * Composite date-time-timezone and hierarchical tree pickers built over UI SDK's
 * popover, date, and tree primitives.
 */
'use client';

import * as React from 'react';
import { isISODate, todayDate, type ISODate } from '@ui-sdk/react/date';
import { Popover as SdkPopover, PopoverContent as SdkPopoverContent, PopoverTrigger as SdkPopoverTrigger } from '@ui-sdk/react/popover';
import { fuzzyScore } from '@ui-sdk/react/text-match';
import {
  Tree,
  TreeGroup,
  TreeItem,
  TreeItemCheckbox,
  TreeItemIndicator,
  TreeItemLabel,
  TreeItems,
  type TreeItemData,
} from '@ui-sdk/react/tree';
import { Icon } from '../Icon.js';
import { cx, isEmptyStateSpec, type ControlSize, type EmptyStateSpec } from '../internal/cx.js';
import { FieldControlBridge, wrapWithField, type FieldFrameProps } from './fieldShell.js';
import { DatePicker, TimeInput, type DatePickerValue, type HourCycle, type TimeInputGranularity } from './pickers.js';
import { Select, type SelectOption } from './selection.js';
import { HighlightMatch } from './systemPrimitives.js';

function renderEmptyNode(empty: EmptyStateSpec | React.ReactNode): React.ReactNode {
  if (isEmptyStateSpec(empty)) {
    return (
      <div className="nx-empty-inline">
        <div className="nx-empty-inline-title">{empty.title}</div>
        {empty.body !== undefined && <div className="nx-empty-inline-body">{empty.body}</div>}
        {empty.action !== undefined && <div className="nx-empty-inline-action">{empty.action}</div>}
      </div>
    );
  }
  return empty;
}

/* ============================================================================
 * 1. DateTimePicker (DatePicker + TimeInput + Optional Timezone Select)
 * ========================================================================== */

/** Selectable IANA timezone entry for `DateTimePicker`. */
export interface TimezoneOption {
  value: string;
  label: string;
  shortLabel?: string;
}

const DEFAULT_TIMEZONES: ReadonlyArray<TimezoneOption> = [
  { value: 'UTC', label: 'UTC · Coordinated Universal Time', shortLabel: 'UTC' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles (PT)', shortLabel: 'PT · LA' },
  { value: 'America/Denver', label: 'America/Denver (MT)', shortLabel: 'MT · DEN' },
  { value: 'America/Chicago', label: 'America/Chicago (CT)', shortLabel: 'CT · CHI' },
  { value: 'America/New_York', label: 'America/New_York (ET)', shortLabel: 'ET · NYC' },
  { value: 'America/Sao_Paulo', label: 'America/Sao_Paulo (BRT)', shortLabel: 'BRT · GRU' },
  { value: 'Europe/London', label: 'Europe/London (GMT/BST)', shortLabel: 'UK · LON' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin (CET)', shortLabel: 'CET · BER' },
  { value: 'Asia/Dubai', label: 'Asia/Dubai (GST)', shortLabel: 'GST · DXB' },
  { value: 'Asia/Kolkata', label: 'Asia/Kolkata (IST)', shortLabel: 'IST · BLR' },
  { value: 'Asia/Singapore', label: 'Asia/Singapore (SGT)', shortLabel: 'SGT · SIN' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo (JST)', shortLabel: 'JST · TYO' },
  { value: 'Australia/Sydney', label: 'Australia/Sydney (AET)', shortLabel: 'AET · SYD' },
];

/** Decomposed date, wall-clock time, and timezone metadata emitted by `DateTimePicker`. */
export interface DateTimeChangeDetails {
  date: string | null;
  time: string | null;
  timezone: string;
}

function parseDateTimeString(
  raw: string | null | undefined,
  granularity: TimeInputGranularity,
): { date: ISODate | null; time: string | null; offset: string } {
  if (!raw) return { date: null, time: null, offset: '' };
  const trimmed = raw.trim();
  /* The zone a timestamp was written in (`Z`, `+05:30`) is read and kept, not dropped: a value handed back without it
     names a different instant than the one that was given. */
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T\s](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?/i.exec(trimmed);
  if (!match) return { date: null, time: null, offset: '' };

  const dateCandidate = match[1];
  const parsedDate: ISODate | null = dateCandidate && isISODate(dateCandidate) ? dateCandidate : null;

  const rawTime = match[2] ?? null;
  if (!rawTime) {
    return { date: parsedDate, time: null, offset: '' };
  }
  const offset = match[3] ?? '';

  if (granularity === 'second') {
    const normalized = rawTime.length === 5 ? `${rawTime}:00` : rawTime.slice(0, 8);
    return { date: parsedDate, time: normalized, offset };
  }

  return { date: parsedDate, time: rawTime.slice(0, 5), offset };
}

/* A day with no time is written as the day alone. Filling in midnight made the time impossible to clear: the value read
   back had a time again. The offset belongs to a time, so it goes when the time does. */
function composeDateTimeString(date: ISODate | null, time: string | null, offset = ''): string | null {
  if (!date) return null;
  return time ? `${date}T${time}${offset}` : date;
}

/** Props for the `DateTimePicker` composite date, time, and timezone field. */
export interface DateTimePickerProps extends FieldFrameProps {
  id?: string;
  ariaLabel?: string;
  /** Controlled ISO datetime value such as `'2026-11-21T14:30'`, a day alone (`'2026-11-21'`, no time set) or `null`. A `Z` or offset on it is kept. */
  value?: string | null;
  /** Initial uncontrolled ISO datetime value. */
  defaultValue?: string | null;
  /** Called whenever the date, time, or timezone updates the composite timestamp. */
  onValueChange?: (value: string | null, details: DateTimeChangeDetails) => void;
  /** Display the timezone selector alongside Date and Time. */
  showTimezone?: boolean;
  /** Controlled IANA timezone identifier (e.g. `'UTC'`, `'America/New_York'`). */
  timezone?: string;
  /** Initial uncontrolled IANA timezone identifier. Defaults to `'UTC'`. */
  defaultTimezone?: string;
  /** Called when the selected timezone changes. */
  onTimezoneChange?: (timezone: string) => void;
  /** Custom list of selectable timezones. */
  timezones?: ReadonlyArray<TimezoneOption>;
  /** Smallest time segment shown. Defaults to `'minute'`. */
  granularity?: TimeInputGranularity;
  /** 12-hour or 24-hour clock. */
  hourCycle?: HourCycle;
  /** Default time filled in when picking a date from an empty state. Defaults to `'09:00'`. */
  defaultTime?: string;
  /** Show quick date presets inside the calendar popover. Defaults to `true`. */
  presets?: boolean;
  /** Allow clearing the timestamp. Defaults to `true`. */
  clearable?: boolean;
  placeholder?: string;
  locale?: string;
  timeLabel?: string;
  timezoneLabel?: string;
  timezonePlaceholder?: string;
  words?: { time?: string; timezone?: string; selectDate?: string };
  size?: ControlSize;
  disabled?: boolean;
  readOnly?: boolean;
  invalid?: boolean;
  name?: string;
  className?: string;
  fieldClassName?: string;
  ref?: React.Ref<HTMLDivElement>;
}

/** Composite date, wall-clock time, and optional IANA timezone picker framed inside one unified field box. */
export function DateTimePicker({
  id: explicitId,
  ariaLabel,
  value,
  defaultValue = null,
  onValueChange,
  showTimezone: showTimezoneProp,
  timezone: controlledTimezone,
  defaultTimezone = 'UTC',
  onTimezoneChange,
  timezones = DEFAULT_TIMEZONES,
  granularity = 'minute',
  hourCycle = 24,
  defaultTime,
  presets = true,
  clearable = true,
  placeholder,
  locale,
  timeLabel,
  timezoneLabel,
  timezonePlaceholder = 'TZ',
  words,
  size = 'md',
  disabled = false,
  readOnly = false,
  invalid,
  name,
  ref,
  label,
  hint,
  description,
  error,
  optional,
  required,
  labelTrailing,
  className,
  fieldClassName,
}: DateTimePickerProps): React.JSX.Element {
  const showTimezone = showTimezoneProp ?? (controlledTimezone !== undefined || onTimezoneChange !== undefined);

  const isInvalid = invalid ?? Boolean(error);
  const resolvedPlaceholder = placeholder ?? words?.selectDate ?? 'Select date';
  const resolvedTimeLabel = timeLabel ?? words?.time ?? 'Time';
  const resolvedTimezoneLabel = timezoneLabel ?? words?.timezone ?? 'Timezone';
  const resolvedDefaultTime = defaultTime ?? (granularity === 'second' ? '09:00:00' : '09:00');

  const [internalParts, setInternalParts] = React.useState<{
    date: ISODate | null;
    time: string | null;
    offset: string;
  }>(() => parseDateTimeString(value !== undefined ? value : defaultValue, granularity));

  const [internalTz, setInternalTz] = React.useState<string>(defaultTimezone);

  const activeTz = controlledTimezone !== undefined ? controlledTimezone : internalTz;

  const controlledParts = React.useMemo(() => (value !== undefined ? parseDateTimeString(value, granularity) : null), [value, granularity]);

  const activeDate = controlledParts ? controlledParts.date : internalParts.date;
  const activeTime = controlledParts ? controlledParts.time : internalParts.time;
  const activeOffset = controlledParts ? controlledParts.offset : internalParts.offset;

  const tzSelectOptions = React.useMemo<SelectOption<string>[]>(
    () =>
      timezones.map((tz) => ({
        value: tz.value,
        label: tz.shortLabel ?? tz.label,
        description: tz.shortLabel ? tz.label : undefined,
      })),
    [timezones],
  );

  const emitChange = React.useCallback(
    (nextDate: ISODate | null, nextTime: string | null, nextTz: string) => {
      if (value === undefined) {
        setInternalParts({ date: nextDate, time: nextTime, offset: activeOffset });
      }
      const composed = composeDateTimeString(nextDate, nextTime, activeOffset);
      onValueChange?.(composed, {
        date: nextDate,
        time: nextTime,
        timezone: nextTz,
      });
    },
    [value, activeOffset, onValueChange],
  );

  const handleDateChange = React.useCallback(
    (nextVal: DatePickerValue) => {
      if (nextVal === null) {
        emitChange(null, null, activeTz);
        return;
      }
      if (typeof nextVal === 'string') {
        const nextTime = activeTime ?? resolvedDefaultTime;
        emitChange(nextVal, nextTime, activeTz);
      }
    },
    [activeTime, activeTz, emitChange, resolvedDefaultTime],
  );

  const handleTimeChange = React.useCallback(
    (nextTime: string | null) => {
      if (nextTime === null) {
        if (value === undefined) {
          setInternalParts((prev) => ({ ...prev, time: null }));
        }
        if (activeDate) {
          onValueChange?.(composeDateTimeString(activeDate, null), {
            date: activeDate,
            time: null,
            timezone: activeTz,
          });
        }
        return;
      }
      const fallbackDate = activeDate ?? todayDate(activeTz);
      emitChange(fallbackDate, nextTime, activeTz);
    },
    [activeDate, activeTz, emitChange, onValueChange, value],
  );

  const handleTimezoneSelect = React.useCallback(
    (nextTz: string | null) => {
      if (!nextTz) return;
      if (controlledTimezone === undefined) {
        setInternalTz(nextTz);
      }
      onTimezoneChange?.(nextTz);
      if (activeDate) {
        onValueChange?.(composeDateTimeString(activeDate, activeTime, activeOffset), {
          date: activeDate,
          time: activeTime,
          timezone: nextTz,
        });
      }
    },
    [activeDate, activeTime, activeOffset, controlledTimezone, onTimezoneChange, onValueChange],
  );

  const composedHidden = composeDateTimeString(activeDate, activeTime, activeOffset) ?? '';
  const subUid = React.useId();

  const control = (
    <FieldControlBridge id={explicitId} ariaLabel={ariaLabel} invalid={isInvalid}>
      {(fieldAttrs) => (
        <div
          ref={ref}
          data-slot="datetime-picker"
          data-size={size}
          data-invalid={fieldAttrs['aria-invalid'] ? '' : undefined}
          data-disabled={disabled ? '' : undefined}
          data-has-timezone={showTimezone ? '' : undefined}
          className={cx('nx-datetime-picker', className)}
        >
          {name ? <input type="hidden" name={name} value={composedHidden} /> : null}

          <div
            data-slot="input-group"
            data-size={size}
            data-invalid={fieldAttrs['aria-invalid'] ? '' : undefined}
            data-disabled={disabled ? '' : undefined}
            className="nx-input-group nx-datetime-picker-box"
          >
            <div className="nx-datetime-date-col">
              <DatePicker
                id={fieldAttrs.id}
                ariaLabel={fieldAttrs['aria-label']}
                aria-labelledby={fieldAttrs['aria-labelledby']}
                aria-describedby={fieldAttrs['aria-describedby']}
                mode="single"
                value={activeDate}
                onValueChange={handleDateChange}
                locale={locale}
                timeZone={activeTz}
                presets={presets}
                clearable={clearable}
                placeholder={resolvedPlaceholder}
                size={size}
                disabled={disabled}
                readOnly={readOnly}
                invalid={false}
                unstyledGroup
                className="nx-datetime-date-part"
              />
            </div>

            <div className="nx-datetime-time-col">
              <TimeInput
                id={`${subUid}-time`}
                value={activeTime}
                onValueChange={handleTimeChange}
                granularity={granularity}
                hourCycle={hourCycle}
                size={size}
                disabled={disabled}
                readOnly={readOnly}
                invalid={false}
                ariaLabel={resolvedTimeLabel}
                className="nx-datetime-time-part"
              />
            </div>

            {showTimezone ? (
              <div className="nx-datetime-tz-col">
                <Select<string>
                  id={`${subUid}-tz`}
                  options={tzSelectOptions}
                  value={activeTz}
                  onValueChange={handleTimezoneSelect}
                  placeholder={timezonePlaceholder}
                  size={size}
                  disabled={disabled || readOnly}
                  ariaLabel={resolvedTimezoneLabel}
                  triggerClassName="nx-datetime-tz-trigger"
                />
              </div>
            ) : null}
          </div>
        </div>
      )}
    </FieldControlBridge>
  );

  return wrapWithField(control, {
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

/* ============================================================================
 * 2. TreeSelect / TreePicker (Popover + @ui-sdk/react/tree)
 * ========================================================================== */

/** Hierarchical node item for `TreeSelect`. */
export interface TreeSelectNode {
  value: string;
  label: string;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  disabled?: boolean;
  children?: ReadonlyArray<TreeSelectNode>;
}

interface IndexedTreeSelectEntry {
  node: TreeSelectNode;
  pathLabels: string[];
}

function indexTreeSelectNodes(
  nodes: ReadonlyArray<TreeSelectNode>,
  ancestors: string[] = [],
  acc = new Map<string, IndexedTreeSelectEntry>(),
): Map<string, IndexedTreeSelectEntry> {
  for (const node of nodes) {
    const pathLabels = [...ancestors, node.label];
    acc.set(node.value, { node, pathLabels });
    if (node.children && node.children.length > 0) {
      indexTreeSelectNodes(node.children, pathLabels, acc);
    }
  }
  return acc;
}

function toTreeItemData(nodes: ReadonlyArray<TreeSelectNode>): TreeItemData[] {
  return nodes.map((n) => ({
    value: n.value,
    label: n.label,
    disabled: n.disabled,
    children: n.children ? toTreeItemData(n.children) : undefined,
  }));
}

function collectBranchValues(nodes: ReadonlyArray<TreeSelectNode>, out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.children && n.children.length > 0) {
      out.push(n.value);
      collectBranchValues(n.children, out);
    }
  }
  return out;
}

function filterTreeSelectNodes(nodes: ReadonlyArray<TreeSelectNode>, query: string, expandedOut: Set<string>): TreeSelectNode[] {
  const result: TreeSelectNode[] = [];
  for (const node of nodes) {
    const selfMatched = fuzzyScore(node.label, query) > 0.25;
    const childMatches = node.children ? filterTreeSelectNodes(node.children, query, expandedOut) : undefined;

    if (selfMatched || (childMatches && childMatches.length > 0)) {
      if (childMatches && childMatches.length > 0) {
        expandedOut.add(node.value);
      }
      result.push({
        ...node,
        children: selfMatched && node.children && (!childMatches || childMatches.length === 0) ? node.children : childMatches,
      });
    }
  }
  return result;
}

interface TreeSelectSharedProps extends FieldFrameProps {
  id?: string;
  ariaLabel?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  /** Hierarchical tree options. */
  options?: ReadonlyArray<TreeSelectNode>;
  /** Alias for `options`. */
  nodes?: ReadonlyArray<TreeSelectNode>;
  placeholder?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  empty?: EmptyStateSpec | React.ReactNode;
  /** Display full ancestor path (`Parent / Child`) for single selection. Defaults to `true`. */
  showPath?: boolean;
  /** Show default folder/document icons when a node has no explicit `icon`. Defaults to `true`. */
  defaultIcons?: boolean;
  /** Render plain SDK `<TreeItems />` when custom icons/badges/highlights are not needed. Defaults to `false`. */
  usePlainTreeItems?: boolean;
  /** Initially expanded branch node values. Defaults to top-level branches. */
  defaultExpandedValues?: ReadonlyArray<string>;
  /** Maximum chips shown in the trigger before collapsing into `+N more` (multi-select). Defaults to `3`. */
  maxVisibleChips?: number;
  clearable?: boolean;
  size?: ControlSize;
  disabled?: boolean;
  readOnly?: boolean;
  invalid?: boolean;
  name?: string;
  words?: {
    clearSelection?: string;
    clearFilter?: string;
    clearAll?: string;
    removeChip?: (label: string) => string;
    treeOptions?: string;
    selectedCount?: (count: number) => string;
  };
  className?: string;
  contentClassName?: string;
  fieldClassName?: string;
  ref?: React.Ref<HTMLDivElement>;
}

/** Single-selection props for `TreeSelect`. */
export interface TreeSelectSingleProps extends TreeSelectSharedProps {
  multiple?: false;
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string | null, node: TreeSelectNode | null) => void;
  checkStrategy?: never;
}

/** Multi-selection props for `TreeSelect`. */
export interface TreeSelectMultiProps extends TreeSelectSharedProps {
  multiple: true;
  value?: ReadonlyArray<string>;
  defaultValue?: ReadonlyArray<string>;
  onValueChange?: (value: string[], nodes: TreeSelectNode[]) => void;
  /** Checkbox cascade strategy in multi-select mode. Defaults to `'independent'`. */
  checkStrategy?: 'independent' | 'cascade';
}

/** Props for the `TreeSelect` hierarchical dropdown picker. */
export type TreeSelectProps = TreeSelectSingleProps | TreeSelectMultiProps;

/** Searchable single- or multi-select hierarchical tree dropdown picker. */
export function TreeSelect(props: TreeSelectProps): React.JSX.Element {
  const {
    id: explicitId,
    ariaLabel: explicitAriaLabelProp,
    'aria-labelledby': explicitAriaLabelledBy,
    'aria-describedby': explicitAriaDescribedBy,
    options,
    nodes,
    placeholder = 'Select item…',
    searchable = true,
    searchPlaceholder = 'Filter hierarchy…',
    empty,
    showPath = true,
    defaultIcons = true,
    usePlainTreeItems = false,
    defaultExpandedValues,
    maxVisibleChips = 3,
    clearable = true,
    size = 'md',
    disabled = false,
    readOnly = false,
    invalid,
    name,
    words,
    label,
    hint,
    description,
    error,
    problem,
    optional,
    required,
    labelTrailing,
    className,
    contentClassName,
    fieldClassName,
    ref,
  } = props;

  const explicitAriaLabel = explicitAriaLabelProp ?? (props as unknown as { 'aria-label'?: string })['aria-label'];
  const legacyEmpty = (props as unknown as { emptyMessage?: React.ReactNode }).emptyMessage;
  const resolvedEmpty = empty ?? legacyEmpty ?? 'No matching nodes';
  const resolvedError = problem ?? error;

  const treeNodes = React.useMemo(() => options ?? nodes ?? [], [options, nodes]);

  const isInvalid = invalid ?? Boolean(resolvedError);
  const isMultiple = props.multiple === true;

  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');

  const [internalExpanded, setInternalExpanded] = React.useState<string[]>(() =>
    defaultExpandedValues ? [...defaultExpandedValues] : treeNodes.filter((n) => n.children && n.children.length > 0).map((n) => n.value),
  );

  const [internalSingle, setInternalSingle] = React.useState<string | null>(() => (!isMultiple ? (props.defaultValue ?? null) : null));
  const [internalMulti, setInternalMulti] = React.useState<string[]>(() => (isMultiple ? [...(props.defaultValue ?? [])] : []));

  const singleValue = !isMultiple ? (props.value !== undefined ? props.value : internalSingle) : null;

  const multiValues = React.useMemo<string[]>(
    () => (isMultiple ? (props.value !== undefined ? [...props.value] : internalMulti) : []),
    [isMultiple, props.value, internalMulti],
  );

  const nodeIndex = React.useMemo(() => indexTreeSelectNodes(treeNodes), [treeNodes]);

  const { visibleNodes, effectiveExpanded } = React.useMemo(() => {
    const trimmed = search.trim();
    if (!trimmed) {
      return { visibleNodes: treeNodes, effectiveExpanded: internalExpanded };
    }
    const autoExpand = new Set<string>();
    const filtered = filterTreeSelectNodes(treeNodes, trimmed, autoExpand);
    return {
      visibleNodes: filtered,
      effectiveExpanded: [...new Set([...internalExpanded, ...autoExpand, ...collectBranchValues(filtered)])],
    };
  }, [treeNodes, search, internalExpanded]);

  const sdkItems = React.useMemo(() => toTreeItemData(visibleNodes), [visibleNodes]);

  const commitSingle = React.useCallback(
    (nextVal: string | null) => {
      if (props.multiple === true) return;
      if (props.value === undefined) {
        setInternalSingle(nextVal);
      }
      const entry = nextVal ? (nodeIndex.get(nextVal)?.node ?? null) : null;
      props.onValueChange?.(nextVal, entry);
      if (nextVal !== null) {
        setOpen(false);
      }
    },
    [nodeIndex, props],
  );

  const commitMulti = React.useCallback(
    (nextVals: string[]) => {
      if (props.multiple !== true) return;
      if (props.value === undefined) {
        setInternalMulti(nextVals);
      }
      const resolvedNodes = nextVals.map((val) => nodeIndex.get(val)?.node).filter((n): n is TreeSelectNode => n !== undefined);
      props.onValueChange?.(nextVals, resolvedNodes);
    },
    [nodeIndex, props],
  );

  const removeChip = (valToRemove: string, event: React.MouseEvent) => {
    if (disabled || readOnly) return;
    event.preventDefault();
    event.stopPropagation();
    commitMulti(multiValues.filter((v) => v !== valToRemove));
  };

  const handleClearAll = (event: React.MouseEvent) => {
    if (disabled || readOnly) return;
    event.preventDefault();
    event.stopPropagation();
    if (isMultiple) {
      commitMulti([]);
    } else {
      commitSingle(null);
    }
  };

  const hasSelection = isMultiple ? multiValues.length > 0 : singleValue !== null;
  const singleEntry = singleValue ? nodeIndex.get(singleValue) : undefined;
  const treeAriaLabel = typeof label === 'string' ? label : (explicitAriaLabel ?? words?.treeOptions ?? 'Tree options');

  const renderTreeBranches = (list: ReadonlyArray<TreeSelectNode>): React.ReactNode =>
    list.map((node) => {
      const hasChildren = Boolean(node.children && node.children.length > 0);
      const resolvedIcon =
        node.icon !== undefined ? (
          node.icon
        ) : defaultIcons ? (
          hasChildren ? (
            <Icon name="folder" size={14} weight="bold" />
          ) : (
            <Icon name="file-text" size={14} />
          )
        ) : null;

      return (
        <TreeItem
          key={node.value}
          value={node.value}
          branch={hasChildren}
          disabled={node.disabled}
          label={node.label}
          className="nx-tree-select-item"
        >
          <TreeItemLabel className="nx-tree-select-row">
            {hasChildren ? (
              <TreeItemIndicator className="nx-tree-select-chevron">
                <Icon name="caret-right" size={11} weight="bold" />
              </TreeItemIndicator>
            ) : (
              <span className="nx-tree-select-leaf-spacer" aria-hidden="true" />
            )}

            {isMultiple ? (
              <TreeItemCheckbox className="nx-tree-select-checkbox">
                {(state) =>
                  state.checked === 'indeterminate' ? (
                    <Icon name="minus" size={10} weight="bold" />
                  ) : state.checked ? (
                    <Icon name="check" size={10} weight="bold" />
                  ) : null
                }
              </TreeItemCheckbox>
            ) : null}

            {resolvedIcon ? (
              <span className="nx-tree-select-node-icon" aria-hidden="true">
                {resolvedIcon}
              </span>
            ) : null}

            <HighlightMatch text={node.label} query={search} className="nx-tree-select-node-label" />

            {node.badge !== undefined ? <span className="nx-badge nx-tree-select-badge">{node.badge}</span> : null}

            {!isMultiple && singleValue === node.value ? (
              <Icon name="check" size={13} weight="bold" className="nx-tree-select-selected-mark" />
            ) : null}
          </TreeItemLabel>

          {hasChildren && node.children ? (
            <TreeGroup className="nx-tree-select-group">{renderTreeBranches(node.children)}</TreeGroup>
          ) : null}
        </TreeItem>
      );
    });

  const hiddenValue = isMultiple ? multiValues.join(',') : (singleValue ?? '');

  const pickerControl = (
    <FieldControlBridge
      id={explicitId}
      ariaLabel={explicitAriaLabel ?? (typeof label === 'string' ? label : placeholder)}
      ariaLabelledBy={explicitAriaLabelledBy}
      ariaDescribedBy={explicitAriaDescribedBy}
      invalid={isInvalid}
    >
      {(fieldAttrs) => (
        <SdkPopover
          open={open}
          onOpenChange={(nextOpen) => {
            if (disabled || readOnly) return;
            setOpen(nextOpen);
            if (!nextOpen) setSearch('');
          }}
        >
          <div
            ref={ref}
            data-slot="tree-select"
            data-size={size}
            data-multiple={isMultiple ? '' : undefined}
            data-invalid={fieldAttrs['aria-invalid'] ? '' : undefined}
            data-disabled={disabled ? '' : undefined}
            className={cx('nx-tree-select', className)}
          >
            {name ? <input type="hidden" name={name} value={hiddenValue} /> : null}

            <SdkPopoverTrigger
              id={fieldAttrs.id}
              disabled={disabled}
              data-size={size}
              data-invalid={fieldAttrs['aria-invalid'] ? '' : undefined}
              aria-label={fieldAttrs['aria-label']}
              aria-labelledby={fieldAttrs['aria-labelledby']}
              aria-describedby={fieldAttrs['aria-describedby']}
              aria-invalid={fieldAttrs['aria-invalid'] || undefined}
              className="nx-tree-select-trigger nx-focusable"
            >
              <span className="nx-tree-select-trigger-body">
                {isMultiple ? (
                  multiValues.length > 0 ? (
                    <span className="nx-tree-select-chips">
                      {multiValues.slice(0, maxVisibleChips).map((val) => {
                        const info = nodeIndex.get(val);
                        const chipLabel = info?.node.label ?? val;
                        return (
                          <span key={val} className="nx-tree-select-chip">
                            <span className="nx-tree-select-chip-text">{chipLabel}</span>
                            {!disabled && !readOnly ? (
                              <span
                                aria-hidden="true"
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={(e) => removeChip(val, e)}
                                className="nx-tree-select-chip-remove"
                              >
                                <Icon name="x" size={10.5} weight="bold" />
                              </span>
                            ) : null}
                          </span>
                        );
                      })}
                      {multiValues.length > maxVisibleChips ? (
                        <span className="nx-tree-select-chip nx-tree-select-chip-more">+{multiValues.length - maxVisibleChips} more</span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="nx-tree-select-placeholder">{placeholder}</span>
                  )
                ) : singleEntry ? (
                  <span className="nx-tree-select-single-value">
                    {singleEntry.node.icon ? (
                      <span className="nx-tree-select-value-icon" aria-hidden="true">
                        {singleEntry.node.icon}
                      </span>
                    ) : null}
                    <span className="nx-tree-select-value-text">
                      {showPath ? singleEntry.pathLabels.join(' / ') : singleEntry.node.label}
                    </span>
                  </span>
                ) : singleValue ? (
                  <span className="nx-tree-select-value-text">{singleValue}</span>
                ) : (
                  <span className="nx-tree-select-placeholder">{placeholder}</span>
                )}
              </span>

              <span className="nx-tree-select-trigger-actions" aria-hidden="true">
                <Icon name="caret-down" size={14} className="nx-select-chevron" />
              </span>
            </SdkPopoverTrigger>

            {clearable && hasSelection && !disabled && !readOnly ? (
              <button
                type="button"
                aria-label={words?.clearSelection ?? 'Clear selection'}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={handleClearAll}
                className="nx-tree-select-clear nx-focusable"
              >
                <Icon name="x" size={12} weight="bold" />
              </button>
            ) : null}

            <SdkPopoverContent
              side="bottom"
              align="start"
              sideOffset={6}
              className={cx('nx-popover-content nx-tree-select-content', contentClassName)}
            >
              {searchable ? (
                <div className="nx-popup-search nx-tree-select-search">
                  <Icon name="magnifying-glass" size={14} className="nx-popup-search-icon" />
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={searchPlaceholder}
                    aria-label={searchPlaceholder}
                    className="nx-popup-search-input"
                  />
                  {search ? (
                    <button
                      type="button"
                      onClick={() => setSearch('')}
                      aria-label={words?.clearFilter ?? 'Clear filter'}
                      className="nx-tree-select-search-clear nx-focusable"
                    >
                      <Icon name="x" size={11} weight="bold" />
                    </button>
                  ) : null}
                </div>
              ) : null}

              <div className="nx-tree-select-viewport">
                {visibleNodes.length === 0 ? (
                  <div className="nx-popup-empty">{renderEmptyNode(resolvedEmpty)}</div>
                ) : isMultiple ? (
                  <Tree
                    mode="single"
                    items={sdkItems}
                    expanded={effectiveExpanded}
                    onExpandedChange={setInternalExpanded}
                    expandOnPress={false}
                    checkable
                    checkStrategy={(props.checkStrategy ?? 'independent') as never}
                    checked={multiValues}
                    onCheckedChange={commitMulti}
                    aria-label={treeAriaLabel}
                    className="nx-tree-select-tree"
                  >
                    {usePlainTreeItems ? <TreeItems items={sdkItems} /> : renderTreeBranches(visibleNodes)}
                  </Tree>
                ) : (
                  <Tree
                    mode="single"
                    items={sdkItems}
                    value={singleValue}
                    onValueChange={commitSingle}
                    expanded={effectiveExpanded}
                    onExpandedChange={setInternalExpanded}
                    expandOnPress={false}
                    aria-label={treeAriaLabel}
                    className="nx-tree-select-tree"
                  >
                    {usePlainTreeItems ? <TreeItems items={sdkItems} /> : renderTreeBranches(visibleNodes)}
                  </Tree>
                )}
              </div>

              {isMultiple && multiValues.length > 0 ? (
                <div className="nx-tree-select-footer">
                  <span className="nx-tree-select-count">
                    {words?.selectedCount ? words.selectedCount(multiValues.length) : `${multiValues.length} selected`}
                  </span>
                  {!disabled && !readOnly ? (
                    <button type="button" onClick={() => commitMulti([])} className="nx-tree-select-reset-btn nx-focusable">
                      {words?.clearAll ?? 'Clear all'}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </SdkPopoverContent>
          </div>
        </SdkPopover>
      )}
    </FieldControlBridge>
  );

  return wrapWithField(pickerControl, {
    label,
    hint,
    description,
    error: resolvedError,
    optional,
    required,
    labelTrailing,
    name,
    disabled,
    invalid: isInvalid,
    fieldClassName,
  });
}
