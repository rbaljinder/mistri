import { applyTo, callToAction, embed, faq, hero, landing } from '@mistriwork/mistri/app';

/* The front page, signed out. The hero's photo, its search and the two rows
   of cars read the marketplace through the App's public grant; the rest is
   the author's words. The search writes the list's own conditions, so its
   answer is an address worth sharing: /vehicles?make=Toyota&body_type=SUV. */
export const forecourtLanding = landing(
  hero(
    'Find the car that fits your life',
    'Used cars from six independent dealers, each one inspected, photographed and priced up front. No haggling required.',
    [{ label: 'Browse all cars', to: 'vehicles' }, applyTo('inquire', 'Ask a question', 'secondary')],
    {
      image: { from: 'site_image', key: 1, alt: 'A slate-blue Ford Mustang GT parked in an open lot under a clear sky.' },
      /* The photograph behind the words, as a showroom window reads. One box
         to search: the refinements wait on the list. */
      layout: 'overlay',
      search: { view: 'vehicles', filters: ['title'], submitLabel: 'Search cars' },
      highlights: ['Every car inspected', 'Prices up front', 'Six local dealers'],
    },
  ),
  [
    embed('featured', { title: 'Featured this week', limit: 6 }),
    embed('arrivals', { title: 'Just arrived', limit: 6, sort: 'listed_on desc' }),
    faq('Questions', [
      {
        question: 'Is Forecourt a real marketplace?',
        answer:
          'No. Forecourt is a demonstration in the tablewalk examples. The dealers, the prices and the inquiries are made up, and the photos are public-domain pictures of cars, not of these cars. Nobody reads what you send.',
      },
      {
        question: 'What is the stock number on each car?',
        answer: 'The dealer’s own reference: FC and four digits. Ask from the car’s page and the form fills it in.',
      },
      {
        question: 'Can I hold a car online?',
        answer: 'Not here. An inquiry holds nothing: a dealer sets a car aside only once you have agreed it with them.',
      },
      {
        question: 'How is the monthly estimate worked out?',
        answer: 'At 10% down over 60 months at 7.9% APR, before tax, title and registration. Your own rate depends on your credit.',
      },
    ]),
    callToAction('Seen one you like?', 'Ask the desk about a test drive, a trade-in or financing.', [applyTo('inquire', 'Ask a question')]),
  ],
  { label: 'Forecourt: used cars from independent dealers' },
);
