/** `@mistriwork/mistri/primitives`: generated self-contained declarations (`scripts/sync-ui-sdk.mjs`). @preview */
import * as React from 'react';
import type { CSSProperties, ComponentProps, HTMLAttributes, MouseEvent, ReactNode, Ref, RefObject } from 'react';
import { Avatar, type AvatarSize, type AvatarStatus, Button, type ButtonProps, type ButtonVariant, Checkbox, type CheckboxProps, type CleanElementProps, type ControlSize, type EmptyStateSpec, type FieldFrameProps, Modal, type Slot, type SpaceScale, type Tone } from './kit.js';

export { ActionBar, type ActionBarProps, AiBadge, type AiBadgeProps, type AnswerKind, Avatar, type AvatarProps, type AvatarSize, type AvatarStatus, Badge, type BadgeProps, Beside, type BesideProps, Button, ButtonLink, type ButtonLinkProps, type ButtonProps, type ButtonSize, type ButtonVariant, Card, CardBody, type CardBodyProps, CardDescription, type CardDescriptionProps, CardFooter, type CardFooterProps, CardHeader, type CardHeaderProps, type CardProps, CardTitle, type CardTitleProps, type CardVariant, Carousel, type CarouselProps, type CarouselSlide, type ChangeDetails, Checkbox, type CheckboxProps, type CheckCard, CheckCards, type CheckCardsProps, ChoiceCards, type ChoiceCardsProps, type ChoiceOption, Cluster, type ClusterProps, Consent, type ConsentProps, type ControlSize, DateField, type DateFieldOpenReason, type DateFieldProps, type DateFieldWords, type DescriptionField, DescriptionList, type DescriptionListItem, type DescriptionListItemsProps, type DescriptionListProps, type DescriptionListRecordProps, Drawer, type DrawerProps, type DrawerSide, Dropdown, type DropdownAction, type DropdownChange, type DropdownItem, type DropdownProps, DropGroup, type DropGroupProps, DropItem, type DropItemProps, DropMenu, type DropMenuProps, DropSeparator, type DropSeparatorProps, EmptyState, type EmptyStateProps, type EmptyStateSpec, Eyebrow, type EyebrowProps, Field, type FieldControlProps, type FieldFrameProps, type FieldProps, Figure, type FigureProps, FileField, type FileFieldProps, FormattedValue, type FormattedValueProps, Grid, type GridProps, Heading, type HeadingLevel, type HeadingProps, type HeadingSize, HelpTip, type HelpTipProps, IconRows, type IconRowsProps, type ItemGroup, ItemList, type ItemListProps, ItemRow, type ItemRowProps, Label, type LabelProps, type LayoutGap, type LineItemColumn, type LineItemColumnKind, type LineItemRow, type LineItemsAdjustment, LineItemsEditor, type LineItemsEditorProps, type LineItemSelectOption, MaskedField, type MaskedFieldProps, type MediaAspect, MediaCard, type MediaCardProps, Meter, type MeterProps, Modal, type ModalHandle, type ModalProps, MoneyField, type MoneyFieldProps, MultiDropdown, type MultiDropdownProps, MultiSelect, type MultiSelectProps, Pagination, type PaginationProps, Person, type PersonProps, type PhotoTile, PhotoTiles, type PhotoTilesProps, Popover, type PopoverProps, ProgressBar, type ProgressBarProps, Resizable, type ResizablePanel, type ResizableProps, ReviewList, type ReviewListProps, Row, type RowProps, ScrollArea, type ScrollAreaProps, SegmentedControl, type SegmentedControlOption, type SegmentedControlProps, type SegmentOption, Select, type SelectOption, type SelectProps, SensitiveField, type SensitiveFieldProps, Skeleton, type SkeletonProps, Slider, type SliderProps, type SpaceScale, Stack, type StackProps, StatCard, type StatCardDelta, type StatCardProps, StatusDot, type StatusDotProps, StepHeader, type StepHeaderProps, Switch, type SwitchProps, type TabItem, type TabItemDefinition, Tabs, type TabsProps, type TabsVariant, Text, TextArea, type TextAreaProps, TextField, type TextFieldProps, type TextHierarchy, type TextProps, type TextSize, type TextWeight, type Tone, Tooltip, type TooltipProps, Typeahead, type TypeaheadProps, type TypeaheadReason, ValidMark, type ValidMarkProps, type ValueFormat, VisuallyHidden, type VisuallyHiddenProps, YesNo, type YesNoProps } from './kit.js';
/** Props for the `IconButton` square icon-only action button. */
export interface IconButtonProps extends Omit<ButtonProps, 'leadingIcon' | 'trailingIcon' | 'shortcut' | 'loadingLabel' | 'block' | 'children' | 'data-icon-only' | 'iconOnly' | 'ariaLabel'> {
    /** Required accessible name for the icon-only button. */
    ariaLabel: string;
    icon?: React.ReactNode;
    children?: React.ReactNode;
}
/** Square icon-only button requiring an explicit `ariaLabel`. */
export declare function IconButton(props: IconButtonProps): React.JSX.Element | null;
/** Surface variant for `Toggle`. */
export type ToggleVariant = 'default' | 'outline' | 'ghost';
/** Props for the `Toggle` two-state press button. */
export interface ToggleProps extends CleanElementProps<'button', 'value'> {
    pressed?: boolean;
    defaultPressed?: boolean;
    onPressedChange?: (pressed: boolean) => void;
    value?: string;
    variant?: ToggleVariant;
    size?: ControlSize;
    leadingIcon?: React.ReactNode;
    trailingIcon?: React.ReactNode;
    iconOnly?: boolean;
}
/** Two-state toggle button reporting `onPressedChange`. */
export declare function Toggle({ pressed, defaultPressed, onPressedChange, variant, size, leadingIcon, trailingIcon, iconOnly, ariaLabel, className, children, ...rest }: ToggleProps): React.JSX.Element;
/** Declarative item option for `ToggleGroup`. */
export interface ToggleGroupItemOption<T extends string = string> {
    value: T;
    label: React.ReactNode;
    icon?: React.ReactNode;
    disabled?: boolean;
    ariaLabel?: string;
}
/** Props for `ToggleGroupItem`. */
export interface ToggleGroupItemProps extends Omit<ToggleProps, 'value'> {
    value: string;
    icon?: React.ReactNode;
}
/** Individual toggle button inside a `ToggleGroup`. */
export declare function ToggleGroupItem({ icon, leadingIcon, children, ...rest }: ToggleGroupItemProps): React.JSX.Element;
declare function ToggleIconPart({ ariaLabel, className, ...props }: CleanElementProps<'span'>): React.JSX.Element;
/** Props for the `ToggleGroup` single- or multi-toggle button bar. */
export interface ToggleGroupProps<T extends string = string> extends CleanElementProps<'div', 'defaultValue'> {
    items?: ReadonlyArray<ToggleGroupItemOption<T>>;
    value?: T[];
    defaultValue?: T[];
    onValueChange?: (value: T[]) => void;
    multiple?: boolean;
    disabled?: boolean;
    orientation?: 'horizontal' | 'vertical';
    loopFocus?: boolean;
    size?: ControlSize;
}
declare function ToggleGroupRoot<T extends string = string>({ items, value, defaultValue, onValueChange, multiple, disabled, orientation, loopFocus, size, ariaLabel, className, children, ...rest }: ToggleGroupProps<T>): React.JSX.Element;
/** Grouped bar of related `Toggle` buttons with roving keyboard focus. */
export declare const ToggleGroup: typeof ToggleGroupRoot & {
    Item: typeof ToggleGroupItem;
    Icon: typeof ToggleIconPart;
};
/** Props for the `Toolbar` action strip. */
export interface ToolbarProps extends CleanElementProps<'div'> {
    orientation?: 'horizontal' | 'vertical';
    disabled?: boolean;
    loopFocus?: boolean;
    size?: ControlSize;
    variant?: 'surface' | 'subtle' | 'plain';
}
/** Props for `ToolbarButton`. */
export interface ToolbarButtonProps extends CleanElementProps<'button'> {
    variant?: ButtonVariant;
    size?: ControlSize;
    iconOnly?: boolean;
}
/** Action button participating in a `Toolbar`'s roving keyboard focus. */
export declare function ToolbarButton({ variant, size, iconOnly, ariaLabel, className, ...rest }: ToolbarButtonProps): React.JSX.Element | null;
/** Props for `ToolbarLink`. */
export interface ToolbarLinkProps extends CleanElementProps<'a'> {
    variant?: ButtonVariant;
    size?: ControlSize;
}
/** Navigation link participating in a `Toolbar`'s roving keyboard focus. */
export declare function ToolbarLink({ variant, size, ariaLabel, className, ...rest }: ToolbarLinkProps): React.JSX.Element | null;
/** Props for `Toolbar.Group`. */
export type ToolbarGroupProps = CleanElementProps<'div'>;
declare function ToolbarGroupPart({ ariaLabel, className, ...props }: ToolbarGroupProps): React.JSX.Element;
/** Props for `Toolbar.Separator`. */
export type ToolbarSeparatorProps = CleanElementProps<'div'>;
declare function ToolbarSeparatorPart({ ariaLabel, className, ...props }: ToolbarSeparatorProps): React.JSX.Element;
/** Props for `Toolbar.Input`. */
export interface ToolbarInputProps extends CleanElementProps<'input'> {
    onValueChange?: (value: string) => void;
}
declare function ToolbarInputPart({ ariaLabel, onValueChange, className, ...props }: ToolbarInputProps): React.JSX.Element;
declare function ToolbarRoot({ size, variant, ariaLabel, className, ...rest }: ToolbarProps): React.JSX.Element;
/** Accessible WAI-ARIA toolbar strip with grouped controls and arrow-key roving focus. */
export declare const Toolbar: typeof ToolbarRoot & {
    Button: typeof ToolbarButton;
    Link: typeof ToolbarLink;
    Group: typeof ToolbarGroupPart;
    Separator: typeof ToolbarSeparatorPart;
    Input: typeof ToolbarInputPart;
};
/** Props for the `BulkActionBar` multi-selection command bar. */
export interface BulkActionBarProps extends CleanElementProps<'div'> {
    floating?: boolean;
    open?: boolean;
    selectedCount?: number;
    label?: React.ReactNode;
    onClearSelection?: () => void;
    clearLabel?: string;
    children: React.ReactNode;
}
/** Contextual action bar shown when one or more collection items are selected. */
export declare function BulkActionBar({ floating, open, selectedCount, label, onClearSelection, clearLabel, ariaLabel, className, children, ...rest }: BulkActionBarProps): React.JSX.Element | null;
/** Resolved accessibility attributes bridged from an enclosing `<Field>`. */
interface ResolvedFieldControlAttrs {
    id?: string;
    'aria-label'?: string;
    'aria-labelledby'?: string;
    'aria-describedby'?: string;
    'aria-invalid'?: boolean;
}
/** Props for the `Input` single-line text control. */
export interface TextInputProps extends CleanElementProps<'input', 'size' | 'prefix' | 'value' | 'defaultValue'>, FieldFrameProps {
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    size?: ControlSize;
    leadingIcon?: React.ReactNode;
    trailingIcon?: React.ReactNode;
    prefix?: React.ReactNode;
    suffix?: React.ReactNode;
    clearable?: boolean;
    clearLabel?: string;
    shortcut?: string;
    invalid?: boolean;
    monospace?: boolean;
    groupClassName?: string;
    fieldClassName?: string;
}
declare function InputGroupPart({ ariaLabel, className, ...props }: CleanElementProps<'div'>): React.JSX.Element;
declare function InputClearPart({ ariaLabel, className, ...props }: CleanElementProps<'button'>): React.JSX.Element;
declare function InputRoot(props: TextInputProps): React.JSX.Element | null;
/** Single-line text input supporting adornments, clear button, keyboard shortcut badge, and field framing. */
export declare const Input: typeof InputRoot & {
    Group: typeof InputGroupPart;
    Clear: typeof InputClearPart;
};
/** Props for the `PasswordInput` visibility-toggleable secret field. */
export interface PasswordInputProps extends FieldFrameProps {
    id?: string;
    name?: string;
    form?: string;
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    visible?: boolean;
    defaultVisible?: boolean;
    onVisibleChange?: (visible: boolean) => void;
    placeholder?: string;
    autoComplete?: string;
    autoFocus?: boolean;
    maxLength?: number;
    minLength?: number;
    pattern?: string;
    inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
    disabled?: boolean;
    readOnly?: boolean;
    onBlur?: React.FocusEventHandler<HTMLInputElement>;
    onFocus?: React.FocusEventHandler<HTMLInputElement>;
    onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
    ariaLabel?: string;
    'aria-describedby'?: string;
    size?: ControlSize;
    leadingIcon?: React.ReactNode;
    showStrength?: boolean;
    invalid?: boolean;
    monospace?: boolean;
    copyable?: boolean;
    toggleLabel?: string;
    capsLockTitle?: string;
    copyLabel?: string;
    copiedLabel?: string;
    className?: string;
    fieldClassName?: string;
    ref?: React.Ref<HTMLInputElement>;
}
declare function PasswordInputControlPart({ ariaLabel, className, ...props }: CleanElementProps<'input'>): React.JSX.Element;
declare function PasswordInputTogglePart({ ariaLabel, className, ...props }: CleanElementProps<'button'>): React.JSX.Element;
declare function PasswordInputRoot(props: PasswordInputProps): React.JSX.Element;
/** Single-box password input with reveal toggle, Caps Lock indicator, optional copy action, and strength meter. */
export declare const PasswordInput: typeof PasswordInputRoot & {
    Root: typeof PasswordInputRoot;
    Control: typeof PasswordInputControlPart;
    Toggle: typeof PasswordInputTogglePart;
};
/**
 * Numeric stepper inputs, pattern-masked inputs, multi-slot verification codes (OTP),
 * tokenized tag inputs, and drag-and-drop file dropzones over UI SDK primitives.
 */
/** Props for the `NumberInput` stepper control. */
export interface NumberInputProps extends FieldFrameProps {
    id?: string;
    name?: string;
    form?: string;
    value?: number | string | null;
    defaultValue?: number | string | null;
    /** Every edit as a number. For a value past a float's precision this is the nearest number: keep `onStringValueChange` for the exact text. */
    onValueChange?: (value: number | null) => void;
    onValueCommit?: (value: number | null) => void;
    /** Every edit as text, exact whatever the size. */
    onStringValueChange?: (value: string) => void;
    min?: number;
    max?: number;
    step?: number;
    largeStep?: number;
    smallStep?: number;
    format?: Intl.NumberFormatOptions;
    locale?: string;
    wheel?: boolean;
    placeholder?: string;
    autoFocus?: boolean;
    disabled?: boolean;
    readOnly?: boolean;
    onBlur?: React.FocusEventHandler<HTMLInputElement>;
    onFocus?: React.FocusEventHandler<HTMLInputElement>;
    ariaLabel?: string;
    'aria-describedby'?: string;
    size?: ControlSize;
    prefix?: React.ReactNode;
    suffix?: React.ReactNode;
    scrubLabel?: React.ReactNode;
    hideSteppers?: boolean;
    invalid?: boolean;
    words?: {
        decrease?: string;
        increase?: string;
    };
    className?: string;
    fieldClassName?: string;
    ref?: React.Ref<HTMLInputElement>;
    children?: React.ReactNode;
}
declare function NumberInputGroupPart({ ariaLabel, className, ...props }: CleanElementProps<'div'>): React.JSX.Element;
declare function NumberInputControlPart({ ariaLabel, className, ...props }: CleanElementProps<'input'>): React.JSX.Element;
declare function NumberInputIncrementPart({ ariaLabel, className, ...props }: CleanElementProps<'button'>): React.JSX.Element;
declare function NumberInputDecrementPart({ ariaLabel, className, ...props }: CleanElementProps<'button'>): React.JSX.Element;
declare function NumberInputScrubAreaPart({ ariaLabel, className, ...props }: CleanElementProps<'span'>): React.JSX.Element;
declare function NumberInputScrubCursorPart({ ariaLabel, className, ...props }: CleanElementProps<'span'>): React.JSX.Element;
declare function NumberInputRoot(props: NumberInputProps): React.JSX.Element;
/** Numeric spinbutton input with inline increment/decrement steppers, prefix/suffix affixes, and `> 2^53` BigInt preservation. */
export declare const NumberInput: typeof NumberInputRoot & {
    Root: typeof NumberInputRoot;
    Group: typeof NumberInputGroupPart;
    Control: typeof NumberInputControlPart;
    Increment: typeof NumberInputIncrementPart;
    Decrement: typeof NumberInputDecrementPart;
    ScrubArea: typeof NumberInputScrubAreaPart;
    ScrubAreaCursor: typeof NumberInputScrubCursorPart;
};
/** Props for the `OTPInput` verification code field. */
export interface OTPInputProps extends CleanElementProps<'div', 'defaultValue' | 'children'>, FieldFrameProps {
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    onComplete?: (value: string) => void;
    length?: number;
    maxLength?: number;
    pattern?: string;
    inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
    autoComplete?: string;
    autoFocus?: boolean;
    name?: string;
    form?: string;
    disabled?: boolean;
    readOnly?: boolean;
    separatorAfter?: number | ReadonlyArray<number>;
    size?: ControlSize;
    invalid?: boolean;
    fieldClassName?: string;
    children?: React.ReactNode;
}
declare function OTPGroupPart({ ariaLabel, className, ...props }: CleanElementProps<'div'>): React.JSX.Element;
declare function OTPSlotPart({ index, ariaLabel, className, ...props }: CleanElementProps<'div'> & {
    index: number;
}): React.JSX.Element;
declare function OTPSeparatorPart({ ariaLabel, className, ...props }: CleanElementProps<'div'>): React.JSX.Element;
declare function OTPInputRoot(props: OTPInputProps): React.JSX.Element;
/** Multi-character one-time passcode verification input with grouped character cells and paste support. */
export declare const OTPInput: typeof OTPInputRoot & {
    Root: typeof OTPInputRoot;
    Group: typeof OTPGroupPart;
    Slot: typeof OTPSlotPart;
    Separator: typeof OTPSeparatorPart;
};
/** Structured token chip entry inside `TokenInput`. */
export interface TokenItem {
    id: string;
    type: string;
    value: string;
    label: string;
}
/** What `TokenInput` holds: its chips. A string is a tag by its text, so a list of tags can be passed as it is. */
export type TokenInputValue = Array<string | TokenItem>;
/** Props for the `TokenInput` / `TagInput` multi-value chip editor. */
export interface TokenInputProps extends FieldFrameProps {
    id?: string;
    name?: string;
    value?: TokenInputValue;
    defaultValue?: TokenInputValue;
    onValueChange?: (value: TokenInputValue) => void;
    placeholder?: string;
    tags?: ReadonlyArray<string>;
    defaultTags?: ReadonlyArray<string>;
    onTagsChange?: (tags: string[]) => void;
    commitOnEnter?: boolean;
    commitOnComma?: boolean;
    disabled?: boolean;
    readOnly?: boolean;
    ariaLabel?: string;
    size?: ControlSize;
    invalid?: boolean;
    renderToken?: (token: TokenItem) => React.ReactNode;
    className?: string;
    editorClassName?: string;
    fieldClassName?: string;
    ref?: React.Ref<HTMLDivElement>;
    children?: React.ReactNode;
}
declare function TokenEditorPart({ ariaLabel, className, ...props }: CleanElementProps<'div'>): React.JSX.Element;
declare function TokenChipPart({ ariaLabel, className, ...props }: CleanElementProps<'span'>): React.JSX.Element;
declare function TokenChipRemovePart({ ariaLabel, className, ...props }: CleanElementProps<'button'>): React.JSX.Element;
declare function TokenInputRoot(props: TokenInputProps): React.JSX.Element;
/** Inline tokenized chip editor: Enter, a comma, a pasted list or leaving the box turns typed text into removable chips. */
export declare const TokenInput: typeof TokenInputRoot & {
    Root: typeof TokenInputRoot;
    Editor: typeof TokenEditorPart;
    Token: typeof TokenChipPart;
    TokenRemove: typeof TokenChipRemovePart;
};
/** Props for `TagInput`. */
export type TagInputProps = TokenInputProps;
/** Tag chip input alias for `TokenInput`. */
export declare const TagInput: typeof TokenInputRoot & {
    Root: typeof TokenInputRoot;
    Editor: typeof TokenEditorPart;
    Token: typeof TokenChipPart;
    TokenRemove: typeof TokenChipRemovePart;
};
/** Props for the `FileDropzone` drag-and-drop upload area. */
export interface FileDropzoneProps extends CleanElementProps<'div', 'title' | 'defaultValue'>, FieldFrameProps {
    value?: File[];
    defaultValue?: File[];
    onValueChange?: (files: File[]) => void;
    accept?: string | string[];
    maxSize?: number;
    maxFiles?: number;
    multiple?: boolean;
    disabled?: boolean;
    name?: string;
    title?: React.ReactNode;
    dropzoneDescription?: React.ReactNode;
    triggerLabel?: React.ReactNode;
    compact?: boolean;
    showFileList?: boolean;
    invalid?: boolean;
    words?: {
        removeFile?: (name: string) => string;
        dropHint?: string;
    };
    fieldClassName?: string;
}
declare function FileDropzoneBoxPart({ ariaLabel, className, ...props }: CleanElementProps<'div'>): React.JSX.Element;
declare function FileDropzoneTriggerPart({ ariaLabel, className, ...props }: CleanElementProps<'button'>): React.JSX.Element;
declare function FileDropzoneListPart({ ariaLabel, className, ...props }: CleanElementProps<'div'>): React.JSX.Element;
declare function FileDropzoneItemPart({ ariaLabel, className, ...props }: CleanElementProps<'div'>): React.JSX.Element;
declare function FileDropzoneItemRemovePart({ ariaLabel, className, ...props }: CleanElementProps<'button'>): React.JSX.Element;
declare function FileDropzoneRoot(props: FileDropzoneProps): React.JSX.Element;
/** Drag-and-drop file upload surface with accept/size constraints and removable file queue. */
export declare const FileDropzone: typeof FileDropzoneRoot & {
    Root: typeof FileDropzoneRoot;
    Dropzone: typeof FileDropzoneBoxPart;
    Trigger: typeof FileDropzoneTriggerPart;
    List: typeof FileDropzoneListPart;
    Item: typeof FileDropzoneItemPart;
    ItemRemove: typeof FileDropzoneItemRemovePart;
};
/** Single and multi-value selection controls: checkboxes, radio groups, choice cards, selects, switches, and ratings. */
/** Single option item for `CheckboxGroup`. */
export interface CheckboxOption<T extends string = string> {
    value: T;
    label: React.ReactNode;
    description?: React.ReactNode;
    disabled?: boolean;
}
/** Props for the `CheckboxGroup` multi-selection field. */
export interface CheckboxGroupProps<T extends string = string> extends CleanElementProps<'div', 'defaultValue'>, FieldFrameProps {
    options?: ReadonlyArray<CheckboxOption<T>>;
    value?: T[];
    defaultValue?: T[];
    onValueChange?: (value: T[]) => void;
    allValues?: T[];
    name?: string;
    disabled?: boolean;
    orientation?: 'vertical' | 'horizontal';
    fieldClassName?: string;
}
declare function CheckboxGroupRoot<T extends string = string>(props: CheckboxGroupProps<T>): React.JSX.Element;
/** Multi-checkbox field group reporting `onValueChange` with the array of checked values. */
export declare const CheckboxGroup: typeof CheckboxGroupRoot & {
    Item: (props: CheckboxProps) => React.ReactNode;
};
/** Single option item for `RadioGroup`. */
export interface RadioOption<T extends string = string> {
    value: T;
    label: React.ReactNode;
    description?: React.ReactNode;
    disabled?: boolean;
}
/** Props for `RadioItem`. */
export interface RadioItemProps extends CleanElementProps<'span', 'children'> {
    value: string;
    disabled?: boolean;
    readOnly?: boolean;
    required?: boolean;
    label?: React.ReactNode;
    description?: React.ReactNode;
    wrapperClassName?: string;
    children?: React.ReactNode;
}
/** Single radio dot option with optional label and description row. */
export declare function RadioItem({ value, label, description, disabled, readOnly, required, ariaLabel, className, wrapperClassName, children, ...rest }: RadioItemProps): React.JSX.Element | null;
declare function RadioDotPart({ value, disabled, ariaLabel, className, ...props }: CleanElementProps<'span'> & {
    value: string;
    disabled?: boolean;
}): React.JSX.Element;
declare function RadioIndicatorPart({ ariaLabel, className, ...props }: CleanElementProps<'span'>): React.JSX.Element;
/** Props for the `RadioGroup` single-selection field. */
export interface RadioGroupProps<T extends string = string> extends CleanElementProps<'div', 'defaultValue'>, FieldFrameProps {
    options?: ReadonlyArray<RadioOption<T>>;
    value?: T;
    defaultValue?: T;
    onValueChange?: (value: T) => void;
    name?: string;
    disabled?: boolean;
    readOnly?: boolean;
    orientation?: 'vertical' | 'horizontal';
    fieldClassName?: string;
}
declare function RadioGroupRoot<T extends string = string>(props: RadioGroupProps<T>): React.JSX.Element;
/** Exclusive radio button group reporting `onValueChange` with arrow-key roving focus. */
export declare const RadioGroup: typeof RadioGroupRoot & {
    Item: typeof RadioItem;
    Radio: typeof RadioDotPart;
    Indicator: typeof RadioIndicatorPart;
};
/** Props for the `Rating` star-score selector. */
export interface RatingProps extends CleanElementProps<'div', 'defaultValue' | 'children'>, FieldFrameProps {
    value?: number | null;
    defaultValue?: number | null;
    onValueChange?: (value: number | null) => void;
    max?: number;
    allowHalf?: boolean;
    allowClear?: boolean;
    disabled?: boolean;
    readOnly?: boolean;
    name?: string;
    formatValueLabel?: (value: number, max: number) => string;
    size?: ControlSize;
    showValue?: boolean;
    fieldClassName?: string;
    children?: React.ReactNode;
}
declare function RatingItemPart({ ariaLabel, className, ...props }: CleanElementProps<'span'>): React.JSX.Element;
declare function RatingRoot(props: RatingProps): React.JSX.Element;
/** Star rating selector supporting half-star precision, keyboard arrows, and numeric readout. */
export declare const Rating: typeof RatingRoot & {
    Root: typeof RatingRoot;
    Item: typeof RatingItemPart;
};
/** Searchable single/multi-value Combobox, free-text Autocomplete, and inline keyboard Listbox primitives. */
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
/** Searchable single- or multi-select combobox with grouped options, multi-chip tags, and optional inline item creation. */
export declare function Combobox<T = string, Multiple extends boolean | undefined = false>(props: ComboboxProps<T, Multiple>): React.JSX.Element;
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
    words?: {
        clearInput?: string;
    };
    className?: string;
    controlClassName?: string;
    contentClassName?: string;
    fieldClassName?: string;
    ref?: React.Ref<HTMLInputElement>;
    children?: React.ReactNode;
}
/** Free-text input with filtered popup suggestions and optional clear action. */
export declare function Autocomplete(props: AutocompleteProps): React.JSX.Element;
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
/** Inline single- or multi-select option list with grouped sections, typeahead, and arrow-key navigation. */
export declare function Listbox<T = string, Multiple extends boolean | undefined = false>(props: ListboxProps<T, Multiple>): React.JSX.Element;
/** Calendar grids, date pickers (single and range), wall-clock time inputs, color pickers, and trigger menus. */
/** Clock display cycle (`12` or `24` hour). */
export type HourCycle = 12 | 24;
/** Precision unit for `TimeInput`. */
export type TimeInputGranularity = 'hour' | 'minute' | 'second';
/** Selected date value controlled by `DatePicker` (`YYYY-MM-DD`, range tuple, or `null`). */
export type DatePickerValue = string | [string, string] | string[] | null;
/** Props for the `TimeInput` segmented wall-clock field. */
export interface TimeInputProps extends FieldFrameProps {
    id?: string;
    name?: string;
    value?: string | null;
    defaultValue?: string | null;
    onValueChange?: (value: string | null) => void;
    min?: string;
    max?: string;
    granularity?: TimeInputGranularity;
    hourCycle?: HourCycle;
    locale?: string;
    disabled?: boolean;
    readOnly?: boolean;
    ariaLabel?: string;
    'aria-labelledby'?: string;
    'aria-describedby'?: string;
    size?: ControlSize;
    showIcon?: boolean;
    invalid?: boolean;
    className?: string;
    style?: React.CSSProperties;
    fieldClassName?: string;
    ref?: React.Ref<HTMLDivElement>;
    children?: React.ReactNode;
}
/** Segmented keyboard wall-clock time input (`HH:MM` or `HH:MM:SS`). */
export declare function TimeInput(props: TimeInputProps): React.JSX.Element;
/** Props for the inline `CalendarGrid` month picker. */
export interface CalendarGridProps {
    mode?: 'single' | 'range' | 'multiple';
    value?: DatePickerValue;
    defaultValue?: DatePickerValue;
    onValueChange?: (value: DatePickerValue) => void;
    focusedValue?: string;
    defaultFocusedValue?: string;
    onFocusedValueChange?: (focused: string) => void;
    min?: string;
    max?: string;
    isDateDisabled?: (date: string) => boolean;
    isDateUnavailable?: (date: string) => boolean;
    months?: number;
    monthYearPicker?: boolean;
    bordered?: boolean;
    fixedWeeks?: boolean;
    showOutsideDays?: boolean;
    locale?: string;
    timeZone?: string;
    disabled?: boolean;
    readOnly?: boolean;
    ariaLabel?: string;
    className?: string;
    style?: React.CSSProperties;
    ref?: React.Ref<HTMLDivElement>;
    children?: React.ReactNode;
}
/** Inline interactive month calendar grid supporting single, range, and multi-date selection. */
export declare function CalendarGrid(props: CalendarGridProps): React.JSX.Element;
/** Quick-select date preset option for `DatePicker`. */
export interface DatePresetItem<V extends DatePickerValue = DatePickerValue> {
    label: React.ReactNode;
    value: V;
}
/** Props for the `DatePicker` popover date and date-range field. */
export interface DatePickerProps extends FieldFrameProps {
    id?: string;
    name?: string;
    ariaLabel?: string;
    'aria-labelledby'?: string;
    'aria-describedby'?: string;
    mode?: 'single' | 'range';
    value?: DatePickerValue;
    defaultValue?: DatePickerValue;
    onValueChange?: (value: DatePickerValue) => void;
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    min?: string;
    max?: string;
    isDateDisabled?: (date: string) => boolean;
    isDateUnavailable?: (date: string) => boolean;
    months?: number;
    presets?: boolean | ReadonlyArray<DatePresetItem>;
    clearable?: boolean;
    clearLabel?: string;
    presetsLabel?: string;
    monthYearPicker?: boolean;
    fixedWeeks?: boolean;
    showOutsideDays?: boolean;
    locale?: string;
    timeZone?: string;
    placeholder?: string;
    endPlaceholder?: string;
    disabled?: boolean;
    readOnly?: boolean;
    size?: ControlSize;
    invalid?: boolean;
    /** Suppress the inner `data-slot="input-group"` wrapper when embedded inside `DateTimePicker`. */
    unstyledGroup?: boolean;
    words?: {
        openCalendar?: string;
        startDate?: string;
        endDate?: string;
        clearDate?: string;
        quickSelect?: string;
    };
    className?: string;
    contentClassName?: string;
    fieldClassName?: string;
    ref?: React.Ref<HTMLInputElement>;
    children?: React.ReactNode;
}
/** Popover date and date-range field (`mode="single"` or `mode="range"`) with segmented input and quick presets. */
export declare function DatePicker(props: DatePickerProps): React.JSX.Element;
/** Props for the `ColorPicker` spectrum, slider, hex input, and swatch selector. */
export interface ColorPickerProps extends FieldFrameProps {
    id?: string;
    name?: string;
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    onValueCommit?: (value: string) => void;
    space?: 'hsv' | 'hsl' | 'rgb';
    swatches?: ReadonlyArray<string>;
    showSwatches?: boolean;
    showAlpha?: boolean;
    showEyeDropper?: boolean;
    showInput?: boolean;
    disabled?: boolean;
    readOnly?: boolean;
    ariaLabel?: string;
    invalid?: boolean;
    words?: {
        colorValue?: string;
        pickFromScreen?: string;
        swatches?: string;
    };
    className?: string;
    style?: React.CSSProperties;
    fieldClassName?: string;
    ref?: React.Ref<HTMLDivElement>;
    children?: React.ReactNode;
}
/** Interactive 2D color spectrum, hue/alpha sliders, hex field, eyedropper, and theme palette swatches. */
export declare function ColorPicker(props: ColorPickerProps): React.JSX.Element;
/** Single completion option item for `TriggerMenu`. */
export interface TriggerMenuItemOption<T = string> {
    value: T;
    label: string;
    keywords?: string[];
    disabled?: boolean;
    insertText?: string;
}
/** Trigger character and item source configuration for `TriggerMenu`. */
export interface TriggerMenuTrigger<T = string> {
    char: string;
    items: ReadonlyArray<TriggerMenuItemOption<T>> | ((query: string) => Promise<ReadonlyArray<TriggerMenuItemOption<T>>>);
}
/** Props for the `TriggerMenu` `@mention` and `/slash` text input. */
export interface TriggerMenuProps<T = string> extends FieldFrameProps {
    id?: string;
    name?: string;
    /** Shorthand single trigger character (default `'@'`), used when `triggers` is omitted. */
    trigger?: string;
    /** Shorthand items or async loader for the single `trigger`. */
    items?: ReadonlyArray<TriggerMenuItemOption<T>> | ((query: string) => Promise<ReadonlyArray<TriggerMenuItemOption<T>>>);
    /** Full multi-trigger configuration (e.g. both `'@'` and `'/'`). */
    triggers?: ReadonlyArray<TriggerMenuTrigger<T>>;
    multiline?: boolean;
    rows?: number;
    placeholder?: string;
    value?: string;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    onSelect?: (item: TriggerMenuItemOption<T>, triggerChar: string) => void;
    empty?: EmptyStateSpec | React.ReactNode;
    disabled?: boolean;
    readOnly?: boolean;
    ariaLabel?: string;
    invalid?: boolean;
    className?: string;
    inputClassName?: string;
    contentClassName?: string;
    fieldClassName?: string;
    ref?: React.Ref<HTMLTextAreaElement | HTMLInputElement>;
    children?: React.ReactNode;
}
/** Single- or multi-line text input that opens an inline completion popup on trigger characters (`@`, `/`). */
export declare function TriggerMenu<T = string>(props: TriggerMenuProps<T>): React.JSX.Element;
/** Multi-column form sections, field column grids, and sticky form action bars. */
/** Props for the `FormSection` titled field group. */
export interface FormSectionProps extends CleanElementProps<'section', 'title'> {
    title?: React.ReactNode;
    description?: React.ReactNode;
    aside?: React.ReactNode;
    footer?: React.ReactNode;
    layout?: 'horizontal' | 'stacked';
    bordered?: boolean;
    children: React.ReactNode;
}
/** Titled form section pairing an introductory heading/description column with a stack of fields. */
export declare function FormSection({ title, description, aside, footer, layout, bordered, ariaLabel, className, children, ...rest }: FormSectionProps): React.JSX.Element;
/** Props for the `FormColumns` multi-column form field grid. */
export interface FormColumnsProps extends CleanElementProps<'div'> {
    columns?: 1 | 2 | 3 | 4;
    gap?: 'sm' | 'md' | 'lg';
    align?: 'start' | 'center' | 'end' | 'stretch';
}
/** Responsive multi-column grid for arranging related form fields side by side. */
export declare function FormColumns({ columns, gap, align, ariaLabel, className, children, ...rest }: FormColumnsProps): React.JSX.Element;
/** Props for the `FormActions` submit/cancel button footer. */
export interface FormActionsProps extends CleanElementProps<'div'> {
    align?: 'start' | 'end' | 'between';
    bordered?: boolean;
    sticky?: boolean;
}
/** Form footer bar aligning primary and secondary form action buttons. */
export declare function FormActions({ align, bordered, sticky, ariaLabel, className, children, ...rest }: FormActionsProps): React.JSX.Element;
/** Destructive or standard action styling variant for `AlertDialog`. */
export type AlertDialogVariant = 'default' | 'danger';
/** Props for the `AlertDialog` confirmation modal. */
export interface AlertDialogProps {
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    onOpenChangeComplete?: (open: boolean) => void;
    dismissible?: boolean;
    trigger?: ReactNode;
    title?: ReactNode;
    description?: ReactNode;
    confirmLabel?: ReactNode;
    cancelLabel?: ReactNode;
    variant?: AlertDialogVariant;
    tone?: Tone;
    onConfirm?: () => unknown;
    confirmationFallbackTitle?: string;
    ariaLabel?: string;
    className?: string;
    style?: CSSProperties;
    ref?: Ref<HTMLDivElement>;
    children?: ReactNode;
}
/** Modal confirmation dialog requiring explicit user acknowledgement before running an action. */
export declare function AlertDialog({ open, defaultOpen, onOpenChange, onOpenChangeComplete, dismissible, trigger, title, description, confirmLabel, cancelLabel, variant, tone, onConfirm, confirmationFallbackTitle, ariaLabel, className, style, ref, children, }: AlertDialogProps): import("react").JSX.Element;
/** Standard action item inside a `DropdownMenu`, `ContextMenu`, or `Menubar`. */
export interface MenuActionEntry {
    type?: 'item';
    id?: string;
    value?: string;
    label: ReactNode;
    icon?: ReactNode;
    shortcut?: string;
    danger?: boolean;
    destructive?: boolean;
    disabled?: boolean;
    closeOnSelect?: boolean;
    onSelect?: () => unknown;
}
/** Visual divider entry between menu sections. */
export interface MenuSeparatorEntry {
    type: 'separator';
    id?: string;
}
/** Titled group of menu entries. */
export interface MenuGroupEntry {
    type: 'group';
    id?: string;
    label?: ReactNode;
    items: ReadonlyArray<MenuEntry>;
}
/** Checkable boolean toggle item inside a menu. */
export interface MenuCheckboxEntry {
    type: 'checkbox';
    id?: string;
    value: string;
    label: ReactNode;
    icon?: ReactNode;
    checked?: boolean;
    defaultChecked?: boolean;
    disabled?: boolean;
    closeOnSelect?: boolean;
    onCheckedChange?: (checked: boolean) => void;
}
/** Exclusive radio selection group inside a menu. */
export interface MenuRadioGroupEntry {
    type: 'radio-group';
    id?: string;
    name: string;
    label?: ReactNode;
    value?: string | null;
    defaultValue?: string | null;
    onValueChange?: (value: string) => void;
    items: ReadonlyArray<{
        value: string;
        label: ReactNode;
        disabled?: boolean;
    }>;
}
/** Nested cascading submenu entry. */
export interface MenuSubmenuEntry {
    type?: 'submenu';
    id?: string;
    label: ReactNode;
    icon?: ReactNode;
    disabled?: boolean;
    submenu: ReadonlyArray<MenuEntry>;
}
/** Union of declarative menu entries supported by `DropdownMenu`, `ContextMenu`, and `Menubar`. */
export type MenuEntry = MenuActionEntry | MenuSeparatorEntry | MenuGroupEntry | MenuCheckboxEntry | MenuRadioGroupEntry | MenuSubmenuEntry;
/** Props for the `DropdownMenu` action menu. */
export interface DropdownMenuProps {
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    disabled?: boolean;
    loopFocus?: boolean;
    trigger?: ReactNode;
    items?: ReadonlyArray<MenuEntry>;
    side?: 'top' | 'bottom' | 'left' | 'right';
    align?: 'start' | 'center' | 'end';
    sideOffset?: number;
    ariaLabel?: string;
    className?: string;
    style?: CSSProperties;
    ref?: Ref<HTMLDivElement>;
    children?: ReactNode;
}
/** Button-triggered popup menu supporting actions, checkboxes, radio groups, shortcuts, and cascading submenus. */
export declare function DropdownMenu({ open, defaultOpen, onOpenChange, disabled, loopFocus, trigger, items, side, align, sideOffset, ariaLabel, className, style, ref, children, }: DropdownMenuProps): import("react").JSX.Element;
/** Props for the `ContextMenu` right-click/long-press menu. */
export interface ContextMenuProps {
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    loopFocus?: boolean;
    items?: ReadonlyArray<MenuEntry>;
    content?: ReactNode;
    disabled?: boolean;
    ariaLabel?: string;
    className?: string;
    contentClassName?: string;
    style?: CSSProperties;
    ref?: Ref<HTMLDivElement>;
    children?: ReactNode;
}
/** Right-click and long-press context menu wrapping an arbitrary target region. */
export declare function ContextMenu({ open, defaultOpen, onOpenChange, loopFocus, items, content, disabled, ariaLabel, className, contentClassName, style, ref, children, }: ContextMenuProps): import("react").JSX.Element;
/** Single top-level menu definition inside a `Menubar`. */
export interface MenubarMenuDefinition {
    id?: string;
    label: ReactNode;
    disabled?: boolean;
    items: ReadonlyArray<MenuEntry>;
}
/** Props for the `Menubar` horizontal application menu strip. */
export interface MenubarProps {
    menus?: ReadonlyArray<MenubarMenuDefinition>;
    disabled?: boolean;
    loopFocus?: boolean;
    orientation?: 'horizontal' | 'vertical';
    ariaLabel?: string;
    className?: string;
    style?: CSSProperties;
    ref?: Ref<HTMLDivElement>;
    children?: ReactNode;
}
/** Horizontal application menubar with keyboard arrow navigation across top-level dropdown menus. */
export declare function Menubar({ menus, disabled, loopFocus, orientation, ariaLabel, className, style, ref, children }: MenubarProps): import("react").JSX.Element;
/** Single executable command entry inside `CommandBox` or `CommandPalette`. */
export interface CommandEntry {
    id: string;
    label: string;
    keywords?: string[];
    icon?: ReactNode;
    shortcut?: string;
    badge?: string;
    disabled?: boolean;
    onSelect?: () => void;
}
/** Titled section of command items inside `CommandBox` or `CommandPalette`. */
export interface CommandGroupEntry {
    heading: string;
    items: ReadonlyArray<CommandEntry>;
}
/** Props for the inline `CommandBox` filterable command list. */
export interface CommandBoxProps {
    placeholder?: string;
    groups?: ReadonlyArray<CommandGroupEntry>;
    empty?: EmptyStateSpec | ReactNode;
    footer?: ReactNode;
    hideSearchIcon?: boolean;
    ariaLabel?: string;
    inputAriaLabel?: string;
    query?: string;
    defaultQuery?: string;
    onQueryChange?: (query: string) => void;
    onAction?: (value: string) => unknown;
    loopFocus?: boolean;
    className?: string;
    style?: CSSProperties;
    ref?: Ref<HTMLDivElement>;
    children?: ReactNode;
}
/** Inline searchable command menu with grouped items, keyboard shortcuts, and empty state. */
export declare function CommandBox(props: CommandBoxProps): import("react").JSX.Element;
/** Props for the modal `CommandPalette` overlay. */
export interface CommandPaletteProps {
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    enableGlobalShortcut?: boolean;
    shortcutKey?: string;
    closeOnSelect?: boolean;
    placeholder?: string;
    groups?: ReadonlyArray<CommandGroupEntry>;
    empty?: EmptyStateSpec | ReactNode;
    hideFooter?: boolean;
    footer?: ReactNode;
    query?: string;
    defaultQuery?: string;
    onQueryChange?: (query: string) => void;
    onAction?: (value: string) => unknown;
    ariaLabel?: string;
    className?: string;
    ref?: Ref<HTMLDivElement>;
    children?: ReactNode;
}
/** Modal `Mod+K` command palette dialog with fuzzy search, grouped commands, and keyboard navigation hints. */
export declare function CommandPalette(props: CommandPaletteProps): import("react").JSX.Element;
/** Semantic notification category for toast messages. */
export type ToastType = 'default' | 'info' | 'success' | 'warning' | 'error' | 'loading';
/** Action button configuration for a toast notification. */
export interface ToastActionSpec {
    label: ReactNode;
    onClick: () => void;
}
/** Cancel button configuration for a toast notification. */
export interface ToastCancelSpec {
    label: ReactNode;
    onCancel?: () => void;
}
/** Payload describing a single toast notification. */
export interface ToastData<Data = ReactNode> {
    id?: string;
    type: ToastType;
    title?: Data;
    description?: Data;
    duration?: number;
    dismissible?: boolean;
    action?: ToastActionSpec;
    cancel?: ToastCancelSpec;
}
/** Options accepted when dispatching a toast notification. */
export interface ToastOptions<Data = ReactNode> {
    id?: string;
    type?: ToastType;
    title?: Data;
    description?: Data;
    duration?: number;
    dismissible?: boolean;
    action?: ToastActionSpec;
    cancel?: ToastCancelSpec;
}
/** Active toast queue item passed to custom `Toaster` render functions. */
export interface ToastItem<Data = ReactNode> {
    id: string;
    data: ToastData<Data>;
}
/** Imperative toast controller returned by `createToaster`. */
export interface ToastController<Data = ReactNode> {
    show: (options: ToastOptions<Data> | Data) => string;
    success: (title: Data, options?: Omit<ToastOptions<Data>, 'type' | 'title'>) => string;
    error: (title: Data, options?: Omit<ToastOptions<Data>, 'type' | 'title'>) => string;
    warning: (title: Data, options?: Omit<ToastOptions<Data>, 'type' | 'title'>) => string;
    info: (title: Data, options?: Omit<ToastOptions<Data>, 'type' | 'title'>) => string;
    loading: (title: Data, options?: Omit<ToastOptions<Data>, 'type' | 'title'>) => string;
    dismiss: (id?: string) => void;
}
/** Placement and queue props for the toast region container. */
export interface ToastRegionProps {
    toaster?: ToastController<ReactNode>;
    side?: 'top' | 'bottom';
    align?: 'start' | 'center' | 'end';
    maxVisible?: number;
    ariaLabel?: string;
    className?: string;
    style?: CSSProperties;
    ref?: Ref<HTMLDivElement>;
}
/** Props for the `Toaster` viewport region. */
export interface ToasterProps extends ToastRegionProps {
    words?: {
        dismiss?: string;
    };
    children?: (toastData: ToastData<ReactNode>, item: ToastItem<ReactNode>) => ReactNode;
}
declare function ToasterRegionPart({ ariaLabel, className, children, ...props }: ToastRegionProps & {
    children?: ReactNode;
}): import("react").JSX.Element;
declare function ToastCardPart({ ariaLabel, className, ...props }: CleanElementProps<'div'>): import("react").JSX.Element;
declare function ToastTitlePart({ ariaLabel, className, ...props }: CleanElementProps<'div'>): import("react").JSX.Element;
declare function ToastDescriptionPart({ ariaLabel, className, ...props }: CleanElementProps<'div'>): import("react").JSX.Element;
declare function ToastActionPart({ ariaLabel, className, ...props }: CleanElementProps<'button'>): import("react").JSX.Element;
declare function ToastClosePart({ ariaLabel, className, action, ...props }: CleanElementProps<'button'> & {
    action?: () => void;
}): import("react").JSX.Element;
declare function ToasterBase({ toaster, side, align, maxVisible, ariaLabel, className, style, ref, words, children, }: ToasterProps): import("react").JSX.Element;
/** Accessible toast notification region rendering stacked alerts in the viewport corner. */
export declare const Toaster: typeof ToasterBase & {
    Region: typeof ToasterRegionPart;
    Toast: typeof ToastCardPart;
    Title: typeof ToastTitlePart;
    Description: typeof ToastDescriptionPart;
    Action: typeof ToastActionPart;
    Close: typeof ToastClosePart;
};
/** Props for the `Alert` inline banner. */
export interface AlertProps extends CleanElementProps<'div', 'title'> {
    tone?: Tone;
    title?: ReactNode;
    description?: ReactNode;
    icon?: ReactNode | false;
    action?: ReactNode;
    onDismiss?: () => void;
    dismissLabel?: string;
}
/** Inline status alert banner with semantic tone icon, title, description, and optional dismiss action. */
export declare function Alert({ tone, title, description, icon, action, onDismiss, dismissLabel, role, ariaLabel, className, children, ...props }: AlertProps): import("react").JSX.Element;
/** Contextual callout banner alias for `Alert`. */
export declare const Callout: typeof Alert;
/** Props for `Callout`. */
export type CalloutProps = AlertProps;
/** Props for `SkeletonText`. */
export interface SkeletonTextProps extends CleanElementProps<'div'> {
    lines?: number;
    lastLineWidth?: string;
    lineHeight?: number | string;
}
/** Multi-line paragraph skeleton placeholder. */
export declare function SkeletonText({ lines, lastLineWidth, lineHeight, ariaLabel, className, ...props }: SkeletonTextProps): import("react").JSX.Element;
/** Props for `SkeletonCard`. */
export interface SkeletonCardProps extends CleanElementProps<'div'> {
    showHeader?: boolean;
    showAvatar?: boolean;
    lines?: number;
    showFooter?: boolean;
}
/** Structured card skeleton placeholder with optional header, avatar, body lines, and footer. */
export declare function SkeletonCard({ showHeader, showAvatar, lines, showFooter, ariaLabel, className, ...props }: SkeletonCardProps): import("react").JSX.Element;
/** Size alias for `Meter`. */
export type GaugeSize = ControlSize;
/** Intrinsic HTML tag supported by `Box`. */
export type BoxTag = 'div' | 'section' | 'article' | 'aside' | 'header' | 'footer' | 'main' | 'nav' | 'span';
/** Props for the `Box` surface container. */
export interface BoxProps extends CleanElementProps<'div'> {
    as?: BoxTag;
    padding?: SpaceScale;
    surface?: 'none' | 'subtle' | 'surface' | 'elevated' | 'inset';
    bordered?: boolean;
    rounded?: 'none' | 'sm' | 'md' | 'lg' | 'xl';
}
/** Generic layout box with tokenized padding, surface fill, border, and corner radius. */
export declare function Box({ as: Tag, padding, surface, bordered, rounded, ariaLabel, className, style, ...props }: BoxProps): import("react").JSX.Element;
/** Props for the `Container` max-width wrapper. */
export interface ContainerProps extends CleanElementProps<'div'> {
    size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full';
    padded?: boolean;
}
/** Centered max-width page or section container. */
export declare function Container({ size, padded, ariaLabel, className, ...props }: ContainerProps): import("react").JSX.Element;
/** Props for the `Separator` horizontal or vertical rule. */
export interface SeparatorProps {
    orientation?: 'horizontal' | 'vertical';
    decorative?: boolean;
    label?: ReactNode;
    className?: string;
    style?: CSSProperties;
    ref?: Ref<HTMLDivElement>;
}
/** Visual and accessible divider line with optional inline label. */
export declare function Separator({ orientation, decorative, label, className, style, ref }: SeparatorProps): import("react").JSX.Element;
/** Single disclosure item definition for `Accordion`. */
export interface AccordionItemDefinition<T extends string = string> {
    value: T;
    title: ReactNode;
    subtitle?: ReactNode;
    icon?: ReactNode;
    content: ReactNode;
    disabled?: boolean;
}
/** Props for the `Accordion` disclosure stack. */
export interface AccordionProps<T extends string = string> {
    items?: ReadonlyArray<AccordionItemDefinition<T>>;
    value?: T[];
    defaultValue?: T[];
    onValueChange?: (value: T[]) => void;
    multiple?: boolean;
    collapsible?: boolean;
    disabled?: boolean;
    keepMounted?: boolean;
    hiddenUntilFound?: boolean;
    orientation?: 'vertical' | 'horizontal';
    variant?: 'default' | 'bordered' | 'separated';
    ariaLabel?: string;
    className?: string;
    style?: CSSProperties;
    ref?: Ref<HTMLDivElement>;
    children?: ReactNode;
}
/** Props for `Accordion.Item`. */
export interface AccordionItemProps extends CleanElementProps<'div'> {
    value: string;
    disabled?: boolean;
}
declare function AccordionItemPart({ ariaLabel, className, ...props }: AccordionItemProps): import("react").JSX.Element;
/** Props for `Accordion.Header`. */
export type AccordionHeaderProps = CleanElementProps<'h3'>;
declare function AccordionHeaderPart({ ariaLabel, className, ...props }: AccordionHeaderProps): import("react").JSX.Element;
/** Props for `AccordionTrigger`. */
export type AccordionTriggerProps = CleanElementProps<'button'>;
/** Expand/collapse button header inside an `Accordion` item. */
export declare function AccordionTrigger({ children, ariaLabel, className, ...props }: AccordionTriggerProps): import("react").JSX.Element;
/** Props for `Accordion.Panel`. */
export interface AccordionPanelProps extends CleanElementProps<'div'> {
    keepMounted?: boolean;
    hiddenUntilFound?: boolean;
}
declare function AccordionPanelPart({ ariaLabel, className, ...props }: AccordionPanelProps): import("react").JSX.Element;
declare function AccordionBase<T extends string = string>({ items, value, defaultValue, onValueChange, multiple, collapsible, disabled, keepMounted, hiddenUntilFound, orientation, variant, ariaLabel, className, style, ref, children, }: AccordionProps<T>): import("react").JSX.Element;
/** Vertically stacked disclosure sections with single or multiple expansion. */
export declare const Accordion: typeof AccordionBase & {
    Root: typeof AccordionBase;
    Item: typeof AccordionItemPart;
    Header: typeof AccordionHeaderPart;
    Trigger: typeof AccordionTrigger;
    Panel: typeof AccordionPanelPart;
};
/** Props for the `Collapsible` disclosure panel. */
export interface CollapsibleProps {
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    onOpenChangeComplete?: (open: boolean) => void;
    disabled?: boolean;
    trigger?: ReactNode;
    title?: ReactNode;
    keepMounted?: boolean;
    hiddenUntilFound?: boolean;
    ariaLabel?: string;
    className?: string;
    style?: CSSProperties;
    ref?: Ref<HTMLDivElement>;
    children?: ReactNode;
}
/** Props for `Collapsible.Trigger`. */
export type CollapsibleTriggerProps = CleanElementProps<'button'>;
declare function CollapsibleTriggerPart({ ariaLabel, className, ...props }: CollapsibleTriggerProps): import("react").JSX.Element;
/** Props for `Collapsible.Panel`. */
export interface CollapsiblePanelProps extends CleanElementProps<'div'> {
    keepMounted?: boolean;
    hiddenUntilFound?: boolean;
}
declare function CollapsiblePanelPart({ ariaLabel, className, ...props }: CollapsiblePanelProps): import("react").JSX.Element;
declare function CollapsibleBase({ open, defaultOpen, onOpenChange, onOpenChangeComplete, disabled, trigger, title, keepMounted, hiddenUntilFound, ariaLabel, className, style, ref, children, }: CollapsibleProps): import("react").JSX.Element;
/** Single expandable/collapsible section with trigger button and content panel. */
export declare const Collapsible: typeof CollapsibleBase & {
    Root: typeof CollapsibleBase;
    Trigger: typeof CollapsibleTriggerPart;
    Panel: typeof CollapsiblePanelPart;
};
/** Props for `ResizableHandle`. */
export interface ResizableHandleProps extends CleanElementProps<'div'> {
    disabled?: boolean;
}
/** Draggable and keyboard-accessible separator handle between resizable panels. */
export declare function ResizableHandle({ children, ariaLabel, className, ...props }: ResizableHandleProps): import("react").JSX.Element;
/** Sub-link card item inside a `NavigationMenu` dropdown panel. */
export interface NavigationMenuSubLink {
    label: ReactNode;
    description?: ReactNode;
    href: string;
    icon?: ReactNode;
    current?: boolean;
}
/** Top-level link or dropdown entry inside `NavigationMenu`. */
export interface NavigationMenuEntry<T extends string = string> {
    value?: T;
    label: ReactNode;
    href?: string;
    icon?: ReactNode;
    current?: boolean;
    disabled?: boolean;
    links?: ReadonlyArray<NavigationMenuSubLink>;
    content?: ReactNode;
}
/** Props for the `NavigationMenu` site/workspace navigation bar. */
export interface NavigationMenuComponentProps<T extends string = string> {
    items?: ReadonlyArray<NavigationMenuEntry<T>>;
    value?: T | null;
    defaultValue?: T | null;
    onValueChange?: (value: T | null) => void;
    delay?: number;
    closeDelay?: number;
    openOnHover?: boolean;
    closeOnSelect?: boolean;
    orientation?: 'horizontal' | 'vertical';
    ariaLabel?: string;
    className?: string;
    style?: CSSProperties;
    ref?: Ref<HTMLElement>;
    children?: ReactNode;
}
/** Alias for `NavigationMenuComponentProps`. */
export type NavigationMenuProps<T extends string = string> = NavigationMenuComponentProps<T>;
/** Accessible top-level navigation menu bar with hover/keyboard flyout link panels. */
export declare function NavigationMenu<T extends string = string>({ items, value, defaultValue, onValueChange, delay, closeDelay, openOnHover, closeOnSelect, orientation, ariaLabel, className, style, ref, children, }: NavigationMenuComponentProps<T>): import("react").JSX.Element;
/** Single step item in a `Breadcrumbs` trail. */
export interface BreadcrumbItem {
    id?: string;
    label: ReactNode;
    href?: string;
    icon?: ReactNode;
    current?: boolean;
    onClick?: (event: MouseEvent<HTMLElement>) => void;
}
/** Props for the `Breadcrumbs` ancestor trail. */
export interface BreadcrumbsProps extends CleanElementProps<'nav'> {
    items: ReadonlyArray<BreadcrumbItem>;
    separator?: ReactNode;
}
/** Hierarchical breadcrumb navigation trail marking the active page with `aria-current="page"`. */
export declare function Breadcrumbs(props: BreadcrumbsProps): import("react").JSX.Element;
/**
 * Badges and landing hero blocks: a status or hero badge, two to four photo tiles where one photo would stand,
 * and up to four rows of an icon and a line. Props only: the words, the icons (as nodes) and the image addresses are
 * handed in, so the kit draws them with its own icons and the files an App holds.
 */
/** Semantic badge tone alias pointing to the canonical `Tone` union. */
type BadgeTone = Tone;
/** Props for the inline `Code` snippet component. */
export type CodeProps = CleanElementProps<'code'>;
/** Inline monospace code token. */
export declare function Code({ ariaLabel, className, ...props }: CodeProps): import("react").JSX.Element;
/** Props for the `Kbd` keyboard shortcut keycap component. */
export interface KbdProps extends CleanElementProps<'kbd'> {
    shortcut?: string;
}
/** Keyboard keycap badge formatting platform-appropriate shortcut symbols. */
export declare function Kbd({ shortcut, ariaLabel, className, children, ...props }: KbdProps): import("react").JSX.Element;
/** Single member entry for `AvatarGroup`. */
export interface AvatarGroupMember {
    id?: string;
    name: string;
    src?: string;
    status?: AvatarStatus;
}
/** Props for the `AvatarGroup` overlapping stack. */
export interface AvatarGroupProps extends CleanElementProps<'div'> {
    items?: ReadonlyArray<AvatarGroupMember>;
    max?: number;
    size?: AvatarSize;
}
/** Overlapping row of member avatars with an overflow `+N` counter chip. */
export declare function AvatarGroup({ items, max, size, ariaLabel, className, children, ...props }: AvatarGroupProps): import("react").JSX.Element;
/** Props for the `JsonView` interactive JSON tree inspector. */
export interface JsonViewProps extends CleanElementProps<'div'> {
    data: unknown;
    defaultExpandedDepth?: number;
    copyable?: boolean;
    maxHeight?: number | string;
}
/** Syntax-colored collapsible JSON tree inspector with one-click copy toolbar. */
export declare function JsonView({ data, defaultExpandedDepth, copyable, maxHeight, ariaLabel, className, style, ...props }: JsonViewProps): import("react").JSX.Element;
/** Crop geometry and transform state controlled by `ImageCropper`. */
export interface ImageCrop {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation?: number;
    flipX?: boolean;
    flipY?: boolean;
}
/** Crop mask shape (`'rectangle'` or `'circle'`). */
export type ImageCropperShape = 'rectangle' | 'circle';
/** Interaction mode for `ImageCropper` (`'box'` or `'pan'`). */
export type ImageCropperMode = 'box' | 'pan';
/** Props for the `ImageCropper` interactive image framing control. */
export interface ImageCropperProps {
    src: string;
    alt?: string;
    aspectRatio?: number;
    shape?: ImageCropperShape;
    mode?: ImageCropperMode;
    crop?: ImageCrop;
    defaultCrop?: Partial<ImageCrop>;
    onValueChange?: (crop: Required<ImageCrop>) => void;
    onValueCommit?: (crop: Required<ImageCrop>) => void;
    onCrop?: (crop: Required<ImageCrop>) => void;
    minWidth?: number;
    minHeight?: number;
    maxZoom?: number;
    disabled?: boolean;
    showControls?: boolean;
    zoomLabel?: string;
    rotateLabel?: string;
    flipLabel?: string;
    viewportHeight?: number | string;
    ariaLabel?: string;
    className?: string;
    style?: CSSProperties;
    ref?: Ref<HTMLDivElement>;
    children?: ReactNode;
}
/** Interactive image cropper supporting zoom, 90° rotation, horizontal flip, and aspect-ratio lock. */
export declare function ImageCropper(props: ImageCropperProps): import("react").JSX.Element;
/** Selectable IANA timezone entry for `DateTimePicker`. */
export interface TimezoneOption {
    value: string;
    label: string;
    shortLabel?: string;
}
/** Decomposed date, wall-clock time, and timezone metadata emitted by `DateTimePicker`. */
export interface DateTimeChangeDetails {
    date: string | null;
    time: string | null;
    timezone: string;
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
    words?: {
        time?: string;
        timezone?: string;
        selectDate?: string;
    };
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
export declare function DateTimePicker({ id: explicitId, ariaLabel, value, defaultValue, onValueChange, showTimezone: showTimezoneProp, timezone: controlledTimezone, defaultTimezone, onTimezoneChange, timezones, granularity, hourCycle, defaultTime, presets, clearable, placeholder, locale, timeLabel, timezoneLabel, timezonePlaceholder, words, size, disabled, readOnly, invalid, name, ref, label, hint, description, error, optional, required, labelTrailing, className, fieldClassName, }: DateTimePickerProps): React.JSX.Element;
/** Hierarchical node item for `TreeSelect`. */
export interface TreeSelectNode {
    value: string;
    label: string;
    icon?: React.ReactNode;
    badge?: React.ReactNode;
    disabled?: boolean;
    children?: ReadonlyArray<TreeSelectNode>;
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
export declare function TreeSelect(props: TreeSelectProps): React.JSX.Element;
/** Async request context passed to `EntityPicker`'s `loadEntities` callback. */
export interface EntityLoadContext {
    signal: AbortSignal;
    page: number;
}
/** Selectable record entry for `EntityPicker`. */
export interface EntityOption<TData = unknown> {
    /** Unique entity identifier. */
    id: string;
    /** Monospace operational code (e.g. `'NX-412'`, `'CUS-109'`). */
    code?: string;
    /** Primary display name. */
    label: string;
    /** Secondary metadata line (e.g. `'Enterprise · San Francisco, CA'`). */
    subtitle?: string;
    /** Avatar image URL. Falls back to monogram derived from `avatarName ?? label`. */
    avatarSrc?: string;
    /** Explicit seed name for monogram fallback. */
    avatarName?: string;
    /** Custom icon rendered instead of monogram Avatar when provided. */
    icon?: React.ReactNode;
    /** Status or category pill rendered on the right of the option row. */
    badge?: React.ReactNode;
    badgeTone?: Tone;
    /** Optional group section heading. */
    group?: string;
    /** Additional search terms matched during static filtering. */
    keywords?: ReadonlyArray<string>;
    disabled?: boolean;
    /** Arbitrary attached domain payload. */
    data?: TData;
}
interface EntityPickerSharedProps<TData = unknown> extends FieldFrameProps {
    id?: string;
    ariaLabel?: string;
    'aria-labelledby'?: string;
    'aria-describedby'?: string;
    /** Static entity list (used when `loadEntities` is not provided). */
    entities?: ReadonlyArray<EntityOption<TData>>;
    /**
     * Async loader receiving `(query, { signal, page })` with automatic debouncing and race cancellation.
     */
    loadEntities?: (query: string, context: EntityLoadContext) => Promise<EntityOption<TData>[] | {
        items: EntityOption<TData>[];
        hasMore?: boolean;
    }>;
    /**
     * The records already chosen, for a value the picker has not loaded: with `loadEntities` a saved id is otherwise all
     * the box has to show until a search happens to return it.
     */
    selectedEntities?: ReadonlyArray<EntityOption<TData>>;
    /** Debounce delay in milliseconds for `loadEntities`. Defaults to `200`. */
    debounceMs?: number;
    /** Trigger `loadEntities('')` immediately on mount. Defaults to `false` (loads on open/type). */
    loadOnMount?: boolean;
    /** Optional handler enabling inline `+ Create "{query}"` action when no exact match exists. */
    onCreateNew?: (query: string) => unknown;
    createNewLabel?: (query: string) => React.ReactNode;
    placeholder?: string;
    empty?: EmptyStateSpec | React.ReactNode;
    loadingMessage?: React.ReactNode;
    clearable?: boolean;
    size?: ControlSize;
    disabled?: boolean;
    readOnly?: boolean;
    invalid?: boolean;
    name?: string;
    words?: {
        clearAll?: string;
        clearEntity?: string;
        toggleEntities?: string;
        removeChip?: (label: string) => string;
        addMore?: string;
        loadingStatus?: string;
        availableStatus?: (count: number) => string;
    };
    className?: string;
    contentClassName?: string;
    fieldClassName?: string;
    ref?: React.Ref<HTMLInputElement>;
}
/** Single-record selection props for `EntityPicker`. */
export interface EntityPickerSingleProps<TData = unknown> extends EntityPickerSharedProps<TData> {
    multiple?: false;
    value?: string | null;
    defaultValue?: string | null;
    onValueChange?: (id: string | null, entity: EntityOption<TData> | null) => void;
}
/** Multi-record selection props for `EntityPicker`. */
export interface EntityPickerMultiProps<TData = unknown> extends EntityPickerSharedProps<TData> {
    multiple: true;
    value?: ReadonlyArray<string>;
    defaultValue?: ReadonlyArray<string>;
    onValueChange?: (ids: string[], entities: EntityOption<TData>[]) => void;
}
/** Props for the `EntityPicker` searchable record selector. */
export type EntityPickerProps<TData = unknown> = EntityPickerSingleProps<TData> | EntityPickerMultiProps<TData>;
/** Searchable single- or multi-record entity picker with monogram avatars, codes, badges, and async loading. */
export declare function EntityPicker<TData = unknown>(props: EntityPickerProps<TData>): React.JSX.Element;
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
    words?: {
        copyCode?: string;
        copiedCode?: string;
        copy?: string;
        copied?: string;
        leaveHint?: string;
    };
    className?: string;
    fieldClassName?: string;
    ref?: React.Ref<HTMLTextAreaElement>;
}
/** Line-numbered monospace code editor with Tab/Shift+Tab indentation (Escape, then Tab, leaves it) and clipboard copy. */
export declare function CodeEditor(props: CodeEditorProps): React.JSX.Element;
/** Diagnostic result emitted by `JsonEditor` when its source changes. */
export interface JsonValidationResult {
    valid: boolean;
    empty: boolean;
    line: number | null;
    column: number | null;
    message: string | null;
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
export declare function JsonEditor(props: JsonEditorProps): React.JSX.Element;
/** Single key/value entry managed by `KeyValueEditor`. */
export interface KeyValueItem {
    id: string;
    key: string;
    value: string;
    secret?: boolean;
}
/** Props for the `KeyValueEditor` component. */
export interface KeyValueEditorProps extends FieldFrameProps {
    value?: ReadonlyArray<KeyValueItem>;
    defaultValue?: ReadonlyArray<KeyValueItem>;
    onValueChange?: (items: KeyValueItem[]) => void;
    keyPlaceholder?: string;
    valuePlaceholder?: string;
    keyHeader?: React.ReactNode;
    valueHeader?: React.ReactNode;
    /** Enable per-row secret masking (`Eye`/`EyeSlash`) and secret lock toggle. Defaults to `true`. */
    allowSecrets?: boolean;
    /** Default `secret` state for newly added rows. Defaults to `false`. */
    defaultSecret?: boolean;
    /** Automatically uppercase typed/pasted keys (ideal for `.env` variables). Defaults to `false`. */
    uppercaseKeys?: boolean;
    /** Parse multiline `KEY=VALUE` or `Header: Value` clipboard pastes into structured rows. Defaults to `true`. */
    allowMultilinePaste?: boolean;
    addLabel?: React.ReactNode;
    empty?: EmptyStateSpec | React.ReactNode;
    readOnly?: boolean;
    disabled?: boolean;
    invalid?: boolean;
    name?: string;
    ariaLabel?: string;
    /** The editor's own wording, for an App in another language. Each falls back to the English. */
    words?: {
        /** The badge on a key that appears twice, and its tooltip. */
        duplicate?: string;
        duplicateTitle?: string;
        /** The line beside the add button about pasting `KEY=VALUE` blocks. */
        pasteTip?: React.ReactNode;
        /** The count in the header: `3 entries · 1 secret`. */
        count?: (entries: number, secrets: number) => string;
        keyLabel?: (index: number) => string;
        valueLabel?: (key: string, index: number) => string;
        revealSecret?: string;
        hideSecret?: string;
        markSecret?: string;
        unmarkSecret?: string;
        deleteRow?: (key: string, index: number) => string;
    };
    className?: string;
    fieldClassName?: string;
    ref?: React.Ref<HTMLDivElement>;
}
/** Key/value table editor with secret masking, duplicate-key warnings, and multiline `.env` paste parsing. */
export declare function KeyValueEditor(props: KeyValueEditorProps): React.JSX.Element;
/** Matching strategy for `HighlightMatch`. */
export type HighlightMatchMode = 'contains' | 'startsWith' | 'fuzzy';
/** Props for the `HighlightMatch` component. */
export interface HighlightMatchProps extends Omit<React.ComponentProps<'span'>, 'children' | 'onChange' | 'aria-label' | 'inlist'> {
    /** Source text to render and highlight. */
    text: string;
    /** Search query whose matched characters or ranges will be highlighted. */
    query?: string;
    /** Matching strategy (`'contains'`, `'startsWith'`, or `'fuzzy'`). Defaults to `'fuzzy'`. */
    mode?: HighlightMatchMode;
    /** Optional minimum fuzzy match score (`0..1`) required before highlighting. */
    minScore?: number;
    /** Custom class applied to each `<mark>` element. */
    markClassName?: string;
    ariaLabel?: string;
}
/** Inline text highlighter that wraps matched query segments in `<mark>` elements. */
export declare function HighlightMatch({ text, query, mode, minScore, markClassName, ariaLabel, className, ...rest }: HighlightMatchProps): React.JSX.Element;
/** Recorded timeline entry in a `useHistoryState` controller. */
export interface HistoryStepItem<T = unknown> {
    id: string;
    description: string;
    source: string;
    timestamp: number;
    snapshot?: T;
    sdkEntry?: unknown;
}
/** Staged control mutation passed to `HistoryStateController.stage`. */
export interface StagedHistoryChange {
    target: string | Element;
    key?: string;
    value?: unknown;
    source?: string;
    description?: string;
}
/** Configuration options for `useHistoryState`. */
export interface UseHistoryStateOptions<T = unknown> {
    /** Maximum number of state snapshots to retain. Defaults to `100`. */
    limit?: number;
    /** Coalesce rapid state updates with identical descriptions within this window (ms). Defaults to `350`. */
    coalesceMs?: number;
    /**
     * When `true` (or automatically when `initialValue` is omitted), observes live control changes
     * inside `scopeRef` (or `within`).
     */
    observeControls?: boolean;
    /** Optional custom UI agent instance used for live control observation and staging. */
    agent?: unknown;
    /** Optional explicit container element or getter for control observation. */
    within?: Element | null | (() => Element | null | undefined);
    /** Observed control state keys. Defaults to `['value', 'checked', 'pressed']`. */
    keys?: string[];
    /** Whether continuous drags/typing on one control are coalesced. Defaults to `true`. */
    coalesce?: boolean;
    /** Formatter for state snapshot action descriptions when none is explicitly passed to `set()`. */
    describeSnapshot?: (next: T, previous: T) => string;
}
/** State and timeline controller returned by `useHistoryState`. */
export interface HistoryStateController<T = unknown> {
    /** Current state value. */
    value: T;
    /** Alias for `value`. */
    state: T;
    /** Record a new state snapshot with an optional human-readable action description. */
    set: (next: T | ((prev: T) => T), description?: string) => void;
    /** Step backward one entry. */
    undo: () => Promise<void>;
    /** Step forward one entry. */
    redo: () => Promise<void>;
    /** Jump to a specific step position (`0..totalSteps`). */
    seek: (step: number) => Promise<void>;
    /** Stage programmatic or AI-driven control updates and receive `{ applied, revert }`. */
    stage: (changes: ReadonlyArray<StagedHistoryChange>) => {
        applied: number;
        revert: () => Promise<void>;
    };
    /** Revert all applied control changes from a specific source (e.g. `'agent'`). */
    undoSource: (source: string) => Promise<void>;
    /** Clear recorded history entries while keeping the current value/DOM state intact. */
    clear: () => void;
    /** Reset back to `nextInitial` (or the original `initialValue`) and clear history. */
    reset: (nextInitial?: T) => void;
    /** Whether there is at least one applied step to undo. */
    canUndo: boolean;
    /** Whether there is at least one undone step to redo. */
    canRedo: boolean;
    /** 0-based count of applied steps (`0` = initial state, `totalSteps` = latest). */
    step: number;
    /** Total recorded steps available across the undo/redo timeline. */
    totalSteps: number;
    /** Ordered list of recorded steps (oldest first). */
    entries: ReadonlyArray<HistoryStepItem<T>>;
    /** Human-readable description of the most recently applied action, or `null` at step `0`. */
    latestAction: string | null;
    /** Attach to a container `<div ref={history.scopeRef}>` to scope live control observation. */
    scopeRef: React.RefObject<HTMLDivElement | null>;
}
/** Props for the `UndoRedoBar` component. */
export interface UndoRedoBarProps extends Omit<React.ComponentProps<'div'>, 'onChange' | 'aria-label' | 'inlist'> {
    /** Bind directly to a `useHistoryState` controller. */
    history?: Pick<HistoryStateController<unknown>, 'canUndo' | 'canRedo' | 'undo' | 'redo' | 'step' | 'totalSteps' | 'latestAction' | 'clear'>;
    canUndo?: boolean;
    canRedo?: boolean;
    onUndo?: () => void | Promise<void>;
    onRedo?: () => void | Promise<void>;
    onClear?: () => void;
    step?: number;
    totalSteps?: number;
    latestAction?: React.ReactNode;
    empty?: EmptyStateSpec | React.ReactNode;
    ariaLabel?: string;
    /** Render as a floating elevated pill bar. Defaults to `false` (inline pill bar). */
    floating?: boolean;
    /** Register `Mod+Z` and `Mod+Shift+Z` shortcuts while mounted. Defaults to `true`. */
    bindShortcuts?: boolean;
    /** Show formatted shortcut badges inside Undo/Redo buttons. Defaults to `true`. */
    showShortcuts?: boolean;
    /** Show a button to clear recorded history when non-empty. Defaults to `false`. */
    showClear?: boolean;
    words?: {
        regionLabel?: string;
        undo?: string;
        redo?: string;
        clearHistory?: string;
    };
}
/** Undo/redo toolbar displaying step progress, latest action description, and shortcut hints. */
export declare function UndoRedoBar({ history, canUndo: canUndoProp, canRedo: canRedoProp, onUndo, onRedo, onClear, step: stepProp, totalSteps: totalStepsProp, latestAction: latestActionProp, empty, ariaLabel, floating, bindShortcuts, showShortcuts, showClear, words, className, ...rest }: UndoRedoBarProps): React.JSX.Element;
/** Props for the `ShortcutKey` component. */
export interface ShortcutKeyProps extends Omit<React.ComponentProps<'span'>, 'children' | 'onChange' | 'aria-label' | 'inlist'> {
    /** Shortcut chord string such as `'mod+k'`, `'mod+shift+z'`, `'g then i'`, or `'?'`. */
    keys: string;
    size?: ControlSize;
    variant?: 'elevated' | 'subtle' | 'plain';
    ariaLabel?: string;
}
/** Platform-aware keyboard shortcut keycap chord badge. */
export declare function ShortcutKey({ keys, size, variant, ariaLabel, className, ...rest }: ShortcutKeyProps): React.JSX.Element;
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
export declare function ShortcutsModal({ sections, open: controlledOpen, defaultOpen, onOpenChange, triggerKey, trigger, title, description, includeRegistered, searchable, size, words, className, }: ShortcutsModalProps): React.JSX.Element;
/** Motion preference state managed by `PreferencesPanel`. */
export type MotionPreferenceValue = 'full' | 'reduced';
/** Contrast preference state managed by `PreferencesPanel`. */
export type ContrastPreferenceValue = 'standard' | 'more';
/** Keyboard shortcut hint visibility state managed by `PreferencesPanel`. */
export type KeyboardHintsPreferenceValue = 'visible' | 'hidden';
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
/** Reader accessibility and ergonomics preferences card for motion, contrast, and shortcut hints. */
export declare function PreferencesPanel({ title, description, ariaLabel, reducedMotion: controlledReducedMotion, onReducedMotionChange, highContrast: controlledHighContrast, onHighContrastChange, showKeyboardHints: controlledShowHints, onShowKeyboardHintsChange, extraToggles, showReset, onReset, className, ...rest }: PreferencesPanelProps): React.JSX.Element;
