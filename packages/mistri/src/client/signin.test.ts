import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import type { Window } from 'happy-dom';
import { showSignIn } from './signin.js';
import { unmountAll } from '../../../kit/src/client/components/mount.js';

const html = readFileSync('packages/kit/src/client/index.html', 'utf8');
/* happy-dom drops every rule inside an `@layer` block (the stylesheets stand
   in layers: style.css names the order), so the base rules this test needs —
   `[hidden]`, the shell's mode rules — are read with their layer taken off.
   Both files are base, so their order within it is kept. */
function unlayered(css: string): string {
  let out = '';
  let at = 0;
  for (const match of css.matchAll(/@layer [\w-]+ \{/g)) {
    out += css.slice(at, match.index);
    let depth = 1,
      i = match.index! + match[0].length;
    const start = i;
    for (; i < css.length && depth; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
    }
    out += css.slice(start, i - 1);
    at = i;
  }
  return out + css.slice(at);
}
const style = unlayered(readFileSync('packages/kit/src/client/style.css', 'utf8'));
const features = unlayered(readFileSync('packages/kit/src/client/features.css', 'utf8'));

beforeEach(() => {
  document.body.innerHTML = html.match(/<body>([\s\S]*?)<\/body>/)![1];
  document.body.className = '';
  const sheet = document.createElement('style');
  sheet.dataset.shellTest = '';
  sheet.textContent = style + features;
  document.head.append(sheet);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Sign-in must not fetch metadata');
    }),
  );
});

afterEach(async () => {
  await act(async () => {
    unmountAll();
  });
  document.querySelector('[data-shell-test]')?.remove();
  document.body.replaceChildren();
  document.body.className = '';
  (window as unknown as Window).happyDOM.setWindowSize({ width: 1024, height: 768 });
  vi.unstubAllGlobals();
});

test.each([390, 1440].flatMap((width) => ['', 'sidebar-hidden', 'app-topnav'].map((prior) => ({ width, prior }))))(
  'sign-in hides all navigation at $width px with prior shell class "$prior"',
  async ({ width, prior }) => {
    (window as unknown as Window).happyDOM.setWindowSize({ width, height: 900 });
    expect(window.matchMedia('(max-width: 700px)').matches).toBe(width <= 700);
    document.body.className = prior;
    // The reveal control is inserted by the explorer's sidebar toggle.
    const reveal = document.createElement('button');
    reveal.className = 'sidebar-reveal';
    reveal.textContent = 'Show tables';
    document.querySelector('.layout')!.prepend(reveal);
    document.getElementById('topnav')!.hidden = false;
    document.getElementById('explain-pane')!.hidden = false;
    document.getElementById('db-label')!.textContent = 'Private database';
    await act(async () => {
      showSignIn({ app: 'Ignition · Assignments', providers: ['email'], signUp: 'invite' });
    });

    expect(document.querySelector('.brand-name')).toHaveTextContent('Ignition · Assignments');
    expect(document.title).toBe('Sign in · Ignition · Assignments');
    expect(screen.getByRole('heading', { name: 'Sign in to Ignition · Assignments' })).toBeVisible();
    expect(document.getElementById('home-button')).toBeDisabled();
    expect(document.getElementById('home-button')).not.toHaveAttribute('title');
    for (const selector of [
      '.sidebar',
      '#table-filter',
      '.sidebar-reveal',
      '#topnav',
      '#querybar',
      '#db-label',
      '#conn-picker',
      '.topbar-actions',
      '#sql-toggle',
      '#search-button',
      '#explain-pane',
    ]) {
      expect(document.querySelector(selector), selector).not.toBeVisible();
    }
    expect(screen.queryByRole('searchbox', { name: 'Filter tables' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveFocus();
    expect(fetch).not.toHaveBeenCalled();
  },
);

test('sign-in replaces the prior mark from its public look and restores the default when omitted', async () => {
  await act(async () => {
    showSignIn({ app: 'Payday', providers: ['email'], signUp: 'invite', look: { logo: 'wallet' } });
  });
  expect(document.querySelector('.brand-mark')).toHaveClass('brand-mark--logo');
  expect(document.querySelector('.brand-mark svg')).toHaveAttribute('aria-hidden', 'true');
  await act(async () => {
    showSignIn({ app: 'Other app', providers: ['email'], signUp: 'invite' });
  });
  expect(document.querySelector('.brand-mark')).not.toHaveClass('brand-mark--logo');
  expect(document.querySelector('.brand-mark svg')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

test('public names are literal text and do not supply private branding or markup', async () => {
  const app = '<img src="/private-logo" onerror="alert(1)">';
  await act(async () => {
    showSignIn({ app, providers: ['email'], signUp: 'invite' });
  });
  expect(document.querySelector('.brand-name')!.textContent).toBe(app);
  expect(screen.getByRole('heading').textContent).toBe(`Sign in to ${app}`);
  expect(document.querySelector('img')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

test.each(['', 'app-mode', 'app-mode app-topnav'])('ordinary shell %j retains its controls', (mode) => {
  document.body.className = mode;
  document.getElementById('topnav')!.hidden = false;
  expect(document.getElementById('home-button')).toBeEnabled();
  expect(document.querySelector('.brand-name')).toHaveTextContent('tablewalk');
  expect(document.querySelector('.topbar-actions')).toBeVisible();
  if (mode.includes('app-topnav')) {
    expect(document.getElementById('topnav')).toBeVisible();
    expect(document.querySelector('.sidebar')).not.toBeVisible();
  } else {
    expect(screen.getByRole('searchbox', { name: 'Filter tables' })).toBeVisible();
  }
  if (!mode) expect(document.getElementById('querybar')).toBeVisible();
});
