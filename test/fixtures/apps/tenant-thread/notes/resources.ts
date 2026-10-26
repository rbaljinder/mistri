import { action } from '@mistriwork/mistri/app';
import type { TypedAppConfig } from '@mistriwork/mistri/app';
import type { Tables } from '../schema.ts';
import { resources as parent } from '../resources.ts';

/* The parent's resources; a discussion can also be renamed and takes notes. */
export const resources = {
  ...parent,
  discussion: {
    ...parent.discussion,
    actions: {
      addDiscussion: action('Add discussion', { command: 'addDiscussion' }),
      addNote: action('Add note', { command: 'addNote', header: false }),
      renameDiscussion: action('Rename', { command: 'renameDiscussion' }),
    },
  },
} satisfies Required<NonNullable<TypedAppConfig<Tables>['resources']>>;
