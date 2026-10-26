import { applyTo, callToAction, contact, embed, faq, features, hero, landing, steps } from '@mistriwork/mistri/app';
import { DEALER } from './dealer.ts';

/* The dealer's front page, signed out at /site. The hero's photo is a car on
   the lot, its search opens Inventory with the visitor's conditions in the
   address, and the picks are the dealer's featured cars. The words are the
   dealer's (dealer_site's headline, tagline and about, copied: a landing is
   text in the App, not a record's). */
export const siteLanding = landing(
  hero(
    'Straight answers, fair prices',
    'New Ford and quality pre-owned vehicles in Harrisburg, PA. Financing through Keystone Auto Finance, with an answer in minutes.',
    [{ label: 'Shop inventory', to: 'inventory' }, applyTo('apply', 'Get pre-approved', 'secondary')],
    {
      image: { from: 'vehicle_photo', key: '2026-ford-f-150-xl-lf1023-1', alt: 'A silver 2026 Ford F-150 XL in the Liberty Ford studio.' },
      layout: 'split',
      search: { view: 'inventory', filters: ['make', 'body', 'list_price'], submitLabel: 'Show cars' },
      highlights: ['35 cars on the lot', 'Serving Harrisburg since 1992', 'Open Saturdays'],
    },
  ),
  [
    embed('featured', { title: 'Featured this week', limit: 3, sort: 'list_price desc' }),
    features('Why buy from us', [
      {
        title: 'One price, on the window',
        description:
          'The price you see is the price we sell at, before tax, title and registration. No haggling, no add-ons you did not ask for.',
      },
      {
        title: 'Financing in minutes',
        description: 'Apply online and our finance manager has Keystone Auto Finance’s answer before you arrive.',
      },
      {
        title: 'Trade-ins welcome',
        description: 'Bring your car for a written appraisal that is good for seven days, whether you buy from us or not.',
      },
    ]),
    steps('Buying a car with us', [
      {
        title: 'Find the one',
        description: 'Filter by body, price and miles, then open a car for every photo and the full specification.',
      },
      { title: 'Drive it', description: 'Pick a day for a test drive. We will have it washed and waiting.' },
      {
        title: 'Get approved, drive it home',
        description:
          'Apply online in about five minutes. We call you with Keystone’s answer, and you leave with your keys, usually within the hour.',
      },
    ]),
    embed('financing', { title: 'Today’s rates from Keystone Auto Finance', limit: 3, sort: 'base_apr' }),
    faq('Questions', [
      {
        question: 'Can I apply before I choose a car?',
        answer:
          'Yes. Apply with the stock number left empty and we will tell you what you are approved for, so you shop knowing your budget.',
      },
      {
        question: 'Does applying affect my credit score?',
        answer:
          'This is a demonstration: nothing is sent to a credit bureau. A real application would be a soft inquiry until you choose to buy.',
      },
      {
        question: 'Is a car held for me when I ask about it?',
        answer: 'Not until we agree it with you by phone or email. A car marked Sale pending already has a buyer’s deposit.',
      },
      {
        question: 'Are the prices final?',
        answer:
          'Each price is our asking price, before sales tax, title and registration fees. Your trade-in and financing are figured separately.',
      },
    ]),
    callToAction('Ready when you are', `Ask a question, book a test drive or call ${DEALER.phone}. We are open six days a week.`, [
      applyTo('test-drive', 'Schedule a test drive'),
      applyTo('ask', 'Ask a question', 'secondary'),
    ]),
    contact('Visit us', [
      { label: '4501 Jonestown Rd, Harrisburg, PA 17109', href: 'https://maps.example.invalid/liberty-ford' },
      { label: `Call ${DEALER.phone}`, href: DEALER.phoneHref },
      { label: DEALER.email, href: `mailto:${DEALER.email}` },
      { label: 'Mon–Fri 9 am–8 pm, Sat 9 am–6 pm', href: 'https://maps.example.invalid/liberty-ford' },
    ]),
  ],
  { label: `${DEALER.name} — new Ford and pre-owned cars in ${DEALER.city}` },
);
