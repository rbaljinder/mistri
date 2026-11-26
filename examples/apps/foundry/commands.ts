// Foundry Market's business writes, beside its manifest. Server-only.
import {
  defineCommand,
  defineCommands,
  defineSource,
  field,
  literal,
  publicReference,
  publicReferencePattern,
  refuse,
  shape,
  text,
} from '@mistriwork/mistri/commands';

interface FoundryRows {
  seller: { id: number; name: string; city: string; specialty: string; verified: number; bio: string };
  listing: {
    id: number;
    title: string;
    maker: string;
    category: string;
    year_made: number;
    condition: string;
    city: string;
    price_cents: number;
    was_price_cents: number | null;
    status: string;
    seller_id: number;
    description: string;
    provenance: string;
    buyer_name: string | null;
    buyer_email: string | null;
  };
  consignment: {
    id: number;
    seller_name: string;
    seller_email: string;
    item_title: string;
    category: string;
    asking_cents: number;
    notes: string | null;
    status: string;
  };
}

const foundry = defineSource<FoundryRows>('foundry');

/**
 * Unified public + staff machine verb (`live -> reserved`).
 * Guards the single piece atomically via `db.listing.claim()` so concurrent visitors can never double-reserve.
 */
export const reserveListing = defineCommand({
  source: foundry,
  public: true,
  target: 'listing',
  targets: 'one',
  input: {
    buyer_name: field.text({ label: 'Your full name', max: 120 }),
    buyer_email: field.email({ label: 'Email address' }),
  },
  output: shape({
    reference: text({ pattern: publicReferencePattern('HD') }),
    message: literal('48-hour hold confirmed. Our curator will reach out with insured courier details.'),
  }),
  async handle({ db, record }, input) {
    const buyerName = input.buyer_name.trim();
    if (!buyerName) refuse('Please enter your name.', { field: 'buyer_name' });

    const claimed = await db.listing.claim(record, {
      where: { status: 'live' },
      set: { status: 'reserved', buyer_name: buyerName, buyer_email: input.buyer_email },
    });
    if (!claimed) refuse('This piece was just reserved by another buyer.');
    return {
      reference: publicReference('HD'),
      message: '48-hour hold confirmed. Our curator will reach out with insured courier details.',
    };
  },
});

/** Curator verb: release a hold back to live. */
export const releaseHold = defineCommand({
  source: foundry,
  target: 'listing',
  async handle({ db, record }) {
    const claimed = await db.listing.claim(record, {
      where: { status: 'reserved' },
      set: { status: 'live', buyer_name: null, buyer_email: null },
    });
    if (!claimed) refuse('Only a reserved listing can be released back to live.');
  },
});

/** Curator verb: finalize a reserved piece as sold. */
export const markSold = defineCommand({
  source: foundry,
  target: 'listing',
  async handle({ db, record }) {
    const claimed = await db.listing.claim(record, {
      where: { status: 'reserved' },
      set: { status: 'sold' },
    });
    if (!claimed) refuse('Only a reserved listing can be marked sold.');
  },
});

/** Public consignment submission form (`views.consign`). */
export const submitConsignment = defineCommand({
  source: foundry,
  public: true,
  target: 'consignment',
  input: {
    seller_name: field.text({ label: 'Your name or workshop', max: 120 }),
    seller_email: field.email({ label: 'Email address' }),
    item_title: field.text({ label: 'Piece title & year', max: 160 }),
    category: field.choice(['Cameras', 'Furniture', 'Audio', 'Lighting']),
    asking_price: field.money({ label: 'Target asking price (USD)', minor: true, min: 1 }),
    notes: field.textarea({ label: 'Condition & provenance', max: 1000, optional: true }),
  },
  output: shape({
    reference: text({ pattern: publicReferencePattern('FM') }),
    message: literal('Consignment received. Our curation team will review your piece within 24 hours.'),
  }),
  async handle({ db }, input) {
    await db.consignment.insert({
      seller_name: input.seller_name,
      seller_email: input.seller_email,
      item_title: input.item_title,
      category: input.category,
      asking_cents: input.asking_price,
      notes: input.notes ?? null,
      status: 'new',
    });
    return {
      reference: publicReference('FM'),
      message: 'Consignment received. Our curation team will review your piece within 24 hours.',
    };
  },
});

export default defineCommands({ reserveListing, releaseHold, markSold, submitConsignment });
