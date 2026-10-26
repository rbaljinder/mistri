import type { TypedAppConfig } from '@mistriwork/mistri/app';
import type { Tables } from './schema.ts';

/* The sidebar: arrangement only. Every entry names a view in views.ts. */
export const navigation = ['overview', 'locations', 'leads', 'follow-ups', 'activity'] satisfies NonNullable<TypedAppConfig<Tables>['nav']>;
