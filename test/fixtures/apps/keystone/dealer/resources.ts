import { action, count, max, min } from '@mistriwork/mistri/app';
import type { Resources } from './mistri-schema.d.ts';

/* What the dealer's settings App says about each table, once. Every row here
   is one of the signed-in manager's own dealerships': policy.ts scopes the
   dealer by id and every dealer-owned table by dealer_id. The vocabularies
   and tones are SUITE.md's, copied, not imported. */

const usd = { format: 'money' } as const;

export const changeRoleAction = action('Change role', { command: 'changeTeamRole' });
export const deactivateAction = action('Deactivate', { command: 'deactivateTeamMember' });
export const addTeamMemberAction = action('Add a team member', { command: 'addTeamMember' });
export const resources = {
  dealer: {
    /* The dealership as Keystone keeps it. Its contact details and its team
       change only through commands (the dealer is the record "Add a team
       member" is pressed on, and a command's target is always in what it
       writes), so no role saves this row generically. */
    access: 'write',
    noun: 'dealership',
    rollups: {
      listed: count('vehicle', { query: 'status = listed' }),
      pending_sale: count('vehicle', { query: 'status = pending' }),
      team: count('dealer_user', { query: 'status = active' }),
      oldest_listing: min('vehicle', 'listed_on', { query: 'status = listed' }),
      last_visit: max('dealer_visit', 'happened_on'),
    },
    display: {
      status: { tone: { on_hold: 'warn', terminated: 'bad', '*': 'neutral' } },
      reserve_pct: { format: 'percent' },
      monthly_goal: { unit: 'loans/mo' },
      listed: { unit: 'listed' },
      team: { unit: 'people' },
      oldest_listing: { format: 'relative' },
      last_visit: { format: 'relative' },
    },
    labels: {
      name: 'Dealership',
      franchise_make: 'Franchise',
      status: 'Standing with Keystone',
      tier: 'Keystone tier',
      zip: 'ZIP code',
      phone: 'Main phone',
      email: 'Main email',
      reserve_pct: 'Dealer reserve',
      joined_on: 'With Keystone since',
      on_hold_reason: 'Why it is on hold',
      intake_address: 'Apply-link address',
      pending_sale: 'Sale pending',
      last_visit: 'Last Keystone visit',
    },
    actions: {
      addTeamMember: addTeamMemberAction,
      updateDealerContact: action('Update contact details', { command: 'updateDealerContact' }),
    },
  },

  dealer_site: {
    /* The white-labeled website /site draws. Every branding field is the
       manager's to edit in place; going live or dark is an action, and only
       a command, so the published day is always true. */
    access: 'write',
    recordLabel: '{dealer_id.name} website',
    noun: 'website',
    settings: 'Website',
    display: {
      published: { values: { true: 'Live', false: 'Not published' }, tone: { true: 'good', false: 'warn' } },
      show_prices: { values: { true: 'Shown', false: 'Call for price' } },
    },
    labels: {
      dealer_id: 'Dealership',
      published: 'Website',
      about: 'About the dealership',
      logo_text: 'Mark letters',
      custom_domain: 'Web address',
      show_prices: 'Prices',
      contact_email: 'Inquiry email',
      contact_phone: 'Inquiry phone',
      published_on: 'Live since',
    },
    actions: {
      publishWebsite: action('Publish website', { command: 'publishWebsite' }),
      unpublishWebsite: action('Unpublish website', { command: 'unpublishWebsite' }),
    },
  },

  dealer_user: {
    segments: {
      active: 'status = active',
      invited: 'status = invited',
      deactivated: 'status = deactivated',
    },
    // The roster as business data. Who joins, what they may do and who leaves are commands with receipts.
    access: 'write',
    noun: { one: 'team member', many: 'team members' },
    display: {
      name: { avatar: true, subtitle: 'email' },
      status: { tone: { invited: 'info', deactivated: 'neutral', '*': 'neutral' } },
      invited_on: { format: 'relative' },
    },
    labels: {
      dealer_id: 'Dealership',
      phone: 'Mobile',
      invited_on: 'Invited',
      joined_on: 'Joined',
      dealer_account_id: 'Dealer sign-in account',
    },
    actions: {
      changeTeamRole: changeRoleAction,
      deactivateTeamMember: deactivateAction,
    },
  },

  vehicle: {
    segments: {
      listed: 'status = listed',
      in_stock: 'status = in_stock',
      sale_pending: 'status = pending',
      sold: 'status = sold',
      /* Not `featured`: that is the column's name, and a query could not tell the two apart. */
      picks: { query: 'featured = true', label: 'Featured' },
    },
    /* The lot as the public sees it on /site and the marketplace. The price,
       the featured flag and the listing's words are edited in place; whether
       it is on the market changes only through its listing commands. */
    access: 'write',
    recordLabel: '{year} {make} {model} {trim}',
    noun: 'vehicle',
    actions: {
      listForSale: action('List for sale', { command: 'listForSale' }),
      takeOffTheMarket: action('Take off the market', { command: 'takeOffTheMarket' }),
    },
    display: {
      cost: usd,
      list_price: usd,
      est_payment: { format: 'money', unit: '/mo' },
      mileage: { unit: 'mi' },
      status: { tone: { listed: 'good', pending: 'info', sold: 'neutral', wholesale: 'neutral', '*': 'neutral' } },
      body: { values: { suv: 'SUV' } },
      drivetrain: { values: { fwd: 'FWD', rwd: 'RWD', awd: 'AWD', '4wd': '4WD' } },
      condition: { values: { certified: 'Certified pre-owned' } },
      featured: { values: { true: 'Featured', false: 'Not featured' } },
      features: { format: 'items' },
      listed_on: { format: 'relative' },
    },
    labels: {
      dealer_id: 'Dealership',
      vin: 'VIN',
      drivetrain: 'Drive',
      exterior_color: 'Exterior',
      interior_color: 'Interior',
      cost: 'Our cost',
      list_price: 'Price',
      est_payment: 'Advertised payment',
      received_on: 'Received',
      listed_on: 'Listed',
      sold_on: 'Sold',
    },
  },

  vehicle_photo: {
    // Download only: uploads are off under a row policy (SUITE.md, gap G8), so the studio's photos are Keystone's seed.
    recordLabel: 'caption',
    file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size', thumbnail: 'thumbnail' },
  },

  lead: {
    /* Counted on the overview and listed under a car; the desk that works
       them is /leads. The saved-form columns belong to the server. */
    recordLabel: '{first_name} {last_name}',
    noun: 'lead',
    fields: {
      read: ['id', 'dealer_id', 'reference', 'source', 'status', 'first_name', 'last_name', 'vehicle_id', 'salesperson_id', 'created_at'],
    },
    display: {
      source: { values: { walk_in: 'Walk-in' } },
      status: { tone: { new: 'info', desking: 'info', submitted: 'info', sold: 'good', lost: 'neutral', '*': 'neutral' } },
      created_at: { format: 'relative' },
    },
    labels: {
      dealer_id: 'Dealership',
      reference: 'Lead',
      created_at: 'Came in',
    },
  },

  dealer_visit: {
    // Keystone's side of the relationship: who came, when, and what was agreed.
    recordLabel: 'summary',
    noun: 'Keystone visit',
    display: { kind: { values: { review: 'Business review' } } },
    labels: {
      dealer_id: 'Dealership',
      lender_user_id: 'From Keystone',
      happened_on: 'Date',
      summary: 'What was covered',
    },
  },

  // Named on a dealership and a visit: the person at Keystone, never their account.
  lender_user: {
    noun: { one: 'Keystone contact', many: 'Keystone contacts' },
    fields: { read: ['id', 'name', 'email', 'title'] },
  },

  // Keystone's rate sheet, the same for every dealer.
  program: {
    noun: 'program',
    fields: {
      read: [
        'id',
        'code',
        'name',
        'tier',
        'min_score',
        'max_ltv_pct',
        'max_term',
        'max_vehicle_age',
        'max_mileage',
        'base_apr',
        'max_amount',
        'advertised',
        'active',
        'description',
      ],
    },
    display: {
      base_apr: { format: 'percent' },
      max_amount: usd,
      max_ltv_pct: { format: 'percent' },
      max_term: { unit: 'months' },
      max_vehicle_age: { unit: 'years' },
      max_mileage: { unit: 'mi' },
      advertised: { values: { true: 'On the marketplace', false: 'Dealer only' } },
    },
    labels: {
      name: 'Program',
      tier: 'Credit tier',
      min_score: 'Lowest score',
      max_ltv_pct: 'Highest LTV',
      max_term: 'Longest term',
      max_vehicle_age: 'Oldest vehicle',
      max_mileage: 'Most miles',
      base_apr: 'Rate from',
      max_amount: 'Up to',
      description: 'About',
    },
  },
} satisfies Resources;
