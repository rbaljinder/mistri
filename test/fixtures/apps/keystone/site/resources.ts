import type { Resources } from './mistri-schema.d.ts';

/* What the website says about each table, once, wherever its rows appear.
   Everything a visitor reads is read-only; the three tables the forms write
   (a lead, its applicant, the first line of its timeline) are written only by
   the public commands (commands.ts), and no role reads them here: the dealer
   answers in /leads. */
export const resources = {
  vehicle: {
    segments: {
      new: 'condition = new',
      pre_owned: { query: 'condition in (used, certified)', label: 'Pre-owned' },
      under_20_000: { query: 'list_price < 20000', label: 'Under $20,000' },
    },
    // What a car is called everywhere it is named: "2024 Ford Explorer ST-Line".
    recordLabel: '{year} {make} {model} {trim}',
    display: {
      list_price: { format: 'money' },
      // A card's and the price card's second figure: "$694/mo", on the terms the page's note gives.
      est_payment: { format: 'money', unit: '/mo' },
      mileage: { unit: 'mi' },
      // One feature a line in the database; a list on the page.
      features: { format: 'items' },
      // A buyer scans for what is still for sale; a car on hold says so.
      status: {
        tone: { listed: 'good', pending: 'info', '*': 'neutral' },
        values: { listed: 'Available', pending: 'Sale pending', in_stock: 'Arriving soon' },
      },
      condition: {
        tone: { new: 'info', certified: 'good', '*': 'neutral' },
        values: { certified: 'Certified pre-owned', used: 'Pre-owned' },
      },
      body: { values: { suv: 'SUV' } },
      drivetrain: { values: { fwd: 'Front-wheel drive', rwd: 'Rear-wheel drive', awd: 'All-wheel drive', '4wd': 'Four-wheel drive' } },
      listed_on: { format: 'relative' },
    },
    labels: {
      list_price: 'Price',
      est_payment: 'Est. payment',
      mileage: 'Miles',
      vin: 'VIN',
      exterior_color: 'Exterior',
      interior_color: 'Interior',
      drivetrain: 'Drive',
      listed_on: 'Listed',
      'dealer_id.city': 'Location',
    },
  },
  // The studio photos: the bytes beside their name, type and size, and a small copy a card draws.
  vehicle_photo: {
    recordLabel: '{caption}',
    file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size', thumbnail: 'thumbnail' },
  },
  dealer: {
    labels: { street: 'Address', zip: 'ZIP code' },
  },
  // The dealer's website settings, written in /dealer; here, the words and colors the site wears.
  dealer_site: {
    recordLabel: '{headline}',
    labels: { contact_phone: 'Call us', contact_email: 'Email us' },
  },
  // Keystone's rate sheet; the site shows the advertised programs.
  program: {
    display: {
      base_apr: { format: 'percent' },
      max_term: { unit: 'months' },
      max_amount: { format: 'money' },
      tier: { values: { super_prime: 'Excellent credit', prime: 'Good credit', near_prime: 'Fair credit', subprime: 'Rebuilding credit' } },
    },
    labels: { base_apr: 'Rates from', max_term: 'Terms up to', max_amount: 'Loans up to', tier: 'For' },
  },
  // The forms' ceilings. Commands write them; no role reads or writes them here.
  lead: { access: 'write' },
  applicant: { access: 'write' },
  lead_activity: { access: 'write' },
} satisfies Resources;
