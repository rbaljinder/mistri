import { TimeInput } from '@ui-sdk/react/time-input';
import { type ReactNode, useState } from 'react';
import { type DateFieldProps, DayControl, FieldFrame } from './fields';

type Common = {
  label: string;
  name?: string;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  required?: boolean;
  tip?: ReactNode;
  disabled?: boolean;
};

export type TimeFieldProps = Common & {
  /* A time of day, as `HH:MM`. */
  value?: string | null;
  defaultValue?: string;
  onValueChange?: (value: string | null) => void;
  min?: string;
  max?: string;
};

/* A time of day, typed a part at a time: the hour, the minute, and morning or afternoon where the reader's place
   counts that way. The arrows step a part, and what is kept is the same `HH:MM` whichever clock is shown. */
export function TimeField({
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
  min,
  max,
}: TimeFieldProps) {
  return (
    <FieldFrame {...{ label, hint, error, optional, required, tip, disabled }}>
      <TimeInput
        name={name}
        value={value}
        defaultValue={defaultValue}
        min={min}
        max={max}
        onValueChange={(next) => onValueChange?.(next === null ? null : String(next))}
      />
    </FieldFrame>
  );
}

export type DateTimeFieldProps = Common &
  Pick<DateFieldProps, 'min' | 'max' | 'unavailable' | 'timeZone'> & {
    /* A day and a time, as `YYYY-MM-DDTHH:MM`. */
    value?: string | null;
    defaultValue?: string;
    onValueChange?: (value: string | null) => void;
  };

const day = (moment: string | null | undefined): string | null => moment?.slice(0, 10) || null;
const time = (moment: string | null | undefined): string | null => moment?.slice(11, 16) || null;

/* A day and a time as one answer: the day typed or picked from its calendar, the time beside it. The field tells a
   caller nothing until both are given, since half a moment is not one, and a form is sent the whole of it under
   the field's name. */
export function DateTimeField({
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
  min,
  max,
  unavailable,
  timeZone,
}: DateTimeFieldProps) {
  const [own, setOwn] = useState<{ day: string | null; time: string | null }>({ day: day(defaultValue), time: time(defaultValue) });
  const held = value === undefined ? own : { day: day(value) ?? own.day, time: time(value) ?? own.time };
  const tell = (next: { day: string | null; time: string | null }) => {
    setOwn(next);
    onValueChange?.(next.day && next.time ? `${next.day}T${next.time}` : null);
  };
  return (
    <FieldFrame {...{ label, hint, error, optional, required, tip, disabled }}>
      <div data-slot="date-time" role="group" aria-label={label}>
        <DayControl
          label={label}
          value={held.day}
          min={min?.slice(0, 10)}
          max={max?.slice(0, 10)}
          unavailable={unavailable}
          timeZone={timeZone}
          onValueChange={(next) => tell({ ...held, day: next })}
        />
        <TimeInput
          aria-label={`${label}, time`}
          value={held.time}
          onValueChange={(next) => tell({ ...held, time: next === null ? null : String(next) })}
        />
      </div>
      {name && <input type="hidden" name={name} value={held.day && held.time ? `${held.day}T${held.time}` : ''} />}
    </FieldFrame>
  );
}
