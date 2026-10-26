import { navGroup } from '@mistriwork/mistri/app';
import type { Navigation } from './mistri-schema.d.ts';

/* The menu: arrangement only. Every entry names a view in views.ts. */
export const navigation = [navGroup('tracking', 'Tracking', ['shipments', 'carriers'])] satisfies Navigation;
