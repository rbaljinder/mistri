/* The suite's status vocabularies (SUITE.md, "Shared conventions"), copied
   rather than imported: each Keystone App is self-contained, and SUITE.md is
   what keeps the copies equal. Only the tones that carry meaning are said;
   the rest read as plain words. */
export const leadStatus = {
  tone: { new: 'info', desking: 'info', submitted: 'info', sold: 'good', lost: 'neutral', '*': 'neutral' },
} as const;
export const dealStatus = { tone: { approved: 'info', contracted: 'info', funded: 'good', cancelled: 'neutral', '*': 'neutral' } } as const;
export const applicationStatus = {
  tone: {
    conditioned: 'warn',
    countered: 'warn',
    approved: 'good',
    funded: 'good',
    declined: 'bad',
    withdrawn: 'neutral',
    '*': 'neutral',
  },
} as const;
export const stipulationStatus = {
  tone: { requested: 'warn', received: 'info', cleared: 'good', waived: 'good', '*': 'neutral' },
} as const;
export const vehicleStatus = { tone: { listed: 'good', pending: 'info', sold: 'neutral', wholesale: 'neutral', '*': 'neutral' } } as const;
export const dealerStatus = { tone: { on_hold: 'warn', terminated: 'bad', '*': 'neutral' } } as const;

/* Units, once. A rate is percent points (7.490 is 7.49%), a term is months,
   mileage is miles. */
export const dollars = { format: 'money' } as const;
export const perMonth = { format: 'money', unit: '/mo' } as const;
export const rate = { format: 'percent' } as const;
export const months = { unit: 'mo' } as const;
export const miles = { unit: 'mi' } as const;
