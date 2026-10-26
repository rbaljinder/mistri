import { fields, history, page, stream, timeline } from '@mistriwork/mistri/app';
import type { TypedAppConfig } from '@mistriwork/mistri/app';
import type { Paths, Tables } from '../schema.ts';
import { pages as parent } from '../pages.ts';

/* A discussion's comments as a timeline whose composer sends `addNote`, and the record's history. */
export const pages = {
  ...parent,
  discussion: page('discussion', [
    fields(['name', 'business_id', 'issue_id.name', 'status'] satisfies Paths['discussion'][]),
    timeline('Notes', [stream('comment', 'discussion_id' satisfies Tables['comment'], 'created_at', 'body')], {
      newest: 'last',
      composer: { reply: 'addNote' },
    }),
    history(),
  ]),
} satisfies NonNullable<TypedAppConfig<Tables>['pages']>;
