/**
 * The post a report is about, as a tab of the report's own page (/reports/12/reported-post). Reports is a list view the
 * moderation feature contributes, so this is a tab on a feature's view: the folder names the view, and the
 * record it is on comes from page.useRecordKey. Moderators' alone, as the report is.
 */
import type { ReactNode } from 'react';
import { definePage, Rows } from '@mistriwork/mistri/page';

const page = definePage({
  label: 'Reported post',
  description: 'The post this report is about, as its author wrote it.',
  icon: 'chat-circle',
  roles: ['moderator', 'admin'],
  reads: ['report'],
  component: ReportedPost,
});
export default page;

function ReportedPost(): ReactNode {
  const report = page.useRecordKey('report');
  return <Rows title="Reported post" from="report" where={{ id: report.id }} show={['post_id.body', 'reason', 'details']} />;
}
