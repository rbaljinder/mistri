// The marketplace source, typed: what the server-side inquiry handler names
// as its `source`, so its `db` reads the generated rows (mistri-schema.d.ts).
// Server-only: the App graph never imports it.
import { defineSource } from '@mistriwork/mistri/commands';
import type { Rows } from './mistri-schema.d.ts';

export const market = defineSource<Rows>('market');
