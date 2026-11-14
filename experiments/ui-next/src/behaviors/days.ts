import { type ChangeDetails, createChange, definePrimitive } from '@ui-sdk/core';

/* A month of days as a grid a keyboard walks: the behavior under a month calendar, a day picker and anything else
   laid out a week a row. As a UI SDK primitive the day the keyboard is on and the month in view are values with
   changes, so a page can hold either (a calendar and a list reading the same month) or leave them alone.

   The grid is one stop in the Tab order, the day last visited. Arrows go by day and by week, Home and End to the
   week's edges, Page Up and Down by month; a day past the month's edge brings its month into view and the
   keyboard follows it there. Enter or Space picks the day, which is the caller's to mean: a picker takes it as
   its value, a calendar goes into what the day holds.

   A day is said as `2026-11-14` and a month as `2026-11`, in no zone: a calendar's day is a date, not a moment. */

export type DaysReason = 'move-key' | 'focus-in' | 'imperative';

export type DaysOptions = {
  /* The day the keyboard is on. */
  value?: string;
  defaultValue?: string;
  onValueChange?: (day: string, details: ChangeDetails<DaysReason>) => void;
  /* The month in view. */
  month?: string;
  defaultMonth?: string;
  onMonthChange?: (month: string, details: ChangeDetails<DaysReason>) => void;
  /* The first day of a week: 1 is Monday, 0 Sunday. */
  weekStart?: number;
  /* The day that is today, for a page that knows it in its own zone; else the reader's. */
  today?: string;
  /* The first and last day the keyboard goes to. */
  min?: string;
  max?: string;
  /* A day the reader may not pick: it is still walked over, and said to be unavailable. */
  unavailable?: (day: string) => boolean;
  /* Enter or Space on a day, or a press on it where `press` is set. */
  onPick?: (day: string, event: Event) => void;
  /* A press on a day picks it too: for a grid whose days hold nothing of their own to press. */
  press?: boolean;
};

const DAY = 86_400_000;
export const dayAt = (day: string): Date => new Date(`${day}T00:00:00Z`);
const iso = (date: Date): string => date.toISOString().slice(0, 10);
export const addDays = (day: string, by: number): string => iso(new Date(dayAt(day).getTime() + by * DAY));
export const monthOf = (day: string): string => day.slice(0, 7);
export const addMonths = (month: string, by: number): string => {
  const date = dayAt(`${month}-01`);
  date.setUTCMonth(date.getUTCMonth() + by);
  return iso(date).slice(0, 7);
};
/* The same day of another month, or that month's last where it is shorter. */
export const inMonth = (day: string, month: string): string => {
  const last = dayAt(`${addMonths(month, 1)}-01`).getTime() - DAY;
  const wanted = dayAt(`${month}-${day.slice(8)}`);
  return Number.isNaN(wanted.getTime()) || monthOf(iso(wanted)) !== month ? iso(new Date(last)) : iso(wanted);
};
export const localToday = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};
/* Whole weeks, from the week a month starts in to the week it ends in. */
export const weeksOf = (month: string, weekStart: number): string[][] => {
  const first = `${month}-01`;
  const lead = (dayAt(first).getUTCDay() - weekStart + 7) % 7;
  const start = addDays(first, -lead);
  const days = (dayAt(`${addMonths(month, 1)}-01`).getTime() - dayAt(first).getTime()) / DAY;
  const count = Math.ceil((lead + days) / 7);
  return Array.from({ length: count }, (_, week) => Array.from({ length: 7 }, (_, day) => addDays(start, week * 7 + day)));
};

export const days = definePrimitive({
  name: 'days',
  options: {
    value: 'string',
    defaultValue: 'string',
    onValueChange: 'callback',
    month: 'string',
    defaultMonth: 'string',
    onMonthChange: 'callback',
    weekStart: 'number',
    today: 'string',
    min: 'string',
    max: 'string',
    unavailable: 'action',
    onPick: 'callback',
    press: 'boolean',
  },
  controlled: ['value', 'month'],
  state: (options: DaysOptions) => {
    const today = options.today ?? localToday();
    const month = options.month ?? options.defaultMonth ?? monthOf(options.value ?? options.defaultValue ?? today);
    return {
      month,
      // The keyboard starts on the day it was given, else on today where the month holds it, else on the month's first.
      value: options.value ?? options.defaultValue ?? (monthOf(today) === month ? today : `${month}-01`),
    };
  },
  sync: (options) => ({
    ...(options.value === undefined ? {} : { value: options.value }),
    ...(options.month === undefined ? {} : { month: options.month }),
  }),
  api: (context) => {
    const change = createChange(context);
    const weekStart = (): number => context.options().weekStart ?? 1;
    const today = (): string => context.options().today ?? localToday();
    const held = (day: string): string => {
      const { min, max } = context.options();
      if (min && day < min) return min;
      if (max && day > max) return max;
      return day;
    };
    /* The keyboard goes with the day: once the grid is drawn again (a new month's cells are not there until it
       is), the day's cell is found and takes the focus. A few frames are allowed for the drawing. */
    const follow = (from: HTMLElement | null | undefined, day: string) => {
      const root = from?.closest<HTMLElement>('[data-slot="days"]');
      if (!root || typeof requestAnimationFrame === 'undefined') return;
      let tries = 0;
      const land = () => {
        const cell = root.querySelector<HTMLElement>(`[role="gridcell"][data-day="${day}"]`);
        if (cell) cell.focus();
        else if (++tries < 12) requestAnimationFrame(land);
      };
      land();
    };
    const visit = (to: string, reason: DaysReason, event?: Event, from?: HTMLElement | null): boolean => {
      const day = held(to);
      const now = context.store.get();
      if (day === now.value && monthOf(day) === now.month) return false;
      if (day !== now.value && !change('value', day, { reason, event })) return false;
      if (monthOf(day) !== context.store.get().month) change('month', monthOf(day), { reason, event });
      if (from) follow(from, day);
      return true;
    };
    return {
      weekStart,
      today,
      now: () => context.store.get(),
      weeks: (): string[][] => weeksOf(context.store.get().month, weekStart()),
      visit,
      /* Another month into view, with the keyboard's day kept to the same date in it. */
      show(month: string, event?: Event): boolean {
        const now = context.store.get();
        if (month === now.month) return false;
        if (!change('month', month, { reason: 'imperative', event })) return false;
        change('value', held(inMonth(now.value, month)), { reason: 'imperative', event });
        return true;
      },
      /* Where a key takes the keyboard from a day, or nowhere. */
      step(day: string, key: string): string | undefined {
        const inWeek = (dayAt(day).getUTCDay() - weekStart() + 7) % 7;
        switch (key) {
          case 'ArrowLeft':
            return addDays(day, -1);
          case 'ArrowRight':
            return addDays(day, 1);
          case 'ArrowUp':
            return addDays(day, -7);
          case 'ArrowDown':
            return addDays(day, 7);
          case 'Home':
            return addDays(day, -inWeek);
          case 'End':
            return addDays(day, 6 - inWeek);
          case 'PageUp':
            return inMonth(day, addMonths(monthOf(day), -1));
          case 'PageDown':
            return inMonth(day, addMonths(monthOf(day), 1));
          default:
            return undefined;
        }
      },
      open(day: string): boolean {
        const { min, max, unavailable } = context.options();
        return !(min && day < min) && !(max && day > max) && !unavailable?.(day);
      },
      /* The day that is the grid's one stop in the Tab order: the keyboard's, or the month's first where a page
         that holds the month has turned it away from that day. */
      stop(): string {
        const now = context.store.get();
        return monthOf(now.value) === now.month ? now.value : `${now.month}-01`;
      },
      pick(day: string, event: Event) {
        context.options().onPick?.(day, event);
      },
      presses: (): boolean => Boolean(context.options().press),
    };
  },
  slots: (slot) => ({
    root: slot<{}, { month: string; day: string; weeks: string[][] }>({
      state: (state, part) => ({ month: state.month, day: state.value, weeks: part.api.weeks() }),
      attrs: (state) => ({ 'data-month': state.month }),
    }),
    day: slot<{ value: string }>({
      props: { value: 'string' },
      attrs: (state, part) => {
        const day = part.props.value;
        return {
          role: 'gridcell',
          tabindex: day === part.api.stop() ? '0' : '-1',
          'data-day': day,
          'data-outside': monthOf(day) === state.month ? undefined : '',
          'data-today': day === part.api.today() ? '' : undefined,
          'aria-current': day === part.api.today() ? 'date' : undefined,
          'aria-disabled': part.api.open(day) ? undefined : 'true',
        };
      },
      on: {
        keydown: (event, { api, el, props }) => {
          // A key on something the day holds is that thing's.
          if (event.target !== el) return;
          const to = api.step(props.value, event.key);
          if (to) {
            event.preventDefault();
            api.visit(to, 'move-key', event, el);
          } else if ((event.key === 'Enter' || event.key === ' ') && api.open(props.value)) {
            event.preventDefault();
            api.pick(props.value, event);
          }
        },
        focus: (event, { api, el, props }) => {
          if (event.target === el) api.visit(props.value, 'focus-in', event);
        },
        click: (event, { api, el, props }) => {
          if (api.presses() && api.open(props.value) && (event.target === el || !(event.target as HTMLElement).closest('a, button'))) {
            api.visit(props.value, 'focus-in', event);
            api.pick(props.value, event);
          }
        },
      },
    }),
  }),
});
