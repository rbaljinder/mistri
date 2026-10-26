import type { Pages } from '../mistri-schema.d.ts';
import { applicationPages } from './application.ts';
import { dealerPages } from './dealer.ts';
import { fundingPages } from './funding.ts';
import { loanPages } from './loan.ts';
import { settingsPages } from './settings.ts';

export const pages = {
  ...applicationPages,
  ...fundingPages,
  ...loanPages,
  ...dealerPages,
  ...settingsPages,
} satisfies Pages;
