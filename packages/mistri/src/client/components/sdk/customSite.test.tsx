/**
 * Client component tests for the custom-site additions:
 *   - `<Value row>` & `useFormat().column` / `money({ round: true })`
 *   - `<Photos>` single-record gallery with aspect ratio & thumbs
 *   - `<SiteHeader>` & `<AppFooter>` public site chrome (`ui.site`)
 */
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { fixtureHost, SectionFrame, type FixtureCatalog } from './fixture.js';
import { fixtures } from './testing.js';
import { useFormat, Value } from './index.js';
import { Photos } from './photos.js';
import { SiteHeader } from '../SiteHeader.js';
import { AppFooter } from '@mistriwork/kit/client/components/AppFooter.js';

afterEach(cleanup);

const CATALOG: FixtureCatalog = {
  tables: [
    {
      name: 'listing',
      columns: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'price', type: 'integer' },
        { name: 'est_monthly', type: 'integer' },
        { name: 'mileage', type: 'integer' },
      ],
    },
  ],
};

describe('column formatting helpers', () => {
  test('Value with row and useFormat().column / money({ round: true }) dress values by resource display rules', () => {
    function Demo() {
      const fmt = useFormat();
      return (
        <div>
          <span data-testid="val-price">
            <Value resource="listing" column="price" value={4890000} row={{ id: 1, price: 4890000 }} />
          </span>
          <span data-testid="fmt-col">{fmt.column('listing', 'mileage', 42100)}</span>
          <span data-testid="fmt-round">{fmt.money(67917, { minor: true, round: true })}</span>
        </div>
      );
    }
    const host = fixtureHost(
      fixtures(
        { listing: [{ id: 1, price: 4890000, mileage: 42100 }] },
        {
          display: {
            'listing.price': { format: 'money', currency: 'USD', minor: true, whole: true },
            'listing.est_monthly': { format: 'money', currency: 'USD', minor: true, round: true },
            'listing.mileage': { format: 'number', unit: 'miles' },
          },
        },
      ),
      { catalog: CATALOG },
      [],
    );
    render(
      <SectionFrame host={host} id="fmt-demo" width={960}>
        <Demo />
      </SectionFrame>,
    );
    expect(screen.getByTestId('val-price').textContent).toBe('$48,900');
    expect(screen.getByTestId('fmt-col').textContent).toBe('42,100 miles');
    expect(screen.getByTestId('fmt-round').textContent).toBe('$679');
  });
});

describe('<Photos> single-record gallery component', () => {
  test('renders lead photo, thumbnail strip, and custom aspect ratio for one record', async () => {
    const data = fixtures({
      listing: [{ id: 1, title: 'Cedar House' }],
      listing_photo: [
        { id: 10, listing_id: 1, position: 1, alt: 'Front view', caption: 'Sunny front porch' },
        { id: 11, listing_id: 1, position: 2, alt: 'Kitchen', caption: 'Open kitchen' },
      ],
    });
    const host = fixtureHost(data, {}, []);
    const { container } = render(
      <SectionFrame host={host} id="photos-demo" width={960}>
        <Photos from="listing_photo" whose="listing_id" record={{ id: 1 }} sort="position asc" aspect="3/2" caption="caption" />
      </SectionFrame>,
    );
    await waitFor(() => {
      const imgs = container.querySelectorAll('img');
      expect(imgs.length).toBeGreaterThanOrEqual(2);
    });
    const gallery = container.querySelector('.gallery');
    expect(gallery?.getAttribute('data-aspect')).toBe('3/2');
    expect(screen.getByRole('button', { name: 'View photo 1 of 2 larger: Front view' })).toBeTruthy();
    expect(screen.getByText('Sunny front porch')).toBeTruthy();
  });
});

describe('<SiteHeader> & <AppFooter> public site chrome', () => {
  const siteApp = {
    id: 'journal',
    name: 'Field Journal',
    views: {
      articles: { table: 'article', label: 'Articles' },
      about: { sections: [], label: 'About' },
    },
  };

  test('renders navigation links, search box, CTA, and respects signIn placement', () => {
    const { rerender } = render(
      <SiteHeader
        app={siteApp}
        site={{
          links: [
            { label: 'Articles', view: 'articles' },
            { label: 'About', view: 'about' },
          ],
          search: { view: 'articles', placeholder: 'Search articles…' },
          cta: { label: 'Subscribe', href: 'https://example.com/subscribe' },
          signIn: 'header',
        }}
      />,
    );
    expect(screen.getByRole('navigation', { name: 'Site navigation' })).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Search articles…' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Subscribe' }).getAttribute('href')).toBe('https://example.com/subscribe');
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeTruthy();

    rerender(
      <SiteHeader
        app={siteApp}
        site={{
          links: [{ label: 'Articles', view: 'articles' }],
          signIn: 'footer',
        }}
      />,
    );
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
  });

  test('AppFooter renders site footer text, app-relative links, and footer Sign in link', () => {
    render(
      <AppFooter
        footer={{
          text: '© 2026 Field Journal',
          links: [
            { label: 'About', href: '/journal/about' },
            { label: 'Privacy', href: 'https://example.com/privacy' },
          ],
        }}
        signInHref="/journal/sign-in"
        signInLabel="Sign in"
      />,
    );
    expect(screen.getByText('© 2026 Field Journal')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'About' }).getAttribute('href')).toBe('/journal/about');
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/journal/sign-in');
  });
});

describe('public custom page SSR (renderPublic kind: "page")', () => {
  test('renders SiteHeader, loader data, useRows with hydrated cover photos, useFormat().column, and AppFooter in HTML', async () => {
    const { renderPublic } = await import('../../ssr/render.js');
    const { mountJson } = await import('@mistriwork/engine/shared/mount.js');
    const schema = {
      tables: [
        {
          id: 'listing',
          name: 'Listing',
          columns: [
            { name: 'id', type: 'integer', nullable: false, primaryKey: true },
            { name: 'title', type: 'text', nullable: false, primaryKey: false },
            { name: 'price', type: 'integer', nullable: false, primaryKey: false },
          ],
          cover: { from: 'listing_photo', whose: 'listing_id', photoKey: 'id', aspect: '3/2' },
        },
        {
          id: 'listing_photo',
          name: 'Listing Photo',
          columns: [
            { name: 'id', type: 'integer', nullable: false, primaryKey: true },
            { name: 'listing_id', type: 'integer', nullable: false, primaryKey: false },
          ],
        },
      ],
      foreignKeys: [],
    };
    const payload = {
      id: 'northsite',
      name: 'North Site',
      home: 'door',
      nav: [],
      resources: {
        listing: {
          slug: true,
          display: { price: { format: 'money', currency: 'USD', minor: true, whole: true } },
        },
        listing_photo: {},
      },
      views: {
        catalog: { table: 'listing', label: 'Catalog', open: { page: 'detail', param: 'id' } },
        door: {
          label: 'Welcome',
          sections: [{ kind: 'custom', component: { id: 'page-door', kind: 'page' } }],
          page: { public: true, reads: ['listing'], commands: [], params: [], loader: 'featured' },
        },
      },
      ui: {
        site: {
          links: [{ label: 'Catalog', view: 'catalog' }],
          cta: { label: 'Contact', href: 'https://example.com/contact' },
          signIn: 'footer' as const,
          footer: { text: '© 2026 North Site' },
        },
      },
    };
    const compiledDoorJs = `
      import { jsxs, jsx } from "react/jsx-runtime";
      import { useRows, useFormat } from "@mistriwork/mistri/ui";
      export default function Door({ data }) {
        const { data: rows } = useRows("listing", { show: ["id", "title", "price"], limit: 6 });
        const fmt = useFormat();
        return jsxs("div", {
          className: "door-page",
          children: [
            jsx("h1", { children: data?.headline ?? "Welcome" }),
            jsx("ul", {
              children: (rows ?? []).map((row) =>
                jsxs("li", {
                  children: [
                    row.cover ? jsx("img", { src: row.cover, alt: String(row.title) }) : null,
                    jsx("span", { children: String(row.title) }),
                    jsx("strong", { children: fmt.column("listing", "price", row.price, row) }),
                  ],
                }, String(row.id))
              ),
            }),
          ],
        });
      }
    `;
    const html = await renderPublic({
      kind: 'page',
      mount: mountJson({ base: '', apps: {} }),
      app: payload as never,
      schema: schema as never,
      viewKey: 'door',
      dashboard: { id: 'door', ...(payload.views.door as object) } as never,
      page: payload.views.door.page as never,
      place: {},
      code: compiledDoorJs,
      read: async (_method, target) => {
        if (target === '/api/pages/load') return { status: 200, body: { data: { headline: 'Find Your Next Place' } } };
        if (target === '/api/view/run') {
          return {
            status: 200,
            body: {
              view: {
                columns: [{ path: 'id' }, { path: 'title' }, { path: 'price' }, { path: 'cover' }],
              },
              columns: ['c0', 'c1', 'c2', 'c3'],
              rows: [{ c0: 7, c1: 'Cedar House', c2: 4890000, c3: 99 }],
            },
          };
        }
        return { status: 404, body: {} };
      },
    });
    expect(html).toContain('Find Your Next Place');
    expect(html).toContain('Cedar House');
    expect(html).toContain('$48,900');
    expect(html).toContain('/api/file?');
    expect(html).toContain('listing_photo');
    expect(html).toContain('class="site-header"');
    expect(html).toContain('© 2026 North Site');
    expect(html).toContain('/northsite/sign-in');
  });
});
