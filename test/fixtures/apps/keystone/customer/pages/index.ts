import type { App } from '../mistri-schema.d.ts';
import { autopayPage } from './autopay.ts';
import { loanPage } from './loan.ts';
import { paymentPage } from './payment.ts';
import { profilePage } from './profile.ts';

export const pages = {
  loan: loanPage,
  payment: paymentPage,
  autopay: autopayPage,
  profile: profilePage,
} satisfies App['pages'];
