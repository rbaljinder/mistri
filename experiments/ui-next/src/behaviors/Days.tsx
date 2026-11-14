import { createParts } from '@ui-sdk/react/primitive';
import type { ComponentProps, ReactNode } from 'react';
import { days } from './days';

const parts = createParts(days, { root: 'div', day: 'div' });

/* The React parts of a grid of days (./days.ts is the primitive). The root hands the month in view, the day the
   keyboard is on and the month's weeks to its children, and what a day is drawn as is the caller's:

     <Days defaultMonth="2026-11" onPick={(day) => choose(day)} role="grid" aria-label="A day to visit">
       {({ weeks }) =>
         weeks.map((week) => (
           <div role="row" key={week[0]}>
             {week.map((day) => (
               <DaysDay key={day} value={day}>{Number(day.slice(8))}</DaysDay>
             ))}
           </div>
         ))
       }
     </Days>

   A day can be another part's element (`render`), so a day that is also a place things are carried to is one
   element with both behaviors: `<DaysDay value={day} render={<TransferList value={day} … />} />`.

   Slots: `days` (`data-month`) and `days-day` (`data-day`, `data-outside`, `data-today`). */
export function Days({
  children,
  ...props
}: Omit<ComponentProps<typeof parts.Root>, 'children'> & {
  children: (state: { month: string; day: string; weeks: string[][] }) => ReactNode;
}) {
  return <parts.Root {...props}>{(state) => children(state)}</parts.Root>;
}

export const DaysDay = parts.Day;
