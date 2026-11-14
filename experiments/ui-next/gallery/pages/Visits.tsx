import { toast } from '@ui-sdk/react/toast';
import { useState } from 'react';
import { Button, Calendar, type CalendarEvent, type TimedEvent, WeekCalendar } from '../../src';

/* Lintel's repair visits and move-ins as a month. The days are made from today, so the room always opens on a
   month with something in it. A visit is carried to another day, or moved with Alt and an arrow; none goes into
   the past, and a move-in stays where the lease put it. */
const pad = (value: number) => String(value).padStart(2, '0');
const NOW = new Date();
const TODAY = `${NOW.getFullYear()}-${pad(NOW.getMonth() + 1)}-${pad(NOW.getDate())}`;
const from = (days: number): string => {
  const date = new Date(Date.UTC(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + days));
  return date.toISOString().slice(0, 10);
};

const START: CalendarEvent[] = [
  { id: 'v1', day: from(0), time: '09:00', title: 'Boiler pressure, AC-204', tone: 'critical' },
  { id: 'v2', day: from(0), time: '11:30', title: 'Hob glass, AC-103' },
  { id: 'v3', day: from(0), time: '14:00', title: 'Extractor fan, BH-102' },
  { id: 'v4', day: from(0), time: '15:30', title: 'Lock change, CM-201' },
  { id: 'v5', day: from(0), time: '16:45', title: 'Smoke alarm, DL-004' },
  { id: 'v6', day: from(1), time: '10:00', title: 'Damp patch survey, BH-305', tone: 'warning' },
  { id: 'v7', day: from(2), time: '13:00', title: 'Gutter clearing, Alder Court' },
  { id: 'm1', day: from(3), title: 'Move-in: Priya Raman, CM-104', tone: 'good', fixed: true },
  { id: 'v8', day: from(5), time: '09:30', title: 'Radiator bleed, AC-301' },
  { id: 'v9', day: from(8), time: '12:00', title: 'Window latch, EW-002' },
  { id: 'm2', day: from(11), title: 'Move-out: Dana Whitlock, BH-201', tone: 'neutral', fixed: true },
  { id: 'v10', day: from(-3), time: '10:30', title: 'Tap washer, FR-001', tone: 'neutral' },
  { id: 'v11', day: from(-6), time: '15:00', title: 'Door closer, AC-G01', tone: 'neutral' },
];

export function Visits() {
  const [events, setEvents] = useState(START);
  const place = (id: string, day: string, time?: string) =>
    setEvents((now) => now.map((event) => (event.id === id ? { ...event, day, time: time ?? event.time } : event)));
  const [view, setView] = useState<'month' | 'week'>('month');
  /* How long each visit runs is the week's to show: the month knows only when one starts. */
  const [length, setLength] = useState<Record<string, number>>({});
  const timed: TimedEvent[] = events
    .filter((event) => event.time)
    .map((event) => {
      const start = Number(event.time?.slice(0, 2)) * 60 + Number(event.time?.slice(3, 5));
      const end = start + (length[event.id] ?? 60);
      return {
        id: event.id,
        day: event.day,
        start: event.time as string,
        end: `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`,
        title: event.title,
        tone: event.tone,
      };
    });
  const NOW_CLOCK = `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`;
  return (
    <div data-part="today">
      <header data-slot="list-head">
        <h1>
          Visits <span data-slot="list-count">{events.length} this season</span>
        </h1>
        <div data-slot="list-actions" role="group" aria-label="View">
          <Button size="sm" aria-pressed={view === 'month'} onClick={() => setView('month')}>
            Month
          </Button>
          <Button size="sm" aria-pressed={view === 'week'} onClick={() => setView('week')}>
            Week
          </Button>
        </div>
      </header>
      {view === 'week' && (
        <WeekCalendar
          label="Visits"
          events={timed}
          today={TODAY}
          now={NOW_CLOCK}
          onOpen={(event) => toast(`${event.title} would open here`)}
          onChange={(event, when) => {
            const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
            place(event.id, when.day, when.start);
            setLength((now) => ({ ...now, [event.id]: minutes(when.end) - minutes(when.start) }));
          }}
        />
      )}
      {view === 'month' && (
        <Calendar
          label="Visits"
          events={events}
          today={TODAY}
          accepts={(_event, day) => day >= TODAY}
          onOpen={(event) => toast(`${event.title} would open here`)}
          onAdd={(day) => toast(`A New visit form would open for ${day}`)}
          onMove={(event, day) => {
            place(event.id, day);
            toast.success(`${event.title} moved`, { action: { label: 'Undo', onAction: () => place(event.id, event.day) } });
          }}
        />
      )}
    </div>
  );
}
