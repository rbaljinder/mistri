import { count, min } from '@mistriwork/mistri/app';
import type { Resources } from './mistri-schema.d.ts';

/* What the marketplace says about each table, once, wherever its rows appear:
   how values dress, what each caption reads, and at most what may be done.
   No role writes through ordinary routes. Every change here is a command:
   the two public forms (features/public-forms.ts), a customer's own shortlist,
   inquiries and rate checks, and the marketing desk's Send to dealer. */
export const resources = {
  vehicle: {
    noun: 'car',
    // The ceiling the account commands target (save, inquire, check a rate);
    // no role holds a generic write on a dealer's car.
    access: 'write',
    recordLabel: '{year} {make} {model} {trim}',
    display: {
      list_price: { format: 'money' },
      // A card's "$412/mo": the dealer's advertised payment at 72 months.
      est_payment: { format: 'money', unit: '/mo' },
      mileage: { unit: 'mi' },
      features: { format: 'items' },
      status: { tone: { listed: 'good', pending: 'info', sold: 'neutral', wholesale: 'neutral', in_stock: 'neutral' } },
      body: { values: { suv: 'SUV' } },
      drivetrain: { values: { fwd: 'Front-wheel drive', rwd: 'Rear-wheel drive', awd: 'All-wheel drive', '4wd': 'Four-wheel drive' } },
      condition: { values: { certified: 'Certified pre-owned' } },
      listed_on: { format: 'relative' },
    },
    labels: {
      list_price: 'Price',
      est_payment: 'Est. payment',
      body: 'Body style',
      drivetrain: 'Drive',
      mileage: 'Miles',
      exterior_color: 'Exterior',
      interior_color: 'Interior',
      vin: 'VIN',
      listed_on: 'Listed',
      status: 'Availability',
    },
  },
  // The studio photos: the bytes beside their name, type and size, and a
  // 320-pixel copy the seed renders with each. A gallery draws the photo; a card the copy.
  vehicle_photo: {
    file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size', thumbnail: 'thumbnail' },
  },
  dealer: {
    rollups: {
      for_sale: count('vehicle', { whose: 'dealer_id', query: 'status in (listed, pending)' }),
      from_price: min('vehicle', 'list_price', { whose: 'dealer_id', query: 'status in (listed, pending)' }),
    },
    display: {
      kind: { values: { franchise: 'Franchise dealer', independent: 'Independent dealer' } },
      for_sale: { unit: 'cars' },
      from_price: { format: 'money' },
      status: { tone: { active: 'good', on_hold: 'warn', terminated: 'bad', '*': 'neutral' } },
    },
    labels: { franchise_make: 'Sells new', from_price: 'Prices from', joined_on: 'Keystone dealer since' },
  },
  // The rate sheet. A shared program reads as one: /marketplace/programs/1-keystone-select.
  program: {
    noun: 'rate',
    slug: true,
    display: {
      base_apr: { format: 'percent' },
      max_amount: { format: 'money' },
      max_ltv_pct: { format: 'percent' },
      max_term: { unit: 'months' },
      max_mileage: { unit: 'mi' },
      max_vehicle_age: { unit: 'years' },
      tier: { values: { super_prime: 'Excellent credit', prime: 'Good credit', near_prime: 'Fair credit', subprime: 'Rebuilding credit' } },
    },
    labels: {
      base_apr: 'APR from',
      max_amount: 'Borrow up to',
      max_term: 'Terms up to',
      max_ltv_pct: 'Loan to value up to',
      max_mileage: 'Miles up to',
      max_vehicle_age: 'Model years back',
      min_score: 'Credit score from',
      tier: 'Best for',
    },
  },
  // A customer's own inquiry is a dealer's lead: the account reads it through
  // policy.ts, narrowed in app.ts to the car, the dealer, the state and the dates.
  lead: {
    noun: 'inquiry',
    access: 'write',
    // The customer reads the reference but not the dealer's copy of their name (app.ts's field ceiling).
    recordLabel: 'reference',
    display: {
      status: {
        tone: { new: 'info', contacted: 'info', desking: 'info', submitted: 'info', sold: 'good', lost: 'neutral', '*': 'neutral' },
      },
      source: { values: { walk_in: 'Walk-in' } },
      created_at: { format: 'relative' },
      last_contact_at: { format: 'relative' },
    },
    labels: {
      vehicle_id: 'Car',
      created_at: 'Sent',
      last_contact_at: 'Dealer last replied',
      status: 'Progress',
      message: 'Your message',
    },
  },
  // Written beside a new lead so the dealer's timeline says where it came from; nobody here reads it.
  lead_activity: { access: 'write' },
  prequalification: {
    noun: 'rate check',
    access: 'write',
    recordLabel: '{reference} · {first_name} {last_name}',
    display: {
      status: { tone: { new: 'info', matched: 'good', sent_to_dealer: 'good', no_match: 'neutral', expired: 'neutral' } },
      monthly_income: { format: 'money', unit: '/mo' },
      desired_payment: { format: 'money', unit: '/mo' },
      estimated_amount: { format: 'money' },
      estimated_apr: { format: 'percent' },
      created_at: { format: 'relative' },
    },
    labels: {
      credit_band: 'Credit',
      monthly_income: 'Income',
      desired_payment: 'Payment in mind',
      vehicle_id: 'Car',
      estimated_amount: 'You could borrow',
      estimated_apr: 'APR from',
      created_at: 'Checked',
      lead_id: 'Dealer lead',
      zip: 'ZIP code',
    },
  },
  // The account's shortlist: policy.ts confines it to the verified account.
  saved_vehicle: {
    access: 'write',
    recordLabel: 'vehicle_id',
    display: { saved_at: { format: 'relative' }, status: { tone: { saved: 'good', archived: 'neutral' } } },
    labels: {
      vehicle_id: 'Car',
      saved_at: 'Saved',
    },
  },
} satisfies Resources;
