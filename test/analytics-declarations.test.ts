import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { analyticsCatalog, analyticsProblems, ANALYTICS_LIMITS } from '../packages/mistri/src/shared/appAnalytics.js';
import type { AppDef } from '../packages/mistri/src/shared/appModel.js';
import { namedCommands, parseTestApp } from './support/commandCatalog.js';
import { validationCode } from '../packages/mistri/src/server/build/checkProblems.js';

const analytics = () => ({
  collect: ['views', 'commands', 'forms'],
  events: { 'compare-opened': { fields: ['vehicleId'] } },
  funnels: {
    apply: {
      unit: 'visitor',
      conversionWindow: '72 hours',
      steps: [{ view: 'items' }, { form: 'apply', step: 'contact' }, { form: 'apply' }, { command: 'close' }, { event: 'compare-opened' }],
    },
  },
});
const raw = (extra: Record<string, unknown> = {}) => ({
  name: 'Shop',
  auth: { roles: { operator: { read: true, commands: ['apply'] } } },
  resources: { item: { actions: { close: { label: 'Close', command: { id: 'close', version: 1, target: 'item', input: {} } } } } },
  views: {
    items: { kind: 'list', from: 'item' },
    apply: {
      kind: 'form',
      label: 'Apply',
      command: { id: 'apply', version: 1, input: { email: { type: 'text' }, note: { type: 'text' } } },
      steps: [
        { id: 'contact', label: 'Contact', fields: ['email'] },
        { id: 'review', label: 'Review', fields: ['note'] },
      ],
    },
  },
  home: 'items',
  nav: ['items', 'apply'],
  analytics: analytics(),
  ...extra,
});
const parse = (value: unknown) => parseTestApp(value, 'analytics-fixture');
const ajv = new Ajv2020({ strict: true, strictTypes: false, strictRequired: false, allErrors: true });
for (const name of ['theme', 'page'])
  ajv.addSchema(JSON.parse(readFileSync(new URL(`../packages/mistri/schema/${name}.schema.json`, import.meta.url), 'utf8')));
const validate = ajv.compile(JSON.parse(readFileSync(new URL('../packages/mistri/schema/app.schema.json', import.meta.url), 'utf8')));

test('a declaration is checked against the JSON schema and normalized frozen', () => {
  const authored = raw();
  assert.equal(validate(namedCommands(authored).app), true, ajv.errorsText(validate.errors));
  const app = parse(authored);
  assert.deepEqual(app.analytics!.collect, ['views', 'commands', 'forms']);
  assert.deepEqual(app.analytics!.events!['compare-opened'].fields, ['vehicleId']);
  assert.equal(app.analytics!.funnels!.apply.steps.length, 5);
  assert.ok(Object.isFrozen(app.analytics!.funnels!.apply.steps[0]));
  authored.analytics.collect.pop();
  assert.equal(app.analytics!.collect!.length, 3);
});

test('an App without the key has no analytics, and the closed shapes are refused', () => {
  const { analytics: _gone, ...none } = raw();
  assert.equal(parse(none).analytics, undefined);
  const bad = (change: (a: ReturnType<typeof analytics>) => unknown, pattern: RegExp) => {
    const a = analytics();
    assert.throws(() => parse(raw({ analytics: change(a) ?? a })), pattern);
  };
  bad((a) => ({ ...a, collect: ['clicks'] }), /collect is a list/);
  bad((a) => ({ ...a, track: true }), /has "track"/);
  bad((a) => {
    a.funnels.apply.unit = 'cookie' as never;
  }, /unit is "subject" or "visitor"/);
  bad((a) => {
    a.funnels.apply.conversionWindow = '0 hours';
  }, /conversionWindow/);
  bad((a) => {
    a.funnels.apply.conversionWindow = `${ANALYTICS_LIMITS.windowHours + 1} hours`;
  }, /conversionWindow/);
  bad((a) => {
    a.funnels.apply.steps = [{ view: 'items' }] as never;
  }, /2 to 10 steps/);
  bad((a) => {
    a.funnels.apply.steps[0] = { view: 'items', command: 'x' } as never;
  }, /exactly one of/);
  bad((a) => {
    a.events['compare-opened'].fields = ['a b'];
  }, /distinct field names/);
  bad((a) => {
    a.collect = ['views', 'actions'];
  }, /collect has "actions", which is now "commands"/);
  bad((a) => {
    a.funnels.apply.steps[3] = { action: 'close' } as never;
  }, /has "action", which is now "command"/);
});

test('a step that names nothing the App has is analytics-unknown-step', () => {
  for (const step of [{ view: 'nope' }, { command: 'nope' }, { form: 'nope' }, { form: 'apply', step: 'nope' }, { event: 'nope' }]) {
    const a = analytics();
    a.funnels.apply.steps[1] = step as never;
    // A business event is not visible to the check, so a bare event name is judged only when the caller can see them.
    if ('event' in step) continue;
    assert.throws(
      () => parse(raw({ analytics: a })),
      (error: Error) => validationCode(error.message) === 'analytics-unknown-step' && /does not declare/.test(error.message),
    );
  }
  const a = analytics();
  a.funnels.apply.steps[1] = { event: 'nope' } as never;
  const app = parse(raw({ analytics: a }));
  const catalog = {
    views: new Set(['items']),
    commands: new Set<string>(),
    forms: new Map(),
    businessEvents: new Set(['application.submitted']),
  };
  const problems = analyticsProblems(app.analytics!, catalog, 'x');
  assert.ok(problems.some((problem) => /event "nope"/.test(problem) && /analytics-unknown-step/.test(problem)));
});

test('a step whose kind is not collected is analytics-not-collected', () => {
  for (const [kind, expected] of [
    ['views', 'view'],
    ['commands', 'command'],
    ['forms', 'form'],
  ] as const) {
    const a = analytics();
    a.collect = a.collect.filter((each) => each !== kind);
    assert.throws(
      () => parse(raw({ analytics: a })),
      (error: Error) => validationCode(error.message) === 'analytics-not-collected' && error.message.includes(`counts ${expected}s`),
    );
  }
  const a = analytics();
  delete (a as { collect?: unknown }).collect;
  assert.throws(() => parse(raw({ analytics: a })), /analytics-not-collected/);
});

test('a custom event that is also a business event is analytics-name-clash', () => {
  const app = parse(raw());
  const catalog = {
    views: new Set(['items']),
    commands: new Set(['close']),
    forms: new Map([['apply', ['contact']]]),
    businessEvents: new Set(['compare-opened']),
  };
  const problems = analyticsProblems(app.analytics!, catalog, 'x');
  assert.ok(problems.some((problem) => validationCode(problem) === 'analytics-name-clash'));
});

test('features mirror the key: collect unions, names are declared once', () => {
  const { analytics: _drop, ...base } = raw();
  const app = parse({
    ...base,
    analytics: { collect: ['views'] },
    features: [
      { id: 'discovery', analytics: { collect: ['views', 'commands'], events: { 'compare-opened': { fields: [] } } } },
      {
        id: 'apply',
        analytics: {
          collect: ['forms'],
          funnels: { apply: { unit: 'visitor', conversionWindow: '24 hours', steps: [{ view: 'items' }, { form: 'apply' }] } },
        },
      },
    ],
  });
  assert.deepEqual([...app.analytics!.collect!].sort(), ['commands', 'forms', 'views']);
  assert.ok(app.analytics!.events!['compare-opened'] && app.analytics!.funnels!.apply);
  assert.throws(
    () => parse({ ...base, analytics: analytics(), features: [{ id: 'again', analytics: { events: { 'compare-opened': {} } } }] }),
    (error: Error) =>
      validationCode(error.message) === 'analytics-name-clash' && /declared by the App and features "again"/.test(error.message),
  );
  assert.throws(() => parse({ ...base, features: [{ id: 'bad', analytics: { collect: 'views' } }] }), /collect must be a list/);
});

test('a funnel id and a custom event name are spelled as a view id is, and the landing is a view step', () => {
  for (const [events, funnels] of [
    [{ compareOpened: {} }, {}],
    [{ compare_opened: {} }, {}],
    [{}, { Apply: analytics().funnels.apply }],
    [{}, { apply_now: analytics().funnels.apply }],
  ] as const) {
    assert.throws(
      () =>
        parse(
          raw({
            analytics: {
              ...analytics(),
              events: { ...events, 'compare-opened': { fields: ['vehicleId'] } },
              funnels: { apply: analytics().funnels.apply, ...funnels },
            },
          }),
        ),
      /is not an id of lowercase letters, digits and "-", as a view id is/,
    );
  }
  for (const name of ['compareOpened', 'Apply', 'apply_now'])
    assert.equal(
      validate(namedCommands(raw({ analytics: { ...analytics(), funnels: { [name]: analytics().funnels.apply } } })).app),
      false,
    );
  const catalog = analyticsCatalog({ views: {}, landing: { view: 'welcome', content: {} } } as unknown as AppDef);
  assert.ok(catalog.views.has('welcome'));
  const a = analytics();
  a.funnels.apply.steps[0] = { view: 'welcome' };
  const judged = (views: ReadonlySet<string>) =>
    analyticsProblems(a as never, { views, commands: new Set(['close']), forms: new Map([['apply', ['contact']]]) }, 'x');
  assert.deepEqual(judged(catalog.views), []);
  assert.match(judged(new Set()).join('\n'), /view "welcome".*analytics-unknown-step/);
});
