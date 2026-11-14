/**
 * Who a screen is drawn for (shared/appAudience.ts): a role an App marks `portal: true` is its own public, and so is
 * a signed-out visitor of an App that signs people in. The shell offers them none of the office's tools; grants are
 * untouched. A list's `primary` titles its rows for that list alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { viewerAudience } from '../packages/mistri/src/shared/appAudience.js';

const app = (roles: Record<string, unknown>, list: Record<string, unknown> = {}) =>
  parseAppConfig(
    {
      name: 'Clinic',
      resources: { visit: {} },
      views: { visits: { kind: 'list', from: 'visit', ...list } },
      home: 'visits',
      auth: { roles },
    },
    'app',
  );

test("a portal role is the App's own public; an office role beside it makes the reader the office", () => {
  const { auth } = app({ patient: { read: true, portal: true }, reception: { read: true } });
  assert.equal(auth!.roles!.patient.portal, true);
  assert.equal(viewerAudience(auth, { signedIn: true, roles: ['patient'] }), 'person');
  assert.equal(viewerAudience(auth, { signedIn: true, roles: ['patient', 'reception'] }), undefined);
  assert.equal(viewerAudience(auth, { signedIn: true, roles: ['reception'] }), undefined);
  assert.equal(viewerAudience(auth, { signedIn: true, roles: [] }), undefined);
});

test('a signed-out visitor of an App that signs people in is a person; an App with no sign-in has no audiences', () => {
  const { auth } = app({ reception: { read: true } });
  assert.equal(viewerAudience(auth, { signedIn: false, roles: [] }), 'person');
  assert.equal(viewerAudience(undefined, { signedIn: false, roles: [] }), undefined);
});

test('portal is declared true or left out, and never said on a service role', () => {
  assert.throws(() => app({ patient: { read: true, portal: false } }), /"portal" that is not true/);
  assert.throws(() => app({ feed: { read: true, portal: true, service: true } }), /both "portal" and "service"/);
});

test("a list's primary names one of the columns it shows", () => {
  assert.equal(
    (app({ r: { read: true } }, { show: ['therapist_id', 'starts_at'], primary: 'therapist_id' }).views.visits as { primary?: string })
      .primary,
    'therapist_id',
  );
  assert.throws(() => app({ r: { read: true } }, { show: ['starts_at'], primary: 'therapist_id' }), /which "show" does not list/);
  assert.throws(() => app({ r: { read: true } }, { primary: 'a b' }), /"primary" must name one of the list's own columns/);
});

test("a dashboard's rows section takes a primary too: one of the columns it shows", () => {
  const dash = (section: Record<string, unknown>) =>
    parseAppConfig(
      {
        name: 'Clinic',
        resources: { visit: {} },
        views: {
          today: { kind: 'dashboard', label: 'Today', sections: [{ kind: 'rows', title: 'Next', from: 'visit', ...section }] },
          visits: { kind: 'list', from: 'visit' },
        },
        home: 'today',
      },
      'app',
    );
  const today = dash({ show: ['patient_id', 'therapist_id', 'starts_at'], primary: 'therapist_id' }).views.today as {
    sections: Array<{ primary?: string }>;
  };
  assert.equal(today.sections[0].primary, 'therapist_id');
  assert.throws(() => dash({ show: ['starts_at'], primary: 'therapist_id' }), /which "show" does not list/);
  assert.throws(() => dash({ show: ['starts_at'], primary: 'a b' }), /"primary" must name one of the section's own columns/);
});
