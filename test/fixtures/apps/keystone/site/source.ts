// The Keystone source, typed for the form handlers' `db`. Server-only.
import { defineSource } from '@mistriwork/mistri/commands';
import type { Rows } from './mistri-schema.d.ts';

export const keystone = defineSource<Rows>('keystone');
