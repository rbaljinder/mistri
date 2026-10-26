import { applyTo, callToAction, embed, faq, hero, landing } from '@mistriwork/mistri/app';

/* The front page, signed out. The hero's photo and the row of homes read the
   buildings through the App's public grant (app.ts `auth.public`); the rest is
   the author's words. */
export const lintelLanding = landing(
  hero(
    'Homes in three Denver buildings, managed by people who answer',
    'Studios to three-bedroom townhomes near Cheesman Park, in RiNo and in Washington Park. Repairs booked within a day, rent paid online.',
    [{ label: 'See homes to let', to: 'listings' }, applyTo('request-viewing', 'Ask for a viewing', 'secondary')],
    {
      image: {
        from: 'property_photo',
        key: 1,
        alt: 'Alder Court from the street: a five-story courtyard building at dusk, its windows lit.',
      },
      layout: 'overlay',
      highlights: ['No application fee', 'Repairs booked within a day', 'Pets welcome'],
    },
  ),
  [
    embed('listings', { title: 'Available now', limit: 6, sort: 'available_on' }),
    faq('Questions', [
      {
        question: 'Is Lintel a real landlord?',
        answer:
          'No. Lintel is a demonstration in the mistri examples. The buildings, homes and people are made up, and nobody reads what is sent.',
      },
      {
        question: 'What is in the rent?',
        answer: 'Water, trash and recycling. Electricity and internet are yours to set up.',
      },
      {
        question: 'When is rent due?',
        answer: 'On the first of the month. It can be paid without a fee until the fifth; after that a $75 late fee is added.',
      },
      {
        question: 'How do I report a repair?',
        answer: 'Sign in and press Report a problem. You can follow it, and message the office about it, from your home page.',
      },
    ]),
    callToAction('Seen one you like?', 'Pick a day and the leasing office confirms a time.', [
      applyTo('request-viewing', 'Ask for a viewing'),
    ]),
  ],
  { label: 'Lintel: homes to let in Denver' },
);
