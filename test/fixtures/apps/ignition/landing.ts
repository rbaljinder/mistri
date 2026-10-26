import { applyTo, callToAction, contact, faq, features, hero, landing, signIn, steps } from '@mistriwork/mistri/app';

// The public face of Ignition's fictional lender, served signed out at
// /ignition (and at /ignition/welcome to anyone, so the desk can see it).
// Content only: the page reads no data, and every figure a real lender would
// quote — rates, fees, terms of credit — is deliberately absent.
export const ignitionLanding = landing(
  hero(
    'Finance your next car',
    'Apply in about five minutes with the quotation from your dealer. A reviewer reads every application and contacts you about next steps.',
    [applyTo('finance', 'Apply for financing'), signIn('Staff sign in')],
  ),
  [
    steps('How it works', [
      {
        title: 'Apply',
        description: 'Tell us about yourself, the vehicle and the loan you want. You get a reference as soon as you send it.',
      },
      {
        title: 'Your dealership picks it up',
        description: 'Your application reaches the dealership whose link you applied through, which confirms the vehicle and the figures.',
      },
      { title: 'A reviewer decides', description: 'The dealership sends it to us for review, and you hear about next steps by email.' },
    ]),
    features('What you need', [
      {
        title: 'Your driver licence',
        description: 'A current licence in your name. You are asked for a copy after you apply, not in the form.',
      },
      { title: 'Proof of income', description: 'Recent pay slips or a statement of earnings. You are told exactly what to send.' },
      {
        title: 'The stock number',
        description:
          'The vehicle’s stock number, printed on the dealership’s quotation. Apply through the dealership’s own link and it knows who you are asking.',
      },
    ]),
    faq('Questions', [
      {
        question: 'Is Ignition a real lender?',
        answer:
          'No. Ignition is a demonstration lender with synthetic data in the tablewalk examples. Nothing submitted here is read by a real person, and no credit is offered.',
      },
      {
        question: 'What happens after I apply?',
        answer:
          'Your application reaches the dealership you applied through, which confirms the vehicle and sends it to us. A reviewer is assigned, checks what you sent, and writes to you.',
      },
      {
        question: 'Can I change my application after sending it?',
        answer: 'Not online. Keep your reference and quote it when the dealership contacts you.',
      },
      {
        question: 'Which vehicles can I finance?',
        answer:
          'Vehicles on the lot of a participating dealership. Apply through that dealership’s own link, and use the stock number from its quotation.',
      },
      { question: 'Does applying check my credit?', answer: 'This demonstration runs no credit checks and stores no credit history.' },
    ]),
    callToAction('Have your quotation to hand?', 'The form asks for the stock number printed on it.', [
      applyTo('finance', 'Apply for financing'),
    ]),
    contact('Contact us', [
      { label: 'applications@example.test', href: 'mailto:applications@example.test' },
      { label: '+1 202 555 0142', href: 'tel:+12025550142' },
    ]),
  ],
  { label: 'Ignition — car financing' },
);
