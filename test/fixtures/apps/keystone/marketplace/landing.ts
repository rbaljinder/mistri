import { applyTo, callToAction, contact, embed, faq, hero, landing, steps } from '@mistriwork/mistri/app';

// Keystone's front page, signed out at /marketplace. The hero's photo, its
// search, the dealer picks and today's rates read the catalog through the
// App's public grant; everything else is the author's text.
export const keystoneLanding = landing(
  hero(
    'Find the car. Know the payment.',
    'Cars from Keystone’s dealers across Pennsylvania, Ohio, New Jersey, Maryland and New York, each with its price and an honest monthly figure. Check your rate in two minutes, with no effect on your credit.',
    [{ label: 'Browse cars for sale', to: 'vehicles' }, applyTo('prequalify', 'Check your rate', 'secondary')],
    {
      // A studio photo the seed draws: one row of the public file resource.
      image: {
        from: 'vehicle_photo',
        key: '2022-hyundai-santa-fe-limited-lf1041-1',
        alt: 'A red 2022 Hyundai Santa Fe Limited in the studio, from the front three-quarter.',
      },
      layout: 'split',
      // The list's own filters, up front: the result is the Vehicles list with
      // exactly those conditions, so it is a link worth sharing.
      search: { view: 'vehicles', filters: ['make', 'body', 'list_price'], submitLabel: 'Show cars' },
      highlights: ['Ten Keystone dealers', 'Rates from 4.99% APR', 'No credit pull to check'],
    },
  ),
  [
    embed('featured', { title: 'Picked by our dealers', limit: 6, sort: 'listed_on desc' }),
    steps('How it works', [
      {
        title: 'Find the one',
        description: 'Narrow by make, body style, price and miles. Every car shows its price and an estimated monthly payment.',
      },
      {
        title: 'Check your rate',
        description:
          'Tell us roughly about your credit and income. We estimate what Keystone could lend and at what APR, without a credit pull.',
      },
      {
        title: 'Meet the dealer',
        description: 'Send your question or your estimate to the car’s dealer. They take it from there and apply with Keystone for you.',
      },
    ]),
    embed('programs', { title: 'Today’s rates', limit: 3 }),
    faq('Questions', [
      {
        question: 'Does checking my rate affect my credit score?',
        answer: 'No. A rate check is an estimate from what you tell us. Nothing is asked of a credit bureau until you apply at a dealer.',
      },
      {
        question: 'Is the monthly figure on each car what I will pay?',
        answer:
          'It is the dealer’s advertised payment at 72 months before tax, title and fees. Your payment depends on your rate, your down payment and the term you choose.',
      },
      {
        question: 'Who will contact me?',
        answer:
          'The dealer that has the car. Keystone lends through its dealers, so the dealer’s finance manager sends your application to us.',
      },
      {
        question: 'Is Keystone a real lender?',
        answer:
          'No. Keystone is a demonstration in the tablewalk examples. The cars, the dealers, the rates and the people are made up, and nobody reads what you send.',
      },
    ]),
    callToAction('Know your budget before you visit', 'A rate check takes about two minutes and never touches your credit.', [
      applyTo('prequalify', 'Check your rate'),
      applyTo('inquire', 'Ask a dealer', 'secondary'),
    ]),
    contact('Talk to Keystone', [
      { label: 'hello@keystone.example.test', href: 'mailto:hello@keystone.example.test' },
      { label: '(717) 555-0100', href: 'tel:+17175550100' },
    ]),
  ],
  // The App's footer (app.ts) says what Keystone is under every room, this one included.
  { label: 'Keystone — cars and rates from Keystone Auto Finance dealers' },
);
