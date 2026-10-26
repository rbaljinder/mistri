/** Closed synthetic models shared by fixture setup and its browser assertions. */
export type TenantProofKind = 'ignition' | 'thread';
export function tenantProofModel(kind: TenantProofKind) {
  if (kind !== 'ignition' && kind !== 'thread') throw new Error('Unknown tenant proof');
  const ignition = kind === 'ignition';
  return Object.freeze({
    unit: ignition ? 'location' : 'project',
    work: ignition ? 'lead' : 'issue',
    target: ignition ? 'follow_up' : 'discussion',
    event: ignition ? 'activity' : 'comment',
    unitForeignKey: ignition ? 'location_id' : 'project_id',
    workForeignKey: ignition ? 'lead_id' : 'issue_id',
    targetForeignKey: ignition ? 'follow_up_id' : 'discussion_id',
    command: ignition ? 'recordFollowUp' : 'addDiscussion',
    action: ignition ? 'Record follow-up' : 'Add discussion',
    workLabel: ignition ? 'Leads' : 'Issues',
    targetLabel: ignition ? 'Follow-ups' : 'Discussions',
    eventLabel: ignition ? 'Activity' : 'Comments',
  });
}
export const tenantProofRows = Object.freeze({
  north: Object.freeze({
    unit: 'northstar-main',
    otherUnit: 'northstar-other',
    work: 'northstar-work',
    otherWork: 'northstar-other-work',
    target: 'northstar-target',
    otherTarget: 'northstar-other-target',
  }),
  south: Object.freeze({ unit: 'riverview-main', work: 'riverview-work', target: 'riverview-target' }),
});
