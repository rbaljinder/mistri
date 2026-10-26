// The one source every handler here names, typed with the App's generated
// `Rows`. Server-only. The typing is a convenience, never the boundary: a
// dealer's command reads and writes inside its own dealer because the runtime
// composes the ownership predicate outside anything a handler writes, and
// injects `dealer_id` on every insert.
import { defineSource } from '@mistriwork/mistri/commands';
import type { Rows } from '../mistri-schema.d.ts';

export const keystone = defineSource<Rows>('keystone');
