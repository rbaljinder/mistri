/**
 * A signed-in saved form (`owner`) on a row-policy App, over the real server: each step runs under the member's own
 * grant and rows, resolved again on its request, so the form works where a public saved form is refused (its intake
 * places one insert and re-proves nothing after; signed-in-drafts-http holds that refusal's wording).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { savedFormProblem } from '../packages/mistri/src/server/forms/savedFormChecks.js';
import { draftApp, draftPolicyServer, DRAFT_FORM, DRAFT_POLICY } from './support/signedInDrafts.js';

test(
  'a signed-in saved form works under a row policy: each step in the member’s rows, the submit finishing the draft',
  { timeout: 60_000 },
  async (t) => {
    const f = await draftPolicyServer(t);
    const ann = await f.signUp('ann');
    for (const step of ['you', 'plan', 'contact']) {
      const saved = await f.step(ann, step);
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
    }
    assert.deepEqual(
      f.onboardings().map((row) => [row.person_id, row.region, row.status, row.resume_progress]),
      [[1, 1, 'in_progress', 'you,plan,contact']],
      "the owner is ann's person row, filled by the server",
    );
    // Bob cannot reach it, by listing or by naming its id.
    const bob = await f.signUp('bob');
    assert.deepEqual((await f.op(bob, 'resume')).body, { draft: null });
    const id = f.onboardings()[0].id as number;
    assert.equal((await f.step(bob, 'plan', id)).status, 404);
    const review = await f.op(ann, 'review');
    assert.equal(review.status, 200, JSON.stringify(review.body));
    const done = await f.submit(ann, review.body.version);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(f.onboardings()[0].status, 'submitted');
  },
);

test(
  'a file beneath a draft is its owner’s alone under a row policy that lets every member read the file table',
  { timeout: 60_000 },
  async (t) => {
    /* A row policy's source carries no App reader: the file route opened none, so the draft check never ran and
       anyone the policy admitted read a draft's files. */
    const f = await draftPolicyServer(t, { files: true });
    const ann = await f.signUp('ann');
    const bob = await f.signUp('bob');
    for (const step of ['you', 'plan', 'contact']) assert.equal((await f.step(ann, step)).status, 200);
    const id = f.attach(f.onboardings()[0].id as number, 'passport.png');
    assert.equal(await f.readFile(ann, id), 200, 'the draft’s owner reads it');
    assert.equal(await f.readFile(bob, id), 404, 'another member does not, though the policy admits the row');
    const review = await f.op(ann, 'review');
    assert.equal((await f.submit(ann, review.body.version)).status, 200);
    assert.equal(await f.readFile(bob, id), 200, 'after submit the file follows the policy');
  },
);

test('a public saved form in a row-policy App is still refused, and the refusal points at a signed-in draft', () => {
  const { owner, ...form } = DRAFT_FORM;
  const app = draftApp() as never;
  const refused = savedFormProblem(app, { ...form, public: true, save: {} } as never, {} as never, {} as never);
  assert.match(refused ?? '', /row-policy App's public intake/);
  assert.match(refused ?? '', /leave out public and name owner/);
  assert.equal(owner, 'person_id');
});

/* Start over deletes the root under the person's own rows. A table that references it and is not wholly theirs used to
   refuse the delete outright (a generic 503). Now the references are counted on the writer across every row: none, and
   the delete runs; any left, even one the person cannot see, and the draft stays with a reason. Nothing cascades. */
test(
  'Start over works where a referencing table is only partly the member’s, and refuses while a row they cannot see still refers to the draft',
  { timeout: 60_000 },
  async (t) => {
    const narrowContacts = DRAFT_POLICY.replace(
      'contact: true,',
      "contact: { groups: [[{ column: 'label', op: '=', value: 'ann@work.test' }]] },",
    );
    const f = await draftPolicyServer(t, { policy: narrowContacts });
    const ann = await f.signUp('ann');
    for (const step of ['you', 'plan', 'contact']) assert.equal((await f.step(ann, step)).status, 200);
    const id = f.onboardings()[0].id as number;
    // A contact someone else wrote, which Ann's rows do not include: the delete is refused and nothing is removed.
    f.addContact(id, 'someone-else');
    const refused = await f.op(ann, 'discard');
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'ineligible_state');
    assert.match(refused.body.message, /Other records still refer to this draft/);
    assert.equal(f.onboardings().length, 1);
    assert.deepEqual(
      f.contacts().map((row) => row.label),
      ['ann@work.test', 'someone-else'],
      'the refusal rolls the whole delete back, her own contact included',
    );
    // Once nothing refers to the draft, Start over removes it and the rows she could see.
    f.removeContacts('someone-else');
    assert.deepEqual((await f.op(ann, 'discard')).body, { discarded: true });
    assert.equal(f.onboardings().length, 0);
    assert.equal(f.contacts().length, 0);
  },
);
