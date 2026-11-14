import { CaretLeft, CaretRight, CaretUpDown, Check, Copy, File as FileIcon, UploadSimple, X } from '@phosphor-icons/react';
import { Checkbox, CheckboxIndicator } from '@ui-sdk/react/checkbox';
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from '@ui-sdk/react/combobox';
import {
  CalendarDay,
  CalendarGrid,
  CalendarHeading,
  CalendarNext,
  CalendarPrevious,
  CalendarWeekday,
  CalendarWeekdays,
  CalendarWeeks,
  DatePicker,
  DatePickerClear,
  DatePickerContent,
  DatePickerInput,
  DatePickerPreset,
  DatePickerTrigger,
} from '@ui-sdk/react/date-picker';
import { Field, FieldDescription, FieldError, FieldLabel } from '@ui-sdk/react/field';
import {
  FileInput,
  FileInputDropzone,
  FileInputItem,
  FileInputItemRemove,
  FileInputList,
  FileInputTrigger,
  formatFileSize,
} from '@ui-sdk/react/file-input';
import { Input, InputClear, InputGroup } from '@ui-sdk/react/input';
import { NumberInput, NumberInputControl, NumberInputGroup } from '@ui-sdk/react/number-input';
import { PasswordInput, PasswordInputControl, PasswordInputToggle } from '@ui-sdk/react/password-input';
import { Radio, RadioGroup } from '@ui-sdk/react/radio';
import { Select, SelectContent, SelectItem, SelectItemIndicator, SelectTrigger, SelectValue } from '@ui-sdk/react/select';
import { Slider, SliderControl, SliderIndicator, SliderThumb, SliderTrack, SliderValue } from '@ui-sdk/react/slider';
import { Switch, SwitchThumb } from '@ui-sdk/react/switch';
import { Textarea } from '@ui-sdk/react/textarea';
import { type ComponentProps, type ReactNode, useEffect, useState } from 'react';
import { HelpTip, ValidMark } from './display';
import { words } from './words';

/* The form controls: each is one labelled field, label over value, with its hint under it and its problem in
   the hint's place. What they share is said once, in Frame.

   A field keeps its own value unless it is handed one: `defaultValue` starts it, and `value` with
   `onValueChange` (`checked` with `onCheckedChange` for a switch or a tick) lets a form hold it, to show one
   field's answer in another, to validate as the reader goes, or to save a draft. */

type Common = {
  label: string;
  name?: string;
  hint?: ReactNode;
  /* A problem the caller found. Its words replace the hint and the field wears the critical edge. */
  error?: ReactNode;
  optional?: boolean;
  /* The field must be answered. Said with a mark beside its label and in words to a screen reader; a form that
     marks what is optional instead leaves this off. */
  required?: boolean;
  /* More about the field than a hint has room for, behind a question mark beside its label. */
  tip?: ReactNode;
  /* The field cannot be answered now. It is skipped by the keyboard and left out of what the form sends. */
  disabled?: boolean;
  /* The label is said to a screen reader and not drawn: for a field whose place says what it is (a search box, a
     cell of a grid of fields under one heading). */
  labelHidden?: boolean;
  /* Keeps a line under the field for its problem, so a form does not jump when one appears and goes. */
  reserve?: boolean;
};

/* The frame every field stands in, for a field written outside this file (MaskedField, the choices). */
export function FieldFrame(props: Common & { children: ReactNode }) {
  return <Frame {...props} />;
}

function Frame({
  label,
  name,
  hint,
  error,
  optional,
  required,
  tip,
  disabled,
  labelHidden,
  reserve,
  count,
  children,
}: Common & { children: ReactNode; /* How much has been typed of how much may be, at the end of the hint's line. */ count?: ReactNode }) {
  const under = error ? <FieldError>{error}</FieldError> : hint ? <FieldDescription>{hint}</FieldDescription> : null;
  return (
    <Field name={name} invalid={error ? true : undefined} disabled={disabled}>
      <FieldLabel data-hidden={labelHidden ? '' : undefined}>
        {label}
        {required && (
          <span data-slot="field-required" aria-hidden="true">
            *
          </span>
        )}
        {required && <span data-slot="visually-hidden"> {words.required}</span>}
        {optional && <span data-slot="field-optional">{words.optional}</span>}
        {tip && <HelpTip label={words.moreAbout(label)}>{tip}</HelpTip>}
      </FieldLabel>
      {children}
      {count ? (
        <div data-slot="field-under">
          {under ?? <span />}
          {count}
        </div>
      ) : (
        (under ?? (reserve ? <span data-slot="field-reserve" aria-hidden="true" /> : null))
      )}
    </Field>
  );
}

/* How much of a limit is used, for a field with one. It is drawn for the eye; a screen reader is told only as the
   limit comes near, since a count read out at every key is noise. */
function Count({ used, max }: { used: number; max: number }) {
  const left = max - used;
  const near = left <= Math.max(10, Math.round(max * 0.1));
  return (
    <span data-slot="field-count" data-near={near ? '' : undefined} data-full={left <= 0 ? '' : undefined}>
      <span aria-hidden="true">
        {used} / {max}
      </span>
      <span data-slot="visually-hidden" aria-live="polite">
        {near ? words.charactersLeft(Math.max(left, 0)) : ''}
      </span>
    </span>
  );
}

/* What a field hands its frame: everything the frame draws, by name. */
const framed = (props: Common): Common => ({
  label: props.label,
  name: props.name,
  hint: props.hint,
  error: props.error,
  optional: props.optional,
  required: props.required,
  tip: props.tip,
  disabled: props.disabled,
  labelHidden: props.labelHidden,
  reserve: props.reserve,
});

export type Option = { value: string; label: string; hint?: string; icon?: ReactNode; disabled?: boolean };

type InputProps = Omit<ComponentProps<typeof Input>, 'name' | 'prefix'>;

export type TextFieldProps = Common &
  InputProps & {
    prefix?: ReactNode;
    suffix?: ReactNode;
    /* A cross at the field's end that empties it, shown once there is something to empty. */
    clearable?: boolean;
    /* The value is known to be right (an address that was found, a code that was accepted): a tick at the field's end. */
    valid?: boolean;
    /* Shows how much of `maxLength` is used. On when there is a `maxLength`, unless a caller says otherwise. */
    counter?: boolean;
  };

export function TextField(props: TextFieldProps) {
  const {
    label: _label,
    name: _name,
    hint: _hint,
    error,
    optional: _optional,
    required: _required,
    tip: _tip,
    disabled: _disabled,
    labelHidden: _hidden,
    reserve: _reserve,
    prefix,
    suffix,
    clearable,
    valid,
    counter,
    value,
    defaultValue,
    onValueChange,
    maxLength,
    ...input
  } = props;
  const [own, setOwn] = useState(String(defaultValue ?? ''));
  const text = value === undefined ? own : String(value ?? '');
  const box = (
    <Input
      {...input}
      value={value}
      defaultValue={defaultValue}
      maxLength={maxLength}
      onValueChange={(next, details) => {
        setOwn(String(next));
        onValueChange?.(next, details);
      }}
    />
  );
  const control = clearable ? (
    <InputGroup data-kind="clearable">
      {box}
      <InputClear aria-label={words.clearField(props.label)}>
        <X aria-hidden="true" />
      </InputClear>
    </InputGroup>
  ) : (
    box
  );
  const mark = valid && !error ? <ValidMark /> : null;
  return (
    <Frame
      {...framed(props)}
      count={(counter ?? maxLength !== undefined) && maxLength ? <Count used={text.length} max={maxLength} /> : undefined}
    >
      {prefix || suffix || mark ? (
        <div data-slot="adorned" data-kind={mark ? 'masked' : undefined}>
          {prefix && <span data-slot="adornment">{prefix}</span>}
          {control}
          {suffix && <span data-slot="adornment">{suffix}</span>}
          {mark}
        </div>
      ) : (
        control
      )}
    </Frame>
  );
}

export type TextAreaFieldProps = Common &
  Omit<ComponentProps<typeof Textarea>, 'name'> & {
    /* Grows with what is typed, up to a height the sheet sets, and scrolls past it. On unless a caller says not. */
    autoGrow?: boolean;
    /* Shows how much of `maxLength` is used. On when there is a `maxLength`. */
    counter?: boolean;
  };

export function TextAreaField(props: TextAreaFieldProps) {
  const {
    label: _label,
    name,
    hint: _hint,
    error: _error,
    optional: _optional,
    required: _required,
    tip: _tip,
    disabled: _disabled,
    labelHidden: _hidden,
    reserve: _reserve,
    autoGrow = true,
    counter,
    value,
    defaultValue,
    onValueChange,
    maxLength,
    ...textarea
  } = props;
  const [own, setOwn] = useState(String(defaultValue ?? ''));
  const text = value === undefined ? own : String(value ?? '');
  return (
    <Frame
      {...framed(props)}
      count={(counter ?? maxLength !== undefined) && maxLength ? <Count used={text.length} max={maxLength} /> : undefined}
    >
      <Textarea
        name={name}
        {...textarea}
        value={value}
        defaultValue={defaultValue}
        maxLength={maxLength}
        autoResize={autoGrow}
        onValueChange={(next, details) => {
          setOwn(String(next));
          onValueChange?.(next, details);
        }}
      />
    </Frame>
  );
}

export type NumberFieldProps = Common & {
  value?: number | null;
  defaultValue?: number;
  onValueChange?: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  format?: Intl.NumberFormatOptions;
  suffix?: ReactNode;
};

export function NumberField({ label, name, hint, error, optional, required, tip, disabled, suffix, ...number }: NumberFieldProps) {
  return (
    <Frame {...{ label, hint, error, optional, required, tip, disabled }}>
      <NumberInput name={name} {...number}>
        <NumberInputGroup data-kind="plain">
          <NumberInputControl />
          {suffix && <span data-slot="adornment">{suffix}</span>}
        </NumberInputGroup>
      </NumberInput>
    </Frame>
  );
}

/* Money is a number shown in its currency: the box reads and writes the format, the form gets the number.
   A step of a cent, since a step of one would round the cents away. */
export function MoneyField({ currency = 'USD', ...rest }: Omit<NumberFieldProps, 'format' | 'step'> & { currency?: string }) {
  return <NumberField min={0} step={0.01} format={{ style: 'currency', currency }} {...rest} />;
}

/* What marks an action row's value apart from an option's. */
const ACTION = '~~action:';

export type SelectFieldProps = Common & {
  options: Option[];
  value?: string | string[] | null;
  defaultValue?: string | string[];
  /* Hears one value, or the list of them where several may be chosen. */
  onValueChange?: (value: string | string[] | null) => void;
  /* Rows under the options that do something and are never the value: "New building…", "Manage the list". */
  actions?: { label: string; icon?: ReactNode; onAction: () => void }[];
  placeholder?: string;
  multiple?: boolean;
};

export function SelectField({
  label,
  name,
  hint,
  error,
  optional,
  required,
  tip,
  disabled,
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder,
  multiple,
  actions = [],
}: SelectFieldProps) {
  /* An action row is an item, so the keyboard reaches it as it reaches an option; choosing it is turned back
     before it can become the value, and its action is run. */
  const acted = (next: unknown, details: { cancel(): void }): boolean => {
    const picked = [next].flat().find((one) => typeof one === 'string' && one.startsWith(ACTION));
    if (typeof picked !== 'string') return false;
    details.cancel();
    actions[Number(picked.slice(ACTION.length))]?.onAction();
    return true;
  };
  const content = (
    <>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} label={option.label} disabled={option.disabled}>
            {multiple && (
              <SelectItemIndicator keepMounted>
                <Check aria-hidden="true" weight="bold" />
              </SelectItemIndicator>
            )}
            {option.icon}
            {option.hint ? (
              <span data-slot="option-words">
                {option.label}
                <small>{option.hint}</small>
              </span>
            ) : (
              option.label
            )}
          </SelectItem>
        ))}
        {actions.map((action, at) => (
          <SelectItem
            key={action.label}
            value={`${ACTION}${at}`}
            label={action.label}
            data-kind="action"
            data-first={at === 0 ? '' : undefined}
          >
            {action.icon}
            {action.label}
          </SelectItem>
        ))}
      </SelectContent>
    </>
  );
  return (
    <Frame {...{ label, hint, error, optional, required, tip, disabled }}>
      {multiple ? (
        <Select
          name={name}
          value={value === undefined ? undefined : [value ?? []].flat()}
          defaultValue={[defaultValue ?? []].flat()}
          onValueChange={(next, details) => acted(next, details) || onValueChange?.((next as string[] | null) ?? [])}
          placeholder={placeholder}
          multiple
        >
          {content}
        </Select>
      ) : (
        <Select
          name={name}
          value={value === undefined ? undefined : ([value].flat()[0] ?? null)}
          defaultValue={[defaultValue].flat()[0]}
          onValueChange={(next, details) => acted(next, details) || onValueChange?.(next === null ? null : String(next))}
          placeholder={placeholder}
        >
          {content}
        </Select>
      )}
    </Frame>
  );
}

export type ComboFieldProps = Common & {
  options: Option[];
  value?: string | null;
  defaultValue?: string;
  onValueChange?: (value: string | null) => void;
  placeholder?: string;
  empty?: string;
};

/* A box with a list: type to narrow it. mistri's Typeahead. */
export function ComboField({
  label,
  name,
  hint,
  error,
  optional,
  required,
  tip,
  disabled,
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder,
  empty,
}: ComboFieldProps) {
  return (
    <Frame {...{ label, hint, error, optional, required, tip, disabled }}>
      <Combobox
        name={name}
        value={value}
        defaultValue={defaultValue}
        onValueChange={(next) => onValueChange?.(next === null ? null : String(next))}
      >
        <div data-slot="adorned" data-kind="combo">
          <ComboboxInput placeholder={placeholder} />
          <CaretUpDown aria-hidden="true" />
        </div>
        <ComboboxContent>
          <ComboboxEmpty>{empty ?? words.nothingMatchesOption}</ComboboxEmpty>
          <ComboboxList>
            {options.map((option) => (
              <ComboboxItem key={option.value} value={option.value}>
                {option.label}
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </Frame>
  );
}

export type DateFieldProps = Common & {
  /* A day, as `YYYY-MM-DD`. */
  value?: string | null;
  defaultValue?: string;
  onValueChange?: (value: string | null) => void;
  /* The earliest and latest day that may be chosen, as `YYYY-MM-DD`. Typed, a day outside them is refused. */
  min?: string;
  max?: string;
  /* Days that may not be chosen: weekends for a viewing, days already booked. */
  unavailable?: ComponentProps<typeof DatePicker>['unavailable'];
  /* The place whose day today is, like `America/Denver`, where that is not the reader's own. */
  timeZone?: string;
};

/* Today as `YYYY-MM-DD`, in the reader's own place or in the one named. */
const today = (timeZone?: string): string => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const of = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${of('year')}-${of('month')}-${of('day')}`;
};

/* The day's own control, without a frame: the box, its calendar, and the calendar's foot. */
export function DayControl({
  label,
  name,
  value,
  defaultValue,
  onValueChange,
  min,
  max,
  unavailable,
  timeZone,
}: Pick<DateFieldProps, 'label' | 'name' | 'value' | 'defaultValue' | 'onValueChange' | 'min' | 'max' | 'unavailable' | 'timeZone'>) {
  return (
    <DatePicker
      name={name}
      value={value}
      defaultValue={defaultValue}
      min={min}
      max={max}
      unavailable={unavailable}
      timeZone={timeZone}
      onValueChange={(next) => onValueChange?.(next === null ? null : String(next))}
    >
      {/* The two share a box so the trigger sits inside the input's end; loose in a Field it drops under it. */}
      <div>
        <DatePickerInput />
        <DatePickerTrigger aria-label={words.chooseDate(label)} />
      </div>
      <DatePickerContent>
        <div data-slot="calendar-head">
          <CalendarPrevious aria-label={words.previousMonth} data-variant="quiet">
            <CaretLeft aria-hidden="true" weight="bold" />
          </CalendarPrevious>
          <CalendarHeading />
          <CalendarNext aria-label={words.nextMonth} data-variant="quiet">
            <CaretRight aria-hidden="true" weight="bold" />
          </CalendarNext>
        </div>
        <CalendarGrid>
          <CalendarWeekdays>{(index) => <CalendarWeekday index={index} />}</CalendarWeekdays>
          <CalendarWeeks>{(cell) => <CalendarDay value={cell.date} />}</CalendarWeeks>
        </CalendarGrid>
        <div data-slot="calendar-foot">
          <DatePickerPreset value={today(timeZone)} data-variant="quiet" data-size="sm">
            {words.today}
          </DatePickerPreset>
          <DatePickerClear data-variant="quiet" data-size="sm">
            {words.clear}
          </DatePickerClear>
        </div>
      </DatePickerContent>
    </DatePicker>
  );
}

/* A day, typed or picked. The calendar's foot holds the two things a reader wants more often than a particular
   day: today, in one press, and the field emptied again. */
export function DateField(props: DateFieldProps) {
  return (
    <Frame {...framed(props)}>
      <DayControl {...props} />
    </Frame>
  );
}

export type SensitiveFieldProps = Common & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /* A button that puts the value on the clipboard without showing it: for a key or a token the reader is here
     to take somewhere else. */
  copyable?: boolean;
};

export function SensitiveField({
  label,
  name,
  hint,
  error,
  optional,
  required,
  tip,
  disabled,
  value,
  defaultValue,
  onValueChange,
  copyable,
}: SensitiveFieldProps) {
  const [own, setOwn] = useState(defaultValue ?? '');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const back = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(back);
  }, [copied]);
  return (
    <Frame {...{ label, hint, error, optional, required, tip, disabled }}>
      <PasswordInput
        name={name}
        value={value}
        defaultValue={defaultValue}
        onValueChange={(next) => {
          setOwn(String(next));
          onValueChange?.(String(next));
        }}
      >
        <PasswordInputControl />
        <PasswordInputToggle aria-label={words.show(label)} />
        {copyable && (
          <button
            type="button"
            data-slot="sensitive-copy"
            data-copied={copied ? '' : undefined}
            aria-label={copied ? words.copiedField(label) : words.copy(label)}
            onClick={() => {
              // Said only once the clipboard has it: a "Copied" that did not copy is worse than none.
              void navigator.clipboard?.writeText(value ?? own).then(() => setCopied(true));
            }}
          >
            {copied ? <Check aria-hidden="true" weight="bold" /> : <Copy aria-hidden="true" />}
            <span aria-live="polite" data-slot="visually-hidden">
              {copied ? words.copied : ''}
            </span>
          </button>
        )}
      </PasswordInput>
    </Frame>
  );
}

export type FileFieldProps = Common & {
  accept?: string;
  multiple?: boolean;
  prompt?: string;
  /* The largest file taken, in bytes, and the most files. One over is turned away and the field says why. */
  maxSize?: number;
  maxFiles?: number;
  value?: File[];
  defaultValue?: File[];
  onValueChange?: (files: File[]) => void;
};

const TURNED_AWAY: Record<string, (limit: { size?: number; files?: number }) => string> = {
  'file-type': () => words.fileWrongKind,
  'file-too-large': ({ size }) => words.fileTooLarge(size ? formatFileSize(size) : undefined),
  'file-too-small': () => words.fileTooSmall,
  'too-many-files': ({ files }) => words.fileTooMany(files ?? 1),
};

/* A picture of a file that is a picture, in the list of what was chosen: the reader sees they picked the right one. */
function Thumb({ file }: { file: File }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    if (!file.type.startsWith('image/')) return;
    const made = URL.createObjectURL(file);
    setSrc(made);
    return () => URL.revokeObjectURL(made);
  }, [file]);
  return src ? <img data-slot="file-thumb" src={src} alt="" /> : <FileIcon data-slot="file-thumb" aria-hidden="true" />;
}

/* Files, dropped on the field or browsed for. A file the field will not take (the wrong kind, too large, one too
   many) is named with the reason under the field, so nothing is silently left out; a picture shows as one; and
   the zone says while a file is held over it whether it would be taken. */
export function FileField(props: FileFieldProps) {
  const { label, name, accept, multiple, prompt, maxSize, maxFiles, value, defaultValue, onValueChange, error, hint } = props;
  const [refused, setRefused] = useState<string[]>([]);
  const limits = [maxSize ? words.fileLimitSize(formatFileSize(maxSize)) : '', maxFiles && multiple ? words.fileLimitCount(maxFiles) : '']
    .filter(Boolean)
    .join(', ');
  return (
    <Frame
      {...framed(props)}
      hint={hint ?? (limits || undefined)}
      error={
        error ??
        (refused.length ? (
          <>
            {refused.map((line) => (
              <span key={line} data-slot="file-refused">
                {line}
              </span>
            ))}
          </>
        ) : undefined)
      }
    >
      <FileInput
        name={name}
        accept={accept}
        multiple={multiple}
        maxSize={maxSize}
        maxFiles={maxFiles}
        value={value}
        defaultValue={defaultValue}
        onValueChange={(files) => {
          setRefused([]);
          onValueChange?.([...files]);
        }}
        onReject={(rejected) =>
          setRefused(
            rejected.map(({ file, reasons }) => {
              const why = reasons[0] ?? 'file-type';
              return `${file.name} ${TURNED_AWAY[why]?.({ size: maxSize, files: maxFiles }) ?? why}.`;
            }),
          )
        }
      >
        <FileInputDropzone>
          <UploadSimple aria-hidden="true" />
          <p>{prompt ?? words.dropFiles}</p>
          <FileInputTrigger data-variant="bare-link">{words.browse}</FileInputTrigger>
        </FileInputDropzone>
        <FileInputList aria-label={words.chosenFiles(label)}>
          <FileInputItem>
            {({ file }) => (
              <>
                <Thumb file={file} />
                <span data-slot="file-name">{file.name}</span>
                <span data-slot="file-size">{formatFileSize(file.size)}</span>
                <FileInputItemRemove aria-label={words.removeFile(file.name)}>
                  <X aria-hidden="true" />
                </FileInputItemRemove>
              </>
            )}
          </FileInputItem>
        </FileInputList>
      </FileInput>
    </Frame>
  );
}

type Toggle = {
  label: string;
  name?: string;
  hint?: ReactNode;
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
};

/* A setting: its words on one side, the switch on the other. */
export function SwitchField({ label, name, hint, checked, defaultChecked, onCheckedChange, disabled }: Toggle) {
  return (
    <Field data-kind="setting" disabled={disabled}>
      <div>
        <FieldLabel>{label}</FieldLabel>
        {hint && <FieldDescription>{hint}</FieldDescription>}
      </div>
      <Switch name={name} checked={checked} defaultChecked={defaultChecked} onCheckedChange={(next) => onCheckedChange?.(next === true)}>
        <SwitchThumb />
      </Switch>
    </Field>
  );
}

export function CheckField({ label, name, hint, checked, defaultChecked, onCheckedChange, disabled }: Toggle) {
  return (
    <Field data-kind="check" disabled={disabled}>
      <Checkbox name={name} checked={checked} defaultChecked={defaultChecked} onCheckedChange={(next) => onCheckedChange?.(next === true)}>
        <CheckboxIndicator />
      </Checkbox>
      <div>
        <FieldLabel>{label}</FieldLabel>
        {hint && <FieldDescription>{hint}</FieldDescription>}
      </div>
    </Field>
  );
}

export type ChoiceFieldProps = Common & {
  options: Option[];
  value?: string | null;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  columns?: number;
};

/* One of a few, all in view: each choice is a card that fills when chosen. */
export function ChoiceField({
  label,
  name,
  hint,
  error,
  optional,
  required,
  tip,
  disabled,
  options,
  value,
  defaultValue,
  onValueChange,
  columns,
}: ChoiceFieldProps) {
  return (
    <Frame {...{ label, hint, error, optional, required, tip, disabled }}>
      <RadioGroup
        name={name}
        value={value}
        defaultValue={defaultValue}
        onValueChange={(next) => next !== null && onValueChange?.(String(next))}
        data-kind="cards"
        style={{ gridTemplateColumns: `repeat(${columns ?? options.length}, minmax(0, 1fr))` }}
      >
        {options.map((option) => (
          <label key={option.value} data-slot="choice">
            <Radio value={option.value} disabled={option.disabled} />
            <span data-slot="choice-label">
              {option.icon}
              {option.label}
            </span>
            {option.hint && <span data-slot="choice-hint">{option.hint}</span>}
          </label>
        ))}
      </RadioGroup>
    </Frame>
  );
}

export type SliderFieldProps = Common & {
  value?: number;
  defaultValue?: number;
  onValueChange?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /* How a value is said: `(n) => `${n} days``. Used for the two ends, which are drawn when it is given. */
  format?: (value: number) => string;
};

export function SliderField({ label, name, hint, error, optional, required, tip, disabled, format, ...slider }: SliderFieldProps) {
  return (
    <Frame {...{ label, hint, error, optional, required, tip, disabled }}>
      <Slider name={name} {...slider}>
        <SliderControl>
          <SliderTrack>
            <SliderIndicator />
            <SliderThumb aria-label={label} />
          </SliderTrack>
        </SliderControl>
        <SliderValue />
        {format && (
          <div data-slot="slider-ends" aria-hidden="true">
            <span>{format(slider.min ?? 0)}</span>
            <span>{format(slider.max ?? 100)}</span>
          </div>
        )}
      </Slider>
    </Frame>
  );
}

/* A form's layout: fields in a column, pairs side by side, and sections with their name beside them. */
export function FormGrid({ children }: { children: ReactNode }) {
  return <div data-slot="form-grid">{children}</div>;
}

export function FormSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section data-slot="form-section" aria-label={title}>
      <header>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </header>
      <div data-slot="form-fields">{children}</div>
    </section>
  );
}

/* The form's verbs: the one that commits is last and filled; the bar keeps to the foot of whatever scrolls. */
export function ActionBar({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div data-slot="action-bar">
      {note && <span data-slot="action-note">{note}</span>}
      {children}
    </div>
  );
}
