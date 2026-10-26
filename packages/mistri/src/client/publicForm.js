/**
 * A public form, as the vanilla client reaches it: the address, the one
 * read, and the crossing into React. Boot asks `publicFormRoute` (publicRoutes.js) before it
 * asks who-am-I, because the answer decides whether there is a session to
 * look for at all — a public form is open to everyone, so an applicant is
 * never sent to sign in, and someone signed in submits it as the public too.
 */
import { createElement } from 'react';
import { applyBrandLogo, headBrandingMark } from './appBrand.js';
import { $ } from '@mistriwork/kit/client/core.js';
import { isMounted, mount } from '@mistriwork/kit/client/components/mount.js';
import { takeServerDrawing } from './serverDrawing.js';
import { FormSurface, formArrives, submitPublicForm } from './components/FormSurface.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { showSignIn } from './signin.js';
import { say } from './copy/public/publicForm.js';
import { served, shown } from '@mistriwork/kit/client/addressMount.js';
import { firstPaintRead } from '@mistriwork/kit/client/firstPaint.js';
import { setTabTitle, shellBody, shellQuery } from '@mistriwork/kit/client/shellHost.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';

/* Fetched when one is shown: FormDialog brings this module into the App
   shell, whose first paint no saved form is ever on. */
const SavedFormSurface = onDemand(() => import('./components/SavedFormSurface.js'), 'SavedFormSurface');
/* A saved form's status check and account screen, each its own page under the form's address. */
const FormStatusSurface = onDemand(() => import('./components/FormStatusSurface.js'), 'FormStatusSurface');
const FormClaimSurface = onDemand(() => import('./components/FormClaimSurface.js'), 'FormClaimSurface');
const PlacedFormSurface = onDemand(() => import('./components/PlacedFormSurface.js'), 'PlacedFormSurface');
/** @type {typeof import('./publicPlacement.js') | undefined} */
let placements;

/**
 * The App's own sign-in, drawn where a saved form's page stands; once there
 * is a session the page reloads to itself (SignIn.tsx), so the check or the
 * question it was on comes back signed in. The door's shape is who-am-I's.
 * @param {string} back the form's own address, the door's way back
 * @param {{ start?: 'up'; lead?: string }} opening
 */
async function signInHere(back, opening) {
  const res = await fetchServer('/api/whoami', { credentials: 'same-origin', signal: AbortSignal.timeout(15_000) });
  const me = await res.json();
  if (!me?.signIn) return;
  showSignIn(me.signIn, { href: back }, opening);
}

/**
 * The staff door, on a form served as the App's home: a quiet Sign in at the
 * top bar's end, as a public App's visitor has one (app.js, showAccount).
 * The App's root is the form there, so without it staff had to know to type
 * `/{app}/sign-in`. Not on the form's own address, `/{app}/form/{key}`: that
 * is a link handed to applicants, drawn before anyone is asked who they are,
 * and its saved flows offer their own sign-in where one is wanted.
 * @param {string} appId
 */
function offerSignIn(appId) {
  const bar = shellQuery('.topbar');
  if (!bar || bar.querySelector('.public-sign-in')) return;
  const link = document.createElement('a');
  link.className = 'ghost account-sign-in public-sign-in';
  link.href = shown(`/${encodeURIComponent(appId)}/sign-in`);
  link.textContent = say('common.signIn');
  bar.append(link);
}

/**
 * Fetch one public form's presentation. `undefined` when the server has no
 * public forms at all, so this address is not one and boot carries on; a
 * throw, with the sentence to show, for a form this App does not serve to
 * everyone — a mistyped key, or a signed-in form's — or a read that failed.
 * Never a sign-in prompt.
 * @param {string} id
 * @param {{ appId?: string; fresh?: boolean }} [options]
 * @returns {Promise<{ app: { id: string; name: string; logo?: import('@mistriwork/engine/shared/appIcons.js').AppIconName; icons?: Record<string, import('@mistriwork/engine/shared/iconGlyphs.js').IconGlyph>; theme?: import('../shared/app.js').AppTheme; customThemes?: import('@mistriwork/engine/shared/theme.js').ThemeDefinition[] }; form: import('./components/FormSurface.js').FormPresentation; placement?: import('../shared/publicPlacement.js').PublicFormPlacement } | undefined>}
 */
export async function loadPublicForm(id, options = {}) {
  const retained = placements?.retainedPublicForm(id, options.appId);
  if (retained) return retained;
  /* The page arrived with it (firstPaint.ts): a form's page asks nothing. */
  const carried = options.fresh ? undefined : firstPaintRead('GET', `/api/forms/${encodeURIComponent(id)}`)?.body;
  if (carried && typeof carried === 'object' && 'form' in carried && !('placement' in carried)) {
    // What the form asks beyond its fields — the stepper and its sheets, the draft's logic, live lines — comes with
    // it, so its first frame is whole, and a form that asks none of it fetches nothing (FormSurface.tsx formArrives).
    await formArrives(/** @type {any} */ (carried).form);
    return /** @type {any} */ (carried);
  }
  /* A tenant's link carries its intake address (`?via=…`): the read carries it on, so a choice from a table is
     offered that tenant's rows (server tenant/tenantPublicChoices.ts). */
  const via = new URLSearchParams(window.location.search).get('via');
  const res = await fetchServer(`/api/forms/${encodeURIComponent(id)}${via ? `?${new URLSearchParams({ via })}` : ''}`, {
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  /** @type {Record<string, any>} */
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* the status is the answer */
  }
  if (res.ok && data && typeof data === 'object' && 'form' in data) {
    if (data.form?.id !== id || (options.appId && data.app?.id !== options.appId)) throw new Error(say('thereIsNoSuch'));
    if ('placement' in data) {
      placements ??= await import('./publicPlacement.js');
      return placements.preparePublicPlacement(/** @type {any} */ (data));
    }
    if (data.form) await formArrives(data.form);
    return /** @type {any} */ (data);
  }
  if (res.status === 404 && data?.code !== 'no_such_form') return undefined;
  throw new Error(
    res.status === 404 || res.status === 401
      ? say('thereIsNoSuch')
      : String(data?.error || say('theFormCouldNotBeLoaded', { status: res.status })),
  );
}

/**
 * Draw the public form into the content pane, in the App's name. The shell
 * chrome is hidden by class; the brand shows the App, not the tool.
 * @param {NonNullable<Awaited<ReturnType<typeof loadPublicForm>>>} prepared
 * @param {'status' | 'claim'} [page] a saved form's status check or account screen, under its address
 * @param {{ signIn?: boolean }} [options] `signIn`: the form is the App's home, to someone signed out of an App that signs people in
 * @returns {boolean} whether the address is one this form serves
 */
export function showPublicForm(prepared, page, options = {}) {
  const { app, form } = prepared;
  /** @type {any} */
  const saved = form;
  if (page === 'status' && !saved.save?.statusCheck) return false;
  if (page === 'claim' && !saved.save?.link?.sameDevice) return false;
  shellBody().classList.add('app-mode', 'public-form-mode');
  const brand = shellQuery('.brand-name');
  if (brand) brand.textContent = app.name;
  applyBrandLogo(
    shellQuery('.brand-mark'),
    /** @type {any} */ (app).theme?.branding?.mark ?? headBrandingMark() ?? app.logo,
    app.name,
    app.icons,
  );
  // An intake form's page has no heading: its label is the tab's title (docs/design.md).
  setTabTitle(form.style === 'intake' ? form.label : `${form.label} · ${app.name}`);
  const home = $('home-button');
  if (home instanceof HTMLButtonElement) {
    home.disabled = true;
    home.removeAttribute('title');
  }
  if (options.signIn) offerSignIn(app.id);
  const host = $('content');
  if (!isMounted(host) && !(host.getAttribute('data-ssr') === 'form' && !page && !prepared.placement && !(form.save && form.steps)))
    host.replaceChildren();
  /* A tenant publishes its form with its intake address, `?via=…`; the
     submission carries it on, as it was, for the server to resolve. Nothing
     on this page reads or depends on it. */
  const via = new URLSearchParams(window.location.search).get('via') ?? undefined;
  // As the browser shows it (addressMount.js): every use is a link.
  const base = shown(`/${encodeURIComponent(app.id)}/form/${encodeURIComponent(form.id)}`);
  if (prepared.placement) {
    if (page) return false;
    mount(host, createElement(PlacedFormSurface, { prepared, review: Boolean(form.steps?.length) }));
    return true;
  }
  if (page === 'status') {
    setTabTitle(say('checkYourApplicationName', { name: app.name }));
    mount(
      host,
      createElement(FormStatusSurface, {
        form: saved,
        appName: app.name,
        onSignIn: () => void signInHere(`${base}/status`, { lead: say('signInToAddYourApplication') }),
      }),
    );
    return true;
  }
  if (page === 'claim') {
    setTabTitle(say('addYourApplication', { name: app.name }));
    const start = new URLSearchParams(window.location.search).get('account') === 'new' ? 'up' : undefined;
    mount(
      host,
      createElement(FormClaimSurface, {
        form,
        appName: app.name,
        ...(saved.save?.statusCheck ? { statusHref: `${base}/status` } : {}),
        onSignIn: () => void signInHere(base, { ...(start ? { start } : {}), lead: say('signInToAddTheApplication') }),
      }),
    );
    return true;
  }
  // A form saved on every step draws its own stepper, review and leave guard.
  if (form.save && form.steps) {
    mount(
      host,
      createElement(SavedFormSurface, {
        form: /** @type {import('./components/SavedFormSurface.js').SavedFormPresentation} */ (form),
        appName: app.name,
        base,
      }),
    );
    return true;
  }
  // With steps, the last one reviews every answer from this page's memory before the one submit.
  mount(
    host,
    createElement(FormSurface, {
      form,
      appName: app.name,
      review: Boolean(form.steps?.length),
      // A reference input's choices: what the App opens to a signed-out visitor, read as one.
      visitor: { app: app.id, ...(via ? { via } : {}) },
      submit: (submission, input, guard) => submitPublicForm(form.id, submission, input, via, guard),
      // Once received, a quiet way back to the App's home; none where this form is that home (the way back is itself).
      ...(options.signIn ? {} : { homeHref: shown(`/${encodeURIComponent(app.id)}`) }),
    }),
    // The server drew the form as it opens (server/publicRender.ts): taken over where it stands.
    takeServerDrawing(host, 'form'),
  );
  return true;
}
