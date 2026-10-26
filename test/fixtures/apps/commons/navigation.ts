import { navGroup } from '@mistriwork/mistri/app';
import type { Navigation } from './mistri-schema.d.ts';

/* The top menu: arrangement only. A signed-out reader sees the forum's four
   rooms; a member also sees Post; a moderator also sees Moderation, whose
   rooms are over what only moderators read. A room a reader cannot open is
   not drawn. The lists a moderator works over public tables (held posts,
   every post, member standing, board settings, tags) are opened from the
   health dashboard instead: a menu entry over a public table would be drawn
   for every visitor. */
export const navigation = [
  'latest',
  'showcase',
  'boards',
  'members',
  navGroup('post', 'Post', ['start-thread', 'join'], { icon: 'note' }),
  navGroup('moderation', 'Moderation', [{ feature: 'moderation' }], { icon: 'shield-check' }),
] satisfies Navigation;
