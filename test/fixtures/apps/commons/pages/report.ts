import { fields, page } from '@mistriwork/mistri/app';
import type { Page } from '../mistri-schema.d.ts';

/* A report, as a moderator decides it: what was reported and why, the post
   itself, and — once decided — the decision. The post's own page has Hide. */
export const reportPage = page(
  'report',
  [
    fields(['reason', 'status', 'created_at'], { title: 'The report', presentation: 'facts' }),
    fields(['details'], { title: 'What the reader said' }),
    fields(['post_id', 'post_id.author_id.display_name', 'post_id.thread_id.title', 'post_id.body'], { title: 'The post', columns: 1 }),
    fields(['resolution', 'resolved_at'], { title: 'Decision', when: 'status != open' }),
  ],
  { listTabs: false },
) satisfies Page;
