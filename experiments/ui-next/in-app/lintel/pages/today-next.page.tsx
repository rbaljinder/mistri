/**
 * Lintel's Today, drawn whole by ui-next: a free-form page at /today-next.
 *
 * A dashboard of charts answers "how are we doing". A property office opening the App in the morning asks "what
 * needs me", so this page is a list of that, in the order it would be worked: the repairs that cannot wait, the
 * leases that are behind with what each owes, and the homes standing empty that nobody can find online yet. Each
 * row is one press from the place it is dealt with: a repair's own page, the lease, the home on the rent roll.
 * Four figures over it say the state of the whole, and a column beside it says what is coming, so nothing ends or
 * falls free unnoticed.
 *
 * It reads through the page's own reads, under the reader's grants, and holds no rule of its own about what is
 * urgent, overdue or current: those are the App's segments and each lease's own balance.
 */
import { definePage, useHref, useNavigate } from '@mistriwork/mistri/page';
import { type ReactNode, useMemo } from 'react';
import { CalendarBlank, House, Receipt, RecordSection, Stats, Toaster, Warning, type WorkItem, Worklist, Wrench } from '../ui';
import '../../../src/theme/list.css';
import '../../../src/theme/record.css';
import '../../../src/theme/worklist.css';
import '../lintel.css';
import { day, daysUntil, fromNow, money, type Row, text, words } from '../format';

const page = definePage({
  label: 'Today, ui-next',
  description: 'What needs the office now, and what is coming.',
  icon: 'gauge',
  nav: { position: 0 },
  head: false,
  reads: ['unit', 'property', 'lease', 'resident', 'maintenance_request'],
  component: Today,
});
export default page;

const said = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

function Today(): ReactNode {
  const nav = useNavigate();
  const href = useHref();
  const units = page.useRows('unit', {
    show: ['code', 'property_id.name', 'status', 'listed', 'available_on', 'market_rent'],
    sort: 'code',
    limit: 500,
  });
  const leases = page.useRows('lease', {
    query: 'current',
    show: ['unit_id', 'unit_id.code', 'resident_id', 'resident_id.name', 'rent', 'end_on', 'status', 'balance'],
    limit: 500,
  });
  const repairs = page.useRows('maintenance_request', {
    query: 'outstanding',
    show: ['title', 'unit_id.code', 'priority', 'status', 'assigned_to', 'scheduled_on', 'reported_on'],
    sort: 'reported_on',
    limit: 300,
  });

  const lease = (id: unknown) => ({
    href: nav.pageHref('lease', { lease: text(id) }),
    onOpen: () => nav.openPage('lease', { lease: text(id) }),
  });
  const home = (id: unknown) => ({
    href: nav.pageHref('rent-roll', { home: text(id) }),
    onOpen: () => nav.openPage('rent-roll', { home: text(id) }),
  });

  const view = useMemo(() => {
    const homes = (units.data ?? []) as Row[];
    const current = (leases.data ?? []) as Row[];
    // The App's `outstanding` holds a finished repair until it is closed; what is still to be done is the rest.
    const open = ((repairs.data ?? []) as Row[]).filter((one) => one.status !== 'completed');
    const behind = current.filter((one) => Number(one.balance) > 0).sort((a, b) => Number(b.balance) - Number(a.balance));
    const urgent = open.filter((one) => one.priority === 'urgent');
    const unlisted = homes.filter((one) => one.status === 'vacant' && !one.listed);
    const ending = current
      .filter((one) => daysUntil(one.end_on) >= 0 && daysUntil(one.end_on) <= 60)
      .sort((a, b) => text(a.end_on).localeCompare(text(b.end_on)));
    const freeing = homes
      .filter((one) => one.available_on && daysUntil(one.available_on) >= 0 && daysUntil(one.available_on) <= 30)
      .sort((a, b) => text(a.available_on).localeCompare(text(b.available_on)));
    const visits = open
      .filter((one) => one.scheduled_on && daysUntil(one.scheduled_on) >= 0 && daysUntil(one.scheduled_on) <= 7)
      .sort((a, b) => text(a.scheduled_on).localeCompare(text(b.scheduled_on)));
    return {
      homes,
      current,
      open,
      behind,
      urgent,
      unlisted,
      ending,
      freeing,
      visits,
      owed: behind.reduce((sum, one) => sum + Number(one.balance), 0),
    };
  }, [units.data, leases.data, repairs.data]);

  const waiting = units.isPending || leases.isPending || repairs.isPending;

  const needs: WorkItem[] = [
    ...view.urgent.map((one) => ({
      id: `r${text(one.id)}`,
      icon: <Warning />,
      tone: 'critical' as const,
      title: text(one.title),
      detail: `${text(one['unit_id.code'])}, urgent, ${one.assigned_to ? words(one.status) : 'no technician yet'}`,
      value: `reported ${fromNow(one.reported_on) || day(one.reported_on, false)}`,
      href: href.record('repairs', { id: one.id }),
    })),
    ...view.behind.slice(0, 8).map((one) => ({
      id: `l${text(one.id)}`,
      icon: <Receipt />,
      tone: 'warning' as const,
      title: `${text(one['resident_id.name'])} is behind`,
      detail: `${text(one['unit_id.code'])}, ${money(one.rent)} a month`,
      value: `${money(one.balance)} due`,
      ...lease(one.id),
    })),
    ...view.unlisted.map((one) => ({
      id: `u${text(one.id)}`,
      icon: <House />,
      tone: 'info' as const,
      title: `${text(one.code)} is empty and not listed`,
      detail: `${text(one['property_id.name'])}, asking ${money(one.market_rent)}`,
      value: one.available_on ? `free ${day(one.available_on, false)}` : undefined,
      ...home(one.id),
    })),
  ];
  const more = view.behind.length - 8;

  const coming: WorkItem[] = [
    ...view.visits.map((one) => ({
      id: `v${text(one.id)}`,
      icon: <Wrench />,
      title: text(one.title),
      detail: `Visit at ${text(one['unit_id.code'])}`,
      value: `${day(one.scheduled_on, false)}${fromNow(one.scheduled_on) ? `, ${fromNow(one.scheduled_on)}` : ''}`,
      href: href.record('repairs', { id: one.id }),
    })),
    ...view.ending.map((one) => ({
      id: `e${text(one.id)}`,
      icon: <CalendarBlank />,
      title: `${text(one['resident_id.name'])}’s lease ends`,
      detail: `${text(one['unit_id.code'])}${one.status === 'notice' ? ', notice given' : ''}`,
      value: `${day(one.end_on, false)}, ${fromNow(one.end_on)}`,
      ...lease(one.id),
    })),
    ...view.freeing.map((one) => ({
      id: `f${text(one.id)}`,
      icon: <House />,
      title: `${text(one.code)} falls free`,
      detail: text(one['property_id.name']),
      value: `${day(one.available_on, false)}, ${fromNow(one.available_on)}`,
      ...home(one.id),
    })),
  ];

  const lived = view.homes.filter((one) => one.status === 'occupied' || one.status === 'notice').length;

  return (
    <div data-part="lintel-page" data-kind="today">
      <header data-slot="list-head">
        <h2>
          Today <span data-slot="list-count">{said}</span>
        </h2>
      </header>

      <Stats
        loading={waiting}
        items={[
          {
            label: 'Needs you',
            value: needs.length + Math.max(more, 0),
            tone: view.urgent.length ? 'critical' : needs.length ? 'warning' : undefined,
            note: needs.length
              ? `${view.urgent.length} urgent, ${view.behind.length} behind, ${view.unlisted.length} unlisted`
              : 'Nothing is waiting on you',
          },
          {
            label: 'Balance due',
            value: money(view.owed),
            tone: view.owed > 0 ? 'warning' : undefined,
            note: `across ${view.behind.length} of ${view.current.length} leases`,
          },
          {
            label: 'Occupancy',
            value: view.homes.length ? `${Math.round((lived / view.homes.length) * 100)}%` : '0%',
            share: view.homes.length ? lived / view.homes.length : 0,
            note: `${lived} of ${view.homes.length} homes`,
          },
          {
            label: 'Open repairs',
            value: view.open.length,
            note: `${view.open.filter((one) => !one.assigned_to).length} with no technician`,
          },
        ]}
      />

      <div data-part="today-columns">
        <RecordSection title="Needs you" count={waiting ? undefined : needs.length + Math.max(more, 0)}>
          <Worklist loading={waiting} label="What needs the office now" items={needs} empty="Nothing needs you right now." />
          {more > 0 && (
            <a
              href={nav.pageHref('rent-roll')}
              data-slot="more-link"
              data-part="today-more"
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                event.preventDefault();
                nav.openPage('rent-roll');
              }}
            >
              {more} more {more === 1 ? 'lease is' : 'leases are'} behind, on the rent roll
            </a>
          )}
        </RecordSection>
        <RecordSection title="Coming up" count={waiting ? undefined : coming.length}>
          <Worklist loading={waiting} label="What is coming" items={coming} empty="Nothing in the next few weeks." />
        </RecordSection>
      </div>
      <Toaster />
    </div>
  );
}
