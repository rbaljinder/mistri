import { useEffect, useState } from 'react';
import type { AppTarget } from '@mistriwork/engine/shared/appLinks.js';

interface AppTargetLinkProps {
  label: string;
  target: AppTarget<string | number>;
  scope: string;
  resolve: (target: AppTarget<string | number>, signal: AbortSignal) => Promise<{ href: string } | null>;
  className?: string;
}

type AvailableLink = Pick<AppTargetLinkProps, 'target' | 'scope' | 'resolve'> & { href: string };

function safeHref(href: string): boolean {
  return typeof href === 'string' && href.startsWith('/') && !href.startsWith('//') && !/[\\\p{Cc}]/u.test(href);
}

/** Only the resolver grants availability; the browser owns navigation. */
export function AppTargetLink({ label, target, scope, resolve, className }: AppTargetLinkProps) {
  const [available, setAvailable] = useState<AvailableLink | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setAvailable(null);
    async function check() {
      try {
        const result = await resolve(target, controller.signal);
        if (!controller.signal.aborted && result && safeHref(result.href)) {
          setAvailable({ target, scope, resolve, href: result.href });
        }
      } catch {
        // Denial and technical failures both leave the action unavailable.
      }
    }
    void check();
    return () => {
      controller.abort();
    };
  }, [target, scope, resolve]);

  // Hide the previous grant during render, before effect cleanup can run.
  if (!available || available.target !== target || available.scope !== scope || available.resolve !== resolve) return null;
  return (
    <a className={`dashboard-note-action${className ? ` ${className}` : ''}`} href={available.href}>
      {label}
    </a>
  );
}
