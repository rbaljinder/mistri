import type { Navigation } from './mistri-schema.d.ts';

/* The top menu: arrangement only. Each reader sees the rooms their role
   opens — a visitor the marketplace, a buyer also their saved cars and
   inquiries, the desk its dashboard, pipeline, inquiries and stock. */
export const navigation = ['vehicles', 'dealers', 'saved', 'my-inquiries', 'desk', 'pipeline', 'inquiries', 'stock'] satisfies Navigation;
