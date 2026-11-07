/*
 * Saved draft: the browser gate's own App for a signed-in form saved on every
 * step (`owner`) — a membership application in three steps, each written to
 * the person's own draft as they move on, then a review and one submit. The
 * draft is found by who is signed in, so a second account opening the same
 * form starts blank. Owned by the test suite, sized to its one spec
 * (e2e/saved-draft.spec.ts).
 */
import { commandForm, defineApp, listView, step } from '@mistriwork/mistri/app';

const COMMANDS = ['startMembership', 'saveTier', 'saveContact', 'submitMembership'];

export default defineApp({
  id: 'saved-draft',
  name: 'Saved draft',
  sources: { club: { connection: 'club' } },
  /* The ceiling the commands write under, not a grant: the only writes are the form's. */
  resources: { person: {}, membership: { access: 'write' }, contact: { access: 'write' } },
  auth: {
    providers: ['email'],
    signUp: 'open',
    defaultRole: 'member',
    // `me` is the person row whose email is the signed-in, proven address; it owns the draft.
    me: { from: 'person', column: 'email' },
    roles: { member: { read: true, commands: COMMANDS } },
  },
  views: {
    memberships: listView('Memberships', 'membership'),
    join: commandForm(
      'Join the club',
      'submitMembership',
      [step('You', 'startMembership'), step('Tier', 'saveTier'), step('Contact', 'saveContact')],
      {
        submitLabel: 'Submit application',
        resume: { token: 'resume_token_hash', expires: 'resume_expires_at', progress: 'resume_progress', after: '14 days' },
        draft: { status: 'in_progress' },
        owner: 'person_id',
        done: { title: 'Application received' },
      },
    ),
  },
  home: 'memberships',
  nav: ['memberships', 'join'],
});
