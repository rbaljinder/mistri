import type { Pages } from '../mistri-schema.d.ts';
import { catalogPages } from './catalog.ts';
import { orderPages } from './orders.ts';

export const pages = { ...orderPages, ...catalogPages } satisfies Pages;
