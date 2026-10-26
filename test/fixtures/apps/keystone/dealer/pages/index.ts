import type { App } from '../mistri-schema.d.ts';
import { dealerPage } from './dealer.ts';
import { memberPage } from './member.ts';
import { sitePage } from './site.ts';
import { vehiclePage } from './vehicle.ts';

export const pages = {
  dealer: dealerPage,
  member: memberPage,
  site: sitePage,
  vehicle: vehiclePage,
} satisfies App['pages'];
