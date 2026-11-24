/** Searchable single/multi-value Combobox, free-text Autocomplete, and inline keyboard Listbox primitives. */
import * as React from 'react';
import {
  Autocomplete as SdkAutocomplete,
  AutocompleteClear as SdkAutocompleteClear,
  AutocompleteContent as SdkAutocompleteContent,
  AutocompleteEmpty as SdkAutocompleteEmpty,
  AutocompleteInput as SdkAutocompleteInput,
  AutocompleteItem as SdkAutocompleteItem,
  AutocompleteItemIcon as SdkAutocompleteItemIcon,
  AutocompleteItemText as SdkAutocompleteItemText,
  AutocompleteList as SdkAutocompleteList,
  type ListData,
  type ListItem,
} from '@ui-sdk/react/autocomplete';
import {
  Combobox as SdkCombobox,
  ComboboxChip as SdkComboboxChip,
  ComboboxChipRemove as SdkComboboxChipRemove,
  ComboboxChips as SdkComboboxChips,
  ComboboxClear as SdkComboboxClear,
  ComboboxContent as SdkComboboxContent,
  ComboboxCreate as SdkComboboxCreate,
  ComboboxEmpty as SdkComboboxEmpty,
  ComboboxGroup as SdkComboboxGroup,
  ComboboxGroupLabel as SdkComboboxGroupLabel,
  ComboboxInput as SdkComboboxInput,
  ComboboxItem as SdkComboboxItem,
  ComboboxItemIcon as SdkComboboxItemIcon,
  ComboboxItemIndicator as SdkComboboxItemIndicator,
  ComboboxItemText as SdkComboboxItemText,
  ComboboxList as SdkComboboxList,
  ComboboxSeparator as SdkComboboxSeparator,
  ComboboxTrigger as SdkComboboxTrigger,
  ComboboxValue as SdkComboboxValue,
  ComboboxValueIcon as SdkComboboxValueIcon,
  type ComboboxProps as SdkComboboxProps,
} from '@ui-sdk/react/combobox';
import {
  Listbox as SdkListbox,
  ListboxGroup as SdkListboxGroup,
  ListboxGroupLabel as SdkListboxGroupLabel,
  ListboxItem as SdkListboxItem,
  ListboxItemIcon as SdkListboxItemIcon,
  ListboxItemIndicator as SdkListboxItemIndicator,
  ListboxSeparator as SdkListboxSeparator,
  type ListboxProps as SdkListboxProps,
} from '@ui-sdk/react/listbox';
import { Icon } from '../Icon.js';
import { cx, isEmptyStateSpec, type ControlSize, type EmptyStateSpec } from '../internal/cx.js';
import { FieldControlBridge, wrapWithField, type FieldFrameProps } from './fieldShell.js';

function optionLabelToString(label: React.ReactNode, fallback: string): string {
  if (typeof label === 'string') return label;
  if (typeof label === 'number') return String(label);
  return fallback;
}

interface GroupableOption {
  group?: string;
}

function groupBySection<Opt extends GroupableOption>(options: ReadonlyArray<Opt>): Array<{ group: string | undefined; items: Opt[] }> {
  const sections: Array<{ group: string | undefined; items: Opt[] }> = [];
  const byGroup = new Map<string | undefined, Opt[]>();

  for (const opt of options) {
    const key = opt.group;
    let bucket = byGroup.get(key);
    if (!bucket) {
      bucket = [];
      byGroup.set(key, bucket);
      sections.push({ group: key, items: bucket });
    }
    bucket.push(opt);
  }
  return sections;
}

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
 * Combobox & Autocomplete
 * ========================================================================== */

/** Single selectable option item for `Combobox`. */
export interface ComboboxOption<T = string> {
  value: T;
  label: React.ReactNode;
  textLabel?: string;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  group?: string;
  keywords?: string[];
  disabled?: boolean;
}

type ComboboxValueType<T, Multiple extends boolean | undefined> = Multiple extends true ? T[] : T | null;

/** Props for the `Combobox` searchable single/multi-select field. */
export interface ComboboxProps<T = string, Multiple extends boolean | undefined = false> extends FieldFrameProps {
  id?: string;
  name?: string;
  ariaLabel?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  options?: ReadonlyArray<ComboboxOption<T>>;
  value?: ComboboxValueType<T, Multiple>;
  defaultValue?: ComboboxValueType<T, Multiple>;
  onValueChange?: (value: ComboboxValueType<T, Multiple>) => void;
  inputValue?: string;
  defaultInputValue?: string;
  onInputValueChange?: (inputValue: string) => void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  multiple?: Multiple;
  disabled?: boolean;
  readOnly?: boolean;
  autoHighlight?: boolean;
  placeholder?: string;
  empty?: EmptyStateSpec | React.ReactNode;
  creatable?: boolean;
  onCreate?: (query: string) => unknown;
  createLabel?: (query: string) => React.ReactNode;
  clearable?: boolean;
  size?: ControlSize;
  invalid?: boolean;
  words?: {
    clearAll?: string;
    clearSelection?: string;
    toggleOptions?: string;
    removeChip?: (label: string) => string;
    createItem?: (query: string) => string;
  };
  className?: string;
  controlClassName?: string;
  contentClassName?: string;
  fieldClassName?: string;
  ref?: React.Ref<HTMLInputElement>;
  children?: React.ReactNode;
}

function renderComboboxOptionItem<T>(opt: ComboboxOption<T>): React.ReactNode {
  const plainText = opt.textLabel ?? optionLabelToString(opt.label, String(opt.value));
  return (
    <SdkComboboxItem<T>
      key={String(opt.value)}
      value={opt.value}
      label={plainText}
      keywords={opt.keywords}
      disabled={opt.disabled}
      className="nx-combobox-item"
    >
      {opt.icon ? <SdkComboboxItemIcon className="nx-item-icon">{opt.icon}</SdkComboboxItemIcon> : null}
      <div className="nx-item-copy">
        <SdkComboboxItemText className="nx-item-label">{typeof opt.label === 'string' ? opt.label : plainText}</SdkComboboxItemText>
        {opt.description ? <span className="nx-item-description">{opt.description}</span> : null}
      </div>
      <SdkComboboxItemIndicator className="nx-item-indicator">
        <Icon name="check" size={13} weight="bold" />
      </SdkComboboxItemIndicator>
    </SdkComboboxItem>
  );
}

/** Searchable single- or multi-select combobox with grouped options, multi-chip tags, and optional inline item creation. */
export function Combobox<T = string, Multiple extends boolean | undefined = false>(props: ComboboxProps<T, Multiple>): React.JSX.Element {
  const {
    id: explicitId,
    ariaLabel,
    'aria-labelledby': explicitAriaLabelledBy,
    'aria-describedby': explicitAriaDescribedBy,
    options,
    value,
    defaultValue,
    onValueChange,
    inputValue,
    defaultInputValue,
    onInputValueChange,
    open,
    defaultOpen,
    onOpenChange,
    multiple,
    placeholder = 'Search…',
    empty,
    creatable = false,
    onCreate,
    createLabel,
    clearable = true,
    size = 'md',
    invalid,
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
    controlClassName,
    contentClassName,
    fieldClassName,
    disabled,
    readOnly,
    autoHighlight,
    name,
    ref,
    children,
  } = props;

  const rawAriaLabel = ariaLabel ?? (props as unknown as { 'aria-label'?: string })['aria-label'];
  const legacyEmpty = (props as unknown as { emptyMessage?: React.ReactNode }).emptyMessage;
  const resolvedEmpty = empty ?? legacyEmpty ?? 'No matches found';
  const resolvedError = problem ?? error;
  const isInvalid = invalid ?? Boolean(resolvedError);
  const canModify = !disabled && !readOnly;

  const derivedItems = React.useMemo<ListData<T> | undefined>(() => {
    if (!options) return undefined;
    return options.map((opt) => ({
      value: opt.value,
      label: opt.textLabel ?? optionLabelToString(opt.label, String(opt.value)),
      keywords: opt.keywords,
      disabled: opt.disabled,
    }));
  }, [options]);

  const sections = React.useMemo(() => (options ? groupBySection(options) : []), [options]);
  const isMultiple = Boolean(multiple);

  const comboboxNode = (
    <FieldControlBridge
      id={explicitId}
      ariaLabel={rawAriaLabel ?? (typeof label === 'string' ? label : placeholder)}
      ariaLabelledBy={explicitAriaLabelledBy}
      ariaDescribedBy={explicitAriaDescribedBy}
      invalid={isInvalid}
    >
      {(fieldAttrs) => (
        <SdkCombobox<T, Multiple>
          {...({
            value,
            defaultValue,
            onValueChange: onValueChange ? (next: ComboboxValueType<T, Multiple>) => onValueChange(next) : undefined,
            inputValue,
            defaultInputValue,
            onInputValueChange: onInputValueChange ? (next: string) => onInputValueChange(next) : undefined,
            open,
            defaultOpen,
            onOpenChange: onOpenChange ? (next: boolean) => onOpenChange(next) : undefined,
            multiple,
            readOnly,
            autoHighlight,
            items: derivedItems,
            disabled,
            required,
            name,
          } as unknown as SdkComboboxProps<T, Multiple>)}
        >
          {children ?? (
            <>
              {isMultiple ? (
                <SdkComboboxChips
                  data-size={size}
                  data-invalid={fieldAttrs['aria-invalid'] ? '' : undefined}
                  data-disabled={disabled ? '' : undefined}
                  className={cx('nx-combobox-chips', controlClassName, className)}
                >
                  <SdkComboboxValue>
                    {(state) =>
                      Array.isArray(state.value)
                        ? (state.value as T[]).map((val, idx) => {
                            const chipText = state.labels[idx] ?? String(val);
                            return (
                              <SdkComboboxChip<T> key={String(val)} value={val} className="nx-combobox-chip">
                                <span className="nx-combobox-chip-label">{chipText}</span>
                                {canModify ? (
                                  <SdkComboboxChipRemove
                                    aria-label={words?.removeChip ? words.removeChip(chipText) : `Remove ${chipText}`}
                                    className="nx-combobox-chip-remove"
                                  >
                                    <Icon name="x" size={11} weight="bold" />
                                  </SdkComboboxChipRemove>
                                ) : null}
                              </SdkComboboxChip>
                            );
                          })
                        : null
                    }
                  </SdkComboboxValue>
                  <SdkComboboxInput
                    ref={ref}
                    id={fieldAttrs.id}
                    placeholder={placeholder}
                    aria-label={fieldAttrs['aria-label']}
                    aria-labelledby={fieldAttrs['aria-labelledby']}
                    aria-describedby={fieldAttrs['aria-describedby']}
                    aria-invalid={fieldAttrs['aria-invalid'] || undefined}
                    className="nx-combobox-chips-input"
                  />
                  <div className="nx-combobox-actions">
                    {clearable && canModify ? (
                      <SdkComboboxClear aria-label={words?.clearAll ?? 'Clear all'} className="nx-input-clear">
                        <Icon name="x" size={13} weight="bold" />
                      </SdkComboboxClear>
                    ) : null}
                    <SdkComboboxTrigger aria-label={words?.toggleOptions ?? 'Toggle options'} className="nx-combobox-trigger">
                      <Icon name="caret-down" size={14} />
                    </SdkComboboxTrigger>
                  </div>
                </SdkComboboxChips>
              ) : (
                <div
                  data-slot="input-group"
                  data-size={size}
                  data-invalid={fieldAttrs['aria-invalid'] ? '' : undefined}
                  data-disabled={disabled ? '' : undefined}
                  className={cx('nx-input-group nx-combobox-control', controlClassName, className)}
                >
                  <SdkComboboxValueIcon className="nx-input-icon" />
                  <SdkComboboxInput
                    ref={ref}
                    id={fieldAttrs.id}
                    placeholder={placeholder}
                    aria-label={fieldAttrs['aria-label']}
                    aria-labelledby={fieldAttrs['aria-labelledby']}
                    aria-describedby={fieldAttrs['aria-describedby']}
                    aria-invalid={fieldAttrs['aria-invalid'] || undefined}
                    className="nx-combobox-input"
                  />
                  {clearable && canModify ? (
                    <SdkComboboxClear aria-label={words?.clearSelection ?? 'Clear selection'} className="nx-input-clear">
                      <Icon name="x" size={13} weight="bold" />
                    </SdkComboboxClear>
                  ) : null}
                  <SdkComboboxTrigger aria-label={words?.toggleOptions ?? 'Toggle options'} className="nx-combobox-trigger">
                    <Icon name="caret-down" size={14} />
                  </SdkComboboxTrigger>
                </div>
              )}

              <SdkComboboxContent sideOffset={6} className={cx('nx-combobox-content', contentClassName)}>
                <SdkComboboxList className="nx-popup-list">
                  {options
                    ? sections.map((sec, idx) =>
                        sec.group ? (
                          <React.Fragment key={sec.group}>
                            {idx > 0 ? <SdkComboboxSeparator className="nx-popup-separator" /> : null}
                            <SdkComboboxGroup className="nx-popup-group">
                              <SdkComboboxGroupLabel className="nx-popup-group-label">{sec.group}</SdkComboboxGroupLabel>
                              {sec.items.map((opt) => renderComboboxOptionItem(opt))}
                            </SdkComboboxGroup>
                          </React.Fragment>
                        ) : (
                          <React.Fragment key={`ungrouped-${idx}`}>
                            {idx > 0 ? <SdkComboboxSeparator className="nx-popup-separator" /> : null}
                            {sec.items.map((opt) => renderComboboxOptionItem(opt))}
                          </React.Fragment>
                        ),
                      )
                    : null}
                </SdkComboboxList>
                {creatable ? (
                  <SdkComboboxCreate onCreate={onCreate} className="nx-combobox-create">
                    {(state) =>
                      createLabel ? (
                        createLabel(state.query)
                      ) : (
                        <>
                          <Icon name="plus" size={13} weight="bold" />
                          <span>{words?.createItem ? words.createItem(state.query) : `Create “${state.query}”`}</span>
                        </>
                      )
                    }
                  </SdkComboboxCreate>
                ) : (
                  <SdkComboboxEmpty className="nx-popup-empty">{renderEmptyNode(resolvedEmpty)}</SdkComboboxEmpty>
                )}
              </SdkComboboxContent>
            </>
          )}
        </SdkCombobox>
      )}
    </FieldControlBridge>
  );

  return wrapWithField(comboboxNode, {
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

/** Single suggestion entry for `Autocomplete`. */
export interface AutocompleteSuggestion {
  value: string;
  label?: string;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  keywords?: string[];
  disabled?: boolean;
}

/** Props for the `Autocomplete` free-text suggestion input. */
export interface AutocompleteProps extends FieldFrameProps {
  id?: string;
  name?: string;
  ariaLabel?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  suggestions?: ReadonlyArray<string | AutocompleteSuggestion>;
  placeholder?: string;
  leadingIcon?: React.ReactNode | false;
  clearable?: boolean;
  empty?: EmptyStateSpec | React.ReactNode;
  disabled?: boolean;
  readOnly?: boolean;
  autoHighlight?: boolean;
  size?: ControlSize;
  invalid?: boolean;
  words?: { clearInput?: string };
  className?: string;
  controlClassName?: string;
  contentClassName?: string;
  fieldClassName?: string;
  ref?: React.Ref<HTMLInputElement>;
  children?: React.ReactNode;
}

/** Free-text input with filtered popup suggestions and optional clear action. */
export function Autocomplete(props: AutocompleteProps): React.JSX.Element {
  const {
    id: explicitId,
    ariaLabel,
    'aria-labelledby': explicitAriaLabelledBy,
    'aria-describedby': explicitAriaDescribedBy,
    value,
    defaultValue,
    onValueChange,
    open,
    defaultOpen,
    onOpenChange,
    suggestions,
    placeholder = 'Type to search…',
    leadingIcon,
    clearable = true,
    empty,
    size = 'md',
    invalid,
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
    controlClassName,
    contentClassName,
    fieldClassName,
    disabled,
    readOnly,
    autoHighlight,
    name,
    ref,
    children,
  } = props;

  const rawAriaLabel = ariaLabel ?? (props as unknown as { 'aria-label'?: string })['aria-label'];
  const legacyEmpty = (props as unknown as { emptyMessage?: React.ReactNode }).emptyMessage;
  const resolvedEmpty = empty ?? legacyEmpty;
  const resolvedError = problem ?? error;
  const isInvalid = invalid ?? Boolean(resolvedError);
  const canClear = clearable && !disabled && !readOnly;

  const normalizedSuggestions = React.useMemo<AutocompleteSuggestion[] | undefined>(() => {
    if (!suggestions) return undefined;
    return suggestions.map((entry) => (typeof entry === 'string' ? { value: entry, label: entry } : entry));
  }, [suggestions]);

  const derivedItems = React.useMemo<ListData<string> | undefined>(() => {
    if (!normalizedSuggestions) return undefined;
    return normalizedSuggestions.map((entry): ListItem<string> => ({
      value: entry.value,
      label: entry.label ?? entry.value,
      keywords: entry.keywords,
      disabled: entry.disabled,
    }));
  }, [normalizedSuggestions]);

  const resolvedLeading = leadingIcon === false ? null : (leadingIcon ?? <Icon name="magnifying-glass" size={15} />);

  const autocompleteNode = (
    <FieldControlBridge
      id={explicitId}
      ariaLabel={rawAriaLabel ?? (typeof label === 'string' ? label : placeholder)}
      ariaLabelledBy={explicitAriaLabelledBy}
      ariaDescribedBy={explicitAriaDescribedBy}
      invalid={isInvalid}
    >
      {(fieldAttrs) => (
        <SdkAutocomplete
          value={value}
          defaultValue={defaultValue}
          onValueChange={onValueChange ? (next) => onValueChange(next) : undefined}
          open={open}
          defaultOpen={defaultOpen}
          onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}
          readOnly={readOnly}
          autoHighlight={autoHighlight}
          items={derivedItems}
          disabled={disabled}
          required={required}
          name={name}
        >
          {children ?? (
            <>
              <div
                data-slot="input-group"
                data-size={size}
                data-invalid={fieldAttrs['aria-invalid'] ? '' : undefined}
                data-disabled={disabled ? '' : undefined}
                className={cx('nx-input-group nx-autocomplete-control', controlClassName, className)}
              >
                {resolvedLeading ? (
                  <span className="nx-input-icon" data-side="start" aria-hidden="true">
                    {resolvedLeading}
                  </span>
                ) : null}
                <SdkAutocompleteInput
                  ref={ref}
                  id={fieldAttrs.id}
                  placeholder={placeholder}
                  aria-label={fieldAttrs['aria-label']}
                  aria-labelledby={fieldAttrs['aria-labelledby']}
                  aria-describedby={fieldAttrs['aria-describedby']}
                  aria-invalid={fieldAttrs['aria-invalid'] || undefined}
                  className="nx-autocomplete-input"
                />
                {canClear ? (
                  <SdkAutocompleteClear aria-label={words?.clearInput ?? 'Clear input'} className="nx-input-clear">
                    <Icon name="x" size={13} weight="bold" />
                  </SdkAutocompleteClear>
                ) : null}
              </div>

              <SdkAutocompleteContent sideOffset={6} className={cx('nx-autocomplete-content', contentClassName)}>
                <SdkAutocompleteList className="nx-popup-list">
                  {normalizedSuggestions
                    ? normalizedSuggestions.map((entry) => (
                        <SdkAutocompleteItem
                          key={entry.value}
                          value={entry.value}
                          label={entry.label ?? entry.value}
                          keywords={entry.keywords}
                          disabled={entry.disabled}
                          className="nx-autocomplete-item"
                        >
                          {entry.icon ? <SdkAutocompleteItemIcon className="nx-item-icon">{entry.icon}</SdkAutocompleteItemIcon> : null}
                          <div className="nx-item-copy">
                            <SdkAutocompleteItemText className="nx-item-label" />
                            {entry.description ? <span className="nx-item-description">{entry.description}</span> : null}
                          </div>
                        </SdkAutocompleteItem>
                      ))
                    : null}
                </SdkAutocompleteList>
                {resolvedEmpty ? (
                  <SdkAutocompleteEmpty className="nx-popup-empty">{renderEmptyNode(resolvedEmpty)}</SdkAutocompleteEmpty>
                ) : null}
              </SdkAutocompleteContent>
            </>
          )}
        </SdkAutocomplete>
      )}
    </FieldControlBridge>
  );

  return wrapWithField(autocompleteNode, {
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

/* ============================================================================
 * Listbox
 * ========================================================================== */

/** Single selectable option item for `Listbox`. */
export interface ListboxOption<T = string> {
  value: T;
  label: React.ReactNode;
  textLabel?: string;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  group?: string;
  keywords?: string[];
  disabled?: boolean;
}

type ListboxValueType<T, Multiple extends boolean | undefined> = Multiple extends true ? T[] : T | null;

/** Props for the `Listbox` inline keyboard selection list. */
export interface ListboxProps<T = string, Multiple extends boolean | undefined = false> extends FieldFrameProps {
  id?: string;
  name?: string;
  ariaLabel?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  options?: ReadonlyArray<ListboxOption<T>>;
  value?: ListboxValueType<T, Multiple>;
  defaultValue?: ListboxValueType<T, Multiple>;
  onValueChange?: (value: ListboxValueType<T, Multiple>) => void;
  multiple?: Multiple;
  disabled?: boolean;
  readOnly?: boolean;
  orientation?: 'vertical' | 'horizontal';
  loopFocus?: boolean;
  empty?: EmptyStateSpec | React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  fieldClassName?: string;
  ref?: React.Ref<HTMLDivElement>;
  children?: React.ReactNode;
}

function renderListboxOptionItem<T>(opt: ListboxOption<T>): React.ReactNode {
  const plainText = opt.textLabel ?? optionLabelToString(opt.label, String(opt.value));
  return (
    <SdkListboxItem<T> key={String(opt.value)} value={opt.value} label={plainText} disabled={opt.disabled} className="nx-listbox-item">
      {opt.icon ? <SdkListboxItemIcon className="nx-item-icon">{opt.icon}</SdkListboxItemIcon> : null}
      <div className="nx-item-copy">
        <span className="nx-item-label">{opt.label}</span>
        {opt.description ? <span className="nx-item-description">{opt.description}</span> : null}
      </div>
      <SdkListboxItemIndicator className="nx-item-indicator">
        <Icon name="check" size={13} weight="bold" />
      </SdkListboxItemIndicator>
    </SdkListboxItem>
  );
}

/** Inline single- or multi-select option list with grouped sections, typeahead, and arrow-key navigation. */
export function Listbox<T = string, Multiple extends boolean | undefined = false>(props: ListboxProps<T, Multiple>): React.JSX.Element {
  const {
    id,
    ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    'aria-describedby': ariaDescribedBy,
    options,
    value,
    defaultValue,
    onValueChange,
    multiple,
    orientation,
    loopFocus,
    empty,
    label,
    hint,
    description,
    error,
    problem,
    optional,
    required,
    labelTrailing,
    fieldClassName,
    disabled,
    readOnly,
    name,
    className,
    style,
    ref,
    children,
  } = props;

  const rawAriaLabel =
    ariaLabel ?? (props as unknown as { 'aria-label'?: string })['aria-label'] ?? (typeof label === 'string' ? label : undefined);
  const resolvedError = problem ?? error;

  const derivedItems = React.useMemo<ListData<T> | undefined>(() => {
    if (!options) return undefined;
    return options.map((opt) => ({
      value: opt.value,
      label: opt.textLabel ?? optionLabelToString(opt.label, String(opt.value)),
      keywords: opt.keywords,
      disabled: opt.disabled,
    }));
  }, [options]);

  const sections = React.useMemo(() => (options ? groupBySection(options) : []), [options]);

  if (options && options.length === 0 && empty !== undefined) {
    return wrapWithField(
      <div ref={ref} className={cx('nx-listbox nx-popup-empty', className)} style={style}>
        {renderEmptyNode(empty)}
      </div>,
      {
        label,
        hint,
        description,
        error: resolvedError,
        optional,
        required,
        labelTrailing,
        name,
        disabled,
        invalid: Boolean(resolvedError),
        fieldClassName,
      },
    );
  }

  const listboxControl = (
    <SdkListbox<T, Multiple>
      {...({
        id,
        ref,
        value,
        defaultValue,
        onValueChange: onValueChange ? (next: ListboxValueType<T, Multiple>) => onValueChange(next) : undefined,
        multiple,
        orientation,
        loopFocus,
        readOnly,
        items: derivedItems,
        disabled,
        required,
        name,
        'aria-label': rawAriaLabel,
        'aria-labelledby': ariaLabelledBy,
        'aria-describedby': ariaDescribedBy,
        style,
        className: cx('nx-listbox', className),
      } as unknown as SdkListboxProps<T, Multiple>)}
    >
      {options
        ? sections.map((sec, idx) =>
            sec.group ? (
              <React.Fragment key={sec.group}>
                {idx > 0 ? <SdkListboxSeparator className="nx-popup-separator" /> : null}
                <SdkListboxGroup className="nx-popup-group">
                  <SdkListboxGroupLabel className="nx-popup-group-label">{sec.group}</SdkListboxGroupLabel>
                  {sec.items.map((opt) => renderListboxOptionItem(opt))}
                </SdkListboxGroup>
              </React.Fragment>
            ) : (
              <React.Fragment key={`ungrouped-${idx}`}>
                {idx > 0 ? <SdkListboxSeparator className="nx-popup-separator" /> : null}
                {sec.items.map((opt) => renderListboxOptionItem(opt))}
              </React.Fragment>
            ),
          )
        : children}
    </SdkListbox>
  );

  return wrapWithField(listboxControl, {
    label,
    hint,
    description,
    error: resolvedError,
    optional,
    required,
    labelTrailing,
    name,
    disabled,
    invalid: Boolean(resolvedError),
    fieldClassName,
  });
}
