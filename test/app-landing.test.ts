/**
 * The public landing in the DSL: what the helpers write, what the parser
 * keeps and refuses by name, the editor's check of the helpers, and — through the real server — that a saved edit is what the next
 * visitor reads.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { typecheck } from './support/tsc.js';
import { applyTo, callToAction, contact, faq, features, hero, landing, signIn, steps, text } from '@mistriwork/mistri/app';
import { LANDING_LIMITS, landingHrefProblem } from '../packages/mistri/src/shared/app.js';
import { parseFooter } from '../packages/mistri/src/shared/appLanding.js';
import { loadApp, reloadApp, type AppHost } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { parseTestApp } from './support/commandCatalog.js';

const WHERE = 'test/app.json';
const base: Record<string, unknown> = {
  name: 'Loans',
  auth: { providers: ['email'], roles: { viewer: { read: true, write: false } } },
  sources: { lending: { connection: 'loans' } },
  resources: { loan: {} },
  views: {
    loans: { kind: 'list', from: 'loan' },
    finance: {
      kind: 'form',
      label: 'Apply',
      public: true,
      steps: [{ id: 'you', label: 'You', fields: ['applicant'] }],
      command: { id: 'apply', version: 1, input: { applicant: { label: 'Name', type: 'text' } } },
    },
  },
  home: 'loans',
  nav: ['loans'],
};
const staffOnly = { name: 'Staff', auth: {}, resources: { loan: {} }, views: { loans: { kind: 'list', from: 'loan' } } };
const HERO = { heading: 'Finance your next car', actions: [{ label: 'Apply', to: 'finance' }] };
/* The landing is the view `welcome`, made the signed-out home before the
   signed-in one, `loans`; a value that is not an object stands as the view
   itself, so its refusal is the view's. */
const withLanding = (value: unknown, app: Record<string, unknown> = base) => ({
  ...app,
  views: { ...(app.views as object | undefined), welcome: value && typeof value === 'object' ? { kind: 'landing', ...value } : value },
  home: [{ view: 'welcome', signedOut: true }, { view: 'loans' }],
});
const parse = (value: unknown, app: Record<string, unknown> = base) => parseTestApp(withLanding(value, app), WHERE).landing?.content;
/* The parsed landing keeps the view a call to action opens as `view`, where it is authored as `to`. */
const parsedForm = <T>(authored: T): T => JSON.parse(JSON.stringify(authored).replace(/"to":/g, '"view":'));
/* The parsed landing is the authored one without its view kind. */
const served = (authored: Record<string, unknown>) => {
  const { kind: _kind, ...rest } = parsedForm(authored);
  return rest;
};
const refused = (value: unknown, pattern: RegExp, app?: Record<string, unknown>) => assert.throws(() => parse(value, app), pattern);
const x = (n: number) => 'x'.repeat(n);
const withSection = (section: unknown) => ({ hero: HERO, sections: [section] });
const withLink = (href: string) => withSection({ kind: 'contact', items: [{ label: 'Link', href }] });

describe('a landing parses to what the author wrote', () => {
  test('the helpers write the plain object, and it parses to itself', () => {
    const built = landing(
      hero('Finance your next car', 'Five minutes.', [applyTo('finance', 'Apply'), signIn('Staff sign in', 'secondary')]),
      [
        steps('How it works', [{ title: 'Apply', description: 'Five minutes.' }]),
        features([{ title: 'Licence', description: 'Yours.' }]),
        faq('Questions', [{ question: 'Real?', answer: 'No.' }]),
        text('One.\n\nTwo.'),
        callToAction('Ready?', [applyTo('finance', 'Start')]),
        contact('Contact', [
          { label: 'Email', href: 'mailto:desk@example.test' },
          { label: 'Call', href: 'tel:+12025550142' },
        ]),
      ],
      { label: 'Loans — apply' },
    );
    assert.deepEqual(built, {
      kind: 'landing',
      label: 'Loans — apply',
      hero: {
        heading: 'Finance your next car',
        description: 'Five minutes.',
        actions: [
          { label: 'Apply', to: 'finance' },
          { label: 'Staff sign in', signIn: true, intent: 'secondary' },
        ],
      },
      sections: [
        { kind: 'steps', title: 'How it works', items: [{ title: 'Apply', description: 'Five minutes.' }] },
        { kind: 'features', items: [{ title: 'Licence', description: 'Yours.' }] },
        { kind: 'faq', title: 'Questions', items: [{ question: 'Real?', answer: 'No.' }] },
        { kind: 'text', text: 'One.\n\nTwo.' },
        { kind: 'callToAction', title: 'Ready?', actions: [{ label: 'Start', to: 'finance' }] },
        {
          kind: 'contact',
          title: 'Contact',
          items: [
            { label: 'Email', href: 'mailto:desk@example.test' },
            { label: 'Call', href: 'tel:+12025550142' },
          ],
        },
      ],
    });
    assert.deepEqual(parse(built), served({ ...built }));
    assert.deepEqual(callToAction('Ready?', 'Bring the quotation.', [signIn('Sign in')]), {
      kind: 'callToAction',
      title: 'Ready?',
      description: 'Bring the quotation.',
      actions: [{ label: 'Sign in', signIn: true }],
    });
  });

  test('strings are trimmed and nothing is added: kinds default in the page, not in the data', () => {
    assert.deepEqual(parse({ hero: { heading: '  Hello  ', actions: [{ label: ' Apply ', to: 'finance' }] } }), {
      hero: { heading: 'Hello', actions: [{ label: 'Apply', view: 'finance' }] },
    });
  });

  test('a sign-in-only landing needs no public form and no access', () => {
    assert.deepEqual(parse({ hero: { heading: 'Staff', actions: [{ label: 'Sign in', signIn: true }] } }, staffOnly), {
      hero: { heading: 'Staff', actions: [{ label: 'Sign in', signIn: true }] },
    });
  });
});

describe('a landing is refused by name', () => {
  test('without auth: an App without sign-in has no signed-out front door', () => {
    const open = { hero: { heading: 'Open', actions: [{ label: 'Sign in', signIn: true }] } };
    assert.throws(
      () => parseTestApp(withLanding(open, { name: 'Open' }), WHERE),
      /a landing view requires "auth"\. An App without sign-in has no signed-out front door/,
    );
  });

  test('a call to action names a public form view the App declares', () => {
    refused(
      { hero: { heading: 'H', actions: [{ label: 'Apply', to: 'loans' }] } },
      /hero, action 1 names the view "loans", which is not a public form view this App declares\. Its public form views: finance\./,
    );
    refused(
      withSection({ kind: 'callToAction', title: 'Go', actions: [{ label: 'Apply', to: 'nope' }] }),
      /section 1 \("callToAction"\), action 1 names the view "nope"/,
    );
    refused({ hero: { heading: 'H', actions: [{ label: 'Apply', to: 'finance' }] } }, /It declares no public form view\./, staffOnly);
  });

  test('links are https://, mailto: or tel: and nothing else', () => {
    for (const href of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<b>x</b>',
      '/relative',
      'relative',
      '//evil.example',
      'http://example.test',
      'https://',
      'https://user:pw@example.test',
      'https://exa mple.test',
      'ftp://example.test',
      'vbscript:x',
      'mailto:',
      'mailto:nobody',
      'tel:',
      'tel:call-me',
      `https://example.test/${x(LANDING_LIMITS.href)}`,
    ]) {
      assert.ok(landingHrefProblem(href.trim()), href);
      refused(withLink(href), /A landing links only to https:\/\/, mailto: or tel: — never a relative path, http:, javascript: or data:\./);
    }
    assert.throws(
      () => parseFooter({ links: [{ label: 'Bad', href: 'javascript:void(0)' }] }, 'ui.footer'),
      /ui\.footer, link 1 has an "href" of "javascript:void\(0\)"/,
    );
    for (const href of [
      'https://example.test',
      'https://example.test/a?b=c#d',
      'HTTPS://EXAMPLE.TEST',
      'mailto:desk@example.test',
      'mailto:desk@example.test?subject=Hello',
      'tel:+12025550142',
      'tel:202-555-0142',
    ]) {
      assert.equal(landingHrefProblem(href), undefined, href);
    }
  });

  test('every string has a ceiling', () => {
    refused({ hero: { ...HERO, heading: x(121) } }, /hero has a "heading" of 121 characters; the most is 120\./);
    refused({ hero: { ...HERO, description: x(601) } }, /hero has a "description" of 601 characters; the most is 600\./);
    refused({ label: x(121), hero: HERO }, /views "welcome" has a "label" of 121 characters/);
    refused({ hero: { ...HERO, actions: [{ label: x(61), to: 'finance' }] } }, /action 1 has a "label" of 61 characters; the most is 60\./);
    refused(
      withSection({ kind: 'features', title: x(121), items: [{ title: 'A', description: 'B' }] }),
      /section 1 \("features"\) has a "title" of 121/,
    );
    refused(withSection({ kind: 'steps', items: [{ title: 'A', description: x(601) }] }), /item 1 has a "description" of 601 characters/);
    refused(
      withSection({ kind: 'faq', items: [{ question: 'Q', answer: x(1201) }] }),
      /question 1 has a "answer" of 1201 characters; the most is 1200\./,
    );
    refused(withSection({ kind: 'text', text: x(2001) }), /has a "text" of 2001 characters; the most is 2000\./);
    assert.throws(() => parseFooter({ text: x(601) }, 'ui.footer'), /ui\.footer has a "text" of 601 characters/);
    refused({ hero: { ...HERO, heading: '   ' } }, /hero has a "heading" that is not text\./);
  });

  test('every list has a ceiling and a floor', () => {
    const action = { label: 'Apply', to: 'finance' };
    const item = { title: 'A', description: 'B' };
    refused({ hero: { ...HERO, actions: [action, action, action, action] } }, /hero has 4 "actions"; the most is 3\./);
    refused({ hero: { ...HERO, actions: [] } }, /hero needs "actions": a list of 1 to 3\./);
    refused(
      { hero: HERO, sections: Array.from({ length: 13 }, () => ({ kind: 'text', text: 'Hi.' })) },
      /views "welcome" has 13 sections; the most is 12\./,
    );
    refused(withSection({ kind: 'features', items: Array.from({ length: 7 }, () => item) }), /has 7 "items"; the most is 6\./);
    refused(
      withSection({ kind: 'faq', items: Array.from({ length: 13 }, () => ({ question: 'Q', answer: 'A' })) }),
      /has 13 "items"; the most is 12\./,
    );
    refused(
      withSection({ kind: 'contact', items: Array.from({ length: 9 }, () => ({ label: 'L', href: 'tel:+12025550142' })) }),
      /has 9 "items"; the most is 8\./,
    );
    refused(withSection({ kind: 'steps', items: [] }), /needs "items": a list of 1 to 6\./);
  });

  test('shapes: unknown keys and kinds, one action target, a title a closing prompt needs', () => {
    refused('front page', /test\/app\.json: views "welcome" is not an object\./);
    refused({ sections: [] }, /views "welcome" needs a "hero": \{ heading, description\?, actions \}\./);
    refused(
      { hero: { ...HERO, subtitle: 'Hi' } },
      /hero has no "subtitle"\. It takes: heading, description, actions, image, layout, search, highlights, badge, tiles, points\./,
    );
    refused(
      { hero: HERO, image: 'car.png' },
      /views "welcome" has no "image"\. "image" belongs inside "presentation" \(cards\) or inside a dashboard section \(note\)\. It takes: kind, label, hero, sections\./,
    );
    refused(
      withSection({ kind: 'gallery', items: [] }),
      /section 1 has a "kind" of "gallery"\. It is one of: features, steps, faq, text, callToAction, contact, view, search\./,
    );
    // The line under a heading is `description`; the word it once was is refused by name.
    refused({ hero: { ...HERO, text: 'Hi' } }, /hero has "text", which is now "description"/);
    refused(withSection({ kind: 'steps', items: [{ title: 'A', text: 'B' }] }), /item 1 has "text", which is now "description"/);
    refused(
      withSection({ kind: 'callToAction', title: 'T', text: 'B', actions: [{ label: 'Sign in', signIn: true }] }),
      /has "text", which is now "description"/,
    );
    refused(withSection({ kind: 'faq', items: [{ title: 'Q', text: 'A' }] }), /question 1 has no "title"\. It takes: question, answer\./);
    refused(withSection({ kind: 'callToAction', actions: [{ label: 'Sign in', signIn: true }] }), /\("callToAction"\) needs a "title"/);
    refused(
      { hero: { ...HERO, actions: [{ label: 'Both', to: 'finance', signIn: true }] } },
      /needs exactly one of "to" \(a public form view this App declares\) or "signIn: true"\./,
    );
    refused({ hero: { ...HERO, actions: [{ label: 'Neither' }] } }, /needs exactly one of "to"/);
    refused({ hero: { ...HERO, actions: [{ label: 'Sign in', signIn: 'yes' }] } }, /has a "signIn" that is not true\./);
    refused(
      { hero: { ...HERO, actions: [{ label: 'Apply', to: 'finance', intent: 'tertiary' }] } },
      /"intent" of "tertiary"\. Use "primary" or "secondary"\./,
    );
    refused(
      { hero: { ...HERO, actions: [{ label: 'Go', href: 'https://example.test' }] } },
      /action 1 has no "href"\. It takes: label, to, signIn, intent\./,
    );
  });
});

test('the helpers are checked in the editor', () => {
  const filename = new URL('./.app-landing-types.ts', import.meta.url).pathname;
  const source = `import { landing, hero, applyTo, signIn, features, steps, faq, contact, callToAction, type AppLandingView, type TypedAppConfig, text, listView } from '@mistriwork/mistri/app';
    type App = TypedAppConfig<{ loan: 'id' | 'amount' }>;
    const front: AppLandingView = landing(hero('H', 'Text.', [applyTo('finance', 'Apply'), signIn('Staff', 'secondary')]), [
      steps('How', [{ title: 'A', description: 'B' }]), features([{ title: 'A', description: 'B' }]), faq([{ question: 'Q', answer: 'A' }]),
      text('Plain.'), callToAction('Ready?', [applyTo('finance', 'Apply')]), contact('Contact', [{ label: 'Email', href: 'mailto:a@example.test' }]),
    ], { label: 'Front' });
    const app: App = { name: 'x', auth: {}, views: { welcome: front, loans: listView('Loan', 'loan') }, home: [{ view: 'welcome', signedOut: true }, { view: 'loans' }] };
    // @ts-expect-error A hero needs its calls to action.
    const noActions = hero('H');
    // @ts-expect-error A call to action is primary or secondary.
    const badKind = signIn('Staff', 'tertiary');
    // @ts-expect-error A FAQ item is a question and an answer.
    const badFaq = faq('Q', [{ title: 'Q', text: 'A' }]);
    // @ts-expect-error A section is one of six kinds.
    const badSection: AppLandingView = landing(hero('H', [signIn('S')]), [{ kind: 'gallery', items: [] }]);
    // @ts-expect-error A link has an href.
    const badLink = contact([{ label: 'Email' }]);
    // @ts-expect-error A closing prompt has a title.
    const badCta: AppLandingView = landing(hero('H', [signIn('S')]), [{ kind: 'callToAction', actions: [signIn('S')] }]);
    // @ts-expect-error An action opens a public form or sign-in, not an arbitrary address.
    const badAction = hero('H', [{ label: 'Go', href: 'https://example.test' }]);
    void [app, noActions, badKind, badFaq, badSection, badLink, badCta, badAction];
  `;
  assert.equal(typecheck(filename, { files: { [filename]: source } }), '');
});

test('a saved edit is what the next visitor reads, and the validator moves with it', { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-landing-reload-'));
  const manifest = (heading: string) =>
    JSON.stringify({
      id: 'loans',
      name: 'Loans',
      auth: {},
      resources: { loan: {} },
      views: {
        welcome: { kind: 'landing', hero: { heading, actions: [{ label: 'Staff sign in', signIn: true }] } },
        loans: { kind: 'list', from: 'loan' },
      },
      home: [{ view: 'welcome', signedOut: true }, { view: 'loans' }],
    });
  writeFileSync(join(dir, 'app.json'), manifest('First words'));
  const loaded = await loadApp(dir);
  const host: AppHost = {
    app: loaded,
    pages: [],
    auth: {
      spec: loaded.app.auth!,
      store: join(dir, 'auth.db'),
      close() {},
      handler: async () => {},
      session: async () => null,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry: new Registry(), bound, apps: [host] });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    const url = `http://${bound.host}:${bound.port}/api/landing`;
    const first = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).landing.hero.heading, 'First words');
    const before = first.headers.get('etag')!;
    assert.match(before, /^"[\w-]{32}"$/);

    writeFileSync(join(dir, 'app.json'), manifest('Second words'));
    assert.equal(await reloadApp(host, dir, []), true);
    const second = await fetch(url, { headers: { 'if-none-match': before }, signal: AbortSignal.timeout(3_000) });
    assert.equal(second.status, 200, 'the old validator no longer matches');
    assert.equal((await second.json()).landing.hero.heading, 'Second words');
    const after = second.headers.get('etag')!;
    assert.notEqual(after, before);
    const unchanged = await fetch(url, { headers: { 'if-none-match': `W/${after}` }, signal: AbortSignal.timeout(3_000) });
    assert.equal(unchanged.status, 304);
    assert.equal(await unchanged.text(), '');
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    rmSync(dir, { recursive: true, force: true });
  }
});

/* An App whose signed-out visitors read some of its resources (auth.public):
   its landing may show a list view's cards, search its filters, and open a
   view the public reads. */
const openApp: Record<string, unknown> = {
  ...base,
  auth: { providers: ['email'], roles: { viewer: { read: true, write: false } }, public: { read: ['loan'] } },
  resources: { loan: {}, branch: {} },
  views: {
    ...(base.views as object),
    cars: { kind: 'list', from: 'loan', filters: ['name', 'amount'], presentation: { kind: 'cards', primary: 'name' } },
    branches: { kind: 'list', from: 'branch' },
  },
  nav: ['loans', 'branches'],
};
const openLanding = (sections: unknown[], actions: unknown[] = [{ label: 'Browse', to: 'cars' }]) => ({
  hero: { heading: 'Find your next car', actions },
  sections,
});

describe('a landing the public may read through shows rows and opens views', () => {
  test('a view section, a search and a call to action that opens a list parse to what was written', () => {
    const sections = [
      { kind: 'search', title: 'Search', view: 'cars', filters: ['name', 'amount'], submitLabel: 'Show loans' },
      { kind: 'view', title: 'Picks', view: 'cars', limit: 6, sort: 'amount desc' },
    ];
    assert.deepEqual(parse(openLanding(sections), openApp), served({ kind: 'landing', ...openLanding(sections) }));
    // A list only the landing reaches is still served as a room: the page draws from it.
    const app = parseTestApp(withLanding(openLanding([{ kind: 'view', view: 'cars' }]), openApp), WHERE);
    assert.ok(Object.hasOwn(app.views, 'cars'));
  });

  test('a call to action opens only a view whose every table the public reads, or a public form', () => {
    refused(
      openLanding([], [{ label: 'Branches', to: 'branches' }]),
      /names the view "branches", which is not a public form view this App declares or a view a signed-out visitor may open\. Its public form views: finance\. Views open to signed-out visitors: loans, cars\./,
      openApp,
    );
    // Without auth.public, the sentence is the one it always was.
    refused(
      openLanding([], [{ label: 'Loans', to: 'loans' }]),
      /names the view "loans", which is not a public form view this App declares\. Its public form views: finance\.$/,
    );
  });

  test('a view section draws a cards list the public reads, a few at a time, sorted by one column', () => {
    refused(openLanding([{ kind: 'view', view: 'loans' }]), /is not drawn as cards/, openApp);
    refused(
      openLanding([{ kind: 'view', view: 'branches' }]),
      /names the view "branches", which is not a list view a signed-out visitor may read\. .* Such list views: loans, cars\./,
      openApp,
    );
    refused(openLanding([{ kind: 'view', view: 'cars', limit: 13 }]), /"limit" that is not a whole number from 1 to 12/, openApp);
    refused(
      openLanding([{ kind: 'view', view: 'cars', sort: 'amount sideways' }]),
      /"sort" that is not one column and a direction/,
      openApp,
    );
    refused(
      openLanding([{ kind: 'view', view: 'cars', show: ['name'] }]),
      /\("view"\) has no "show"\. It takes: kind, title, view, limit, sort/,
      openApp,
    );
    // An App with no public side has no list a signed-out visitor may read.
    refused(openLanding([{ kind: 'view', view: 'loans' }], [{ label: 'Apply', to: 'finance' }]), /This App has none\./);
  });

  test("a search offers the list's own filters, each once, at most six", () => {
    refused(
      openLanding([{ kind: 'search', view: 'cars', filters: ['term'] }]),
      /filter 1 is "term", which is not one of the view "cars"'s filters\. A search offers the list's own filters: name, amount\./,
      openApp,
    );
    refused(openLanding([{ kind: 'search', view: 'cars', filters: ['name', 'name'] }]), /names one filter twice/, openApp);
    refused(openLanding([{ kind: 'search', view: 'cars', filters: [] }]), /needs "filters": a list of 1 to 6/, openApp);
    refused(
      openLanding([{ kind: 'search', view: 'cars', filters: ['name'], submitLabel: x(61) }]),
      /"submitLabel" of 61 characters; the most is 60/,
      openApp,
    );
    refused(
      openLanding([{ kind: 'search', view: 'branches', filters: ['name'] }]),
      /not a list view a signed-out visitor may read/,
      openApp,
    );
  });
});

/* The hero, beyond its words: a photo from a file resource the public reads,
   a layout that places it, a search inside it and a line of highlights. */
describe('a hero with a photo, a search and highlights', () => {
  const files = { content: 'data', name: 'file_name' };
  const heroApp: Record<string, unknown> = {
    ...openApp,
    resources: { ...(openApp.resources as object), site_image: { file: files }, vault: { file: files } },
    auth: { providers: ['email'], roles: { viewer: { read: true, write: false } }, public: { read: ['loan', 'site_image'] } },
  };
  const words = { heading: 'Find your next car', actions: [{ label: 'Browse', to: 'cars' }] };
  const photo = { from: 'site_image', key: 1, alt: 'Three cars in the studio' };

  test('it parses to what was written, and a photo without a layout is split', () => {
    const full = {
      ...words,
      image: photo,
      search: { view: 'cars', filters: ['name'], submitLabel: 'Go' },
      highlights: ['60 cars', '6 dealers'],
    };
    assert.deepEqual(parse({ hero: full }, heroApp)!.hero, parsedForm({ ...full, layout: 'split' }));
    assert.equal(parse({ hero: { ...full, layout: 'overlay' } }, heroApp)!.hero.layout, 'overlay');
    assert.deepEqual(
      parse({ hero: { ...words, highlights: [' 60 cars '] } }, heroApp)!.hero,
      parsedForm({ ...words, highlights: ['60 cars'] }),
    );
    // The list the hero's search opens is served as a room, though only the landing reaches it.
    assert.ok(
      Object.hasOwn(
        parseTestApp(
          withLanding(
            { hero: { ...words, actions: [{ label: 'Apply', to: 'finance' }], search: { view: 'cars', filters: ['name'] } } },
            heroApp,
          ),
          WHERE,
        ).views,
        'cars',
      ),
    );
  });

  test('a photo comes from a file resource the public reads, by key, with alt text', () => {
    refused(
      { hero: { ...words, image: { ...photo, from: 'vault' } } },
      /takes its photo from "vault", which is not a resource of files a signed-out visitor may read\. .* Such resources: site_image\./,
      heroApp,
    );
    refused({ hero: { ...words, image: { ...photo, from: 'loan' } } }, /not a resource of files a signed-out visitor may read/, heroApp);
    refused({ hero: { ...words, image: { from: 'site_image', key: 1 } } }, /image needs a "alt"/, heroApp);
    refused({ hero: { ...words, image: { from: 'site_image', alt: 'x' } } }, /needs a "key"/, heroApp);
    refused({ hero: { ...words, image: { ...photo, alt: x(201) } } }, /"alt" of 201 characters; the most is 200/, heroApp);
    refused({ hero: { ...words, image: { ...photo, src: '/x.png' } } }, /image has no "src"/, heroApp);
    // An App with no public side has no photo a signed-out visitor may see.
    refused({ hero: { ...HERO, image: photo } }, /This App has none\./);
  });

  test('a layout needs a photo and is split or overlay; the search and the highlights are held like their sections', () => {
    refused({ hero: { ...words, layout: 'overlay' } }, /has a "layout" and no "image"/, heroApp);
    refused({ hero: { ...words, image: photo, layout: 'full-bleed' } }, /"layout" of "full-bleed"\. Use "split" or "overlay"/, heroApp);
    refused(
      { hero: { ...words, search: { view: 'cars', filters: ['term'] } } },
      /hero, search, filter 1 is "term", which is not one of the view "cars"'s filters/,
      heroApp,
    );
    refused(
      { hero: { ...words, search: { view: 'branches', filters: ['name'] } } },
      /not a list view a signed-out visitor may read/,
      heroApp,
    );
    refused({ hero: { ...words, search: { view: 'cars', filters: ['name'], title: 'Search' } } }, /search has no "title"/, heroApp);
    refused({ hero: { ...words, highlights: ['a', 'b', 'c', 'd', 'e'] } }, /5 "highlights"; the most is 4/, heroApp);
    refused({ hero: { ...words, highlights: [x(61)] } }, /highlight 1 has a "0" of 61 characters; the most is 60/, heroApp);
  });

  test('photo tiles, a badge and icon rows: two to four tiles the public reads, a short badge, up to four rows', () => {
    const tiles = [photo, { ...photo, key: 2, alt: 'The forecourt at dusk' }, { ...photo, key: 3, alt: 'A dealer’s desk' }];
    const blocks = {
      ...words,
      tiles,
      badge: { text: ' Decisions in minutes ', icon: 'lightning' },
      points: [
        { icon: 'shield-check', text: 'No effect on your credit score' },
        { icon: 'clock', text: 'Five minutes to apply' },
      ],
    };
    assert.deepEqual(
      parse({ hero: blocks }, heroApp)!.hero,
      parsedForm({ ...blocks, badge: { text: 'Decisions in minutes', icon: 'lightning' } }),
    );
    assert.deepEqual(parse({ hero: { ...words, badge: { text: 'New' } } }, heroApp)!.hero.badge, { text: 'New' });
    refused({ hero: { ...words, tiles: [photo] } }, /"tiles" that are not a list of 2 to 4 photos; one photo is "image"/, heroApp);
    refused({ hero: { ...words, tiles: [photo, photo, photo, photo, photo] } }, /not a list of 2 to 4 photos/, heroApp);
    refused({ hero: { ...words, tiles: [photo, { ...photo, from: 'vault' }] } }, /tile 2 takes its photo from "vault"/, heroApp);
    refused({ hero: { ...words, image: photo, tiles } }, /an "image" and "tiles": one wide photo, or two to four tiles, not both/, heroApp);
    refused({ hero: { ...words, tiles, layout: 'overlay' } }, /"tiles" and a "layout": tiles sit beside the words/, heroApp);
    refused({ hero: { ...words, badge: { text: x(41) } } }, /badge has a "text" of 41 characters; the most is 40/, heroApp);
    refused({ hero: { ...words, badge: 'New' } }, /badge is not an object/, heroApp);
    refused({ hero: { ...words, badge: { text: 'New', icon: 'unicorn' } } }, /unicorn/, heroApp);
    refused({ hero: { ...words, points: [{ text: 'Fast' }] } }, /point 1 needs an "icon"/, heroApp);
    refused(
      { hero: { ...words, points: Array.from({ length: 5 }, () => ({ icon: 'clock', text: 'Fast' })) } },
      /5 "points"; the most is 4/,
      heroApp,
    );
    refused(
      { hero: { ...words, highlights: ['60 cars'], points: [{ icon: 'clock', text: 'Fast' }] } },
      /"highlights" and "points": one quiet line of words, or rows with icons, not both/,
      heroApp,
    );
  });

  test('the hero helper takes its options last, with or without a description', () => {
    assert.deepEqual(hero('H', [applyTo('finance', 'Apply')], { highlights: ['a'] }), {
      heading: 'H',
      actions: [{ label: 'Apply', to: 'finance' }],
      highlights: ['a'],
    });
    assert.deepEqual(hero('H', 'T', [signIn('In')], { layout: 'overlay' }), {
      heading: 'H',
      description: 'T',
      actions: [{ label: 'In', signIn: true }],
      layout: 'overlay',
    });
  });
});
