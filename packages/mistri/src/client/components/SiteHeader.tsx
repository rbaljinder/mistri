/**
 * Public site header (`ui.site`): worn by signed-out visitors across every public page (except
 * `layout: 'bare'`), completely separate from the operator desk's `TopNav` and `nav`.
 *
 * Works for any custom public site — marketing, editorial, directory, docs, portfolio, booking site,
 * or storefront. Renders semantic `<a href>` navigation links, an optional site search form that
 * routes straight into a public search page or list view without a full reload, an optional primary
 * CTA, and an optional Sign in link (only when `signIn` is `'header'`; omitted, `'footer'`, and
 * `false` keep Sign in off the site header).
 */
import { useState, useSyncExternalStore, type FormEvent, type MouseEvent } from 'react';
import type { AppSite, AppSiteLink } from '@mistriwork/engine/shared/servedApp.js';
import { go, state, subscribeWalk, tableView } from '@mistriwork/kit/client/core.js';
import { resolveInAppSpaHref } from '@mistriwork/kit/client/inAppLink.js';
import { navFollow } from '@mistriwork/kit/client/shellHost.js';
import { Icon } from '@mistriwork/kit/client/components/Icon.js';
import { dashPageId, dashViewKey, formPageId, formViewKey, isListRoom } from '@mistriwork/kit/client/components/appRooms.js';
import { rootSlot } from '@mistriwork/kit/client/components/dashboardModel.js';
import { shownUnplaced } from '@mistriwork/kit/client/addressMount.js';
import { isFormView } from '../../shared/appModel.js';
import { hrefFor } from '../publicAddress.js';
import { say } from '../copy/components/components/SiteHeader.js';
import './SiteHeader.css';

interface SiteHeaderApp {
  id: string;
  name: string;
  views: Readonly<Record<string, unknown>>;
}

interface SiteHeaderProps {
  app: SiteHeaderApp;
  site: AppSite;
  /** Optional explicit href resolver (used during SSR when the client address book is not mounted). */
  resolveHref?: (link: AppSiteLink) => string;
  /** Optional active view key override (used during SSR). */
  activeView?: string;
}

function linkHref(app: SiteHeaderApp, link: AppSiteLink, resolveHref?: (link: AppSiteLink) => string): string {
  if (resolveHref) return resolveHref(link);
  if (link.href) return link.href;
  if (link.view && state.schema) {
    const href = hrefFor({ kind: 'view', view: link.view });
    if (href) return href;
  }
  return shownUnplaced(`/${encodeURIComponent(app.id)}/${encodeURIComponent(link.view ?? '')}`);
}

function isExternalHref(href: string): boolean {
  return !href.startsWith('/') && !href.startsWith('#');
}

function openSiteView(app: SiteHeaderApp, viewKey: string, params?: Record<string, string>) {
  const view = app.views[viewKey] as { table?: string; label?: string; query?: string; tabs?: Array<{ query?: string }> } | undefined;
  if (!view) return;
  if ('table' in view && typeof view.table === 'string') {
    const base = view.query ?? view.tabs?.[0]?.query ?? '';
    const typed = (params?.search ?? (params ? Object.values(params).find((value) => value.trim()) : undefined))?.trim();
    const query = typed ? [base, `"${typed.replace(/"/g, '')}"`].filter(Boolean).join(' ') : base;
    go({ ...tableView(view.table, query), view: viewKey, title: view.label ?? viewKey }, 'push');
    return;
  }
  if (isFormView(view as never)) {
    go({ kind: 'page', pageId: formPageId(viewKey), table: undefined, label: view.label ?? viewKey }, 'push');
    return;
  }
  const cleanParams = params ? Object.fromEntries(Object.entries(params).filter(([, value]) => value !== '')) : {};
  const body = Object.keys(cleanParams).length ? rootSlot(null, cleanParams) : '';
  go(
    {
      kind: 'page',
      pageId: dashPageId(viewKey),
      table: undefined,
      label: view.label ?? viewKey,
      ...(body ? { rootBody: body } : {}),
    },
    'push',
  );
}

function isViewActive(viewKey: string | undefined, activeView?: string): boolean {
  if (!viewKey) return false;
  if (activeView !== undefined) return activeView === viewKey;
  const here = state.stack.at(-1);
  if (!here) return false;
  if (isListRoom(here)) return (here as { view?: string }).view === viewKey;
  if (here.kind === 'page' && here.pageId) {
    return dashViewKey(here.pageId) === viewKey || formViewKey(here.pageId) === viewKey;
  }
  return false;
}

export function SiteHeader({ app, site, resolveHref, activeView }: SiteHeaderProps) {
  useSyncExternalStore(
    subscribeWalk,
    () => {
      const top = state.stack.at(-1);
      return `${top?.kind ?? ''}:${top?.view ?? ''}:${top?.pageId ?? ''}`;
    },
    () => '',
  );
  const [queryText, setQueryText] = useState('');
  const links = (site.links ?? []).filter((item) => !item.view || Object.hasOwn(app.views, item.view));
  const search = site.search && Object.hasOwn(app.views, site.search.view) ? site.search : undefined;
  const cta = site.cta && (!site.cta.view || Object.hasOwn(app.views, site.cta.view)) ? site.cta : undefined;
  const showHeaderSignIn = site.signIn === 'header';

  const onLinkClick = (event: MouseEvent<HTMLAnchorElement>, link: AppSiteLink, href: string) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    if (link.view) {
      event.preventDefault();
      openSiteView(app, link.view);
      return;
    }
    const target = resolveInAppSpaHref(href);
    if (!target) return;
    event.preventDefault();
    navFollow(target);
  };

  const onSearchSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!search) return;
    const trimmed = queryText.trim();
    const target = app.views[search.view];
    const isList = Boolean(target && typeof target === 'object' && 'table' in target);
    const param = search.param ?? (isList ? 'search' : 'q');
    openSiteView(app, search.view, trimmed ? { [param]: trimmed } : undefined);
  };

  const ctaHref = cta ? linkHref(app, cta, resolveHref) : undefined;

  return (
    <div className="site-header">
      {links.length > 0 && (
        <nav className="site-nav" aria-label={say('siteNavigation')}>
          {links.map((link, index) => {
            const active = isViewActive(link.view, activeView);
            const href = linkHref(app, link, resolveHref);
            return (
              <a
                key={`${link.view ?? link.href ?? index}`}
                className="site-link"
                href={href}
                rel={isExternalHref(href) ? 'noopener noreferrer' : undefined}
                aria-current={active ? 'page' : undefined}
                onClick={(event) => onLinkClick(event, link, href)}
              >
                {link.label}
              </a>
            );
          })}
        </nav>
      )}
      {search && (
        <form className="site-search" role="search" onSubmit={onSearchSubmit}>
          <span className="site-search-icon" aria-hidden="true">
            <Icon name="magnifying-glass" size={14} />
          </span>
          <input
            type="search"
            className="site-search-input"
            value={queryText}
            onChange={(event) => setQueryText(event.target.value)}
            placeholder={search.placeholder ?? say('searchSite')}
            aria-label={search.placeholder ?? say('searchSite')}
          />
        </form>
      )}
      <div className="site-actions">
        {cta && ctaHref && (
          <a
            className="site-cta"
            href={ctaHref}
            rel={isExternalHref(ctaHref) ? 'noopener noreferrer' : undefined}
            onClick={(event) => onLinkClick(event, cta, ctaHref)}
          >
            {cta.label}
          </a>
        )}
        {showHeaderSignIn && (
          <a className="site-sign-in" href={shownUnplaced(`/${encodeURIComponent(app.id)}/sign-in`)}>
            {say('signIn')}
          </a>
        )}
      </div>
    </div>
  );
}
