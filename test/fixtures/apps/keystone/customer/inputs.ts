// Server-only field shapes shared by the command handlers.
import { field } from '@mistriwork/mistri/commands';

export const makePaymentInput = {
  amount: field.money({
    min: 1,
    max: 100_000,
    help: 'The amount due is filled in. You may pay more; anything over it goes to your balance.',
  }),
  method: field.choice(
    [
      { value: 'ach', label: 'Bank account' },
      { value: 'card', label: 'Debit card' },
    ],
    { label: 'Pay from' },
  ),
  pay_on: field.date({ label: 'Payment date', help: 'Today or any day in the next 30. A payment made by the due date is on time.' }),
};

export const requestPayoffQuoteInput = {};

export const enrollAutopayInput = {
  bank_name: field.text({ label: 'Bank', max: 80 }),
  account_type: field.choice([
    { value: 'checking', label: 'Checking' },
    { value: 'savings', label: 'Savings' },
  ]),
  account_last4: field.text({
    label: 'Last four digits of the account',
    min: 4,
    max: 4,
    pattern: /\d{4}/,
    message: 'The last four digits, such as 4821.',
    help: 'Only the last four digits are kept, so you can tell your accounts apart.',
  }),
  draft_day: field.number({
    label: 'Day of the month',
    integer: true,
    min: 1,
    max: 28,
    help: 'Between the 1st and the 28th, so every month has it. On or before your due date keeps you on time.',
  }),
};

export const cancelAutopayInput = {};
