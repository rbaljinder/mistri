import { Plus } from '@phosphor-icons/react';
import { Avatar, AvatarFallback } from '@ui-sdk/react/avatar';
import { toast } from '@ui-sdk/react/toast';
import { useState } from 'react';
import { Board, type BoardLane, Button, Status, type Tone } from '../../src';

type Repair = { id: string; title: string; home: string; lane: string; priority: 'Low' | 'Normal' | 'Urgent'; who: string; age: string };

const LANES: BoardLane[] = [
  { value: 'new', label: 'New' },
  { value: 'scheduled', label: 'Scheduled', tone: 'info' },
  { value: 'progress', label: 'In progress', tone: 'warning' },
  { value: 'done', label: 'Done', tone: 'good' },
];

/* What may be done to a repair from each lane and where it lands: the made-up version of a workflow's verbs. The
   first is its next step, on the card's button; the rest are in its menu; and carrying a card to a lane is the
   step that leads there, where one does. */
type Step = { value: string; label: string; to: string };
const STEPS: Record<string, Step[]> = {
  new: [{ value: 'book', label: 'Book a visit', to: 'scheduled' }],
  scheduled: [
    { value: 'start', label: 'Start work', to: 'progress' },
    { value: 'unbook', label: 'Cancel the visit', to: 'new' },
  ],
  progress: [
    { value: 'complete', label: 'Complete', to: 'done' },
    { value: 'pause', label: 'Back to scheduled', to: 'scheduled' },
  ],
  done: [{ value: 'reopen', label: 'Reopen', to: 'progress' }],
};

const PRIORITY_TONE: Record<Repair['priority'], Tone> = { Low: 'neutral', Normal: 'info', Urgent: 'critical' };

const REPAIRS: Repair[] = [
  { id: 'R-218', title: 'Boiler loses pressure overnight', home: 'AC-204', lane: 'new', priority: 'Urgent', who: 'ML', age: '2h' },
  { id: 'R-217', title: 'Bathroom extractor fan rattles', home: 'BH-102', lane: 'new', priority: 'Low', who: 'JB', age: '1d' },
  { id: 'R-216', title: 'Front door lock sticks', home: 'CM-301', lane: 'new', priority: 'Normal', who: 'ML', age: '1d' },
  { id: 'R-214', title: 'Replace cracked hob glass', home: 'AC-103', lane: 'scheduled', priority: 'Normal', who: 'KA', age: '3d' },
  { id: 'R-211', title: 'Damp patch on bedroom ceiling', home: 'BH-305', lane: 'scheduled', priority: 'Urgent', who: 'JB', age: '4d' },
  { id: 'R-209', title: 'Repaint hallway after leak', home: 'AC-106', lane: 'progress', priority: 'Low', who: 'KA', age: '6d' },
  { id: 'R-207', title: 'Kitchen tap drips', home: 'CM-102', lane: 'progress', priority: 'Normal', who: 'ML', age: '1w' },
  { id: 'R-203', title: 'Window latch replaced', home: 'BH-201', lane: 'done', priority: 'Normal', who: 'JB', age: '1w' },
  { id: 'R-198', title: 'Smoke alarm battery', home: 'AC-301', lane: 'done', priority: 'Low', who: 'KA', age: '2w' },
];

export function Repairs() {
  const [repairs, setRepairs] = useState(REPAIRS);
  const place = (id: string, lane: string) => setRepairs((all) => all.map((item) => (item.id === id ? { ...item, lane } : item)));
  /* A step is done at once and said, and the saying carries the way back: no "are you sure" before a thing that
     Undo puts right. */
  const take = (repair: Repair, value: string) => {
    const step = STEPS[repair.lane]?.find((one) => one.value === value);
    if (!step) return;
    place(repair.id, step.to);
    toast.success(`${step.label}: ${repair.title}`, { action: { label: 'Undo', onAction: () => place(repair.id, repair.lane) } });
  };
  return (
    <section data-slot="list-view" aria-label="Repair board">
      <header data-slot="list-head">
        <h1>
          Repair board <span data-slot="list-count">{repairs.length}</span>
        </h1>
        <div data-slot="list-actions">
          <Button intent="primary" onClick={() => toast('A New form would open here')}>
            <Plus aria-hidden="true" weight="bold" />
            New repair
          </Button>
        </div>
      </header>
      <Board
        label="Repairs by stage"
        lanes={LANES}
        cards={repairs}
        cardKey={(repair) => repair.id}
        cardName={(repair) => repair.title}
        laneOf={(repair) => repair.lane}
        onOpen={(repair) => toast(`${repair.id} would open here`)}
        verbs={(repair) => (STEPS[repair.lane] ?? []).slice(1)}
        onVerb={take}
        drop={(repair, lane) => STEPS[repair.lane]?.find((step) => step.to === lane)}
        card={(repair) => {
          const next = STEPS[repair.lane]?.[0];
          return (
            <>
              <p data-slot="board-card-meta">
                <span>{repair.id}</span>
                <span>{repair.home}</span>
                <span>{repair.age}</span>
              </p>
              {repair.priority === 'Urgent' && repair.lane !== 'done' && (
                <p data-part="card-facts">
                  <Status tone={PRIORITY_TONE[repair.priority]}>{repair.priority}</Status>
                </p>
              )}
              <div data-slot="board-card-foot">
                {next && repair.lane !== 'done' ? (
                  <Button size="sm" intent={repair.priority === 'Urgent' ? 'primary' : 'default'} onClick={() => take(repair, next.value)}>
                    {next.label}
                  </Button>
                ) : (
                  <span />
                )}
                <Avatar data-size="sm">
                  <AvatarFallback>{repair.who}</AvatarFallback>
                </Avatar>
              </div>
            </>
          );
        }}
      />
    </section>
  );
}
