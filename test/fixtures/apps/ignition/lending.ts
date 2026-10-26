// The lending source, typed: what every server-side command here names as its
// `source`. Its tables and rows are the App's generated `Rows`
// (mistri-schema.d.ts), so a handler's `db` reads a lead as a lead, with the
// columns the database has.
//
// Server-only: the App graph never imports it. Note what a handler's `db` does
// *not* decide — which rows it can see. A dealer's command reads and writes
// within its own tenant because the runtime composes the ownership predicate
// outside anything written here, and injects `tenant_id` on insert; a platform
// command reads across dealers because its realm says so. The typing is a
// convenience, never the boundary.
import { defineSource } from '@mistriwork/mistri/commands';
import type { Rows } from './mistri-schema.d.ts';

export const lending = defineSource<Rows>('lending');
