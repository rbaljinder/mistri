import { component } from '@mistriwork/mistri/app';

/* Commons' own components, declared as data: a name and a module path each.
   Where it is placed says what it reads (views.ts); the
   module draws with @mistriwork/mistri/ui and changes the forum only through the
   posting commands. It is drawn for a signed-out visitor too, on pages
   the public grant reads: what it declares it reads is held to it. */

/** A thread's posts as a forum reads them: oldest first, each whole, its photos and reactions under it. */
export const postStream = component('post-stream', { module: './widgets/PostStream.tsx', kind: 'list' });
