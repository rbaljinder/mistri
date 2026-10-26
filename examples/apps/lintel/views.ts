import { calendar, cards, commandForm, gantt, listView, queue, step } from '@mistriwork/mistri/app';
import type { Views } from './mistri-schema.d.ts';
import { lintelLanding } from './landing.ts';

/* Every room of Lintel but the two dashboards (dashboards.ts); navigation.ts
   arranges them. Column captions are the resources' (resources.ts), so a view
   names columns and paths only. */

const OFFICE = ['leasing', 'manager', 'admin'];

/* A home as the listings and the front page draw it: the building's photo, the
   headline, the asking rent large, and one quiet line of facts. */
export const homeCard = cards('headline', {
  value: 'market_rent',
  badge: 'code',
  facts: ['bedrooms', 'bathrooms', 'sqft', 'property_id.name'],
  image: { about: 'property_id', from: 'property_photo', whose: 'property_id', sort: 'position' },
});

export const views = {
  /* ---------- the public side ---------- */
  welcome: lintelLanding,
  // What is to let, as cards, refined from a rail: /listings?bedrooms=2&market_rent=..200000.
  listings: listView('Homes to let', 'unit', {
    icon: 'house',
    query: 'advertised',
    presentation: homeCard,
    filterBar: 'rail',
    filters: ['property_id', 'bedrooms', 'market_rent'],
    sort: [
      { label: 'Available soonest', sort: 'available_on' },
      { label: 'Lowest rent', sort: 'market_rent' },
      { label: 'Most space', sort: 'sqft desc' },
    ],
    empty: { title: 'Every home is let', description: 'Nothing is free right now. Ask the office to hear first when one is.' },
  }),
  'request-viewing': commandForm('Ask for a viewing', 'requestViewing', {
    public: true,
    description: 'Pick a day and the leasing office confirms a time by email, usually the same day.',
    submitLabel: 'Ask for a viewing',
    done: { title: 'Viewing requested', description: 'Keep this reference: the office quotes it when it writes back.' },
    prefillable: ['code', 'preferred_on'],
  }),

  /* ---------- leasing ---------- */
  // The rent roll, kept in place: an asking rent, a listing, a date is an edit in the grid.
  units: listView('Rent roll', 'unit', {
    icon: 'buildings',
    roles: OFFICE,
    show: ['code', 'property_id', 'bedrooms', 'sqft', 'market_rent', 'rent_per_sqft', 'status', 'resident', 'available_on', 'listed'],
    editable: ['market_rent', 'available_on', 'listed'],
    filters: ['property_id', 'bedrooms', 'status'],
    totals: ['market_rent'],
    tabs: [
      { label: 'All', sort: 'code' },
      { segment: 'vacant', sort: 'available_on' },
      { segment: 'turnover', sort: 'available_on' },
      { segment: 'on_notice', sort: 'available_on' },
      { segment: 'advertised', sort: 'available_on' },
    ],
  }),
  leases: listView('Leases', 'lease', {
    icon: 'file-text',
    roles: [...OFFICE, 'accountant'],
    show: ['unit_id', 'resident_id', 'status', 'start_on', 'end_on', 'rent', 'balance'],
    filters: ['status', 'end_on', 'unit_id.property_id'],
    totals: ['rent', 'balance'],
    tabs: [
      { segment: 'current', sort: 'end_on' },
      { segment: 'ending_soon', sort: 'end_on' },
      { segment: 'notice_given', sort: 'end_on' },
      { segment: 'drafts', sort: 'start_on' },
      { segment: 'past', sort: 'end_on desc' },
    ],
  }),
  // Who lives where, and for how long: each building's leases as bars, the turnovers the gaps between them.
  occupancy: listView('Occupancy', 'lease', {
    icon: 'calendar',
    roles: OFFICE,
    query: 'status != ended or end_on = last 90 days',
    presentation: gantt('start_on', 'end_on', 'unit_id', { by: 'unit_id.property_id' }),
  }),
  residents: listView('Residents', 'resident', {
    icon: 'users',
    roles: [...OFFICE, 'accountant'],
    show: ['name', 'email', 'phone', 'language', 'balance', 'open_requests', 'since'],
    filters: ['language', 'email_ok'],
    sort: 'name',
  }),
  viewings: listView('Viewings', 'viewing', {
    icon: 'calendar-check',
    roles: OFFICE,
    presentation: calendar('preferred_on', 'name', { lines: ['unit_id'], badge: 'status' }),
    filters: ['status', 'unit_id'],
  }),

  /* ---------- the ledger ---------- */
  ledger: listView('Charges', 'charge', {
    icon: 'receipt',
    roles: ['manager', 'admin', 'accountant'],
    show: ['description', 'lease_id', 'kind', 'due_on', 'amount', 'status', 'paid_on'],
    filters: ['kind', 'status', 'period', 'due_on'],
    totals: ['amount'],
    rowActions: true,
    tabs: [
      { segment: 'overdue', sort: 'due_on' },
      { segment: 'unpaid', sort: 'due_on' },
      { segment: 'late_fees', sort: 'due_on desc' },
      { label: 'All', sort: 'due_on desc' },
    ],
  }),
  /* The rent poster posts each month's rent by itself (jobs.ts); the books post it by hand when a month is late or a
     lease was signed after the first. Posting twice posts nothing new. */
  'post-rent': commandForm('Post rent', 'postRent', {
    description: 'Charges every current lease its rent for the month, once. The rent poster does this at 6 a.m. on the first.',
    submitLabel: 'Post rent',
  }),
  payments: listView('Payments', 'payment', {
    icon: 'bank',
    roles: ['manager', 'admin', 'accountant'],
    show: ['reference', 'lease_id', 'received_on', 'amount', 'method'],
    filters: ['method', 'received_on'],
    totals: ['amount'],
    sort: 'received_on desc',
  }),

  /* ---------- repairs ---------- */
  // The open repairs as lanes of their road; a card moves by the verb that leads there.
  'repair-board': listView('Repair board', 'maintenance_request', {
    icon: 'kanban',
    roles: ['manager', 'admin', 'technician'],
    query: 'outstanding',
    open: 'modal',
    board: {
      by: 'status',
      primary: 'title',
      category: 'category',
      lines: ['unit_id'],
      footer: ['assigned_to', { column: 'reported_on', icon: 'clock' }],
    },
    filters: ['assigned_to', 'priority', 'unit_id.property_id'],
  }),
  repairs: listView('Repairs', 'maintenance_request', {
    icon: 'wrench',
    roles: [...OFFICE, 'technician'],
    show: ['title', 'unit_id', 'category', 'priority', 'status', 'assigned_to', 'reported_on', 'scheduled_on'],
    filters: ['status', 'category', 'priority', 'assigned_to', 'unit_id.property_id'],
    // The office works a repair by talking: the queue beside the one picked, its conversation drawn whole with its
    // verbs in the head, where a grid would have a row menu.
    split: { row: { primary: 'title', lines: ['unit_id'], badge: 'status' } },
    tabs: [
      { segment: 'to_triage', sort: 'reported_on' },
      { segment: 'urgent', sort: 'reported_on' },
      { segment: 'visits', sort: 'scheduled_on' },
      { segment: 'finished', sort: 'completed_on desc' },
      { label: 'All', sort: 'reported_on desc' },
    ],
  }),
  // A technician's day, on a phone: the visits still to come, soonest first; a visit past its day is one tab over.
  'my-repairs': listView('My visits', 'maintenance_request', {
    icon: 'clipboard-text',
    roles: ['technician'],
    query: 'mine',
    tabs: [
      { segment: 'coming', sort: 'scheduled_on' },
      { segment: 'behind', sort: 'scheduled_on' },
      { label: 'All', sort: 'scheduled_on' },
    ],
    count: true,
    presentation: queue('title', {
      lines: ['unit_id'],
      properties: ['scheduled_on', 'priority', 'entry_ok', 'resident_id.phone'],
      openLabel: 'Open repair',
    }),
    empty: { title: 'Nothing booked for you', description: 'Visits the office books for you appear here.' },
  }),
  parts: listView('Storeroom', 'part', {
    icon: 'package',
    roles: ['manager', 'admin', 'technician'],
    show: ['sku', 'name', 'category', 'on_hand', 'reorder_at', 'bin', 'unit_cost', 'used'],
    editable: ['reorder_at', 'bin'],
    filters: ['category'],
    tabs: [
      { label: 'All', sort: 'sku' },
      { segment: 'low', sort: 'on_hand' },
    ],
  }),
  deliveries: listView('Parts deliveries', 'part_receipt', {
    icon: 'truck',
    roles: ['manager', 'admin', 'technician'],
    show: ['part_id', 'quantity', 'vendor', 'received_on'],
    sort: 'received_on desc',
  }),

  /* ---------- a resident's own ---------- */
  'my-charges': listView('My charges', 'charge', {
    icon: 'receipt',
    roles: ['resident'],
    show: ['description', 'due_on', 'amount', 'status', 'paid_on'],
    sort: 'due_on desc',
    filterBar: 'none',
    tabs: [
      { segment: 'unpaid', sort: 'due_on' },
      { label: 'All', sort: 'due_on desc' },
    ],
  }),
  'my-requests': listView('My repairs', 'maintenance_request', {
    icon: 'wrench',
    roles: ['resident'],
    show: ['title', 'status', 'reported_on', 'scheduled_on', 'assigned_to'],
    sort: 'reported_on desc',
    filterBar: 'none',
    empty: {
      title: 'No repairs yet',
      description: 'Something not working? Report it and the office books a visit.',
      action: { label: 'Report a problem', to: 'report' },
    },
  }),
  // Three short questions at a time, a visit window asked only of someone who wants to be home for it.
  report: commandForm(
    'Report a problem',
    'reportIssue',
    [
      step('The problem', ['title', 'category'], { title: 'What’s wrong?', lead: 'Pick the closest kind; the office reads the rest.' }),
      step('Details', ['description', 'urgent'], { title: 'Tell us more' }),
      step('A visit', ['entry_ok', ['visit_on', 'visit_window']], { title: 'How should we visit?', next: 'Review' }),
    ],
    {
      style: 'intake',
      note: { icon: 'warning', text: 'For a gas smell or a flood, call (303) 555-0100 first, day or night.' },
      submitLabel: 'Send report',
      done: { title: 'Report sent', description: 'The office will be in touch about a visit.' },
    },
  ),
} satisfies Views;
