import { CalendarBlank, House, Receipt, Warning, Wrench } from '@phosphor-icons/react';
import { RecordSection, Stats, type WorkItem, Worklist } from '../../src';
import { money, UNITS } from '../data';

/* The same page Lintel runs for real (in-app/lintel/pages/today-next.page.tsx), on made-up rows: what needs the
   office now, in the order it would be worked, each one press from where it is dealt with. */
const LIVED = UNITS.filter((unit) => unit.resident).length;
const UNLISTED = UNITS.filter((unit) => unit.status === 'Vacant' && !unit.listed);

const NEEDS: WorkItem[] = [
  {
    id: 'r1',
    icon: <Warning />,
    tone: 'critical',
    title: 'Boiler loses pressure overnight',
    detail: 'AC-204, urgent, no technician yet',
    value: 'reported 2 hours ago',
    href: '#repairs',
  },
  {
    id: 'r2',
    icon: <Warning />,
    tone: 'critical',
    title: 'Damp patch on bedroom ceiling',
    detail: 'BH-305, urgent, visit booked',
    value: 'reported 4 days ago',
    href: '#repairs',
  },
  {
    id: 'l1',
    icon: <Receipt />,
    tone: 'warning',
    title: 'Andre Okoye is behind',
    detail: 'AC-101, $1,285 a month',
    value: '$2,645 due',
    href: '#lease',
  },
  ...UNLISTED.map((unit) => ({
    id: `u${unit.code}`,
    icon: <House />,
    tone: 'info' as const,
    title: `${unit.code} is empty and not listed`,
    detail: `${unit.building}, asking ${money(unit.rent)}`,
    value: unit.available ? `free ${unit.available}` : undefined,
    href: '#rent-roll',
  })),
];

const COMING: WorkItem[] = [
  { id: 'v1', icon: <Wrench />, title: 'Replace cracked hob glass', detail: 'Visit at AC-103', value: 'Tomorrow', href: '#repairs' },
  {
    id: 'e1',
    icon: <CalendarBlank />,
    title: 'Omar Ramirez’s lease ends',
    detail: 'AC-203, notice given',
    value: 'Oct 1, in 2 weeks',
    href: '#lease',
  },
  { id: 'e2', icon: <CalendarBlank />, title: 'Lena Patel’s lease ends', detail: 'AC-106', value: 'Oct 31, in 7 weeks', href: '#lease' },
  ...UNITS.filter((unit) => unit.status === 'Turnover').map((unit) => ({
    id: `f${unit.code}`,
    icon: <House />,
    title: `${unit.code} falls free`,
    detail: unit.building,
    value: unit.available ?? undefined,
    href: '#rent-roll',
  })),
];

const SAID = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

export function Today() {
  return (
    <div data-part="today">
      <header data-slot="list-head">
        <h1>
          Today <span data-slot="list-count">{SAID}</span>
        </h1>
      </header>
      <Stats
        items={[
          { label: 'Needs you', value: NEEDS.length, tone: 'critical', note: `2 urgent, 1 behind, ${UNLISTED.length} unlisted` },
          { label: 'Balance due', value: '$2,645', tone: 'warning', note: 'across 1 of 47 leases' },
          {
            label: 'Occupancy',
            value: `${Math.round((LIVED / UNITS.length) * 100)}%`,
            share: LIVED / UNITS.length,
            note: `${LIVED} of ${UNITS.length} homes`,
          },
          { label: 'Open repairs', value: 7, note: '3 with no technician' },
        ]}
      />
      <div data-part="today-columns">
        <RecordSection title="Needs you" count={NEEDS.length}>
          <Worklist label="What needs the office now" items={NEEDS} />
        </RecordSection>
        <RecordSection title="Coming up" count={COMING.length}>
          <Worklist label="What is coming" items={COMING} />
        </RecordSection>
      </div>
    </div>
  );
}
