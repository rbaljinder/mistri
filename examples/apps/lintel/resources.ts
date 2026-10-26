import { action, computed, count, latest, machine, sum, today } from '@mistriwork/mistri/app';
import type { Resources } from './mistri-schema.d.ts';

/* What Lintel says about each table, once, wherever its records appear: how
   values dress, what each caption reads, the verbs a record offers and the
   road a lease, a charge and a repair travel. Who may do what is app.ts's;
   which rows a resident reaches is policy.ts's.

   Money is whole cents in the database (examples/databases/lintel/schema.mjs),
   so every amount is drawn as dollars from its minor units: a ledger that
   never rounds. */
const dollars = { format: 'money', minor: true } as const;
/* A repair called off, from any state before the work starts: the desk's command, which asks why and keeps it. */
const cancel = { to: 'cancelled', label: 'Cancel request' } as const;
const cancelViewing = { to: 'cancelled', label: 'Cancel', confirm: true } as const;
/* Waiting on a part, or on an answer from the resident. */
const hold = { to: 'on_hold', label: 'Put on hold' } as const;

export const resources = {
  /* ---------- the buildings ---------- */
  property: {
    access: 'write',
    recordLabel: 'name',
    rollups: {
      homes: count('unit'),
      vacant: count('unit', { query: 'available' }),
      open_repairs: count('maintenance_request', { whose: 'unit_id.property_id', query: 'outstanding' }),
    },
    labels: { year_built: 'Built', manager_id: 'Property manager' },
  },
  // Two street views of each building, drawn by the seed: the bytes beside their name, type and size.
  property_photo: {
    access: 'write',
    delete: true,
    noun: 'photo',
    file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size', thumbnail: 'thumbnail', maxBytes: 4_000_000 },
    labels: { position: 'Order', file_name: 'File', byte_size: 'Size' },
  },
  unit: {
    segments: {
      occupied: 'status = occupied',
      on_notice: 'status = notice',
      vacant: 'status = vacant',
      turnover: 'status = turnover',
      available: 'status = vacant or status = turnover',
      advertised: 'listed = true',
    },
    access: 'write',
    recordLabel: '{property_id.name} #{number}',
    noun: 'home',
    computed: { rent_per_sqft: computed.number('market_rent / sqft') },
    rollups: {
      open_repairs: count('maintenance_request', { query: 'outstanding' }),
      resident: latest('lease', 'resident_id', { query: "status != 'ended' and status != 'draft'", sort: 'start_on' }),
    },
    display: {
      market_rent: dollars,
      // Cents a square foot, said as dollars.
      rent_per_sqft: { format: 'money', minor: true, unit: '/sq ft' },
      // A studio has no bedroom to count: said as the word a listing uses, not "0 bd".
      bedrooms: { values: { 0: 'Studio' } },
      status: {
        // A vacant home is income to chase, not an alarm: warning, with the notice and turnover ahead of it in info.
        tone: { occupied: 'good', notice: 'info', vacant: 'warn', turnover: 'info' },
        values: { notice: 'On notice' },
      },
    },
    labels: {
      number: 'Home',
      property_id: 'Building',
      market_rent: 'Asking rent',
      rent_per_sqft: 'Per sq ft',
      bedrooms: 'Beds',
      bathrooms: 'Baths',
      sqft: 'Size',
      listed: 'Listed online',
    },
    validation: [
      { must: 'bedrooms <= 4', message: 'Lintel’s homes have at most four bedrooms.' },
      { must: 'listed = false or available_on is not empty', message: 'A listed home says when it is available.' },
    ],
    form: { defaults: { listed: false } },
  },

  /* ---------- the people ---------- */
  resident: {
    access: 'write',
    recordLabel: 'name',
    rollups: {
      balance: sum('charge', 'amount', { whose: 'lease_id.resident_id', query: 'unpaid' }),
      open_requests: count('maintenance_request', { query: 'outstanding' }),
    },
    display: {
      // A resident is a person: their initials beside their name wherever it is said, and large over their record.
      name: { avatar: true },
      balance: { ...dollars, tone: { '> 0': 'warn' } },
      language: { values: { en: 'English', es: 'Spanish' } },
    },
    labels: { email_ok: 'Email updates', since: 'Resident since', balance: 'Balance due' },
  },
  staff: {
    recordLabel: 'name',
  },

  /* ---------- leasing ---------- */
  lease: {
    segments: {
      current: 'status = active or status = notice',
      ending_soon: 'status = active and end_on = next 60 days',
      notice_given: 'status = notice',
      drafts: 'status = draft',
      past: 'status = ended',
    },
    access: 'write',
    recordLabel: '{unit_id.property_id.name} #{unit_id.number}',
    rollups: {
      balance: sum('charge', 'amount', { query: 'unpaid' }),
      charged: sum('charge', 'amount'),
      paid: sum('payment', 'amount'),
    },
    display: {
      rent: dollars,
      deposit: dollars,
      balance: { ...dollars, tone: { '> 0': 'warn' } },
      charged: dollars,
      paid: dollars,
      status: { tone: { draft: 'info', active: 'good', notice: 'warn', ended: 'neutral' }, values: { notice: 'Notice given' } },
    },
    labels: {
      unit_id: 'Home',
      start_on: 'Starts',
      end_on: 'Ends',
      notice_on: 'Notice given',
      balance: 'Balance due',
    },
    /* A lease is written as a draft, signed, given notice on and ended. The
       last step also happens by itself: once a notice lease's last day has
       passed, the lease clock ends it (jobs.ts). Each move is a command, since
       each moves the home too. */
    machine: machine('status', {
      draft: { on: { signLease: 'active' } },
      active: { on: { giveNotice: 'notice' } },
      notice: { on: { endLease: 'ended' } },
      ended: { final: true },
    }),
    at: { end_on: { command: 'endLease', when: "status = 'notice'" } },
    actions: { addCharge: action('Add charge', { command: 'addCharge' }) },
    validation: [{ must: 'end_on > start_on', message: 'A lease ends after it starts.' }],
  },

  /* ---------- the ledger ---------- */
  charge: {
    segments: {
      unpaid: 'status = open',
      overdue: 'status = open and due_on < today',
      rent: 'kind = rent',
      late_fees: { query: 'kind = late_fee', label: 'Late fees' },
    },
    access: 'write',
    recordLabel: 'description',
    display: {
      amount: dollars,
      // Critical red is kept for what has failed; a late fee is a charge to watch.
      kind: {
        tone: { rent: 'neutral', late_fee: 'warn', utility: 'info', repair: 'warn', other: 'neutral' },
      },
      status: { tone: { open: 'warn', paid: 'good', waived: 'neutral' } },
    },
    labels: { waived_reason: 'Why waived' },
    // A charge is paid by a payment, recorded by the desk or settled by the processor, or waived with a reason.
    machine: machine('status', {
      open: {
        on: {
          recordPayment: 'paid',
          settleCharge: 'paid',
          waive: { to: 'waived', label: 'Waive', reason: 'waived_reason', confirm: true },
        },
      },
      paid: { final: true },
      waived: { final: true },
    }),
  },
  payment: {
    access: 'write',
    recordLabel: 'reference',
    display: { amount: dollars, method: { values: { ach: 'Bank transfer (ACH)' } } },
  },

  /* ---------- maintenance ---------- */
  maintenance_request: {
    segments: {
      to_triage: 'status = new',
      // Not yet done or called off: every state before the end of the road.
      outstanding: 'status is open',
      visits: 'status is onSite',
      urgent: 'priority = urgent and status is open',
      mine: 'assigned_to = me and status is open',
      // A technician's work list: visits still to come, and the ones whose day has passed with the repair not done.
      coming: 'assigned_to = me and status is open and scheduled_on >= today',
      behind: { query: 'assigned_to = me and status is open and scheduled_on < today', label: 'Past due' },
      finished: 'status is done',
    },
    access: 'write',
    noun: { one: 'repair', many: 'repairs' },
    // The desk's New work order asks for the kind of problem as cards, as the resident's report does.
    form: { fields: { category: { as: 'cards' } } },
    /* A template, read alike by the office and by a resident the row policy scopes: both are served the label, never
       the key (test/row-policy-label-template.test.ts). */
    recordLabel: '{title}',
    rollups: {
      parts_used: sum('request_part', 'quantity'),
    },
    display: {
      category: { values: { hvac: 'Heating and cooling' } },
      status: {
        icons: {
          new: 'envelope',
          triaged: 'tray',
          scheduled: 'calendar',
          in_progress: 'wrench',
          on_hold: 'hourglass',
          completed: 'check-circle',
        },
      },
      assigned_to: { format: 'avatars' },
      entry_ok: { values: { true: 'May let themselves in', false: 'Call first' } },
    },
    labels: {
      unit_id: 'Home',
      assigned_to: 'Technician',
      entry_ok: 'Entry',
      scheduled_on: 'Visit',
    },
    /* A repair's road. A new one is triaged, a visit is booked with a
       technician (a command: it says who and when), the work starts, waits on
       a part or an answer, and is completed with what was done — which tells
       the resident by email, account or not. The groups are the words the desk
       uses: waiting, on site, done. */
    machine: machine(
      'status',
      {
        new: {
          on: {
            triage: { to: 'triaged', label: 'Triage' },
            assignTechnician: 'triaged',
            scheduleVisit: 'scheduled',
            cancelRequest: cancel,
          },
        },
        triaged: { on: { assignTechnician: 'triaged', scheduleVisit: 'scheduled', cancelRequest: cancel } },
        scheduled: {
          on: { start: { to: 'in_progress', label: 'Start work' }, scheduleVisit: 'scheduled', hold, cancelRequest: cancel },
        },
        in_progress: { on: { completeRequest: 'completed', hold } },
        on_hold: { on: { resume: { to: 'in_progress', label: 'Resume' }, cancelRequest: cancel } },
        completed: { on: { close: { to: 'closed', label: 'Close' } } },
        closed: { final: true },
        cancelled: { final: true },
      },
      {
        since: 'status_since',
        groups: { waiting: ['new', 'triaged'], onSite: ['scheduled', 'in_progress', 'on_hold'], done: ['completed', 'closed'] },
      },
    ),
    actions: {
      reply: action('Message the resident', { command: 'replyToResident' }),
      addNote: action('Add an internal note', { command: 'addNote' }),
      messageOffice: action('Message the office', { command: 'messageOffice' }),
    },
    notify: [
      // The technician hears of a visit booked for them, in the App and by email.
      {
        on: { changes: 'assigned_to' },
        when: 'status = scheduled',
        to: 'assigned_to',
        email: true,
        title: 'Visit booked: {title} at {unit_id.number}',
      },
      /* The resident hears the repair is done by email, whether or not they have an account: the address on their
         record, only while they agreed to mail (email_ok), with a one-click unsubscribe at its foot. */
      {
        on: { changes: 'status' },
        when: 'status = completed',
        send: { channel: 'email', to: 'resident_id.email', consent: 'resident_id.email_ok' },
        title: 'Your repair is done: {title}',
      },
    ],
  },
  /* A part used on a repair takes it off the storeroom's shelf, and a receipt puts it back: the balance moves on every
     door — a Save, an import, a command — and a take past zero refuses the whole write. */
  request_part: {
    access: 'write',
    delete: true,
    noun: 'part used',
    recordLabel: '{part_id.name}',
    consumes: { column: 'part_id.on_hand', by: 'quantity', message: 'Only {part_id.on_hand} of {part_id.name} left in the storeroom' },
    // Read through the line's reference: parts are logged while the technician is on site.
    validation: [
      {
        must: 'request_id.status in (scheduled, in_progress, on_hold)',
        message: 'Parts are logged while the repair is scheduled or in progress.',
      },
    ],
    labels: { request_id: 'Repair' },
    form: { defaults: { quantity: 1, used_on: today } },
  },
  request_note: {
    access: 'write',
    noun: 'message',
    display: { kind: { values: { internal: 'Internal note' }, tone: { internal: 'warn', staff: 'info', resident: 'neutral' } } },
  },
  part: {
    // Low by the shelf's own floor: each part's reorder point, which the storeroom edits in the list.
    segments: { low: 'on_hand <= reorder_at', out: 'on_hand = 0' },
    access: 'write',
    // A supplier's catalog arrives as a spreadsheet: new SKUs are imported, never typed.
    import: true,
    recordLabel: 'name',
    rollups: { used: sum('request_part', 'quantity'), received: sum('part_receipt', 'quantity') },
    display: {
      unit_cost: dollars,
      on_hand: { format: 'number', tone: { '= 0': 'bad', '<= 2': 'warn' } },
      category: { values: { hvac: 'Heating and cooling' } },
    },
  },
  part_receipt: {
    access: 'write',
    noun: 'delivery',
    recordLabel: '{part_id.name} from {vendor}',
    restocks: { column: 'part_id.on_hand', by: 'quantity', message: 'Only {part_id.on_hand} of {part_id.name} are still on the shelf' },
    // Read off the packing slip in pairs: what came and how many, then when and from whom. A row is side by side.
    form: {
      show: [
        ['part_id', 'quantity'],
        ['received_on', 'vendor'],
      ],
      defaults: { received_on: today },
    },
  },

  /* ---------- the public side ---------- */
  viewing: {
    segments: { upcoming: 'status = requested or status = confirmed', past: 'status = completed or status = cancelled' },
    access: 'write',
    recordLabel: 'name',
    display: { status: { tone: { requested: 'info', confirmed: 'good', completed: 'neutral', cancelled: 'neutral' } } },
    labels: { unit_id: 'Home', preferred_on: 'Preferred day' },
    /* A visitor's ask, confirmed for a time and then shown, or called off. Written first by the public form, and
       moved after by the office's verbs. */
    machine: machine('status', {
      requested: { on: { confirm: { to: 'confirmed', label: 'Confirm' }, cancelViewing } },
      confirmed: { on: { markShown: { to: 'completed', label: 'Mark shown' }, cancelViewing } },
      completed: { final: true },
      cancelled: { final: true },
    }),
  },
} satisfies Resources;
