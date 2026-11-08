/**
 * What readers reported, beside the report itself: the open reports oldest first in a queue, each named by the post
 * it is about, and the picked report's reason, status and details next to it. The pick is in the address
 * (`?report=12`), so Back and a shared link keep the report a moderator was reading. Deciding one (Remove post,
 * Dismiss) stays in the Moderation queue, whose bulk actions it is; this page reads.
 *
 * Moderators' alone, as the Moderation queue is: a report is not public, so a member never reads this page.
 */
import type { ReactNode } from 'react';
import { definePage, Split } from '@mistriwork/mistri/page';

const page = definePage({
  label: 'Report desk',
  description: 'Open reports beside the post each is about.',
  icon: 'flag',
  nav: { group: 'moderation', position: 2 },
  roles: ['moderator', 'admin'],
  reads: ['report'],
  params: { report: 'id' },
  component: ReportDesk,
});
export default page;

function ReportDesk(): ReactNode {
  return (
    <Split
      from="report"
      where={{ status: 'open' }}
      sort="created_at"
      /* Reports are anonymous and one post is often reported by several readers, so the reader's details are what tell two reports of one post apart. The queue is oldest first, and the date is beside it once picked. */
      row={{ primary: 'post_id.body', lines: ['reason', 'details'] }}
      detail={['reason', 'status', 'created_at', 'details']}
      param="report"
      label="Open reports"
    />
  );
}
