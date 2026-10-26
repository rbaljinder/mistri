import type { TypedAppConfig } from '@mistriwork/mistri/app';
import { navigation as parentNavigation } from '../assignment/navigation.ts';
import type { Tables } from './schema.ts';

/* The assignment variant's sidebar, then the inventory views. */
export const navigation = [...parentNavigation, 'vehicles', 'reservations', 'availability-history'] satisfies NonNullable<
  TypedAppConfig<Tables>['nav']
>;
