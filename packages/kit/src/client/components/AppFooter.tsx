/**
 * The App's footer: a line of small print and a row of links, drawn under
 * every room of an App that declares `ui.footer`.
 *
 * A landing already had a footer of its own, which is where this shape comes
 * from (`appLanding.parseFooter`). What was missing is the one people read: a
 * public-facing App's listing and record pages ended in nothing, while the
 * sites they are modelled on carry their terms, privacy and contact links on
 * every page. The database browser has no footer and gets none — this belongs
 * to an App, the way a look does.
 *
 * Every string the author wrote is drawn as React text, so markup in it is
 * shown and never run, and a link's href was held to https:, mailto: and tel:
 * when the App loaded.
 */
import type { MouseEvent } from 'react';
import type { LandingLink } from '@mistriwork/engine/shared/servedApp.js';
import { resolveInAppSpaHref } from '../inAppLink.js';
import { navFollow } from '../shellHost.js';
import { safeHref } from './LandingSurface.js';
import './AppFooter.css';

function followFooterLink(event: MouseEvent<HTMLAnchorElement>, href: string) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const target = resolveInAppSpaHref(href);
  if (!target) return;
  event.preventDefault();
  navFollow(target);
}

export function AppFooter({
  footer,
  signInHref,
  signInLabel,
}: {
  footer?: { text?: string; links?: LandingLink[] };
  signInHref?: string;
  signInLabel?: string;
}) {
  const links = footer?.links ?? [];
  if (!footer?.text && !links.length && !signInHref) return null;
  return (
    <footer className="app-footer">
      {footer?.text && <p className="app-footer-text">{footer.text}</p>}
      {links.length || signInHref ? (
        <ul className="app-footer-links">
          {links.map((link, index) => {
            const href =
              link.href.startsWith('/') && !link.href.startsWith('//') && !link.href.startsWith('/\\') ? link.href : safeHref(link.href);
            return (
              <li key={index}>
                {href ? (
                  <a
                    href={href}
                    {...(href.startsWith('/')
                      ? { onClick: (event: MouseEvent<HTMLAnchorElement>) => followFooterLink(event, href) }
                      : { rel: 'noreferrer noopener' })}
                  >
                    {link.label}
                  </a>
                ) : (
                  <span>{link.label}</span>
                )}
              </li>
            );
          })}
          {signInHref && signInLabel && (
            <li>
              <a href={signInHref}>{signInLabel}</a>
            </li>
          )}
        </ul>
      ) : null}
    </footer>
  );
}
