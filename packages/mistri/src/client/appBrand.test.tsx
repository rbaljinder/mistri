import { afterEach, expect, test, vi } from 'vitest';
import { act } from '@testing-library/react';
import { unmountAll } from '../../../kit/src/client/components/mount.js';
import { applyBrandLogo, brandInitial } from './appBrand.js';

afterEach(() => {
  act(() => {
    unmountAll();
  });
  document.body.replaceChildren();
});

test('renders an authored App icon and replaces it cleanly when the logo is omitted', async () => {
  const host = document.createElement('span');
  host.className = 'brand-mark';
  document.body.append(host);

  await act(async () => {
    applyBrandLogo(host, 'car');
  });
  expect(host).toHaveClass('brand-mark--logo');
  expect(host).toHaveAttribute('aria-hidden', 'true');
  expect(host.querySelector('svg')).toHaveClass('brand-logo');
  expect(host.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

  await act(async () => {
    applyBrandLogo(host);
  });
  expect(host).not.toHaveClass('brand-mark--logo');
  expect(host.querySelector('svg')).toBeNull();
  expect(host).toHaveAttribute('aria-hidden', 'true');
});

test('unknown logo values use the linked-node fallback', async () => {
  const host = document.createElement('span');
  host.className = 'brand-mark';
  document.body.append(host);

  await act(async () => {
    applyBrandLogo(host, 'not-an-app-icon');
  });
  expect(host).not.toHaveClass('brand-mark--logo');
  expect(host.querySelector('svg')).toBeNull();
});

test("an App with no logo is its own initial, never mistri's mark, and the tab icon follows it", async () => {
  const icon = document.createElement('link');
  icon.rel = 'icon';
  icon.href = 'data:image/svg+xml,original';
  document.head.append(icon);
  const host = document.createElement('span');
  host.className = 'brand-mark';
  document.body.append(host);

  expect(brandInitial('  inventory ')).toBe('I');
  await act(async () => {
    applyBrandLogo(host, undefined, 'Inventory');
  });
  expect(host).toHaveClass('brand-mark--initial');
  expect(host).toHaveTextContent('I');
  expect(decodeURIComponent(icon.href)).toContain('>I</text>');

  await act(async () => {
    applyBrandLogo(host, 'car', 'Inventory');
  });
  expect(host).not.toHaveClass('brand-mark--initial');
  expect(host).toHaveClass('brand-mark--logo');
  expect(decodeURIComponent(icon.href)).toContain('<svg');

  // The database browser names no App: its own mark, and the page's own icon back.
  await act(async () => {
    applyBrandLogo(host);
  });
  expect(host).not.toHaveClass('brand-mark--initial');
  expect(host).toBeEmptyDOMElement();
  expect(icon.getAttribute('href')).toBe('data:image/svg+xml,original');
  icon.remove();
});

test("a tenant's logo is drawn in a fixed box from the App's own logo address only, and the tab icon follows it", async () => {
  const icon = document.createElement('link');
  icon.rel = 'icon';
  icon.href = 'data:image/svg+xml,original';
  document.head.append(icon);
  const host = document.createElement('span');
  host.className = 'brand-mark';
  document.body.append(host);
  const src = `/api/branding/logo/${'a'.repeat(64)}`;

  await act(async () => {
    applyBrandLogo(host, { src }, 'North Co');
  });
  expect(host).toHaveClass('brand-mark--image');
  const image = host.querySelector('img');
  expect(image).toHaveAttribute('width', '96');
  expect(image).toHaveAttribute('height', '24');
  expect(image?.getAttribute('src')).toMatch(new RegExp(`${src}$`));
  expect(icon.getAttribute('href')).toMatch(new RegExp(`${src}$`));

  // Any other address is not a tenant's logo: the App's initial stands.
  for (const forged of ['https://evil.example/x.png', 'javascript:alert(1)', `/api/branding/logo/${'a'.repeat(63)}`, `${src}?x=1`]) {
    await act(async () => {
      applyBrandLogo(host, { src: forged }, 'North Co');
    });
    expect(host).not.toHaveClass('brand-mark--image');
    expect(host.querySelector('img')).toBeNull();
    expect(host).toHaveTextContent('N');
  }
  icon.remove();
});

test("a tenant's dark logo is drawn beside its logo for a dark bar, and only from the App's own logo address", async () => {
  const host = document.createElement('span');
  host.className = 'brand-mark';
  document.body.append(host);
  const src = `/api/branding/logo/${'a'.repeat(64)}`;
  const dark = `/api/branding/logo/${'b'.repeat(64)}`;

  await act(async () => {
    applyBrandLogo(host, { src, dark }, 'North Co');
  });
  const [day, night] = [...host.querySelectorAll('img')];
  expect(day?.getAttribute('src')).toMatch(new RegExp(`${src}$`));
  expect(night).toHaveClass('brand-image--dark');
  expect(night?.getAttribute('src')).toMatch(new RegExp(`${dark}$`));

  // A dark address that is not the App's own is not drawn: the one logo stands, as it does with none.
  await act(async () => {
    applyBrandLogo(host, { src, dark: 'https://evil.example/x.png' }, 'North Co');
  });
  expect(host.querySelectorAll('img')).toHaveLength(1);
  host.remove();
});

test("an App's own picture is drawn in the logo's fixed box, its dark one by night, and its mark in the tab", async () => {
  const icon = document.createElement('link');
  icon.rel = 'icon';
  icon.href = 'data:image/svg+xml,original';
  document.head.append(icon);
  const host = document.createElement('span');
  host.className = 'brand-mark';
  document.body.append(host);
  const logo = {
    src: './brand/acme.png',
    href: '/acme/_brand/acme-0123456789ab.png',
    dark: './brand/acme-night.svg',
    darkHref: '/acme/_brand/acme-night-0123456789ab.svg',
    mark: './brand/mark.png',
    markHref: '/acme/_brand/mark-0123456789ab.png',
  };
  await act(async () => {
    applyBrandLogo(host, logo, 'Acme');
  });
  expect(host).toHaveClass('brand-mark--image');
  // Decorative: the App's name beside it is the label.
  expect(host).toHaveAttribute('aria-hidden', 'true');
  const [day, night] = [...host.querySelectorAll('img')];
  expect(day!.getAttribute('src')).toMatch(/\/acme\/_brand\/acme-0123456789ab\.png$/);
  expect(night!.getAttribute('src')).toMatch(/\/acme\/_brand\/acme-night-0123456789ab\.svg$/);
  expect(night).toHaveClass('brand-image--dark');
  expect(day).toHaveAttribute('width', '96');
  expect(icon.getAttribute('href')).toMatch(/\/acme\/_brand\/mark-0123456789ab\.png$/);
  // Without a mark the tab shows the picture itself.
  await act(async () => {
    applyBrandLogo(host, { src: logo.src, href: logo.href }, 'Acme');
  });
  expect(host.querySelectorAll('img')).toHaveLength(1);
  expect(icon.getAttribute('href')).toMatch(/\/acme\/_brand\/acme-0123456789ab\.png$/);
  // Only the App's own address is drawn: anything else the payload says is the App's initial.
  await act(async () => {
    applyBrandLogo(host, { src: logo.src, href: 'https://elsewhere.example/acme.png' }, 'Acme');
  });
  expect(host.querySelector('img')).toBeNull();
  expect(host).toHaveClass('brand-mark--initial');
  icon.remove();
});

test('an App mounted at the root, or under a base, draws its picture where the browser reaches it', async () => {
  const logo = {
    src: './brand/acme.png',
    dark: './brand/night.svg',
    href: '/acme/_brand/acme-0123456789ab.png',
    darkHref: '/acme/_brand/night-0123456789ab.svg',
  };
  for (const [mount, src, dark] of [
    [{ base: '', apps: { acme: '' } }, '/_brand/acme-0123456789ab.png', '/_brand/night-0123456789ab.svg'],
    [{ base: '/tools', apps: { acme: 'acme' } }, '/tools/acme/_brand/acme-0123456789ab.png', '/tools/acme/_brand/night-0123456789ab.svg'],
  ] as const) {
    const meta = document.createElement('meta');
    meta.name = 'mistri-mount';
    meta.content = JSON.stringify(mount);
    document.head.append(meta);
    try {
      vi.resetModules();
      const brand = await import('./appBrand.js');
      const host = document.createElement('span');
      host.className = 'brand-mark';
      document.body.append(host);
      await act(async () => {
        brand.applyBrandLogo(host, logo);
      });
      const [light, night] = host.querySelectorAll('img');
      expect(light).toHaveAttribute('src', src);
      expect(night).toHaveAttribute('src', dark);
    } finally {
      meta.remove();
      act(() => {
        unmountAll();
      });
      document.body.replaceChildren();
    }
  }
});
