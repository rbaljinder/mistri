/** `@mistriwork/mistri` shared kit declarations (`scripts/sync-ui-sdk.mjs`). */
import * as React from 'react';
import type { AnchorHTMLAttributes, AriaAttributes, ButtonHTMLAttributes, CSSProperties, ComponentProps, ComponentType, HTMLAttributes, InputHTMLAttributes, KeyboardEvent, MouseEvent, ReactElement, ReactNode, Ref, RefObject } from 'react';

/** Semantic tone shared across badges, status indicators, alerts, cards, and charts. */
export type Tone = 'neutral' | 'info' | 'good' | 'warning' | 'critical' | 'accent';
/** Control size shared across buttons, fields, pickers, switches, and meters. */
export type ControlSize = 'xs' | 'sm' | 'md' | 'lg';
/** Structured empty-state content shared across lists, tables, pickers, and views. */
export interface EmptyStateSpec {
  title: React.ReactNode;
  body?: React.ReactNode;
  action?: React.ReactNode;
}
/** Interaction metadata passed to `Button` press callbacks. */
interface ButtonActionDetails {
    source: string;
}
/** Visual emphasis variant for `Button` and `ButtonLink`. */
export type ButtonVariant = 'primary' | 'secondary' | 'soft' | 'outline' | 'ghost' | 'danger' | 'danger-soft';
/** Control height scale for `Button` and `ButtonLink`. */
export type ButtonSize = ControlSize;
/** Props for the `Button` component. */
export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children' | 'onClick' | 'onChange' | 'aria-label' | 'inlist' | 'className'> {
    /** Primary is the one filled action; secondary the outlined rest; ghost a word in the link ink; danger what cannot be taken back. */
    variant?: ButtonVariant;
    size?: ButtonSize;
    /** Working: pressed once already. Says so and refuses another press, keeping the focus. */
    loading?: boolean;
    /** What the button says while loading ("Saving…"); its own words otherwise. */
    loadingLabel?: ReactNode;
    leadingIcon?: ReactNode;
    trailingIcon?: ReactNode;
    shortcut?: string;
    /** Full width of its row: the phone's actions, the sign-in card's submit. */
    block?: boolean;
    iconOnly?: boolean;
    'data-icon-only'?: '' | undefined;
    type?: 'button' | 'submit' | 'reset';
    ariaLabel?: string;
    /** Optional destination URL; renders as a button-styled link wired through the host router seam when provided. */
    href?: string;
    target?: string;
    rel?: string;
    download?: boolean | string;
    className?: string;
    onClick?: (event: MouseEvent<HTMLButtonElement>, details: ButtonActionDetails) => unknown;
    children?: ReactNode;
    ref?: Ref<HTMLButtonElement>;
}
declare function DefaultButton({ variant, size, loading, loadingLabel, leadingIcon, trailingIcon, shortcut, block, iconOnly, type, disabled, ariaLabel, href, target, rel, download, className, onClick, children, ref, ...rest }: ButtonProps): import("react").JSX.Element;
/** Props for the `ButtonLink` component. */
export interface ButtonLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'onChange' | 'aria-label' | 'inlist'> {
    variant?: ButtonVariant;
    size?: ButtonSize;
    leadingIcon?: ReactNode;
    trailingIcon?: ReactNode;
    shortcut?: string;
    block?: boolean;
    iconOnly?: boolean;
    disabled?: boolean;
    ariaLabel?: string;
    ref?: Ref<HTMLAnchorElement>;
}
/** A link dressed as a button: it goes somewhere (a download, another page) rather than doing something here, so it
    is an anchor and nothing more, wearing the button's part for its look. A held one (`disabled` or `aria-disabled`)
    says so in the part's own state attribute, so it is drawn as a held button and refuses to go. */
declare function DefaultButtonLink({ variant, size, leadingIcon, trailingIcon, shortcut, block, iconOnly, disabled, ariaLabel, href, onClick, children, ...rest }: ButtonLinkProps): import("react").JSX.Element;
/** Interactive action button with variants, sizes, loading focus retention, and optional link routing. */
export declare const Button: typeof DefaultButton;
/** Anchor element styled with canonical `Button` variants, sizes, and affixes. */
export declare const ButtonLink: typeof DefaultButtonLink;
export type CleanElementProps<T extends keyof React.JSX.IntrinsicElements, K extends PropertyKey = never> = Omit<React.ComponentProps<T>, 'onChange' | 'aria-label' | 'inlist' | K> & { ariaLabel?: string };
/** Single exclusive choice in `SegmentedControl`. */
export interface SegmentOption<T extends string = string> {
    value: T;
    label: React.ReactNode;
    icon?: React.ReactNode;
    count?: React.ReactNode;
    /** Accessible name when `label` is non-text or abbreviated. */
    ariaLabel?: string;
    name?: string;
    disabled?: boolean;
}
/** Alias for `SegmentOption`. */
export type SegmentedControlOption<T extends string = string> = SegmentOption<T>;
/** Props for the unified `SegmentedControl` radio pill bar. */
export interface SegmentedControlProps<T extends string = string> {
    options: ReadonlyArray<SegmentOption<T>>;
    value?: T;
    defaultValue?: T;
    onValueChange?: (value: T) => void;
    /** Accessible name for the radio group (`ariaLabel` preferred; `label` supported for parity). */
    ariaLabel?: string;
    label?: string;
    size?: ControlSize;
    block?: boolean;
    disabled?: boolean;
    orientation?: 'horizontal' | 'vertical';
    className?: string;
    style?: React.CSSProperties;
    ref?: React.Ref<HTMLDivElement>;
}
/** Exclusive radio pill bar with arrow-key roving focus that folds to a native `<select>` past four options on narrow viewports. */
export declare function SegmentedControl<T extends string = string>(props: SegmentedControlProps<T>): React.JSX.Element;
/** Internal field shell and ARIA control-attribute bridge shared across form primitives. */
/** Shared field framing props (`label`, `hint`, `error`, `optional`, `required`) accepted by form primitives. */
export interface FieldFrameProps {
    label?: React.ReactNode;
    hint?: React.ReactNode;
    description?: React.ReactNode;
    error?: React.ReactNode;
    problem?: React.ReactNode;
    optional?: React.ReactNode | boolean;
    required?: boolean;
    labelTrailing?: React.ReactNode;
}
/**
 * One field: its label over the control, a hint under it, and the problem
 * it holds under that — in the control's own column, so saying a problem
 * never narrows or moves the control (docs/design.md, Access).
 *
 * The wiring is the point. The control is handed its id, what describes it
 * (the hint, the problem), `aria-invalid` while it holds a problem and
 * `aria-required` beside the star, so no form has to remember to join them.
 * A control that is one element takes them as props (`children` an element);
 * one that is several — a listbox's button, a date and its calendar, a
 * picker — takes them through `children` as a function and puts them where
 * its focusable is.
 */
/** The short answers: a count, an amount, a day, a day and its time, a time of day. */
export type AnswerKind = 'number' | 'money' | 'date' | 'datetime' | 'time';
/** Accessibility attributes wired from `Field` onto its child control. */
export interface FieldControlProps {
    id: string;
    'aria-describedby'?: string;
    'aria-invalid'?: true;
    'aria-required'?: true;
    /** A group's label is not a `<label>`: its control names itself by this. */
    'aria-labelledby'?: string;
}
/** Props for the `Field` form wrapper component. */
export interface FieldProps {
    label: ReactNode;
    /** A sentence that helps before anything goes wrong. */
    hint?: ReactNode;
    /** What is wrong with the value now, in the reader's words. Empty or absent: nothing. */
    problem?: ReactNode;
    required?: boolean;
    /** The control's id; one is made when not given. */
    id?: string;
    /** A control that is not one labelable element (radios, a listbox's button): the label is a caption the control points at. */
    group?: boolean;
    /** A checkbox: the control first and its label beside it, on one line, the label checking it. */
    check?: boolean;
    /** The word that says a field may be left empty ("(optional)"), in the caller's language. Given on every field that is
        not required, it is drawn only where the worn theme asks for it (`recipes.required: 'optional-word'`, the
        stylesheet's to decide) and replaces the star. It stands beside the label, not in it, so the label's name is the
        same either way; `aria-required` is untouched. */
    optional?: ReactNode;
    /** The label is read, not drawn: a group whose question is the heading above it. */
    labelHidden?: boolean;
    /** Something beside the label on its row: a help tip. */
    labelAside?: ReactNode;
    /** Keep the problem's line in the flow while it is empty, so a problem that arrives moves nothing below it. */
    reserve?: boolean;
    /** Control size for dense rows or standard forms. */
    size?: ControlSize;
    /** What kind of answer the control takes, where it is a short one: the control is only as wide as that answer
        (forms.css) and consecutive short fields share a row. Decided from the data, never measured, so no answer
        resizes its field. Absent for text and for a choice, which take the column. */
    kind?: AnswerKind;
    className?: string;
    ref?: Ref<HTMLDivElement>;
    children: ReactElement<Record<string, unknown>> | ((control: FieldControlProps) => ReactNode);
}
declare function DefaultField({ label, hint, problem, required, id, group, check, size, kind, optional, labelAside, labelHidden, reserve, className, ref, children, }: FieldProps): import("react").JSX.Element;
/** Labeled form field wrapper that wires accessible label, hint, validation error, and required state to its control. */
export declare const Field: typeof DefaultField;
/**
 * What every change callback here hears second: why the value moved and what moved it. A caller that only wants the
 * value ignores it; one that must tell a person's choice from its own (a filter that should not save when the page set
 * it, a dialog closed by Escape rather than by Save) reads it instead of keeping a flag beside the control.
 *
 * `reason` is one short word per cause (`trigger-press`, `outside-press`, `escape-key`, `item-press`, `focus-out` …);
 * each callback's type lists the words it can hear. The words are this package's, not the library's the primitives
 * are drawn over: they were Base UI's first, callers read them, and they stayed when the drawing moved to UI SDK
 * (internal/told.ts puts UI SDK's details under them).
 * `source` is the hand that did it. `event` is the DOM event behind it, absent when the page made the change.
 */
type ChangeSource = 'pointer' | 'keyboard' | 'program';
export interface ChangeDetails<Reason extends string = string> {
    reason: Reason;
    source: ChangeSource;
    event?: Event;
}
declare function DefaultHelpTip({ text, label, icon, className, ref }: HelpTipProps): ReactNode;
/** Press-activated inline help button and note popover beside form field labels. */
export declare const HelpTip: typeof DefaultHelpTip;
/**
 * The small parts a form is drawn from: the help tip, the progress bar, a step's heading, the fixed action bar, the
 * review group and a row of columns. Props only: every word and every picture arrives as a prop, and none of them
 * knows a field, a step or an address. Preview: @mistriwork/ui is Preview at 1.0.
 */
/** Props for the `HelpTip` press-activated label tooltip button. */
export interface HelpTipProps {
    /** The tip's text. */
    text: ReactNode;
    /** What the button is called ("More information"); the caller's word. */
    label: string;
    /** The mark on the button; without one, an "i". */
    icon?: ReactNode;
    className?: string;
    ref?: Ref<HTMLButtonElement>;
}
/** Props for the `ProgressBar` linear step progress indicator. */
export interface ProgressBarProps {
    value: number;
    max: number;
    /** The bottom of the range, announced as `aria-valuemin`: 0 by default, 1 for "step 1 of 5". */
    min?: number;
    /** What the bar is called to assistive technology ("Step 3 of 12"). Leave it out, with `decorative`, to hide the bar. */
    label?: string;
    ariaLabel?: string;
    decorative?: boolean;
    className?: string;
    ref?: Ref<HTMLDivElement>;
}
/** How far along: a filled track. It is information that moves often, so the fill is not animated. */
declare function DefaultProgressBar({ value, max, min, label, ariaLabel, decorative, className, ref }: ProgressBarProps): ReactNode;
/** Props for the `StepHeader` wizard step heading block. */
export interface StepHeaderProps {
    title: ReactNode;
    /** The heading's level: 1 (the room's own) by default, 2 where the form sits in a dialog that has its title. */
    level?: 1 | 2;
    /** The heading's id, for a region that is named by it. */
    id?: string;
    lead?: ReactNode;
    /** A decorative glyph before the title. */
    mark?: ReactNode;
    className?: string;
    ref?: Ref<HTMLElement>;
}
/** A step's title and the quiet lead under it. */
declare function DefaultStepHeader({ title, lead, mark, level, id, className, ref }: StepHeaderProps): ReactNode;
/** Props for the `ActionBar` form footer action strip. */
export interface ActionBarProps {
    /** Another class on the bar, for the form that draws it. */
    className?: string;
    back?: {
        label: ReactNode;
        onClick: () => void;
        icon?: ReactNode;
    };
    primary: {
        label: ReactNode;
        onClick: () => void;
        disabled?: boolean;
        loading?: boolean;
        loadingLabel?: ReactNode;
        icon?: ReactNode;
    };
    ref?: Ref<HTMLElement>;
}
/** The bar fixed to the foot of its container: Back as a quiet word, and a filled primary that takes the rest of the width. */
declare function DefaultActionBar({ back, primary, className, ref }: ActionBarProps): ReactNode;
/** Props for the `Columns` responsive form column layout. */
interface ColumnsProps {
    cols?: string;
    children: ReactNode;
    className?: string;
    ref?: Ref<HTMLDivElement>;
}
/** Fields side by side; `cols` is a grid template such as "1fr 1.8fr". */
declare function DefaultColumns({ cols, children, className, ref }: ColumnsProps): ReactNode;
/** Props for the `ReviewList` labelled form summary group. */
export interface ReviewListProps {
    label: string;
    children: ReactNode;
    className?: string;
    ref?: Ref<HTMLDivElement>;
}
/** The editable review: earlier steps' fields drawn again in one labelled group. */
declare function DefaultReviewList({ label, children, className, ref }: ReviewListProps): ReactNode;
/** Static linear progress bar for multi-step forms and completion ratios. */
export declare const ProgressBar: typeof DefaultProgressBar;
/** Focusable step heading with optional lead subtitle and decorative mark. */
export declare const StepHeader: typeof DefaultStepHeader;
/** Sticky or bottom-anchored form footer pairing a quiet Back action with a primary submit button. */
export declare const ActionBar: typeof DefaultActionBar;
/** Responsive multi-column grid container for adjacent form fields. */
declare const Columns: typeof DefaultColumns;
/** Accessible labelled group for reviewing and editing earlier form step answers. */
export declare const ReviewList: typeof DefaultReviewList;
/**
 * What every form control says about its frame, once: the label, the hint, the problem, the word for an optional
 * field and a help tip. internal/Frame.tsx draws it around the control, so a control never joins them by hand.
 */
/** Shared label, hint, problem, and sizing frame props inherited by form controls. */
interface FieldFrame {
    label: ReactNode;
    /** A sentence under the control that helps before anything goes wrong. */
    hint?: ReactNode;
    /** What is wrong now, in the reader's words. Its line is kept in the flow, so saying it moves nothing (`reserve`). */
    problem?: ReactNode;
    required?: boolean;
    /** The label is read to assistive technology but not drawn. */
    labelHidden?: boolean;
    /** The word that says a field may be left empty ("(optional)"), in the caller's language; Field draws it where the worn theme asks. */
    optional?: ReactNode;
    /** A help tip beside the label. */
    tip?: HelpTipProps;
    /** Keep the problem's line in the flow while empty. On by default for a form's controls; turn it off for a dense row. */
    reserve?: boolean;
    /** A short answer's kind: the control is only as wide as the answer (Field's `kind`). */
    kind?: AnswerKind;
    /** The control's id; one is made when not given. */
    id?: string;
    className?: string;
}
interface FileFieldBase extends FieldFrame {
    /** What the picker offers, as the input's `accept`: `.csv`, `text/csv`, `image/*`, separated by commas. */
    accept?: string;
    name?: string;
    disabled?: boolean;
    ref?: Ref<HTMLInputElement>;
    /** The button's words, in the caller's language: "Choose file" ("Choose files" with `multiple`) unless said. */
    chooseLabel?: string;
    /** What the names say while there is no file: "No file chosen". */
    noneLabel?: string;
    /** Localized strings for FileField controls. */
    words?: {
        chooseFile?: string;
        chooseFiles?: string;
        noFileChosen?: string;
    };
}
/** Props for single-file or multi-file `FileField`. */
export type FileFieldProps = FileFieldBase & ({
    multiple?: false;
    /** The chosen file; null while there is none. Set it to null to clear the choice. */
    value: File | null;
    onValueChange?: (file: File | null, details: ChangeDetails<'file-pick'>) => void;
} | {
    multiple: true;
    /** The chosen files; empty while there are none. Set it to `[]` to clear the choice. */
    value: readonly File[];
    onValueChange?: (files: File[], details: ChangeDetails<'file-pick'>) => void;
});
declare function DefaultFileField(props: FileFieldProps): ReactNode;
/** Accessible browser file picker field with themed trigger button and selected file readout. */
export declare const FileField: typeof DefaultFileField;
interface Mask {
    format: (raw: string) => string;
    parse: (typed: string) => string;
    /** How many raw characters make a whole value, when there is one (a phone is 10 digits). */
    length?: number;
    placeholder?: string;
    inputMode?: 'text' | 'numeric' | 'decimal' | 'tel' | 'email';
}
type MaskName = 'phone' | 'date' | 'month' | 'ssn' | 'zip' | 'digits' | 'money' | 'grouped';
/** Props for the `SensitiveField` masked secret control. */
export interface SensitiveFieldProps extends FieldFrame {
    /** The raw value. */
    value: string;
    onValueChange?: (raw: string, details: ChangeDetails<'input-change'>) => void;
    mask: Mask | MaskName;
    disabled?: boolean;
    valid?: boolean;
    validIcon?: ReactNode;
    onBlur?: () => void;
    /** The line under the box. */
    note?: ReactNode;
    noteIcon?: ReactNode;
    /** The words of the button beside the box. */
    showLabel: string;
    hideLabel: string;
    ref?: Ref<HTMLInputElement>;
}
declare function DefaultSensitiveField(props: SensitiveFieldProps): ReactNode;
/** Masked sensitive identifier field holding bullet dots in the DOM until explicitly revealed. */
export declare const SensitiveField: typeof DefaultSensitiveField;
/** Props for the `TextArea` multi-line form control. */
export interface TextAreaProps extends FieldFrame {
    value: string;
    onValueChange?: (value: string, details: ChangeDetails<'input-change'>) => void;
    onBlur?: () => void;
    /** Lines the box shows before the reader stretches it. Default 3. */
    rows?: number;
    maxLength?: number;
    autoComplete?: string;
    placeholder?: string;
    name?: string;
    disabled?: boolean;
    readOnly?: boolean;
    monospace?: boolean;
    ref?: Ref<HTMLTextAreaElement>;
    /** Something drawn under the box: a count, say. */
    after?: ReactNode;
}
declare function DefaultTextArea(props: TextAreaProps): ReactNode;
/** Framed multi-line textarea wiring label, hint, problem, and optional monospace styling. */
export declare const TextArea: typeof DefaultTextArea;
/** Props for `ValidMark`. */
export interface ValidMarkProps {
    icon?: ReactNode;
    className?: string;
    ref?: Ref<HTMLSpanElement>;
}
/** The mark at a box's inline end: drawn in CSS unless a picture is lent. Decorative: validity is `aria-invalid`'s to say. */
declare function DefaultValidMark({ icon, className, ref }: ValidMarkProps): ReactNode;
/** Props for the `TextField` form control. */
export interface TextFieldProps extends FieldFrame {
    value: string;
    onValueChange?: (value: string, details: ChangeDetails<'input-change'>) => void;
    onBlur?: () => void;
    /** Present, the box reserves room for the mark; true draws it. Leave it out for a box that never shows one. */
    valid?: boolean;
    /** A picture for the mark in place of the drawn check. */
    validIcon?: ReactNode;
    type?: 'text' | 'email' | 'tel' | 'url';
    inputMode?: 'text' | 'email' | 'tel' | 'numeric' | 'decimal' | 'url';
    autoComplete?: string;
    placeholder?: string;
    name?: string;
    disabled?: boolean;
    readOnly?: boolean;
    ref?: Ref<HTMLInputElement>;
    /** Something drawn under the box: a computed line, say. */
    after?: ReactNode;
}
declare function DefaultTextField(props: TextFieldProps): ReactNode;
/** Props for the `MaskedField` form control. */
export interface MaskedFieldProps extends Omit<TextFieldProps, 'value' | 'onValueChange'> {
    mask: Mask | MaskName;
    /** The raw value: the digits, usually. */
    value: string;
    onValueChange?: (raw: string, details: ChangeDetails<'input-change'>) => void;
}
/** A box that shows its value through a mask and keeps the raw one: `masks.phone`, `masks.date` (typed MM/DD/YYYY), `masks.ssn`… */
declare function DefaultMaskedField(props: MaskedFieldProps): ReactNode;
/** Props for the `MoneyField` form control. */
export type MoneyFieldProps = Omit<MaskedFieldProps, 'mask'> & {
    symbol?: string;
};
/** Money, drawn `$2,500` or `$1,250.50` (or `25,000` with `symbol=""`) in the page's locale. The value is a plain decimal
    string whatever the locale: `2500`, `1250.5`, `-5`. */
declare function DefaultMoneyField({ symbol, ...rest }: MoneyFieldProps): ReactNode;
/** Decorative inline check indicator rendered inside validated field boxes. */
export declare const ValidMark: typeof DefaultValidMark;
/** Framed single-line text input wiring label, hint, problem, and optional validity mark. */
export declare const TextField: typeof DefaultTextField;
/** Framed text input formatting display values through a reversible `Mask` while preserving caret position. */
export declare const MaskedField: typeof DefaultMaskedField;
/** Framed currency input built over `MaskedField` and `masks.money`. */
export declare const MoneyField: typeof DefaultMoneyField;
/** Props for the `Label` form caption element. */
export type LabelProps = CleanElementProps<'label'>;
/** Accessible `<label>` element styled for form controls. */
export declare function Label({ ariaLabel, className, ...rest }: LabelProps): React.ReactElement | null;
/** Option descriptor for `ChoiceCards`. */
export interface ChoiceOption {
    value: string;
    label: string;
    /** A picture for a card. */
    icon?: ReactNode;
}
/** Props for the `YesNo` binary radio card pair. */
export interface YesNoProps extends Omit<FieldFrame, 'label'> {
    /** The question. */
    label: ReactNode;
    value: 'yes' | 'no' | '';
    onValueChange?: (value: 'yes' | 'no', details: ChangeDetails<'select'>) => void;
    /** The two words, in the caller's language. */
    yes: string;
    no: string;
    ref?: Ref<HTMLDivElement>;
}
/** Two buttons answering a question. */
declare function DefaultYesNo(props: YesNoProps): ReactNode;
/** Props for `ChoiceCards` single-choice or multi-choice card group. */
export interface ChoiceCardsProps extends FieldFrame {
    options: readonly ChoiceOption[];
    value: readonly string[];
    onValueChange?: (value: string[], details: ChangeDetails<'select'>) => void;
    /** Several may be on. */
    multiple?: boolean;
    /** The card that stands alone ("None"): choosing it clears the rest, and choosing another clears it. */
    exclusive?: string;
    ref?: Ref<HTMLDivElement>;
}
/** Cards with an icon, a label and a box. One choice is a radio group; `multiple` a group of checkboxes. */
declare function DefaultChoiceCards(props: ChoiceCardsProps): ReactNode;
/** One card of several: its words, its picture and whether it is on. */
export interface CheckCard {
    key: string;
    label: ReactNode;
    icon?: ReactNode;
    /** A line under the label. */
    help?: ReactNode;
    on: boolean;
}
/** Props for the `CheckCards` roving-focus checkbox card group. */
export interface CheckCardsProps {
    cards: readonly CheckCard[];
    /** The card at `index` turned on or off. */
    onToggle: (index: number, on: boolean, details: ChangeDetails<'toggle'>) => void;
    id?: string;
    disabled?: boolean;
    ariaLabel?: string;
    'aria-labelledby'?: string;
    'aria-describedby'?: string;
    'aria-invalid'?: AriaAttributes['aria-invalid'];
    /** How short every card's words are (`short` or `brief`). */
    fit?: 'short' | 'brief';
    className?: string;
    ref?: Ref<HTMLDivElement>;
}
declare function DefaultCheckCards(props: CheckCardsProps): ReactNode;
/** Props for the `Checkbox` control. */
export interface CheckboxProps extends Omit<FieldFrame, 'label'> {
    value?: string;
    checked?: boolean | 'indeterminate';
    defaultChecked?: boolean;
    indeterminate?: boolean;
    onCheckedChange?: (on: boolean, details: ChangeDetails<'toggle'>) => void;
    /** The text beside the box; it is the label, so it is a click target too. Omit for a standalone checkbox with `ariaLabel`. */
    label?: ReactNode;
    description?: ReactNode;
    ariaLabel?: string;
    size?: ControlSize;
    disabled?: boolean;
    ref?: Ref<HTMLButtonElement>;
}
/** Props for the `Consent` long-notice checkbox control. */
export type ConsentProps = CheckboxProps;
/** A checkbox beside its text, or standalone when `label` is omitted. */
declare function DefaultCheckbox(props: CheckboxProps): ReactNode;
/** A checkbox for a long notice: the paragraph is the label, in the body's weight. */
declare function DefaultConsent(props: ConsentProps): ReactNode;
/** Framed Yes/No radio card pair for binary questions. */
export declare const YesNo: typeof DefaultYesNo;
/** Framed single-choice or multi-choice option cards with icons and exclusive option support. */
export declare const ChoiceCards: typeof DefaultChoiceCards;
/** Roving-focus multi-select checkbox card group with single Tab stop and arrow-key navigation. */
export declare const CheckCards: typeof DefaultCheckCards;
/** Accessible checkbox control with optional indeterminate state, label, hint, and problem wiring. */
export declare const Checkbox: typeof DefaultCheckbox;
/** Long-notice consent checkbox styled in body text weight. */
export declare const Consent: typeof DefaultConsent;
/**
 * A themed listbox, over UI SDK's Select.
 *
 * A native `<select>` cannot be styled where it matters: the open menu is
 * drawn by the operating system, in the system font, with the system
 * highlight colour, ignoring the page entirely. UI SDK gives back what
 * the native one gave for free — arrows move, Home and End jump, Enter and
 * Space choose, Escape closes and returns focus, Tab closes, typing jumps
 * to a matching option, the roles and `aria-expanded` — and this draws it
 * on its parts' slots (`select-trigger`, `select-content`, `select-item`),
 * which the stylesheet dresses.
 *
 * Actions ride under a divider and are walked with the same arrows, but
 * run rather than become the value: the value stays what the caller says
 * it is, so choosing "re-read the schema" cannot select it.
 */
/** Option item descriptor for `Dropdown` and `MultiDropdown`. */
export interface DropdownItem {
    value: string;
    label: string;
    detail?: string;
    badge?: string;
    disabled?: boolean;
    /** Semantic tone colouring the option's label. */
    tone?: Tone;
    swatches?: string[];
}
/** Change details reported when a `Dropdown` or `MultiDropdown` value moves. */
export type DropdownChange = ChangeDetails<'item-press' | 'autofill' | 'sync'>;
interface DropdownBase {
    items: readonly DropdownItem[];
    /** What a reader hears the list called; falls back to the host seam's `select` word when unnamed. */
    ariaLabel?: string;
    ariaInvalid?: boolean;
    ariaDescribedBy?: string;
    /** The caption that names the button, where it is drawn beside it (a field's label, "(required)" and all); `ariaLabel` gives way to it. */
    ariaLabelledBy?: string;
    /** The button's id, so a field's `<label for>` names it (components/Field.tsx). */
    id?: string;
    /** Ref forwarded to the trigger `<button>` element. */
    ref?: Ref<HTMLButtonElement>;
    popupRef?: Ref<HTMLDivElement>;
    onOpenChange?: (open: boolean, details: ChangeDetails<'trigger-press' | 'outside-press' | 'escape-key' | 'window-resize' | 'item-press' | 'focus-out' | 'list-navigation' | 'cancel-open' | 'implicit'>) => void;
    disabled?: boolean;
    readOnly?: boolean;
    /** Wrapper class name on the `[data-slot="dropdown"]` container. */
    className?: string;
    /** A class on the shown value — a page title that is also a picker. */
    valueClassName?: string;
    /** Things to do rather than pick, listed under a divider — "re-read the schema" beneath the databases. */
    actions?: readonly DropdownAction[];
    /** Classes on the button beside `dd-button`: a form's field wears `field-control` through it. */
    buttonClassName?: string;
    /** Classes on the list beside `dd-list`. */
    listClassName?: string;
    /** The id of the shown value, so a form can name the button by its label and its value both. */
    valueId?: string;
    /** What the button says while nothing is chosen (a form's "Choose"); without it an empty list says a dash. */
    placeholder?: string;
}
/** Props for single-value `Dropdown`. */
export type DropdownProps = DropdownBase & {
    value: string;
    onValueChange?: (value: string, details: DropdownChange) => void;
};
/** Props for multi-value `MultiDropdown`. */
export type MultiDropdownProps = DropdownBase & {
    value: readonly string[];
    onValueChange?: (value: string[], details: DropdownChange) => void;
};
/** Non-selectable command row rendered beneath a separator inside `Dropdown`. */
export interface DropdownAction {
    label: string;
    onSelect: () => void;
}
declare function DefaultDropdown(props: DropdownProps): import("react").JSX.Element;
/** The same listbox choosing several: it stays open while it is chosen from, and the button says the choices. */
declare function DefaultMultiDropdown(props: MultiDropdownProps): import("react").JSX.Element;
/** Accessible single-select listbox popup with keyboard typeahead, swatches, and trailing actions. */
export declare const Dropdown: typeof DefaultDropdown;
/** Accessible multi-select listbox popup preserving item order and check indicators. */
export declare const MultiDropdown: typeof DefaultMultiDropdown;
/** Option item descriptor for `Select` and `MultiSelect`. */
export type SelectOption<T extends string = string> = Omit<DropdownItem, 'value'> & {
    value: T;
    icon?: ReactNode;
    description?: string;
};
interface BaseSelectFrame<T extends string = string> extends Omit<FieldFrame, 'label'> {
    label?: ReactNode;
    options: readonly SelectOption<T>[];
    /** What the box says while nothing is chosen ("Choose"). */
    placeholder?: string;
    disabled?: boolean;
    size?: ControlSize;
    ariaLabel?: string;
    'aria-labelledby'?: string;
    triggerClassName?: string;
    ref?: Ref<HTMLButtonElement>;
}
/** Props for single-choice `Select`. */
export interface SelectProps<T extends string = string> extends BaseSelectFrame<T> {
    value?: T | null;
    onValueChange?: (value: T, details: DropdownChange) => void;
}
/** Props for multi-choice `MultiSelect`. */
export interface MultiSelectProps<T extends string = string> extends BaseSelectFrame<T> {
    value: readonly T[];
    onValueChange?: (value: T[], details: DropdownChange) => void;
}
/** One choice from a list, under a field box or standalone. */
declare function DefaultSelect<T extends string = string>(props: SelectProps<T>): ReactNode;
/** Several choices, each with a checkbox; the closed box says them as "Acura, Alfa Romeo". */
declare function DefaultMultiSelect<T extends string = string>(props: MultiSelectProps<T>): ReactNode;
/** Framed or standalone single-choice listbox control over `Dropdown`. */
export declare const Select: typeof DefaultSelect;
/** Framed or standalone multi-choice listbox control over `MultiDropdown`. */
export declare const MultiSelect: typeof DefaultMultiSelect;
/** Props for the `Slider` numeric range control. */
export interface SliderProps extends FieldFrame {
    value: number;
    onValueChange?: (value: number, details: ChangeDetails<'slide'>) => void;
    min: number;
    max: number;
    step?: number;
    /** Custom value formatter overriding `format` preset and default grouped integer readout. */
    formatValue?: (n: number) => string;
    /** Built-in numeric format preset (`'number' | 'money' | 'percent'`). */
    format?: 'number' | 'money' | 'percent';
    /** ISO currency code for `format="money"`, as `FormattedValue` and `LineItemsEditor` take theirs. Defaults to `'USD'`. */
    currency?: string;
    locale?: string;
    disabled?: boolean;
    ref?: Ref<HTMLInputElement>;
}
declare function DefaultSlider(props: SliderProps): ReactNode;
/** Framed numeric range slider with live readout and labelled min/max bounds. */
export declare const Slider: typeof DefaultSlider;
/** Props for the `Switch` toggle control. */
export interface SwitchProps {
    /** The label beside the switch; its click toggles, as the switch's own does. */
    label?: ReactNode;
    /** A line under the label, in the muted ink, never a click target. */
    description?: ReactNode;
    checked?: boolean;
    defaultChecked?: boolean;
    onCheckedChange?: (checked: boolean, details: ChangeDetails<'toggle'>) => void;
    disabled?: boolean;
    /** Working: pressed once already. Says so and refuses another press, keeping the focus. */
    loading?: boolean;
    size?: ControlSize;
    ariaLabel?: string;
    controlPosition?: 'start' | 'end';
    wrapperClassName?: string;
    id?: string;
    className?: string;
    ref?: Ref<HTMLButtonElement>;
}
declare function DefaultSwitch(props: SwitchProps): import("react").JSX.Element;
/** Accessible boolean switch control with label, description, and focus-preserving loading state. */
export declare const Switch: typeof DefaultSwitch;
/**
 * A box you type into and a list that answers, over UI SDK's Autocomplete.
 *
 * Three surfaces here are this shape — the record picker, the table picker
 * on the diagram, the reference filter box — and each walked its own list
 * with arrow keys, placed it by hand and closed it on a blur timer. UI SDK
 * owns that now: the combobox roles, arrows and Home/End, Enter on the
 * highlighted row, Tab and a click outside to leave, the first row lit as
 * you type. The caller ranks and fetches the items, so nothing is filtered
 * here; it draws each row in its own classes, and hears one `onPick`.
 *
 * The text is the caller's: on a pick UI SDK would fill the box with the
 * item's label, and that fill is refused here, so a picker that wants the
 * box emptied (a multi-select) or named (a single one) decides itself.
 * Escape closes only this layer, stopped, so the panel underneath does not
 * take the same key. The list is placed by UI SDK against the box (or the
 * caller's anchor) and drawn inside the enclosing dialog when there is one.
 */
/** Why a combobox's text or list moved: typed, cleared, an option pressed, Escape, the focus gone… */
export type TypeaheadReason = 'trigger-press' | 'input-press' | 'outside-press' | 'item-press' | 'close-press' | 'escape-key' | 'list-navigation' | 'focus-out' | 'input-change' | 'input-clear' | 'clear-press' | 'chip-remove-press' | 'cancel-open' | 'implicit';
/** Props for the `Typeahead` combobox primitive. */
export interface TypeaheadProps<T> {
    text: string;
    onText: (text: string, details: ChangeDetails<TypeaheadReason>) => void;
    /** Already ranked and bounded; drawn in this order. */
    items: T[];
    itemKey: (item: T) => string;
    itemLabel: (item: T) => string;
    itemClassName: (item: T, highlighted: boolean) => string;
    renderItem: (item: T) => ReactNode;
    onPick: (item: T) => void;
    open: boolean;
    onOpenChange: (open: boolean, details: ChangeDetails<TypeaheadReason>) => void;
    /** The `<input>`'s own attributes — class, label, placeholder, title, the caller's keys. */
    inputProps: Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'aria-label' | 'inlist'> & {
        ariaLabel?: string;
    };
    /** Forwarded ref to the underlying `<input>` element. */
    ref?: Ref<HTMLInputElement>;
    /** The actual popup, including when it is portalled outside the input's parent. */
    popupRef?: Ref<HTMLDivElement>;
    /** The element the list is sized and placed against; the input by default. */
    anchorRef?: RefObject<HTMLElement | null>;
    /** `width` matches the anchor exactly; `min-width` lets a long name widen the list. */
    fit?: 'width' | 'min-width';
    popupClassName: string;
    listClassName: string;
    /** Shown in the list when nothing matches; nothing at all when omitted. */
    empty?: EmptyStateSpec | ReactNode;
    emptyClassName?: string;
    /**
     * Where the list is drawn: inside the enclosing dialog (the default), so
     * it shares the dialog's focus trap, or the body. A popover is a dialog
     * too, and a caller whose box stands in one may not want the list held
     * inside it (clipped to it, sized by it): `body` sends the list where
     * every popup on the page goes (internal/popups.ts).
     */
    portal?: 'dialog' | 'body';
    /** Light the first row as the reader types (the default), or nothing until they arrow in: a search box's Enter is its own. */
    autoHighlight?: boolean;
    /** Hears the row lit by the keys or the pointer, and undefined when none is. */
    onHighlight?: (item: T | undefined) => void;
    className?: string;
}
declare function DefaultTypeahead<T>(props: TypeaheadProps<T>): import("react").JSX.Element;
/** Text input with ranked popup suggestions, keyboard navigation, and custom item rendering. */
export declare const Typeahead: typeof DefaultTypeahead;
/**
 * The themed calendar field: editable ISO text beside a calendar popover,
 * for a date, or with `withTime` for a date and a wall-clock time. The text
 * is the value — typed drafts survive, the calendar only ever writes the
 * date part — and nothing here converts a value through an instant. The
 * arithmetic and the bounds are datePickerModel.ts's; the popover and the
 * month's grid, with its keys, are UI SDK's. Its words and the calendar
 * button's icon are props: the kit lends its catalog's and its icon.
 */
/** What a date field says. A `format` is the locale's numeric date pattern ("MM/DD/YYYY"). */
export interface DateFieldWords {
    /** How a wall-clock time is written in the box ("HH:MM"). A date and a time are typed as the locale's date, then this:
        the one format the box shows, the placeholder says and the hint reads. */
    timePattern: string;
    /** The box's complaint at a date and time it cannot take, given the format it takes. */
    enterDateAndTime: (format: string) => string;
    /** The box's complaint at a date it cannot take. */
    enterDate: (format: string) => string;
    /** The hint read with the box: its format, for a date and a time. */
    dateAndTimeFormat: (format: string) => string;
    /** The hint read with the box: its format, for a date. */
    dateFormat: (format: string) => string;
    /** The hint's second sentence: the key that opens the calendar. */
    openWithKeys: string;
    /** The calendar button's name, with the field's label when it has one. */
    chooseDate: (label?: string) => string;
    /** The calendar's name, with the field's label when it has one. */
    calendar: (label?: string) => string;
    previousMonth: string;
    nextMonth: string;
    clear: string;
    today: string;
    /** The clock's name beside a date and a time, with the field's label when it has one. Absent, no clock is drawn. */
    time?: (label?: string) => string;
}
/** Props for the `DateField` ISO date and wall-clock date-time picker control. */
export interface DateFieldProps {
    id: string;
    words: DateFieldWords;
    /** Drawn in the calendar button. */
    calendarIcon: ReactNode;
    value: string;
    /** Typed text is preserved, including an incomplete date; callers validate on commit. `day-press` is a day (or Clear,
        or Today) chosen in the calendar. */
    onValueChange?: (value: string, details: ChangeDetails<'input-change' | 'day-press'>) => void;
    /** Composite blur: never fired while focus moves between the input and calendar. */
    onBlur?: () => void;
    onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
    disabled?: boolean;
    required?: boolean;
    min?: string;
    max?: string;
    locale?: string;
    timezone?: string;
    /** The moment the calendar's today is counted from: the App's clock where it runs as of another day; the real time when absent. */
    now?: Date;
    firstDay?: number;
    className?: string;
    name?: string;
    ref?: Ref<HTMLInputElement>;
    placeholder?: string;
    /** A date and a wall-clock time (`YYYY-MM-DD HH:MM`, as the box says it; the `T` a datetime-local control writes is read too): the calendar
        picks the date and keeps the time typed. `min` and `max` then bound the whole value. */
    withTime?: boolean;
    /** The calendar is drawn in a portal; an owner that watches focus (an autosaving field) is told where. */
    popupRef?: (node: HTMLDivElement | null) => void;
    /** A popover's words (`trigger-press`, `outside-press`, `escape-key` …), `day-press` when a choice closed it, `open-key` for Alt+ArrowDown, and `disabled` when the
        field was disabled or its bounds stopped agreeing while it was open. */
    onOpenChange?: (open: boolean, details: ChangeDetails<DateFieldOpenReason>) => void;
    ariaLabel?: string;
    'aria-invalid'?: AriaAttributes['aria-invalid'];
    'aria-describedby'?: string;
}
/** Reasons reported to `DateField`'s `onOpenChange` callback. */
export type DateFieldOpenReason = 'trigger-hover' | 'trigger-focus' | 'trigger-press' | 'outside-press' | 'escape-key' | 'close-press' | 'focus-out' | 'imperative-action' | 'implicit' | 'day-press' | 'open-key' | 'disabled';
/** A date field, or a date and a wall-clock time. No input is parsed as an instant or shifted by a timezone. */
declare function DefaultDateField(props: DateFieldProps): import("react").JSX.Element;
/** Editable ISO date or wall-clock date-time field paired with a lazy-loaded popover calendar. */
export declare const DateField: typeof DefaultDateField;
/** Screen edge from which a `Drawer` sheet enters. */
export type DrawerSide = 'left' | 'right';
interface DrawerBase {
    open: boolean;
    onOpenChange?: (open: boolean, details: ChangeDetails<'trigger-press' | 'outside-press' | 'escape-key' | 'close-watcher' | 'close-press' | 'focus-out' | 'imperative-action' | 'swipe' | 'implicit'>) => void;
    side?: DrawerSide;
    children: ReactNode;
    className?: string;
    /** A non-cancellable operation is awaiting acknowledgement. */
    closeDisabled?: boolean;
    /** The close control's name, in the caller's language. */
    closeLabel?: string;
    /** Localized strings for Drawer controls. */
    words?: {
        close?: string;
    };
    ref?: Ref<HTMLDivElement>;
}
/** Props for `Drawer`; requires either a visible `title` or an `ariaLabel`. */
export type DrawerProps = DrawerBase & ({
    title: ReactNode;
    ariaLabel?: string;
} | {
    title?: undefined;
    ariaLabel: string;
});
declare function DefaultDrawer({ open, onOpenChange, side, title, ariaLabel, children, className, closeDisabled, closeLabel, words, ref, }: DrawerProps): import("react").JSX.Element;
/** Slide-in edge sheet dialog with focus trap, backdrop scrim, and Escape/swipe dismissal. */
export declare const Drawer: typeof DefaultDrawer;
/** Imperative handle for closing an open `Modal`. */
export interface ModalHandle {
    close: () => void;
}
/** Props for the `Modal` dialog primitive. */
export interface ModalProps {
    /** The classes the stylesheet knows the box by (`confirm`, `prefs`); the first also names the scrim (`[data-slot='dialog-backdrop'][data-for='confirm']`). Optional: a bare modal is centered and sized as a modal alone. */
    className?: string;
    /** Told once, however the dialog closed. */
    onClose: () => void;
    /** A non-cancellable operation is awaiting acknowledgement. */
    closeDisabled?: boolean;
    /** Return false to keep the dialog open, for example while confirming discard. */
    beforeClose?: () => boolean;
    children: ReactNode;
    /** The control to focus on open; UI SDK's default (the first focusable) otherwise. */
    initialFocus?: RefObject<HTMLElement | null> | false;
    /** Where focus goes on close, once the page is no longer inert; the element focused at open otherwise. */
    finalFocus?: RefObject<HTMLElement | null>;
    /** The dialog's name; absent, its first heading names it. */
    ariaLabel?: string;
    /** The name of a cross in the box's top corner that closes it ("Close"). Given, the cross is drawn; it steps aside
        while a button of the caller's own says the same word, so a dialog has one control of that name. */
    closeLabel?: string;
    /** The box places itself — a panel that is its own scrim, a box the stylesheet already centres — so the `modal` placement is left off. */
    plain?: boolean;
    /** No scrim element: the box covers the screen itself. */
    backdrop?: boolean;
    /** `'mobile'` — the default — takes the whole screen under 640px, because a
        dialog that leaves a sliver of the page around it on a phone reads as a
        mistake rather than as a layer. `true` takes the whole screen at every
        width; `false` opts out, for a dialog small enough to be a confirmation
        and nothing more. */
    fullscreen?: boolean | 'mobile';
    ref?: Ref<ModalHandle>;
}
declare function DefaultModal({ className, onClose, closeDisabled, beforeClose, children, initialFocus, finalFocus, ariaLabel, closeLabel, plain, backdrop, fullscreen, ref, }: ModalProps): import("react").JSX.Element;
/** Modal dialog layer with focus trapping, scrim dismissal, Escape handling, and focus restoration. */
export declare const Modal: typeof DefaultModal;
/** Props for the `Popover` anchored floating surface. */
export interface PopoverProps {
    trigger: ReactNode;
    children: ReactNode;
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean, details: ChangeDetails<'trigger-hover' | 'trigger-focus' | 'trigger-press' | 'outside-press' | 'escape-key' | 'close-press' | 'focus-out' | 'imperative-action' | 'implicit'>) => void;
    side?: 'top' | 'bottom' | 'left' | 'right';
    align?: 'start' | 'center' | 'end';
    sideOffset?: number;
    arrow?: boolean;
    className?: string;
    /** The popup's accessible name, where it needs one. */
    ariaLabel?: string;
    ref?: Ref<HTMLDivElement>;
}
declare function DefaultPopover({ trigger, children, open, defaultOpen, onOpenChange, side, align, sideOffset, arrow, className, ariaLabel, ref, }: PopoverProps): import("react").JSX.Element;
/** Anchored floating popover layer with collision-aware placement, Escape dismissal, and dialog portal containment. */
export declare const Popover: typeof DefaultPopover;
/** Props for the `Tooltip` hover-and-focus supplementary note. */
export interface TooltipProps {
    /** The element the note belongs to; a button, a word, an icon. */
    trigger: ReactNode;
    /** The note itself: short, supplementary, never an action. */
    children: ReactNode;
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean, details: ChangeDetails<'trigger-hover' | 'trigger-focus' | 'trigger-press' | 'outside-press' | 'escape-key' | 'disabled' | 'imperative-action' | 'implicit'>) => void;
    side?: 'top' | 'bottom' | 'left' | 'right';
    align?: 'start' | 'center' | 'end';
    className?: string;
    ref?: Ref<HTMLDivElement>;
}
declare function DefaultTooltip({ trigger, children, open, defaultOpen, onOpenChange, side, align, className, ref }: TooltipProps): import("react").JSX.Element;
/** Accessible hover-and-focus tooltip note wired to its trigger's `aria-describedby`. */
export declare const Tooltip: typeof DefaultTooltip;
/** Props for the `DropMenu` trigger-and-popup menu control. */
export interface DropMenuProps {
    /** The wrapper's class — where the stylesheet places the control. */
    className?: string;
    /** The trigger's classes, in place of the menu's own trigger, which is a secondary button: a trigger that has them
     *  says `data-own` and is dressed by them alone. */
    triggerClassName?: string;
    triggerTitle?: string;
    /** The trigger's accessible name, when its visible label is shared with another menu on the page. */
    triggerLabel?: string;
    /** Accessible name for the trigger button when no visible text distinguishes it. */
    ariaLabel?: string;
    label: ReactNode;
    /** The popup's classes, over the menu's own surface. */
    popupClassName?: string;
    side?: 'top' | 'bottom';
    align?: 'start' | 'end';
    sideOffset?: number;
    disabled?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean, details: ChangeDetails<'trigger-hover' | 'trigger-focus' | 'trigger-press' | 'outside-press' | 'focus-out' | 'list-navigation' | 'escape-key' | 'item-press' | 'close-press' | 'sibling-open' | 'cancel-open' | 'imperative-action' | 'implicit'>) => void;
    /** Where the focus goes when the menu closes; absent, back to the trigger. An element, a ref to one, or a function
        that answers once the page has drawn again: an element, `true` for the trigger, `false` to leave the focus be. */
    finalFocus?: boolean | RefObject<HTMLElement | null> | (() => boolean | HTMLElement | null | void);
    children: ReactNode;
    ref?: Ref<HTMLDivElement>;
}
declare function DefaultDropMenu({ className, triggerClassName, triggerTitle, triggerLabel, ariaLabel, label, popupClassName, side, align, sideOffset, disabled, open, onOpenChange, finalFocus, children, ref, }: DropMenuProps): import("react").JSX.Element;
/** Props for `DropGroup`. */
export interface DropGroupProps {
    className?: string;
    labelClassName?: string;
    label: string;
    children: ReactNode;
    ref?: Ref<HTMLDivElement>;
}
/** A labelled run of items: a menu that changes several things says which each item changes. */
declare function DefaultDropGroup({ className, labelClassName, label, children, ref }: DropGroupProps): import("react").JSX.Element;
/** Props for `DropSeparator`. */
export interface DropSeparatorProps {
    className?: string;
    ref?: Ref<HTMLDivElement>;
}
/** A rule between two runs of items, a separator to a screen reader. */
declare function DefaultDropSeparator({ className, ref }: DropSeparatorProps): import("react").JSX.Element;
/** Props for `DropItem`. */
export interface DropItemProps {
    className?: string;
    disabled?: boolean;
    closeOnClick?: boolean;
    onClick: () => void;
    title?: string;
    children: ReactNode;
    ref?: Ref<HTMLButtonElement>;
}
/** An item drawn as a button, so `disabled` and the button styles hold. Closes the menu unless told not to. */
declare function DefaultDropItem({ className, disabled, closeOnClick, onClick, title, children, ref }: DropItemProps): import("react").JSX.Element;
/** Button-triggered popup action menu with keyboard navigation and focus restoration. */
export declare const DropMenu: typeof DefaultDropMenu;
/** Labeled group of items inside a `DropMenu`. */
export declare const DropGroup: typeof DefaultDropGroup;
/** Visual and accessible separator rule between `DropMenu` item groups. */
export declare const DropSeparator: typeof DefaultDropSeparator;
/** Action button item inside a `DropMenu`. */
export declare const DropItem: typeof DefaultDropItem;
/** Props for the `EmptyState` placeholder block. */
export interface EmptyStateProps extends CleanElementProps<'div', 'title'> {
    icon?: ReactNode;
    title: ReactNode;
    body?: ReactNode;
    description?: ReactNode;
    action?: ReactNode;
    secondaryAction?: ReactNode;
    compact?: boolean;
}
/** Placeholder card shown when a collection, search, or view has no items to display. */
export declare function EmptyState({ icon, title, body, description, action, secondaryAction, compact, ariaLabel, className, children, ...props }: EmptyStateProps): import("react").JSX.Element;
/** Props for the `Skeleton` loading placeholder bar. */
export interface SkeletonProps extends CleanElementProps<'span'> {
    width?: number | string;
    height?: number | string;
    lines?: number;
    circle?: boolean;
    radius?: 'xs' | 'sm' | 'md' | 'lg' | 'full';
}
/** Presentational loading placeholder bar or multi-line stack (`aria-hidden="true"`). */
export declare function Skeleton({ width, height, lines, circle, radius, ariaLabel, className, style, ref, ...props }: SkeletonProps): import("react").JSX.Element;
/** Props for the unified `Meter` component. */
export interface MeterProps {
    value: number;
    min?: number;
    max?: number;
    indeterminate?: boolean;
    tone?: Tone;
    label?: ReactNode;
    ariaLabel?: string;
    'aria-labelledby'?: string;
    valueLabel?: string;
    formatValue?: (value: number) => string;
    format?: 'number' | 'percent';
    showValue?: boolean;
    size?: ControlSize;
    fluid?: boolean;
    locale?: string;
    className?: string;
    style?: CSSProperties;
    ref?: Ref<HTMLElement>;
    children?: ReactNode;
}
declare function MeterTrackPart({ ariaLabel, className, ...props }: CleanElementProps<'div'>): import("react").JSX.Element;
declare function MeterIndicatorPart({ ariaLabel, className, ...props }: CleanElementProps<'div'>): import("react").JSX.Element;
declare function MeterLabelPart({ ariaLabel, className, ...props }: CleanElementProps<'span'>): import("react").JSX.Element;
declare function MeterValuePart({ ariaLabel, className, ...props }: CleanElementProps<'span'>): import("react").JSX.Element;
declare function MeterBase(props: MeterProps): import("react").JSX.Element;
/** Proportional bar meter supporting inline kit layout, labeled header gauge layout, and compound subparts. */
export declare const Meter: typeof MeterBase & {
    Root: typeof MeterBase;
    Track: typeof MeterTrackPart;
    Indicator: typeof MeterIndicatorPart;
    Label: typeof MeterLabelPart;
    Value: typeof MeterValuePart;
};
/**
 * A carousel: one slide at a time from a row of them, chosen with Previous
 * and Next or with a dot per slide. Plain React: one slide, two steps and
 * a dot row is all one is. The slides are the
 * caller's array (the Tabs pattern), not children kept in step by hand.
 * Controlled with `index`/`onIndexChange`, uncontrolled with
 * `defaultIndex`. The ends do not wrap: Previous disables on the first
 * slide and Next on the last, so the row keeps its shape and a reader is
 * never spun back to the start without asking. Only the current slide is
 * exposed to assistive tech (the rest are `aria-hidden`); the arrow keys
 * on the region move, Home goes first, End goes last — only while focus
 * is on the carousel or its own controls, so a widget inside a slide
 * keeps its keys — and
 * the slide's movement is silenced for a reader who asked for reduced
 * motion (the track's transition lives under `no-preference` in the
 * stylesheet). A step button that disables under a focused finger
 * hands focus to the other step, never to nowhere.
 */
/** Single slide definition for `Carousel`. */
export interface CarouselSlide {
    /** The slide's short name, said after its number ("1 of 3: Studio"). */
    label?: string;
    children: ReactNode;
}
/** Props for the `Carousel` slide viewer. */
export interface CarouselProps {
    slides: readonly CarouselSlide[];
    index?: number;
    defaultIndex?: number;
    onIndexChange?: (index: number, details: ChangeDetails<'navigate'>) => void;
    /** The region's accessible name, where the carousel needs one ("Project photos"). */
    ariaLabel?: string;
    /** Every word the carousel says, in the caller's language; any left out are English. */
    words?: Partial<CarouselWords>;
    className?: string;
    ref?: Ref<HTMLElement>;
}
interface CarouselWords {
    /** The region's name when `ariaLabel` is not given. */
    region: string;
    /** The step buttons' visible words. */
    previous: ReactNode;
    next: ReactNode;
    /** The dot row's name. */
    chooseSlide: string;
    /** A slide's name: "1 of 3: Studio". */
    slide: (number: number, total: number, label?: string) => string;
    /** A dot's name: "Go to slide 2: Studio". */
    goToSlide: (number: number, label?: string) => string;
    /** The polite status line read as the slide changes. */
    status: (number: number, total: number, label?: string) => string;
}
declare function DefaultCarousel({ slides, index, defaultIndex, onIndexChange, ariaLabel, words: given, className, ref }: CarouselProps): import("react").JSX.Element | null;
/** Accessible single-slide carousel with step buttons, dot indicators, and keyboard navigation. */
export declare const Carousel: typeof DefaultCarousel;
/** Single pane definition for `Resizable`. */
export interface ResizablePanel {
    /** The pane's accessible name, said by its handle's controls. */
    label?: string;
    /** The pane's starting share, in percent; shares are scaled to 100. */
    defaultSize?: number;
    /** The pane's smallest share, in percent; 10 by default. */
    minSize?: number;
    children: ReactNode;
}
/** Props for the `Resizable` multi-pane split container. */
export interface ResizableProps {
    panels: readonly ResizablePanel[];
    direction?: 'horizontal' | 'vertical';
    sizes?: readonly number[];
    onSizesChange?: (sizes: number[], details: ChangeDetails<'resize'>) => void;
    /** The group's accessible name, where the panes need one ("Record and detail"). */
    ariaLabel?: string;
    /** Every word the handles say, in the caller's language; any left out are English. */
    words?: Partial<ResizableWords>;
    className?: string;
    ref?: Ref<HTMLDivElement>;
}
interface ResizableWords {
    /** A handle's name, from the names of the two panes it parts (`before`, `after`). */
    resize: (before: string, after: string) => string;
    /** A pane's stand-in name when it has no `label`: "panel 2". */
    panel: (number: number) => string;
}
declare function DefaultResizable({ panels, direction, sizes, onSizesChange, ariaLabel, words: given, className, ref, }: ResizableProps): import("react").JSX.Element | null;
/** Multi-pane split layout with pointer-draggable and keyboard-navigable separator handles. */
export declare const Resizable: typeof DefaultResizable;
/**
 * A scroll area: a region that scrolls inside itself, with its own
 * thumb, instead of growing the page around it. Over UI SDK's ScrollArea,
 * which gives it the viewport, the thumb that tracks it and the corner
 * where two thumbs meet. Where its content overflows, the viewport is a
 * tab stop with the region's name, so a keyboard reader can reach it and
 * scroll with the arrows without a mouse; a region whose content never
 * overflows draws no thumb and is no tab stop to nowhere. `orientation`
 * says which thumbs exist (vertical by default); `maxHeight` caps the
 * region where the caller wants one, as a CSS length, and is otherwise
 * the caller's own height.
 * Where the scrolled content is a list, the list's own semantics stay on
 * the content — this region adds scrolling, never a second list. The
 * viewport is a tab stop only while its content overflows: a region
 * whose content fits draws no thumb and must be no tab stop to nowhere.
 * Overflow is measured, not assumed — on mount, on content change, and
 * whenever the box resizes.
 */
/** Props for the `ScrollArea` bounded scroll container. */
export interface ScrollAreaProps {
    children: ReactNode;
    /** The scrollable region's accessible name ("Recent activity"). */
    ariaLabel?: string;
    orientation?: 'vertical' | 'horizontal' | 'both';
    /** A cap on the region's height, as a CSS length (for example "320px"). */
    maxHeight?: string;
    className?: string;
    ref?: Ref<HTMLDivElement>;
}
declare function DefaultScrollArea({ children, ariaLabel, orientation, maxHeight, className, ref }: ScrollAreaProps): import("react").JSX.Element;
/** Bounded scroll container with custom scrollbars and keyboard-focusable overflow viewport. */
export declare const ScrollArea: typeof DefaultScrollArea;
/** Spacing scale tokens for padding and grid gaps. */
export type SpaceScale = 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl';
/** Layout gap scale shared across `Stack`, `Row`, `Cluster`, and `Beside`. */
export type LayoutGap = 'tight' | 'field' | 'section' | SpaceScale;
/** Props for the `Stack` vertical flex container. */
export interface StackProps extends CleanElementProps<'div'> {
    as?: 'div' | 'ul' | 'ol';
    gap?: LayoutGap;
    align?: 'stretch' | 'start' | 'center' | 'end';
    justify?: 'start' | 'center' | 'end' | 'between';
}
/** Vertical flex stack with tokenized spacing between children. */
export declare function Stack({ as, gap, align, justify, ariaLabel, className, style, ref, ...props }: StackProps): import("react").JSX.Element;
/** Props for the `Row` horizontal flex container. */
export interface RowProps extends CleanElementProps<'div'> {
    gap?: LayoutGap;
    align?: 'start' | 'center' | 'end' | 'baseline' | 'stretch';
    justify?: 'start' | 'center' | 'end' | 'between' | 'around';
    wrap?: boolean;
    foot?: boolean;
}
/** Horizontal flex row that wraps onto new lines when needed. */
export declare function Row({ gap, align, justify, wrap, foot, ariaLabel, className, style, ...props }: RowProps): import("react").JSX.Element;
/** Props for the `Cluster` responsive auto-fit column grid. */
export interface ClusterProps extends CleanElementProps<'div'> {
    /** Minimum column width as a CSS length (`'16rem'` by default). */
    min?: string;
    gap?: LayoutGap;
}
/** Responsive grid of equal columns at least `min` wide that wraps without sideways scroll. */
export declare function Cluster({ min, gap, ariaLabel, className, style, ...props }: ClusterProps): import("react").JSX.Element;
/** Props for the `Grid` CSS grid container. */
export interface GridProps extends CleanElementProps<'div'> {
    columns?: number | string;
    gap?: LayoutGap;
    align?: 'start' | 'center' | 'end' | 'stretch';
}
/** Multi-column CSS grid layout container. */
export declare function Grid({ columns, gap, align, ariaLabel, className, style, ...props }: GridProps): import("react").JSX.Element;
/** Props for the `Beside` main-plus-rail asymmetric two-column layout. */
export interface BesideProps extends CleanElementProps<'div'> {
    rail: ReactNode;
    railWidth?: string;
    side?: 'start' | 'end';
    gap?: LayoutGap;
    stackBelow?: string;
}
/** Main content column beside a fixed-width rail that stacks cleanly on narrow containers. */
export declare function Beside({ rail, railWidth, side, gap, stackBelow, ariaLabel, className, style, children, ref, ...props }: BesideProps): import("react").JSX.Element;
/** Surface elevation variant for `Card`. */
export type CardVariant = 'default' | 'subtle' | 'elevated' | 'ghost';
/** Props for `Card.Header`. */
export interface CardHeaderProps extends CleanElementProps<'div'> {
    bordered?: boolean;
}
/** Header bar inside a compound `Card`. */
export declare function CardHeader({ bordered, ariaLabel, className, ...props }: CardHeaderProps): import("react").JSX.Element;
/** Props for `Card.Title`. */
export type CardTitleProps = CleanElementProps<'h3'>;
/** Heading element inside a compound `Card.Header`. */
export declare function CardTitle({ ariaLabel, className, ...props }: CardTitleProps): import("react").JSX.Element;
/** Props for `Card.Description`. */
export type CardDescriptionProps = CleanElementProps<'p'>;
/** Secondary description line inside a compound `Card.Header`. */
export declare function CardDescription({ ariaLabel, className, ...props }: CardDescriptionProps): import("react").JSX.Element;
/** Props for `Card.Body`. */
export interface CardBodyProps extends CleanElementProps<'div'> {
    flush?: boolean;
}
/** Content body inside a compound `Card`. */
export declare function CardBody({ flush, ariaLabel, className, ...props }: CardBodyProps): import("react").JSX.Element;
/** Props for `Card.Footer`. */
export type CardFooterProps = CleanElementProps<'div'>;
/** Footer bar inside a compound `Card`. */
export declare function CardFooter({ ariaLabel, className, ...props }: CardFooterProps): import("react").JSX.Element;
/** Props for the unified `Card` container. */
export interface CardProps extends CleanElementProps<'div', 'title'> {
    title?: ReactNode;
    level?: 2 | 3 | 4;
    count?: ReactNode;
    action?: ReactNode;
    actions?: ReactNode;
    description?: ReactNode;
    badge?: ReactNode;
    footer?: ReactNode;
    tone?: Tone;
    ground?: 'nav';
    variant?: CardVariant;
    interactive?: boolean;
    flush?: boolean;
    borderedHeader?: boolean;
}
declare function CardBase({ title, level, count, action, actions, description, badge, footer, tone, ground, variant, interactive, flush, borderedHeader, ariaLabel, className, children, ...props }: CardProps): import("react").JSX.Element;
/** Bordered surface card that collapses to a plain group when nested inside another `Card`. */
export declare const Card: typeof CardBase & {
    Header: typeof CardHeader;
    Title: typeof CardTitle;
    Description: typeof CardDescription;
    Body: typeof CardBody;
    Footer: typeof CardFooter;
};
/** Props for the `Pagination` page navigation bar. */
export interface PaginationProps {
    /** The current page, 1-based. */
    page: number;
    /** The number of pages. */
    pages: number;
    onPageChange: (page: number, details: ChangeDetails<'page-press'>) => void;
    /** The list's accessible name, where the pager needs one ("Invoices, pages"). */
    ariaLabel?: string;
    /** Every word the pager says, in the caller's language; any left out are English. */
    words?: Partial<PaginationWords>;
    className?: string;
    ref?: Ref<HTMLElement>;
}
interface PaginationWords {
    /** The nav's name when `ariaLabel` is not given. */
    pages: string;
    previous: ReactNode;
    next: ReactNode;
}
declare function DefaultPagination({ page, pages, onPageChange, ariaLabel, words: given, className, ref }: PaginationProps): import("react").JSX.Element | null;
/** Accessible 1-based page navigation bar with windowed page numbers, ellipses, and previous/next controls. */
export declare const Pagination: typeof DefaultPagination;
/**
 * Tabs: one panel at a time, chosen from a row. Over UI SDK's Tabs, which
 * gives it the tablist, the arrow-key walk between tabs and the panel that
 * belongs to the chosen one; a disabled tab is skipped by that walk, never
 * a dead end. Controlled with `value`/`onValueChange`, uncontrolled with
 * `defaultValue`. Panels are the tab's own children, not a second render
 * the caller keeps in step.
 */
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
} & ({
    value: T;
    key?: T;
} | {
    key: T;
    value?: T;
});
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
declare function DefaultTabs<T extends string = string>({ tabs, items, value, defaultValue, param, width, onValueChange, variant, orientation, activationMode, fitted, className, ariaLabel, children, ref, }: TabsProps<T>): import("react").JSX.Element;
/** Accessible tabbed panel switcher with arrow-key roving focus, indicator bar, and optional URL query param sync. */
export declare const Tabs: typeof DefaultTabs;
/** Visual size scale for `Avatar`. */
export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
/** Presence indicator status for `Avatar`. */
export type AvatarStatus = 'online' | 'offline' | 'busy' | 'away';
/** Props for the `Avatar` component. */
export interface AvatarProps {
    /** The person's name, for the fallback initials. */
    name?: string;
    /** The picture's address; absent, the fallback shows at once. */
    src?: string;
    alt?: string;
    fallback?: ReactNode;
    size?: AvatarSize;
    shape?: 'circle' | 'rounded';
    status?: AvatarStatus;
    className?: string;
    ref?: Ref<HTMLSpanElement>;
}
declare function DefaultAvatar({ name, src, alt, fallback, size, shape, status, className, ref }: AvatarProps): import("react").JSX.Element;
/** Person or entity avatar disc with image fallback to grapheme-safe initials and optional presence status dot. */
export declare const Avatar: typeof DefaultAvatar;
/** Props for the `Badge` component. */
export interface BadgeProps extends Omit<HTMLAttributes<HTMLElement>, 'children' | 'onChange' | 'aria-label' | 'inlist'> {
    /** The few words. */
    children?: ReactNode;
    /** Semantic tone; when omitted without pill/onRemove, draws as the quiet hero badge (`data-kind="hero"`). */
    tone?: Tone;
    pill?: boolean;
    /** A picture before the words, already sized by the caller. */
    icon?: ReactNode;
    onRemove?: () => void;
    removeLabel?: string;
    ariaLabel?: string;
    ref?: Ref<HTMLElement>;
}
/** A badge: quiet hero eyebrow when untoned, or a semantic status/tag chip when `tone`, `pill`, or `onRemove` is given. */
declare function DefaultBadge({ children, tone, pill, icon, onRemove, removeLabel, ariaLabel, className, ref, ...rest }: BadgeProps): import("react").JSX.Element;
/** Image tile descriptor for `PhotoTiles`. */
export interface PhotoTile {
    src: string;
    alt: string;
    srcSet?: string;
    sizes?: string;
}
/** Props for the `PhotoTiles` component. */
export interface PhotoTilesProps {
    tiles: readonly PhotoTile[];
    className?: string;
    ref?: Ref<HTMLDivElement>;
}
/**
 * Two to four photos in the one photo's 4:3 box, cut into a mosaic, so the box has its size before any photo arrives
 * and nothing moves. The first is the one the page waits for; the rest load as they come near. Fewer than two is no
 * mosaic, and more than four are cut off.
 */
declare function DefaultPhotoTiles({ tiles, className, ref }: PhotoTilesProps): import("react").JSX.Element | null;
/** Props for the `IconRows` component. */
export interface IconRowsProps {
    rows: readonly {
        icon: ReactNode;
        text: string;
    }[];
    className?: string;
    ref?: Ref<HTMLUListElement>;
}
/** Up to four rows, each an icon in the accent and a line in the muted ink. Nothing for no rows. */
declare function DefaultIconRows({ rows, className, ref }: IconRowsProps): import("react").JSX.Element | null;
/** Semantic status chip or hero eyebrow badge with optional icon, pill rounding, and remove button. */
export declare const Badge: typeof DefaultBadge;
/** Fixed-aspect mosaic of two to four hero photographs with safe placeholder fallback. */
export declare const PhotoTiles: typeof DefaultPhotoTiles;
/** Compact list of up to four accented icon-and-caption rows. */
export declare const IconRows: typeof DefaultIconRows;
/** Section heading outline level (`2`, `3`, or `4`). */
export type HeadingLevel = 2 | 3 | 4;
/** Props for the `Heading` typography component. */
export interface HeadingProps extends CleanElementProps<'h3'> {
    level?: HeadingLevel;
}
/** Section or subsection heading rendered at semantic level `h2`, `h3`, or `h4`. */
export declare function Heading({ level, ariaLabel, className, children, ref, ...props }: HeadingProps): import("react").JSX.Element;
/** Font size scale for `Text`. */
export type TextSize = '2xs' | 'xs' | 'sm' | 'base' | 'md' | 'lg';
/** Ink hierarchy level for `Text`. */
export type TextHierarchy = 'default' | 'secondary' | 'muted' | 'subtle';
/** Font weight options for `Text`. */
export type TextWeight = 'regular' | 'medium' | 'semibold' | 'bold';
/** Props for the `Text` body and caption typography component. */
export interface TextProps extends CleanElementProps<'p', 'ref'> {
    as?: 'span' | 'p' | 'div' | 'label';
    size?: TextSize;
    hierarchy?: TextHierarchy;
    muted?: boolean;
    tone?: Tone;
    mono?: boolean;
    tabular?: boolean;
    weight?: TextWeight;
    truncate?: boolean;
    ref?: Ref<HTMLElement>;
}
/** Body or caption text element supporting ink hierarchy, semantic `Tone`, monospace, and truncation. */
export declare function Text(props: TextProps): import("react").JSX.Element;
/** Props for `VisuallyHidden`. */
export interface VisuallyHiddenProps extends CleanElementProps<'span', 'ref'> {
    as?: 'span' | 'div';
    ref?: Ref<HTMLElement>;
}
/** Screen-reader-only text clipped out of visual layout without leaving the accessibility tree. */
export declare function VisuallyHidden({ as, ariaLabel, className, ref, ...props }: VisuallyHiddenProps): import("react").JSX.Element;
/** Props for the `StatusDot` indicator. */
export interface StatusDotProps extends CleanElementProps<'span'> {
    tone?: Tone;
    pulse?: boolean;
}
/** Semantic status dot and optional text label dressed in the active theme's status ink. */
export declare function StatusDot({ tone, pulse, ariaLabel, className, children, ref, ...props }: StatusDotProps): import("react").JSX.Element;
/** Props for the `AiBadge` provenance indicator. */
export interface AiBadgeProps extends CleanElementProps<'span'> {
    quiet?: boolean;
    pill?: boolean;
    label?: ReactNode;
}
/** Sparkle badge marking AI-generated or AI-assisted content. */
export declare function AiBadge({ quiet, label, pill, ariaLabel, className, children, ref, ...props }: AiBadgeProps): import("react").JSX.Element;
/** Props for the `Person` identity lockup. */
export interface PersonProps extends CleanElementProps<'div', 'role' | 'ref'> {
    name: string;
    secondary?: ReactNode;
    role?: ReactNode;
    email?: string;
    src?: string;
    href?: string;
    status?: AvatarStatus;
    size?: ControlSize;
    meta?: ReactNode;
    hoverDetails?: ReactNode | boolean;
    ref?: Ref<HTMLElement>;
}
/** Person avatar, truncated primary name, optional secondary role/email, and optional hover profile card. */
export declare function Person({ name, secondary, role, email, src, href, status, size, meta, hoverDetails, ariaLabel, className, ref, ...props }: PersonProps): import("react").JSX.Element;
/** Period-over-period change descriptor for `StatCard`. */
export interface StatCardDelta {
    value: number | string;
    direction?: 'up' | 'down' | 'flat';
    good?: 'up' | 'down';
    tone?: Tone;
    against?: string;
}
/** Props for the `StatCard` KPI summary figure. */
export interface StatCardProps extends CleanElementProps<'div', 'children' | 'ref'> {
    label: ReactNode;
    value: ReactNode;
    delta?: StatCardDelta;
    trend?: ReadonlyArray<number | {
        key?: string;
        value: number;
    }>;
    sparkline?: ReactNode;
    formatValue?: (value: number) => string;
    hint?: ReactNode;
    icon?: ReactNode;
    href?: string;
    locale?: string;
    ref?: Ref<HTMLElement>;
}
/** KPI metric figure with period delta badge, comparison note, and inline trend sparkline. */
export declare function StatCard({ label, value, delta, trend, sparkline, formatValue, hint, icon, href, locale, ariaLabel, className, ref, ...props }: StatCardProps): import("react").JSX.Element;
/** Explicit label/value pair item for `DescriptionList`. */
export interface DescriptionListItem {
    id?: string;
    label: ReactNode;
    value: ReactNode;
}
/** Field descriptor for record-backed `DescriptionList` (`fields` mode). */
export type DescriptionField = string | {
    field: string;
    label?: ReactNode;
} | {
    id?: string;
    label: ReactNode;
    value: ReactNode;
};
/** Props for `DescriptionList` in explicit `items` mode. */
export interface DescriptionListItemsProps extends CleanElementProps<'dl'> {
    items: ReadonlyArray<DescriptionListItem>;
    columns?: 1 | 2 | 3;
}
/** Props for `DescriptionList` in schema-aware `resource` + `row` + `fields` mode. */
export interface DescriptionListRecordProps<Row extends Readonly<Record<string, unknown>> = Record<string, unknown>> extends CleanElementProps<'dl'> {
    resource: string;
    row: Row;
    fields: ReadonlyArray<DescriptionField>;
    columns?: 1 | 2 | 3;
}
/** Props for the unified `DescriptionList` term-and-value grid. */
export type DescriptionListProps<Row extends Readonly<Record<string, unknown>> = Record<string, unknown>> = DescriptionListItemsProps | DescriptionListRecordProps<Row>;
/** Multi-column key-value `<dl>` supporting either explicit `{ label, value }` items or schema-bound record fields. */
export declare function DescriptionList<Row extends Readonly<Record<string, unknown>> = Record<string, unknown>>(props: DescriptionListProps<Row>): import("react").JSX.Element;
/** Sticky-headed section run inside `ItemList`. */
export interface ItemGroup {
    key?: string;
    title: ReactNode;
    count?: ReactNode;
    items: ReactNode;
}
/** Props for the `ItemList` vertical entity list. */
export interface ItemListProps extends CleanElementProps<'ul'> {
    label?: string;
    empty?: EmptyStateSpec | ReactNode;
    groups?: ReadonlyArray<ItemGroup>;
    flush?: boolean;
    divided?: boolean;
    bordered?: boolean;
    compact?: boolean;
}
/** Headerless list of `ItemRow`s supporting grouped sticky headers, empty state, and automatic card-flush layout. */
export declare function ItemList({ label, ariaLabel, empty, groups, flush, divided, bordered, compact, className, children, ref, ...props }: ItemListProps): import("react").JSX.Element | null;
/** Props for a single `ItemRow` inside `ItemList`. */
export interface ItemRowProps extends CleanElementProps<'li', 'title'> {
    leading?: ReactNode;
    lead?: ReactNode;
    tone?: Tone;
    leadTone?: Tone;
    title: ReactNode;
    description?: ReactNode;
    subtitle?: ReactNode;
    note?: ReactNode;
    meta?: ReactNode;
    action?: ReactNode;
    actions?: ReactNode;
    trailing?: ReactNode;
    onClick?: (event: MouseEvent<HTMLElement>) => void;
    href?: string;
    selected?: boolean;
    disabled?: boolean;
}
/** Single row of `ItemList` with leading slot/tone mark, single keyboard target on `title`, and isolated trailing actions. */
export declare function ItemRow({ leading, lead, tone, leadTone, title, description, subtitle, note, meta, action, actions, trailing, onClick, href, selected, disabled, ariaLabel, className, ref, ...props }: ItemRowProps): import("react").JSX.Element;
/** Display preset for `FormattedValue`. */
export type ValueFormat = 'text' | 'number' | 'currency' | 'percent' | 'date' | 'datetime' | 'bytes' | 'id';
/** Props for the `FormattedValue` inline scalar display. */
export interface FormattedValueProps extends CleanElementProps<'span'> {
    value: unknown;
    format?: ValueFormat;
    currency?: string;
    locale?: string;
    copyable?: boolean;
    copyLabel?: string;
    placeholder?: ReactNode;
}
/** Locale-aware scalar formatter preserving `> 2^53` string IDs and tabular numbers with optional copy button. */
export declare function FormattedValue({ value, format, currency, locale: explicitLocale, copyable, copyLabel, placeholder, ariaLabel, className, ...props }: FormattedValueProps): import("react").JSX.Element;
/** Supported cell data kind for `LineItemsEditor` columns. */
export type LineItemColumnKind = 'text' | 'number' | 'money' | 'select' | 'computed';
/** Option entry for `'select'` columns in `LineItemsEditor`. */
export interface LineItemSelectOption {
    value: string;
    label: string;
}
/** Base row record edited by `LineItemsEditor`. */
export interface LineItemRow {
    id: string;
    [key: string]: string | number | undefined;
}
/** Column descriptor for `LineItemsEditor`. */
export interface LineItemColumn<TRow extends LineItemRow = LineItemRow> {
    key: string;
    label: React.ReactNode;
    kind: LineItemColumnKind;
    /** CSS Grid track width (e.g. `'2fr'`, `'110px'`, `'140px'`). */
    width?: string;
    align?: 'start' | 'end';
    placeholder?: string;
    /** Options when `kind === 'select'`. */
    options?: ReadonlyArray<LineItemSelectOption>;
    min?: number;
    max?: number;
    step?: number;
    /** Currency ISO code override for `kind === 'money'` or `'computed'`. */
    currency?: string;
    /** Include this column directly in the automatic `Subtotal` rollup. */
    sumInSubtotal?: boolean;
    /** Live row computation for `kind === 'computed'` (e.g. `(row) => Number(row.qty) * Number(row.unitPrice)`). */
    compute?: (row: TRow, rowIndex: number) => number;
}
/** Subtotal adjustment line (discount, shipping, surcharge) for `LineItemsEditor`. */
export interface LineItemsAdjustment {
    label: React.ReactNode;
    /** Positive for tax/shipping surcharges, negative for discounts/credits. */
    amount: number;
}
/** Props for the `LineItemsEditor` component. */
export interface LineItemsEditorProps<TRow extends LineItemRow = LineItemRow> extends FieldFrameProps {
    /** Structured column definitions. */
    columns: ReadonlyArray<LineItemColumn<TRow>>;
    /** Controlled line items array. */
    value?: ReadonlyArray<TRow>;
    /** Initial uncontrolled line items array. */
    defaultValue?: ReadonlyArray<TRow>;
    /** Emits updated line items on edit, reorder, add, or delete. */
    onValueChange?: (rows: TRow[]) => void;
    /** Optional factory for creating a new blank row when clicking `+ Add line`. */
    createRow?: () => TRow;
    /** Custom row total function overriding automatic `qty × price` / money column sum. */
    computeRowTotal?: (row: TRow, rowIndex: number) => number;
    /** Show an automatic read-only `Amount` column when `qty` + `money` columns exist and no `'computed'` column is defined. Defaults to `true`. */
    showAutoLineAmount?: boolean;
    /** Currency ISO code used for money symbols and summary totals. Defaults to `'USD'`. */
    currency?: string;
    /** Locale for number & currency formatting. Falls back to `<html lang>` and runtime default. */
    locale?: string;
    /** Optional tax rate (`0..1`, e.g. `0.0825` for 8.25%) added between Subtotal and Total. */
    taxRate?: number;
    taxLabel?: React.ReactNode;
    /** Optional extra summary adjustments (discounts, shipping, fees) applied to Subtotal. */
    adjustments?: ReadonlyArray<LineItemsAdjustment>;
    /** Show live `Subtotal` / `Total` summary footer. Defaults to `true`. */
    showSummary?: boolean;
    /** Allow drag-and-drop / keyboard reordering via `SortableHandle`. Defaults to `true`. */
    sortable?: boolean;
    addLabel?: React.ReactNode;
    empty?: EmptyStateSpec | React.ReactNode;
    minRows?: number;
    maxRows?: number;
    readOnly?: boolean;
    disabled?: boolean;
    invalid?: boolean;
    name?: string;
    ariaLabel?: string;
    words?: {
        amount?: string;
        subtotal?: string;
        total?: string;
        removeLine?: (index: number) => string;
        reorderLine?: (index: number) => string;
    };
    className?: string;
    fieldClassName?: string;
    ref?: React.Ref<HTMLDivElement>;
}
/** Sortable repeating line-items grid with live row amounts, tax, and currency totals. */
export declare function LineItemsEditor<TRow extends LineItemRow = LineItemRow>(props: LineItemsEditorProps<TRow>): React.JSX.Element;
/**
 * The slots a control kit may fill and the rules a kit is held to before it draws (UiKit.tsx, Preview), in a module
 * with no React and no primitive in it: an App's load and `mistri check` judge a kit with these on the server, where
 * an App's own typecheck follows the import and has no JSX to read a primitive's module with.
 */
/** Every slot a kit may fill, in the order the docs list them. */
declare const SLOT_NAMES: readonly ['Button', 'ButtonLink', 'TextField', 'MaskedField', 'MoneyField', 'SensitiveField', 'Select', 'MultiSelect', 'Dropdown', 'MultiDropdown', 'Typeahead', 'DateField', 'Checkbox', 'YesNo', 'ChoiceCards', 'CheckCards', 'Consent', 'Switch', 'Slider', 'Modal', 'Drawer', 'Popover', 'Tooltip', 'DropMenu', 'DropGroup', 'DropItem', 'DropSeparator', 'Tabs', 'Pagination', 'Avatar', 'Field', 'TextArea', 'FileField', 'ValidMark', 'HelpTip', 'ProgressBar', 'StepHeader', 'ActionBar', 'Columns', 'ReviewList', 'Badge', 'PhotoTiles', 'IconRows', 'Carousel', 'Resizable', 'ScrollArea'];
export type SlotName = (typeof SLOT_NAMES)[number];
/**
 * A control kit (Preview): another drawing of the primitives here, slot by slot. Every slotted primitive reads the
 * kit in place (internal/uiKitContext.ts) and draws the kit's component for its slot with the very props it was given,
 * its own otherwise, so a kit that draws only the button leaves every other control as it was and no screen that
 * imports a primitive changes. The page itself (a grid, a record's layout, the navigation) stays the platform's;
 * what a kit replaces is the controls on it.
 *
 * The contract is each slot's props type below, plus the behavior the conformance suite holds a kit to
 * (`@mistriwork/ui/conformance.js`): a value and its change, disabled, the words a slot is handed, a modal's handle and
 * where its focus goes back to, a menu's and a listbox's keys, a popup drawn inside the dialog that opened it.
 *
 * Nothing here imports a primitive's module, only its types: a kit compiled apart from the page reads this file for
 * `defineUiKit`, and the defaults arrive in `defaultUiKit` as the page loads them.
 */
type KitCallback<F> = F extends (...args: [...infer A, infer D extends ChangeDetails<string>]) => infer R ? (...args: A | [...A, D]) => R : F;
type KitProps<P> = {
    [K in keyof P]: KitCallback<P[K]>;
};
export type Slot<C> = C extends ComponentType<infer P> ? ComponentType<KitProps<P>> : never;
type TypeaheadItemProps = 'itemKey' | 'itemLabel' | 'itemClassName' | 'renderItem' | 'onPick' | 'onHighlight';
/** Each slot's component, typed by the props the platform draws it with. */
export interface UiKitSlots {
    Button: Slot<typeof Button>;
    /** A link dressed as a button: a download, another page. */
    ButtonLink: Slot<typeof ButtonLink>;
    TextField: Slot<typeof TextField>;
    MaskedField: Slot<typeof MaskedField>;
    MoneyField: Slot<typeof MoneyField>;
    SensitiveField: Slot<typeof SensitiveField>;
    Select: Slot<typeof Select>;
    MultiSelect: Slot<typeof MultiSelect>;
    Dropdown: Slot<typeof Dropdown>;
    MultiDropdown: Slot<typeof MultiDropdown>;
    /** Generic in the item it lists, as the default is. */
    Typeahead: <T>(props: KitProps<Omit<TypeaheadProps<T>, TypeaheadItemProps>> & Pick<TypeaheadProps<T>, TypeaheadItemProps>) => ReactNode;
    DateField: Slot<typeof DateField>;
    Checkbox: Slot<typeof Checkbox>;
    YesNo: Slot<typeof YesNo>;
    ChoiceCards: Slot<typeof ChoiceCards>;
    CheckCards: Slot<typeof CheckCards>;
    Consent: Slot<typeof Consent>;
    Switch: Slot<typeof Switch>;
    Slider: Slot<typeof Slider>;
    /** Open from mount; `onClose` heard once however it closed; `ref` takes the handle that closes it. */
    Modal: Slot<typeof Modal>;
    Drawer: Slot<typeof Drawer>;
    Popover: Slot<typeof Popover>;
    Tooltip: Slot<typeof Tooltip>;
    /** A menu's four parts share the menu's state, so a kit draws all four or none. */
    DropMenu: Slot<typeof DropMenu>;
    DropGroup: Slot<typeof DropGroup>;
    DropItem: Slot<typeof DropItem>;
    DropSeparator: Slot<typeof DropSeparator>;
    Tabs: Slot<typeof Tabs>;
    Pagination: Slot<typeof Pagination>;
    Avatar: Slot<typeof Avatar>;
    /** A label over any control, with its hint and its problem: the wiring between them is the slot's to keep. */
    Field: Slot<typeof Field>;
    TextArea: Slot<typeof TextArea>;
    FileField: Slot<typeof FileField>;
    /** The mark at a box's end. */
    ValidMark: Slot<typeof ValidMark>;
    HelpTip: Slot<typeof HelpTip>;
    ProgressBar: Slot<typeof ProgressBar>;
    StepHeader: Slot<typeof StepHeader>;
    ActionBar: Slot<typeof ActionBar>;
    Columns: Slot<typeof Columns>;
    ReviewList: Slot<typeof ReviewList>;
    /** The landing's blocks. */
    Badge: Slot<typeof Badge>;
    PhotoTiles: Slot<typeof PhotoTiles>;
    IconRows: Slot<typeof IconRows>;
    Carousel: Slot<typeof Carousel>;
    Resizable: Slot<typeof Resizable>;
    ScrollArea: Slot<typeof ScrollArea>;
}
/** The props a slot is drawn with. */
export type SlotProps<Name extends SlotName> = UiKitSlots[Name] extends (props: infer Props) => unknown ? Props : UiKitSlots[Name] extends ComponentType<infer Props> ? Props : never;
/** A kit: any of the slots; the rest draw as they always have. */
export type UiKit = Readonly<Partial<UiKitSlots>>;
/** Declares a kit, refusing a slot it does not have in words: `export default defineUiKit({ Button, Modal })`. */
export declare function defineUiKit(kit: UiKit): UiKit;
/** Props for the `Sparkline` component. */
export interface SparklineProps {
    data: ReadonlyArray<number>;
    width?: number;
    height?: number;
    tone?: Tone;
    curve?: 'smooth' | 'linear';
    fill?: boolean;
    showEndDot?: boolean;
    locale?: string;
    /** Optional group label announced around the sparkline. */
    label?: string;
    ariaLabel?: string;
    formatValue?: (v: number) => string;
    className?: string;
    ref?: Ref<HTMLSpanElement>;
}
/** Compact inline SVG trend line with single-point fallback, optional area fill, and screen-reader value summary. */
export declare function Sparkline(props: SparklineProps): import("react").JSX.Element;
/** Single datum entry in `MiniBars`. */
export interface MiniBarDatum {
    label?: string;
    value: number;
    tone?: Tone;
}
/** Props for the `MiniBars` component. */
export interface MiniBarsProps {
    data: ReadonlyArray<number | MiniBarDatum>;
    /** Optional category labels read out in the screen-reader table. */
    labels?: ReadonlyArray<string>;
    /** Zero-based bar index highlighted in full ink while siblings render quieter. */
    highlight?: number;
    /** Accessible group name announced for the bar strip. */
    label?: string;
    ariaLabel?: string;
    width?: number;
    height?: number;
    tone?: Tone;
    locale?: string;
    formatValue?: (v: number) => string;
    className?: string;
    ref?: Ref<HTMLSpanElement>;
}
/** Compact inline column bar strip with optional highlight index and screen-reader value table. */
export declare function MiniBars(props: MiniBarsProps): import("react").JSX.Element;
/** Single labeled bar row in `BreakdownList`. */
export interface BreakdownItem {
    key?: string;
    id?: string;
    label: ReactNode;
    value: number | string;
    note?: ReactNode;
    hint?: ReactNode;
    color?: string;
    tone?: Tone;
}
/** Props for the `BreakdownList` component. */
export interface BreakdownListProps {
    items: ReadonlyArray<BreakdownItem>;
    /** Explicit denominator for computing each row's bar share and percentage. */
    total?: number | string;
    /** Draw each row's percentage share beside its formatted value. */
    showPercent?: boolean;
    /** Built-in formatting preset used when `formatValue` is omitted. */
    format?: 'number' | 'money' | 'percent';
    /** Custom value formatter taking precedence over `format`. */
    formatValue?: (v: number) => string;
    /**
     * ISO 4217 code for `format: 'money'`. Read where no host formatter says money (the host's own currency wins for
     * ordinary numbers) and for a string value too large for a number. Defaults to `USD`.
     */
    currency?: string;
    tone?: Tone;
    locale?: string;
    label?: string;
    ariaLabel?: string;
    activeIndex?: number | null;
    onActiveIndexChange?: (index: number | null) => void;
    className?: string;
    style?: CSSProperties;
    ref?: Ref<HTMLUListElement>;
}
/**
 * Ranked or categorical horizontal meter list supporting explicit `total`, percentage shares, and `> 2^53` counts.
 * A count past 2^53 is given as a string and printed digit for digit in the `format` preset; `formatValue` takes a
 * `number` and so is not asked to say it.
 */
export declare function BreakdownList(props: BreakdownListProps): import("react").JSX.Element;
/** Tab item rendered in `PageHeader`. */
export interface PageHeaderTab {
    id: string;
    label: ReactNode;
    count?: number | string;
    icon?: ReactNode;
    disabled?: boolean;
}
/** Back navigation link descriptor for `PageHeader`. */
export interface PageHeaderBack {
    label: string;
    href?: string;
    onClick?: (event: MouseEvent<HTMLElement>) => void;
}
/** Props for the `PageHeader` component. */
export interface PageHeaderProps {
    title: ReactNode;
    description?: ReactNode;
    back?: PageHeaderBack;
    level?: 1 | 2;
    badge?: ReactNode;
    icon?: ReactNode;
    tabs?: ReadonlyArray<PageHeaderTab>;
    activeTab?: string;
    defaultTab?: string;
    onTabChange?: (tabId: string) => void;
    actions?: ReactNode;
    className?: string;
    ref?: Ref<HTMLDivElement>;
}
/** Unified page heading bar supporting back navigation, description intro, action verbs, and optional section tabs. */
export declare function PageHeader(props: PageHeaderProps): import("react").JSX.Element;
type ResizableSize = number | `${number}%` | `${number}px` | `${number}rem`;
/** Master-list item descriptor in `SplitView`. */
export interface SplitViewItem<T = unknown> {
    id: string;
    code?: string;
    title: string;
    subtitle?: string;
    preview?: string;
    meta?: string;
    unread?: boolean;
    badge?: ReactNode;
    tone?: Tone;
    icon?: ReactNode;
    data?: T;
}
/** Item-driven master-detail props for `SplitView`. */
export interface SplitViewItemsProps<T = unknown> {
    items: ReadonlyArray<SplitViewItem<T>>;
    value?: string | null;
    defaultValue?: string | null;
    onValueChange?: (id: string | null, item: SplitViewItem<T> | null) => void;
    renderItem?: (item: SplitViewItem<T>, selected: boolean) => ReactNode;
    renderDetail: (item: SplitViewItem<T>) => ReactNode;
    empty?: EmptyStateSpec | ReactNode;
    detailEmpty?: EmptyStateSpec | ReactNode;
    listTitle?: ReactNode;
    listHeaderActions?: ReactNode;
    searchable?: boolean;
    searchPlaceholder?: string;
    defaultListSize?: ResizableSize;
    minListSize?: ResizableSize;
    maxListSize?: ResizableSize;
    collapseBreakpoint?: number;
    backLabel?: string;
    autoSaveId?: string;
    listLabel?: string;
    listAriaLabel?: string;
    detailLabel?: string;
    detailAriaLabel?: string;
    height?: number | string;
    className?: string;
    ref?: Ref<HTMLDivElement>;
}
/** Custom list + detail pane props for `SplitView`. */
export interface SplitViewPaneProps {
    list: ReactNode;
    detail?: ReactNode;
    detailActions?: ReactNode;
    selected?: boolean;
    detailOpen?: boolean;
    detailTitle?: string;
    onCloseDetail?: () => void;
    isCurrent?: () => boolean;
    listWidth?: 'balanced' | 'compact' | string;
    listLabel?: string;
    listAriaLabel?: string;
    detailLabel?: string;
    detailAriaLabel?: string;
    empty?: EmptyStateSpec | ReactNode;
    className?: string;
    ref?: Ref<HTMLDivElement>;
}
/** Props for the unified `SplitView` component. */
export type SplitViewProps<T = unknown> = SplitViewItemsProps<T> | SplitViewPaneProps;
/** Master-detail split workspace supporting both item-driven inbox splits and custom `list`/`detail` panes. */
export declare function SplitView<T = unknown>(props: SplitViewProps<T>): import("react").JSX.Element;
