/* Legacy single-dealer presentation for the original views/landing modules.
   The active App replaces it through features/publicSite.ts and fromRecord
   branding; server/inputs.ts replaces its stock/consent presentation. None of
   these constants is read scope or an intake destination: policy.ts admits the
   public placement and commands.ts requires the binder's trusted tenant key. */
export const DEALER = {
  id: 'liberty-ford',
  name: 'Liberty Ford of Harrisburg',
  city: 'Harrisburg, PA',
  phone: '(717) 555-0139',
  phoneHref: 'tel:+17175550139',
  email: 'hello@liberty-ford.example',
  // A stock number this dealer prints on its windows: LF and four digits.
  stock: /LF\d{4}/,
  stockExample: 'LF1041',
} as const;
