import { action, computed, count, machine, max, sum, today } from '@mistriwork/mistri/app';
import type { Resources } from './mistri-schema.d.ts';

/* What Compass says about each resource, once: which it writes, how values
   dress, the column captions every view and form uses, its invariants, the
   New form and the actions a record offers. */

// Resource invariants (preview): the server checks each rule against the
// stored row after every insert and update — the New form, a record Save, a
// fixed action or an API call alike — and rolls the write back when one
// fails. The refusal is one fixed message ("The record does not satisfy the
// application rules.") that names each failing field with another ("This
// value does not meet the application rules."); the rule's own message stays
// here and is not shown.
/** A deal can be lost from any open stage. */
const markLost = { to: 'closed_lost', label: 'Mark lost', confirm: true } as const;

export const resources = {
  lead: {
    segments: {
      new: 'status = new',
      working: 'status = working',
      qualified: 'status = qualified',
      converted: 'status = converted',
      lost: 'status = lost',
    },
    access: 'write',
    // A duplicate or junk lead is removed; an account is never deleted here.
    delete: true,
    favorite: true,
    display: {
      status: { tone: { qualified: 'good', converted: 'good', lost: 'bad', working: 'info', '*': 'neutral' } },
      // A lead reads as a person: initials beside the name, the email under it.
      name: { avatar: true, subtitle: 'email' },
    },
    // An address the rep can write to, said as it is typed and held on every write.
    text: {
      email: { pattern: '[^@\\s]+@[^@\\s]+\\.[^@\\s]+', message: 'Enter an email address, like ana@company.com.' },
    },
    validation: [
      {
        must: 'converted_contact_id is not empty',
        when: 'status = converted',
        message: 'A converted lead names the contact it became.',
      },
    ],
    // The New form says what a lead is and asks in two parts: who, then where
    // they came from, the pairs that are read together side by side in a row
    // (one column on a narrow form). Each input is the column's own — a listbox of sources in
    // their words, a picker of reps, a date that starts today — and the help
    // says what a field is for, or what leaving it empty does.
    form: {
      description: 'Someone who may buy. Work the lead, then qualify it or mark it lost.',
      defaults: { created_on: today },
      groups: [
        { label: 'Person', fields: ['name', ['email', 'phone']] },
        {
          label: 'Lead',
          description: 'Where they came from, and who follows up.',
          fields: ['company', ['source', 'owner_id'], 'created_on'],
        },
      ],
      fields: {
        name: { placeholder: 'First and last name' },
        email: { placeholder: 'name@company.com' },
        phone: { help: 'A new lead is worked by email first.' },
        owner_id: { help: 'The rep who replies within a working day.' },
        created_on: { help: 'Today, unless you are entering an older lead.' },
      },
    },
    actions: {
      startWorking: action('Start working', { set: { status: 'working' }, when: 'status = new' }),
      markQualified: action('Mark qualified', { set: { status: 'qualified' }, when: 'status = working' }),
      markLost: action('Mark lost', {
        set: { status: 'lost' },
        when: 'status != lost and status != converted',
        confirm: true,
      }),
    },
  },
  opportunity: {
    segments: {
      // A deal still in play: neither won nor lost.
      open_pipeline: 'stage != closed_won and stage != closed_lost',
      // Every deal but the lost ones: the funnel's stages and a rep's deals, won ones included.
      not_lost: 'stage != closed_lost',
      closing_soon: 'close_date = next 90 days and stage != closed_won and stage != closed_lost',
      won: 'stage = closed_won',
      lost: 'stage = closed_lost',
    },
    access: 'write',
    delete: true,
    favorite: true,
    display: {
      weighted: { format: 'money' },
      // The people working the deal, as a stack of their initials.
      team: { format: 'avatars' },
      // A probability is set along its range in steps of five, rather than typed.
      probability: { format: 'percent', bar: true, slider: { min: 0, max: 100, step: 5 } },
      stage: {
        tone: { closed_won: 'good', closed_lost: 'bad', negotiation: 'info', proposal: 'info', '*': 'neutral' },
        values: { closed_won: 'Won', closed_lost: 'Lost' },
      },
    },
    // What the deal page sums up: its quote and the work logged against it.
    rollups: {
      lines: count('opportunity_line'),
      units: sum('opportunity_line', 'qty'),
      activities: count('activity'),
      open_tasks: count('task', { query: 'open' }),
    },
    // The deal's amount at its odds: a number of the row's own, summed under the list as a stored one is.
    computed: { weighted: computed.number('amount * probability / 100') },
    labels: {
      name: 'Opportunity',
      probability: 'Prob. %',
      lines: 'Quote lines',
      units: 'Units quoted',
    },
    validation: [
      {
        must: 'close_date >= created_on',
        message: 'A deal cannot close before it was created.',
      },
      {
        must: 'probability = 100',
        when: 'stage = closed_won',
        message: 'A won deal is at 100% probability.',
      },
    ],
    // The road a deal travels. Each stage's verbs are its buttons, in this
    // order; the page's stepper and the pipeline board's lanes read it; and
    // the server refuses any other change of stage, through a form, the API
    // or an import alike. Won sets the probability the rule above asks for.
    machine: machine('stage', {
      prospecting: { on: { qualify: 'qualification', markLost } },
      qualification: { on: { sendProposal: { to: 'proposal', label: 'Send proposal' }, markLost } },
      // `{to}` is the stage the verb leads to, in the stage's own words: "Move to Negotiation".
      proposal: { on: { negotiate: { to: 'negotiation', label: 'Move to {to}' }, markLost } },
      negotiation: { on: { markWon: { to: 'closed_won', label: 'Mark won', set: { probability: 100 } }, markLost } },
      closed_won: { final: true },
      closed_lost: { final: true },
    }),
    form: {
      defaults: { probability: 10 },
      // Groups are presentation: the New form reads in two parts without
      // changing which columns are written or required — `created_on` is
      // NOT NULL with no default, so it is shown, as on the Leads form.
      groups: [
        { label: 'Deal', fields: ['name', 'account_id', 'owner_id', 'created_on'] },
        { label: 'Forecast', fields: ['amount', 'probability', 'close_date'] },
      ],
    },
  },
  account: {
    segments: {
      hot: 'rating = hot',
      in_play: 'open_deals > 0',
      new_this_quarter: 'created_on = last 3 months',
    },
    favorite: true,
    // Its open deals, read like columns: shown, sorted and filtered in the
    // accounts list, computed from the opportunities in the same statement.
    rollups: {
      open_deals: count('opportunity', { query: 'open_pipeline' }),
      open_pipeline: sum('opportunity', 'amount', { query: 'open_pipeline' }),
      won_value: sum('opportunity', 'amount', { query: 'stage = closed_won' }),
      open_tasks: count('task', { query: 'open' }),
    },
    labels: {
      name: 'Account',
      won_value: 'Won',
    },
  },
  contact: {
    segments: {
      primary_contacts: 'is_primary = true',
    },
    access: 'write',
    // How much this person has been talked to, and when last.
    rollups: {
      conversations: count('activity'),
      minutes_logged: sum('activity', 'minutes'),
      last_contacted: max('activity', 'happened_on'),
    },
    display: { minutes_logged: { unit: 'min' } },
    labels: {
      is_primary: 'Primary',
      minutes_logged: 'Time spent',
    },
  },
  task: {
    segments: {
      overdue: 'status = open and due_on < today',
      due_this_week: 'status = open and due_on = next 7 days',
      open: 'status = open',
      done: 'status = done',
    },
    access: 'write',
    display: {
      status: { tone: { open: 'warn', done: 'good' } },
      priority: { tone: { '>= 3': 'bad', '>= 2': 'warn' } },
    },
    labels: {
      subject: 'Task',
      is_urgent: 'Urgent',
    },
    // A task's deal is one of its account's: once an account is chosen, the
    // deal picker offers only that account's opportunities.
    form: {
      show: ['subject', 'account_id', 'opportunity_id', 'owner_id', 'due_on', 'priority', 'is_urgent', 'created_on'],
      defaults: { created_on: today },
      fields: {
        opportunity_id: {
          where: { account_id: 'account_id' },
          help: "Only the chosen account's deals; leave it empty for a task on the account alone.",
        },
        created_on: { help: 'Today, unless you are entering an older task.' },
      },
    },
    actions: { markDone: action('Mark done', { set: { status: 'done' }, when: 'status = open' }) },
  },
  activity: {
    segments: {
      last_30_days: 'happened_on = last 30 days',
      calls: 'kind = call',
      meetings_demos: { query: 'kind = meeting or kind = demo', label: 'Meetings & demos' },
    },
    access: 'write',
    labels: {
      happened_on: 'When',
      'owner_id.name': 'Rep',
    },
  },
  campaign: {
    segments: {
      running: 'starts_on <= today and ends_on >= today',
      upcoming: 'starts_on > today',
      finished: 'ends_on < today',
    },
    labels: { name: 'Campaign' },
  },
  product: {
    segments: {
      active: 'is_active = true',
    },
    labels: { name: 'Product', is_active: 'Active' },
  },
  sales_rep: {
    segments: {
      amer: { query: 'region = amer', label: 'AMER' },
      emea: { query: 'region = emea', label: 'EMEA' },
      apac: { query: 'region = apac', label: 'APAC' },
    },
    // A rep's name wears their initials wherever it is said: owner, rep, manager.
    display: { name: { avatar: true } },
  },
  /* The rest of what the rooms read — an account's industry, a campaign's
     members, a deal's lines. An App serves only what it declares, so these
     are named even with little more to say about them. */
  industry: {},
  campaign_member: {},
  opportunity_line: {},
} satisfies Resources;
