/**
 * A day or a week at a time: previous, Today, next, and the date field between for a jump of any size. What a
 * schedule or a day's list is stepped by, so a page does not draw its own three buttons and a clock. `T` goes to
 * today from anywhere on the page that is not a box being typed in, and a page that has its own use for `T` says so
 * by preventing the key first. `skip` says a day that is not stepped onto (a weekend, a closed day): stepping goes on
 * to the next day that is not skipped. Today is always reachable, skipped or not.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '@mistriwork/ui/Button.js';
import { DateField } from '@mistriwork/kit/client/components/DateField.js';
import { addHostListener } from '@mistriwork/kit/client/shellHost.js';
import { say } from '../../copy/components/components/sdk/DateNav.js';

/* The day arithmetic of the behaviors' `addDays` and `localToday`, written out here: the behaviors module has no
   `sideEffects` flag, so importing one name would carry every behavior into this page-controls chunk. */
const addDays = (day: string, by: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);
const localToday = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** More skipped days in a row than any calendar has: a `skip` that refuses every day must not loop. */
const MOST_SKIPPED = 14;

/** Where stepping lands from `from`, `by` days at a time, past what `skip` refuses. */
export function stepDay(from: string, by: number, skip?: (day: string) => boolean): string {
  let day = addDays(from, by);
  for (let tries = 0; tries < MOST_SKIPPED && skip?.(day); tries += 1) day = addDays(day, by < 0 ? -1 : 1);
  return day;
}

export function DateNav({
  value,
  onValueChange,
  step = 'day',
  skip,
  label,
  ariaLabel,
  locale,
  min,
  max,
  className,
}: {
  /** The day, as `2026-11-14`. */
  value: string;
  onValueChange: (day: string) => void;
  /** What previous and next move by. */
  step?: 'day' | 'week';
  /** A day not to land on when stepping. */
  skip?: (day: string) => boolean;
  /** Optional visible caption rendered beside the date navigation controls. */
  label?: ReactNode;
  /** Accessible name for the group and date field; defaults to `label` (when text) or `'Date'`. */
  ariaLabel?: string;
  locale?: string;
  min?: string;
  max?: string;
  className?: string;
}) {
  const id = useId();
  const weekly = step === 'week';
  const by = weekly ? 7 : 1;
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const latest = useRef({ onValueChange });
  latest.current = { onValueChange };

  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      if (event.key !== 't' && event.key !== 'T') return;
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      event.preventDefault();
      latest.current.onValueChange(localToday());
    };
    return addHostListener(document, 'keydown', press);
  }, []);

  const go = (days: number) => onValueChange(stepDay(value, days, skip));
  let previous = say('previousDay');
  let next = say('nextDay');
  if (weekly) {
    previous = say('previousWeek');
    next = say('nextWeek');
  }
  const name = ariaLabel ?? (typeof label === 'string' ? label : say('date'));
  return (
    <div className={`kit-datenav${className ? ` ${className}` : ''}`} role="group" aria-label={name}>
      {label !== undefined && label !== null && label !== false && <span className="kit-datenav-label">{label}</span>}
      <Button size="sm" ariaLabel={previous} onClick={() => go(-by)}>
        {'‹'}
      </Button>
      <Button size="sm" onClick={() => onValueChange(localToday())}>
        {say('today')}
      </Button>
      <Button size="sm" ariaLabel={next} onClick={() => go(by)}>
        {'›'}
      </Button>
      <DateField
        id={id}
        ariaLabel={name}
        value={text}
        locale={locale}
        min={min}
        max={max}
        onValueChange={(nextDay) => {
          setText(nextDay);
          if (DAY.test(nextDay)) onValueChange(nextDay);
        }}
      />
    </div>
  );
}
