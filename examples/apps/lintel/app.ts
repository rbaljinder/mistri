import { defineApp } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';
import { portal, today } from './dashboards.ts';
import { navigation } from './navigation.ts';
import { resources } from './resources.ts';
import { blueprint, hearth, lintel, tidelight } from './theme.ts';
import { views } from './views.ts';

/* Lintel: a property company's three Denver buildings, run from one App by
   two audiences. The office lets homes, keeps the ledger and fixes things;
   residents sign in to the same App and see only their own household (the
   row policy, policy.ts). The public browses what is to let and asks for a
   viewing. Record pages are found by file (pages/). authority.lock beside this
   file records every grant, and `mistri check` fails the moment that changes. */

const repairs = ['replyToResident', 'addNote'] as const;
const leasing = {
  label: 'Leasing',
  read: true,
  // The rent roll, the people and the viewings; a lease moves only by its commands.
  write: ['unit', 'resident', 'viewing', 'property_photo'],
  // Homes are built, not created at the desk: the rent roll is edited, never added to.
  create: ['resident', 'viewing', 'property_photo'],
  commands: ['signLease', 'giveNotice', 'endLease', ...repairs],
  // A home's status is its lease's to move (commands/leasing.ts); the rest of the rent roll is edited in place.
  fields: {
    unit: { write: ['market_rent', 'listed', 'available_on', 'headline', 'description'] },
    // A viewing moves along its verbs; a command's revision column (`version`) is never edited in place.
    viewing: { write: ['status', 'preferred_on', 'unit_id', 'phone', 'message'] },
  },
} as const;
const manager = {
  label: 'Manager',
  extends: 'leasing',
  // Repairs and the storeroom too: a part used or received moves the shelf (resources.ts `consumes`).
  write: ['maintenance_request', 'request_part', 'part', 'part_receipt', 'property'],
  commands: ['assignTechnician', 'scheduleVisit', 'completeRequest', 'cancelRequest', 'postRent', 'recordPayment', 'addCharge'],
  actions: { charge: ['waive'] },
  /* A repair is filed and moved along its road in place; who goes and when is booked by scheduleVisit, what was done is
     said by completeRequest and why one is called off by cancelRequest. Cancel is granted by that command alone, so a
     technician, who moves a repair by its status, is never offered it. */
  fields: {
    maintenance_request: {
      write: ['unit_id', 'resident_id', 'title', 'description', 'category', 'priority', 'status', 'entry_ok', 'reported_on'],
    },
  },
} as const;

export default defineApp({
  id: 'lintel',
  name: 'Lintel',
  // Open pages follow what others change: a repair moved by a technician shows on the office's board as it happens.
  live: true,
  sources: { lintel: { connection: 'lintel' } },
  resources,
  auth: {
    rows: 'policy',
    providers: ['email'],
    // `assigned_to = me` reads the signed-in person's staff row.
    me: { from: 'staff', column: 'email' },
    roles: {
      leasing,
      manager,
      // The account a first start bootstraps (MISTRI_AUTH_ADMIN_EMAIL): a manager who also runs the workflows room.
      admin: { label: 'Admin', extends: 'manager', operations: ['workflows'] },
      /* A technician reads the buildings, how to reach the residents, who lives where and the repairs, and works the
         repairs and the storeroom. Never the ledger: no rent, deposits, charges or payments. */
      technician: {
        label: 'Technician',
        read: [
          'property',
          'property_photo',
          'unit',
          'resident',
          'staff',
          'lease',
          'maintenance_request',
          'request_part',
          'request_note',
          'part',
          'part_receipt',
        ],
        write: ['maintenance_request', 'request_part', 'part_receipt'],
        create: ['request_part', 'part_receipt'],
        commands: ['completeRequest', ...repairs],
        fields: {
          resident: { read: ['id', 'name', 'email', 'phone', 'language'] },
          lease: { read: ['id', 'unit_id', 'resident_id', 'start_on', 'end_on', 'status'] },
          // Moves its repairs along the road (Start, Hold, Resume, Close); who and when is the desk's to book.
          maintenance_request: { write: ['status'] },
        },
      },
      // The books: charges, payments and the month's rent. Repairs are read (what a resident has open), never worked.
      accountant: {
        label: 'Accountant',
        read: ['property', 'property_photo', 'unit', 'resident', 'staff', 'lease', 'charge', 'payment', 'maintenance_request'],
        export: ['charge', 'payment'], // the ledger leaves as a file through the books alone
        commands: ['postRent', 'recordPayment', 'addCharge'],
        actions: { charge: ['waive'] },
      },
      /* A resident: their own household, by the row policy. They report a problem and write on their own repairs;
         of the office they read who is coming, never an address book. */
      resident: {
        label: 'Resident',
        read: [
          'property',
          'property_photo',
          'unit',
          'resident',
          'staff',
          'lease',
          'charge',
          'payment',
          'maintenance_request',
          'request_note',
          'request_part',
          'part',
        ],
        commands: ['reportIssue', 'messageOffice'],
        // What went into their repair, by name; never what the storeroom paid or holds.
        fields: { staff: { read: ['id', 'name', 'title'] }, part: { read: ['id', 'name'] } },
      },
      // The jobs module's services (jobs.ts), each named by the policy and given its rows there.
      rent_poster: { label: 'Rent poster', service: true, read: ['lease', 'charge'], commands: ['postRent', 'assessLateFees'] },
      // Reads what the routing decision asks from and the technicians it may name (jobs.ts).
      repair_triage: {
        label: 'Repair triage',
        service: true,
        read: ['maintenance_request', 'unit', 'property', 'staff'],
        commands: ['assignTechnician'],
      },
      lease_clock: { label: 'Lease clock', service: true, read: ['lease', 'unit'], commands: ['endLease'] },
      processor: { label: 'Payment processor', service: true, read: ['lease', 'charge', 'payment'], commands: ['settleCharge'] },
    },
    // Signed out: the buildings, their photos and what a listing says of a home. Never who lives there.
    public: {
      read: ['property', 'property_photo', 'unit'],
      fields: {
        property: { read: ['id', 'name', 'address', 'city', 'state', 'zip', 'kind', 'year_built', 'description'] },
        unit: {
          read: [
            'id',
            'property_id',
            'number',
            'code',
            'floor',
            'bedrooms',
            'bathrooms',
            'sqft',
            'market_rent',
            'listed',
            'available_on',
            'headline',
            'description',
          ],
        },
      },
    },
  },
  views: { ...views, today, portal },
  home: [
    { view: 'welcome', signedOut: true },
    { view: 'portal', roles: ['resident'] },
    { view: 'my-repairs', roles: ['technician'] },
    { view: 'ledger', roles: ['accountant'] },
    { view: 'today' },
  ],
  nav: navigation,
  ui: {
    logo: 'buildings',
    theme: { preset: 'lintel' },
    customThemes: [lintel, blueprint, hearth, tidelight],
    shell: {
      placement: 'side',
      rail: true,
      counts: true,
      // Every way to start something, by the bell; each person sees the ones their role may make.
      new: [
        { command: 'postRent', label: 'Post this month’s rent', icon: 'receipt' },
        { view: 'repairs', label: 'Repair', icon: 'wrench' },
        { view: 'residents', label: 'Resident', icon: 'user' },
        { view: 'deliveries', label: 'Parts delivery', icon: 'truck' },
      ],
      // The company's name alone: ui.shell.sidebar.footer has no per-role form, so it says nothing a resident should not read.
      sidebar: { footer: { title: 'Lintel Property Co.', description: 'Denver, Colorado' } },
    },
    locale: 'en-US',
    timezone: 'America/Denver',
    currency: 'USD',
  },
} satisfies App);
