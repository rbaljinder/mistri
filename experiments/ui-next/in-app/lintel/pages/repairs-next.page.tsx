/**
 * Lintel's repairs as a board, drawn whole by ui-next: a free-form page at /repairs-next.
 *
 * A repair does not move wherever it is dragged. It has a next step, and which one depends on where it stands: a new
 * one is triaged, a triaged one is given a visit, a visit is started, work is completed or put on hold. So a card
 * here does not ask to be carried to a lane. It says its next step on a button, and the other things that may be
 * done to it are in its menu; the lanes only show where everything stands. Each step is Lintel's own: a fixed
 * action of the repair's machine runs at once, and a command that has something to ask (who, when, what was done)
 * opens its own form. The server judges every one again.
 *
 * A mouse may also carry a card to a lane, and that is the same step said another way: the lanes a step leads to
 * light up and name it (carry a new repair to "On site" and the lane says "Book a visit"), the others stand back,
 * and letting go runs the step. There is no carrying a card somewhere no step leads.
 *
 * Urgent repairs lead their lane, and the strip over the board says what a desk checks first: how many are open,
 * how many are urgent, what has waited longest, and what is booked for today.
 */
import { definePage, useHref } from '@mistriwork/mistri/page';
import { type ReactNode, useMemo, useState } from 'react';
import {
  Avatar,
  AvatarFallback,
  Board,
  type BoardLane,
  type BoardVerb,
  Button,
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
  Stats,
  Status,
  Toaster,
  type Tone,
} from '../ui';
import '../../../src/theme/board.css';
import '../../../src/theme/list.css';
import '../../../src/theme/record.css';
import '../lintel.css';
import { day, daysUntil, initials, type Row, text, words } from '../format';

const page = definePage({
  label: 'Repairs, ui-next',
  description: 'Every open repair by where it stands, each with its next step.',
  icon: 'wrench',
  nav: { group: 'maintenance', position: 0 },
  head: false,
  reads: ['maintenance_request', 'unit', 'staff'],
  commands: ['assignTechnician', 'scheduleVisit', 'completeRequest', 'cancelRequest'],
  actions: ['triage', 'start', 'hold', 'resume', 'close'],
  component: Repairs,
});
export default page;

/* The desk's own words for where a repair stands, a lane each. */
const LANES: BoardLane[] = [
  { value: 'new', label: 'New' },
  { value: 'triaged', label: 'Waiting for a visit', tone: 'info' },
  { value: 'site', label: 'On site', tone: 'warning' },
  { value: 'completed', label: 'Done, to close', tone: 'good' },
];
const LANE: Record<string, string> = {
  new: 'new',
  triaged: 'triaged',
  scheduled: 'site',
  in_progress: 'site',
  on_hold: 'site',
  completed: 'completed',
};
const STAGE: Record<string, string> = { scheduled: 'Visit booked', in_progress: 'Being worked on', on_hold: 'On hold' };
const PRIORITY: Record<string, Tone> = { urgent: 'critical', normal: 'neutral', low: 'neutral' };
const CATEGORY: Record<string, string> = { hvac: 'Heating and cooling' };

/* What may be done to a repair from each place it stands, in the machine's order: the first is its next step. */
const STEPS: Record<string, string[]> = {
  new: ['triage', 'assignTechnician', 'scheduleVisit', 'cancelRequest'],
  triaged: ['scheduleVisit', 'assignTechnician', 'cancelRequest'],
  scheduled: ['start', 'scheduleVisit', 'hold', 'cancelRequest'],
  in_progress: ['completeRequest', 'hold'],
  on_hold: ['resume', 'cancelRequest'],
  completed: ['close'],
};
const SAID: Record<string, string> = {
  triage: 'Triage',
  assignTechnician: 'Assign a technician',
  scheduleVisit: 'Book a visit',
  completeRequest: 'Complete',
  cancelRequest: 'Cancel the request',
  start: 'Start work',
  hold: 'Put on hold',
  resume: 'Resume',
  close: 'Close',
};

/* The lane a step leaves a repair in, for the steps that move it: what carrying a card there means. */
const LEADS: Record<string, string> = { triage: 'triaged', scheduleVisit: 'site', completeRequest: 'completed' };

const age = (iso: unknown): string => {
  const days = -daysUntil(iso);
  return days <= 0 ? 'today' : days === 1 ? '1 day' : days < 14 ? `${days} days` : `${Math.round(days / 7)} weeks`;
};

function Repairs(): ReactNode {
  const href = useHref();
  const [only, setOnly] = useState<string | null>('all');
  const repairs = page.useRows('maintenance_request', {
    query: 'status is open or status = completed',
    show: [
      'title',
      'unit_id',
      'unit_id.code',
      'category',
      'priority',
      'status',
      'assigned_to',
      'assigned_to.name',
      'scheduled_on',
      'reported_on',
      'status_since',
    ],
    sort: 'reported_on',
    limit: 300,
  });

  /* Every step the page may run, asked for once each: a hook is called the same way on every draw. */
  const actions = {
    triage: page.useAction('triage'),
    start: page.useAction('start'),
    hold: page.useAction('hold'),
    resume: page.useAction('resume'),
    close: page.useAction('close'),
  };
  const commands = {
    assignTechnician: page.useCommand('assignTechnician'),
    scheduleVisit: page.useCommand('scheduleVisit'),
    completeRequest: page.useCommand('completeRequest'),
    cancelRequest: page.useCommand('cancelRequest'),
  };
  const may = (step: string): boolean =>
    step in actions ? actions[step as keyof typeof actions].granted : commands[step as keyof typeof commands].granted;
  /* A step is run on the repair's key and the state it leaves, and nothing else of the row: that is all a step
     reads. At this commit the server answers every fixed action on a repair with a 400 all the same ("status_since
     is stamped by its machine as the state moves"), from here and from an unmodified Lintel alike, so the action
     buttons are right by the API and move nothing yet. The README says what was tried. */
  const run = (step: string, repair: Row): Promise<unknown> => {
    const record = { id: repair.id, status: repair.status };
    return step in actions ? actions[step as keyof typeof actions].run(record) : commands[step as keyof typeof commands].open(record);
  };
  const steps = (repair: Row): string[] => (STEPS[text(repair.status)] ?? []).filter(may);

  const all = useMemo(() => {
    const rows = (repairs.data ?? []) as Row[];
    // Urgent leads its lane; within that, what has waited longest.
    return [...rows].sort(
      (a, b) =>
        Number(b.priority === 'urgent') - Number(a.priority === 'urgent') ||
        text(a.status_since ?? a.reported_on).localeCompare(text(b.status_since ?? b.reported_on)),
    );
  }, [repairs.data]);
  const open = all.filter((repair) => repair.status !== 'completed');
  const urgent = open.filter((repair) => repair.priority === 'urgent');
  const today = open.filter((repair) => repair.scheduled_on && daysUntil(repair.scheduled_on) === 0);
  const waiting = open.filter((repair) => repair.status === 'new' || repair.status === 'triaged');
  const longest = waiting[0] ? [...waiting].sort((a, b) => text(a.reported_on).localeCompare(text(b.reported_on)))[0] : undefined;
  const shown =
    only === 'urgent'
      ? all.filter((repair) => repair.priority === 'urgent')
      : only === 'unassigned'
        ? all.filter((repair) => !repair.assigned_to)
        : all;

  const reading = repairs.isPending;

  return (
    <div data-part="lintel-page" data-slot="list-view">
      <header data-slot="list-head">
        <h2>Repairs {!reading && <span data-slot="list-count">{open.length} open</span>}</h2>
        <div data-slot="list-actions">
          <SegmentedControl aria-label="Which repairs" value={only} onValueChange={(next) => next !== null && setOnly(String(next))}>
            <SegmentedControlIndicator />
            <SegmentedControlItem value="all">All</SegmentedControlItem>
            <SegmentedControlItem value="urgent">Urgent</SegmentedControlItem>
            <SegmentedControlItem value="unassigned">No technician</SegmentedControlItem>
          </SegmentedControl>
        </div>
      </header>

      <Stats
        loading={reading}
        items={[
          { label: 'Open', value: open.length, note: `${waiting.length} waiting, ${open.length - waiting.length} on site` },
          {
            label: 'Urgent',
            value: urgent.length,
            tone: urgent.length ? 'critical' : undefined,
            note: urgent.length ? `${urgent.filter((repair) => !repair.assigned_to).length} with no technician` : 'None',
          },
          {
            label: 'Waiting longest',
            value: longest ? age(longest.reported_on) : '—',
            note: longest ? `${text(longest.title)}, ${text(longest['unit_id.code'])}` : 'Nothing is waiting',
          },
          {
            label: 'Visits today',
            value: today.length,
            note: today.length ? today.map((repair) => text(repair['unit_id.code'])).join(', ') : 'None booked',
          },
        ]}
      />

      <Board<Row>
        label="Repairs by where they stand"
        lanes={LANES}
        cards={shown}
        cardKey={(repair) => text(repair.id)}
        cardName={(repair) => text(repair.title)}
        laneOf={(repair) => LANE[text(repair.status)] ?? 'new'}
        onOpen={(repair) => {
          window.location.href = href.record('repairs', { id: repair.id });
        }}
        verbs={(repair): BoardVerb[] =>
          steps(repair)
            .slice(1)
            .map((step) => ({ value: step, label: SAID[step] ?? words(step) }))
        }
        onVerb={(repair, step) => void run(step, repair)}
        drop={(repair, lane) => {
          const step = steps(repair).find((one) => LEADS[one] === lane);
          return step ? { value: step, label: SAID[step] ?? words(step) } : undefined;
        }}
        loading={reading}
        empty="Nothing here"
        card={(repair) => {
          const next = steps(repair)[0];
          return (
            <>
              <p data-slot="board-card-meta">
                <span>{text(repair['unit_id.code'])}</span>
                <span>{CATEGORY[text(repair.category)] ?? words(repair.category)}</span>
                <span>{age(repair.status_since ?? repair.reported_on)}</span>
              </p>
              {((repair.priority === 'urgent' && repair.status !== 'completed') || STAGE[text(repair.status)]) && (
                <p data-part="card-facts">
                  {repair.priority === 'urgent' && repair.status !== 'completed' && <Status tone={PRIORITY.urgent}>Urgent</Status>}
                  {STAGE[text(repair.status)] && (
                    <Status tone={repair.status === 'on_hold' ? 'warning' : 'info'}>{STAGE[text(repair.status)]}</Status>
                  )}
                  {repair.scheduled_on && repair.status === 'scheduled' ? (
                    <span data-part="visit">{day(repair.scheduled_on, false)}</span>
                  ) : null}
                </p>
              )}
              <div data-slot="board-card-foot">
                {next ? (
                  <Button
                    size="sm"
                    intent={repair.priority === 'urgent' && repair.status !== 'completed' ? 'primary' : 'default'}
                    // The button waits on the step it started: a fixed action runs at once, and it shows that.
                    onClick={() => (next in actions ? run(next, repair) : void run(next, repair))}
                  >
                    {SAID[next] ?? words(next)}
                  </Button>
                ) : (
                  <span />
                )}
                {repair.assigned_to ? (
                  <span data-part="person" title={text(repair['assigned_to.name'])}>
                    <Avatar data-size="sm">
                      <AvatarFallback aria-hidden="true">{initials(repair['assigned_to.name'])}</AvatarFallback>
                    </Avatar>
                    <span data-slot="visually-hidden">{text(repair['assigned_to.name'])}</span>
                  </span>
                ) : (
                  <span data-slot="absent">No technician</span>
                )}
              </div>
            </>
          );
        }}
      />
      <Toaster />
    </div>
  );
}
