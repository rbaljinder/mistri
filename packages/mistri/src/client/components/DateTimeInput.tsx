/**
 * A command's date-and-time input: the date field with its clock
 * (DateField's `withTime`), read in the App's time zone. The box holds the
 * wall time a person types; the form holds the UTC instant it names, which is
 * what is sent and what a starting value arrives as. Text that is not yet a
 * whole date and time goes to the form as typed, for the shared reader to
 * refuse as not a date and time. A chunk of its own (CommandFields.tsx), so
 * the zone arithmetic never rides on a public form's first page.
 */
import { useState, type AriaAttributes } from 'react';
import { DateField } from '@mistriwork/kit/client/components/DateField.js';
import { formatLocale, formatTimezone } from '@mistriwork/kit/client/locale.js';
import { instantWallTime, wallTimeInstant } from './wallTime.js';

interface DateTimeInputProps {
  id: string;
  /** The instant (ISO 8601), text not yet one, or empty. */
  value: string;
  onChange: (value: string) => void;
  /** Bounds, as instants. */
  min?: string;
  max?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  'aria-invalid'?: AriaAttributes['aria-invalid'];
  'aria-describedby'?: string;
}

export function DateTimeInput({ value, onChange, min, max, ...rest }: DateTimeInputProps) {
  const zone = formatTimezone();
  const wall = (at: string | undefined) => (at ? (instantWallTime(at, zone) ?? at) : at);
  const [draft, setDraft] = useState(() => wall(value) ?? '');
  // What this box last told the form: any other value came from outside (a starting value, a reset) and is drawn afresh.
  const [told, setTold] = useState(value);
  if (value !== told) {
    setTold(value);
    setDraft(wall(value) ?? '');
  }
  return (
    <DateField
      {...rest}
      withTime
      min={wall(min)}
      max={wall(max)}
      locale={formatLocale()}
      timezone={zone}
      value={draft}
      onChange={(next) => {
        setDraft(next);
        const typed = next.trim();
        const sent = typed ? (wallTimeInstant(typed, zone) ?? next) : '';
        setTold(sent);
        onChange(sent);
      }}
    />
  );
}
