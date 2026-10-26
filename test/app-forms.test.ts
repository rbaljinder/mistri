/**
 * Command forms: one view kind, `form`, for every form that runs one
 * command — signed in unless it says `public: true`, and nothing else makes
 * it public. The parser owns the shape (a slug key, steps that carve the
 * command's input up exactly, no target) and each audience's rules: a
 * public form takes no reference input and is never in nav; a signed-in
 * form is a room, reachable, opened by the roles granted its command and by
 * nobody else. The helpers in packages/mistri/schema/app.mjs are plain data constructors.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicForm, type AppFormView } from '../packages/mistri/src/shared/app.js';
import { publicHome } from '../packages/mistri/src/shared/appHome.js';
import { applyTo, commandForm, hero, landing, step } from '../packages/mistri/schema/app.mjs';
import { catalogOf, parseTestApp } from './support/commandCatalog.js';

const command = 'applyForFinancing';
const logCall = 'logCall';
/* What the App's commands module registers: the forms name these. */
const contracts = {
  applyForFinancing: {
    public: true,
    input: {
      applicant_name: { label: 'Full name', type: 'text', max: 120 },
      dealer_code: { label: 'Dealer code', type: 'text' },
      requested_amount: { label: 'Amount', type: 'number', min: 1 },
    },
  },
  logCall: {
    input: {
      account: { label: 'Account', type: 'reference', from: 'loan', by: 'id', labelColumn: 'name' },
      notes: { label: 'Notes', type: 'textarea', optional: true },
    },
  },
};
const roles = { viewer: { read: true, write: false }, clerk: { read: true, write: false, commands: ['logCall'] } };
const base = {
  name: 'Loans',
  auth: { providers: ['email'], roles },
  sources: { lending: { connection: 'loans' } },
  resources: { loan: { access: 'write' } },
  views: { loans: { kind: 'list', from: 'loan' } },
  home: 'loans',
  nav: ['loans'],
};
const withViews = (views: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  parseTestApp({ ...base, ...extra, views: { ...base.views, ...views } }, 'form fixture', contracts);
const finance = () =>
  commandForm(
    'Apply for financing',
    command,
    [step('About you', ['applicant_name']), step('The vehicle', ['dealer_code']), step('The loan', ['requested_amount'])],
    { public: true, description: 'A demonstration.', done: { title: 'Received', description: 'Keep the reference.' } },
  );
const log = () => commandForm('Log a call', logCall, [step('The call', ['account', 'notes'])], { done: { title: 'Logged' } });
const inNav = { nav: ['loans', 'log'] };
const form = (app: ReturnType<typeof withViews>, key: string) => app.views[key] as AppFormView;

describe('a public form', () => {
  test('parses into the views under its key, public, its steps carrying the command inputs', () => {
    const app = withViews({ finance: finance() });
    const parsed = form(app, 'finance');
    assert.ok(isPublicForm(parsed));
    assert.equal(parsed.label, 'Apply for financing');
    assert.equal(parsed.command.id, 'applyForFinancing');
    assert.deepEqual(
      parsed.steps!.map((s) => s.id),
      ['about-you', 'the-vehicle', 'the-loan'],
    );
    assert.deepEqual(
      parsed.steps!.map((s) => s.fields),
      [['applicant_name'], ['dealer_code'], ['requested_amount']],
    );
    assert.deepEqual(parsed.done, { title: 'Received', description: 'Keep the reference.' });
    assert.equal('target' in parsed.command, false);
    assert.equal(
      publicHome(withViews({ finance: finance() }, { home: [{ view: 'finance', signedOut: true }, { view: 'loans' }] })),
      'finance',
    );
  });

  test('is never in nav, which is signed-in chrome', () => {
    assert.throws(
      () => withViews({ finance: finance() }, { nav: ['loans', 'finance'] }),
      /names the public form view "finance"\. Public views are not in nav, which is signed-in chrome/,
    );
  });

  test('runs a public command, whose reference input is judged against auth.public (savedFormChecks.ts)', () => {
    // A signed-in command is not a public form's: only a command registered public: true is.
    assert.throws(
      () => withViews({ f: commandForm('T', logCall, [step('One', ['account', 'notes'])], { public: true }) }),
      /is public and names "logCall", which is not registered with public: true/,
    );
    // A public command's reference input parses where it is declared; what the public may read decides it where the App is known.
    assert.doesNotThrow(() =>
      catalogOf({
        asks: { public: true, input: { account: { type: 'reference', from: 'loan', by: 'id', labelColumn: 'name' } } },
      }),
    );
  });

  test('public: true is the only switch, written; anything else is refused and a form without it is signed in', () => {
    assert.throws(
      () => withViews({ finance: { ...finance(), public: 'yes' } }),
      /has a "public" that is not true or false\. A form is signed in unless it says public: true\./,
    );
    const app = withViews({ log: log() }, inNav);
    assert.equal(isPublicForm(form(app, 'log')), false);
    assert.equal(publicHome(app), undefined);
  });
});

describe('a signed-in form', () => {
  test('is a room nav and home name, with steps, a done screen and a reference input', () => {
    const app = withViews({ log: log() }, { ...inNav, home: [{ view: 'log', roles: ['clerk'] }, { view: 'loans' }] });
    const parsed = form(app, 'log');
    assert.equal(parsed.label, 'Log a call');
    assert.equal(parsed.public, undefined);
    assert.deepEqual(parsed.steps, [{ id: 'the-call', label: 'The call', fields: ['account', 'notes'] }]);
    assert.deepEqual(parsed.done, { title: 'Logged' });
    assert.equal(parsed.command.input[0].type, 'reference');
    assert.deepEqual(app.nav, [{ view: 'loans' }, { view: 'log' }]);
    assert.deepEqual(app.home, [{ view: 'log', roles: ['clerk'] }, { view: 'loans' }]);
  });

  test('without steps it is one page, with or without options', () => {
    const app = withViews({ log: commandForm('Log a call', logCall, { done: { title: 'Logged' } }) }, inNav);
    assert.equal(form(app, 'log').steps, undefined);
    assert.deepEqual(form(app, 'log').done, { title: 'Logged' });
    assert.equal(form(withViews({ log: commandForm('Log a call', logCall) }, inNav), 'log').steps, undefined);
  });

  test('its command must be granted to a declared role: one nobody holds is refused, naming the form and the command', () => {
    assert.throws(
      () => withViews({ log: log() }, { ...inNav, auth: { providers: ['email'], roles: { viewer: roles.viewer } } }),
      /views "log" runs the command "logCall", which no role in auth\.roles is granted, so nobody could open the form/,
    );
  });

  test('a home rule with roles names it only for roles granted its command', () => {
    assert.throws(
      () => withViews({ log: log() }, { ...inNav, home: [{ view: 'log', roles: ['clerk', 'viewer'] }, { view: 'loans' }] }),
      /rule 1: the role "viewer" is not granted the command "logCall", which the form "log" runs\. A home must be a view its visitors can open\./,
    );
  });

  test('is never a signed-out home, and no call to action opens it', () => {
    assert.throws(
      () => withViews({ log: log() }, { ...inNav, home: [{ view: 'log', signedOut: true }, { view: 'loans' }] }),
      /sends signed-out visitors to "log", a signed-in form view; a signed-out visitor can open only a public view \(a landing or a public form\)/,
    );
    assert.throws(
      () =>
        withViews(
          { log: log(), welcome: landing(hero('Hi', [applyTo('log', 'Log')])) },
          { ...inNav, home: [{ view: 'welcome', signedOut: true }, { view: 'loans' }] },
        ),
      /names the view "log", which is not a public form view this App declares\. It declares no public form view\./,
    );
  });

  test('must be reachable, and its command may not also run on a record', () => {
    assert.throws(() => withViews({ log: log() }), /views "log" is a signed-in form referenced by nothing — not nav, not home/);
    // A form's command names no record, so no action on a record may run it.
    assert.throws(
      () =>
        withViews(
          { log: log() },
          { ...inNav, resources: { loan: { access: 'write', actions: { log: { label: 'Log', command: 'logCall' } } } } },
        ),
      /names "logCall", which names no existing record \(it is a form's command\)/,
    );
  });
});

describe('every form', () => {
  test('the helpers are data constructors: commandForm() and step() return the JSON they stand for', () => {
    assert.deepEqual(step('The loan', ['a']), { id: 'the-loan', label: 'The loan', fields: ['a'] });
    assert.deepEqual(step('X', ['a'], { id: 'own' }), { id: 'own', label: 'X', fields: ['a'] });
    assert.deepEqual(commandForm('T', command, [step('S', ['applicant_name'])], { submitLabel: 'Send', public: true }), {
      kind: 'form',
      label: 'T',
      command,
      steps: [{ id: 's', label: 'S', fields: ['applicant_name'] }],
      submitLabel: 'Send',
      public: true,
    });
    assert.deepEqual(commandForm('T', command), { kind: 'form', label: 'T', command });
    assert.deepEqual(commandForm('T', command, { done: { title: 'Done' } }), {
      kind: 'form',
      label: 'T',
      command,
      done: { title: 'Done' },
    });
  });

  test('requires auth and role grants, like the commands it runs', () => {
    assert.throws(
      () => parseTestApp({ name: 'x', views: { finance: finance() } }, 'f', contracts),
      /form views require "auth" and "auth.roles"/,
    );
  });

  // Keys of one object cannot collide, so a duplicate-id check has no input.
  test('the key is a route segment', () => {
    assert.throws(
      () => withViews({ 'Not A Slug': finance() }),
      /views "Not A Slug": a view key is its address, and must be lowercase letters, digits and hyphens/,
    );
  });

  test('every command input is asked on exactly one step, and steps name only command inputs', () => {
    const f = (steps: ReturnType<typeof step>[]) => withViews({ f: commandForm('T', command, steps, { public: true }) });
    assert.throws(() => f([step('One', ['applicant_name', 'dealer_code'])]), /the command input "requested_amount" belongs to no step/);
    assert.throws(
      () => f([step('One', ['applicant_name', 'dealer_code', 'requested_amount', 'extra'])]),
      /step "One" names "extra", which the command does not take/,
    );
    // The shared form parser refuses a field owned twice.
    assert.throws(
      () => f([step('One', ['applicant_name']), step('Two', ['applicant_name', 'dealer_code', 'requested_amount'])]),
      /invalid form declaration/,
    );
  });

  test('the command names no existing record: it creates records', () => {
    const assign = { assignLoan: { target: 'loan' } };
    assert.throws(
      () =>
        parseTestApp({ ...base, views: { ...base.views, finance: { ...finance(), command: 'assignLoan' } } }, 'form fixture', {
          ...contracts,
          ...assign,
        }),
      /names "assignLoan", which acts on an existing record; a form's command creates records and names none/,
    );
  });

  test('the old names are refused by the ordinary unknown-key and unknown-kind refusals', () => {
    assert.throws(
      () => withViews({ finance: { ...finance(), kind: 'intake' } }),
      /views "finance" has a "kind" of "intake"\. A view is one of: list, dashboard, form or landing, written with/,
    );
    const { label, ...rest } = finance();
    assert.throws(
      () => withViews({ finance: { ...rest, title: label } }),
      /views "finance" has no "title"\. It takes: kind, label, path, icon, description, command, steps, style, note, review, submitLabel, done, public, prefillable, resume, draft, abandoned, statusCheck, link, inputs\./,
    );
    assert.throws(() => parseTestApp({ ...base, intake: [] }, 'f'), /has no "intake"\. It takes:/);
    assert.throws(() => withViews({ finance: { ...finance(), sidebar: true } }), /has no "sidebar"/);
    assert.throws(() => withViews({ finance: { ...finance(), done: { banner: 'x' } } }), /"done" has no "banner"/);
  });
});

test("a saved step's id follows the one step rule: the label's slug unless written, the same pattern as a step of fields", async () => {
  const { parseSavedSteps: parse } = await import('../packages/mistri/src/shared/appSavedForms.js');
  const { withCommandCatalog } = await import('../packages/mistri/src/shared/command.js');
  const named = catalogOf(
    Object.fromEntries(['startApplication', 'saveHome', 'a', 'b'].map((id) => [id, { public: true, input: { name: { type: 'text' } } }])),
  );
  const parseSavedSteps = (raw: unknown, at: string) => withCommandCatalog(named, () => parse(raw, at));
  const steps = parseSavedSteps(
    [
      { label: 'About you', command: 'startApplication' },
      { id: 'home_work', label: 'Home', command: 'saveHome' },
    ],
    'steps',
  );
  assert.deepEqual(
    steps.map((step) => step.id),
    ['about-you', 'home_work'],
  );
  assert.throws(() => parseSavedSteps([{ id: '1st', label: 'First', command: 'a' }], 'steps'), /step/);
  assert.throws(
    () =>
      parseSavedSteps(
        [
          { label: 'About you', command: 'a' },
          { label: 'About you', command: 'b' },
        ],
        'steps',
      ),
    /repeats the step id "about-you"/,
  );
});

describe('the intake style', () => {
  const intake = (
    opts: Record<string, unknown> = {},
    steps: unknown[] = [
      step('About you', [['applicant_name', 'dealer_code']], { title: 'Hello', next: 'Go' }),
      step('The loan', ['requested_amount'], { skip: 'Skip' }),
    ],
  ) =>
    commandForm(
      'Apply',
      command,
      steps as never,
      { public: true, style: 'intake', note: { icon: 'shield-check', text: 'Stored securely' }, ...opts } as never,
    );

  test('parses its style, note and review, and serves rows and words on the steps', () => {
    const parsed = form(withViews({ apply: intake({ review: false }) }), 'apply');
    assert.equal(parsed.style, 'intake');
    assert.deepEqual(parsed.note, { icon: 'shield-check', text: 'Stored securely' });
    assert.equal(parsed.review, false);
    assert.deepEqual(parsed.steps?.[0].rows, [['applicant_name', 'dealer_code']]);
    assert.equal(parsed.steps?.[0].title, 'Hello');
    assert.equal(parsed.steps?.[1].skip, 'Skip');
    // A review left alone is the default and is not stored.
    assert.equal(form(withViews({ apply: intake() }), 'apply').review, undefined);
    assert.equal(form(withViews({ finance: finance() }), 'finance').style, undefined);
  });

  test('refuses what it cannot draw', () => {
    assert.throws(() => withViews({ apply: intake({ style: 'wizard' }) }), /"style" that is not 'stepper' or 'intake'/);
    assert.throws(() => withViews({ apply: intake({ note: { text: 'x'.repeat(121) } }) }), /"text" of at most 120/);
    assert.throws(() => withViews({ apply: intake({ note: { icon: 'nope-not-an-icon', text: 'x' } }) }), /icon/);
    assert.throws(() => withViews({ apply: intake({ style: 'stepper' }) }), /has "note", which the intake style takes/);
    assert.throws(() => withViews({ apply: intake({ review: 'no' }) }), /"review" that is not true or false/);
    assert.throws(
      () => withViews({ apply: commandForm('Apply', command, { public: true, style: 'intake' } as never) }),
      /"style", which draws steps/,
    );
    assert.throws(
      () => withViews({ apply: intake({}, [step('One', [['applicant_name', 'dealer_code', 'requested_amount', 'applicant_name']])]) }),
      /at most 3|invalid form declaration/,
    );
  });
});
