import type { Pages } from '../mistri-schema.d.ts';
import { dealerPage } from './dealer.ts';
import { inquiryPage } from './inquiry.ts';
import { vehiclePage } from './vehicle.ts';

export const pages = { vehicle: vehiclePage, inquiry: inquiryPage, dealer: dealerPage } satisfies Pages;
