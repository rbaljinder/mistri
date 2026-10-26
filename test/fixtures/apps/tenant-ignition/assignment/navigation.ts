import type { TypedAppConfig } from '@mistriwork/mistri/app';
import { navigation as parentNavigation } from '../navigation.ts';
import type { Tables } from './schema.ts';

/* The parent's sidebar, then this variant's views. */
export const navigation = [...parentNavigation, 'applications', 'review-staff', 'assignment-history'] satisfies NonNullable<
  TypedAppConfig<Tables>['nav']
>;
