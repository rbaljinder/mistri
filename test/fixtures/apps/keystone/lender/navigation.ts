import { navGroup } from '@mistriwork/mistri/app';
import type { Navigation } from './mistri-schema.d.ts';

/* The side menu, in the order an application travels: underwriting decides
   it, funding pays the dealer, the portfolio services the loan; then the
   dealers who send the work, and the rate sheet and the staff. Each group's
   queue comes first. The collectors' worklist is on the Delinquency board;
   customers are reached from their loans and from ⌘K. The Workflows page
   places itself under Settings (pages/workflows.page.tsx). */
export const navigation = [
  { to: 'home', label: 'Home' },
  navGroup('underwriting', 'Underwriting', ['queue', 'my-files', 'applications', 'stipulations', 'late-decisions'], { icon: 'file-text' }),
  navGroup('funding', 'Funding', ['funding-queue', 'funded'], { icon: 'bank' }),
  navGroup('portfolio', 'Portfolio', ['loans', 'delinquency', 'posting', 'payments', 'payoff-quotes', 'customers'], { icon: 'wallet' }),
  navGroup('dealers', 'Dealers', ['dealers', 'visits', 'triage'], { icon: 'storefront' }),
  navGroup('settings', 'Settings', ['programs', 'staff'], { icon: 'gear' }),
] satisfies Navigation;
