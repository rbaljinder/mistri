import { applyTo, callToAction, contact, embed, faq, hero, landing, steps } from '@mistriwork/mistri/app';

// Forecourt's front page, signed out at /forecourt. The hero's photo, its
// search and the recommended cards read the marketplace through the App's
// public grant; everything else on the page is the author's text.
export const forecourtLanding = landing(
  hero(
    'Find a car you will love driving',
    'Sixty used cars from six independent dealers, each photographed in the studio, inspected and priced up front.',
    [{ label: 'Browse all vehicles', to: 'vehicles' }, applyTo('inquire', 'Ask a dealer', 'secondary')],
    {
      // The studio scene the seed draws: one row of a file resource the public reads.
      image: { from: 'site_image', key: 1, alt: 'Three cars in the Forecourt studio: a silver sedan, a red SUV and a blue hatchback.' },
      layout: 'overlay',
      // The list's own filters, up front: make and body from their values, a
      // model to type, a most-you-would-pay. It opens the Vehicles list with
      // exactly those conditions, so the result is a link worth sharing.
      search: { view: 'vehicles', filters: ['make', 'model', 'body_type', 'price'], submitLabel: 'Show vehicles' },
      highlights: ['60 cars', '6 independent dealers', 'Every car inspected'],
    },
  ),
  [
    embed('recommended', { title: 'Recommended by our dealers', limit: 6, sort: 'listed_on desc' }),
    steps('How it works', [
      {
        title: 'Find the one',
        description: 'Search by make, body and budget, then open a car to see every photo, the full specs and its dealer.',
      },
      {
        title: 'Ask the dealer',
        description: 'Send a question with the car’s reference. The dealer replies by email, usually the same day.',
      },
      {
        title: 'Book a test drive',
        description: 'Set up a test drive at the dealer’s lot. Nothing is on hold until you agree it with them.',
      },
    ]),
    faq('Questions', [
      {
        question: 'Is Forecourt a real marketplace?',
        answer:
          'No. Forecourt is a demonstration in the tablewalk examples. The dealers, the prices and the inquiries are synthetic, and the photos are drawn by its seed script. Nobody reads what you send.',
      },
      {
        question: 'What is the stock number on each car?',
        answer:
          'The dealer’s own number for the car: FC and four digits. Ask from the car’s page and the form fills it in, so the right dealer answers.',
      },
      {
        question: 'Can I put a car on hold online?',
        answer: 'Not here. An inquiry holds nothing: the dealer sets a car aside only once you have agreed it with them.',
      },
      {
        question: 'Are the prices final?',
        answer:
          'Each price is the dealer’s asking price, before sales tax, title and registration fees. Trade-ins and financing are between you and the dealer.',
      },
      {
        question: 'Do the cars come with a warranty?',
        answer: 'Every car’s page says what its dealer includes. Ask the dealer for the details before you buy.',
      },
    ]),
    callToAction('Seen one you like?', 'Ask the dealer about a test drive, a trade-in or financing.', [
      applyTo('inquire', 'Inquire about a vehicle'),
    ]),
    contact('Talk to us', [{ label: 'hello@forecourt.example.test', href: 'mailto:hello@forecourt.example.test' }]),
  ],
  { label: 'Forecourt — used cars from independent dealers' },
);
