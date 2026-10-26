import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Menu } from '@base-ui/react/menu';
import type { AppUi } from '../../shared/appModel.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { localAppNavTarget, type NavTargetApp } from '../appNavTargets.js';
import { captureSessionIdentity, subscribeSessionIdentity, type SessionIdentitySnapshot } from '@mistriwork/kit/client/sessionIdentity.js';
import { suiteApps, suiteNavigationCurrent, useSuiteNavigation, type SuiteNavigationScope } from '../suiteNavigation.js';
import { appTargetLinksCurrent, resolveAppTargetLink, useAppTargetLinks, type AppTargetLinksScope } from '../appTargetLinks.js';
import { useMessageLanguage } from '@mistriwork/kit/client/components/useMessageLanguage.js';
import { DropMenu, DropItem, DropGroup } from '@mistriwork/ui/DropMenu.js';
import { say } from '../copy/shell/components/SuiteAppSwitcher.js';
import './SuiteNavigation.css';
import { addHostListener, removeHostListener } from '@mistriwork/kit/client/shellHost.js';

/** The normalized ui.appSwitcher contract; no configuration means no menu. */
export type AppSwitcherConfig = NonNullable<AppUi['appSwitcher']>;
/** The payload and schema captured by the shell under this exact session. */
export interface AppSwitcherLocal {
  app: NavTargetApp;
  schema: DatabaseSchema;
  owner: SessionIdentitySnapshot;
}
interface AvailableGroup {
  label?: string;
  links: { label: string; href: string }[];
}
const isGrouped = (config: AppSwitcherConfig): config is Extract<AppSwitcherConfig, { groups: readonly unknown[] }> =>
  config.groups !== undefined;

export function SuiteAppSwitcher({
  config,
  local,
  placement = 'navbar',
}: {
  config?: AppSwitcherConfig;
  local?: AppSwitcherLocal;
  placement?: 'navbar' | 'account';
}) {
  const suite = useSuiteNavigation(),
    targets = useAppTargetLinks();
  const identity = useSyncExternalStore(subscribeSessionIdentity, captureSessionIdentity, captureSessionIdentity);
  const localGeneration = useRef({ app: local?.app, schema: local?.schema, value: 0 });
  if (localGeneration.current.app !== local?.app || localGeneration.current.schema !== local?.schema) {
    localGeneration.current = { app: local?.app, schema: local?.schema, value: localGeneration.current.value + 1 };
  }
  const localReady =
    local &&
    local.owner === identity &&
    !identity.tenantRequired &&
    (identity.mode === 'authenticated' || identity.mode === 'anonymous') &&
    local.app.id === identity.appId;
  if (!config || config.placement !== placement || (isGrouped(config) ? !targets && !localReady : !suite)) return null;
  // A new authoring/scope generation never renders the previous generation's availability.
  const key = JSON.stringify([
    isGrouped(config) ? (targets?.key ?? [identity.epoch, localGeneration.current.value]) : suite!.generation,
    config,
  ]);
  return (
    <Switcher
      key={key}
      config={config}
      local={localReady ? local : undefined}
      suite={isGrouped(config) ? null : suite}
      targets={isGrouped(config) ? targets : null}
    />
  );
}

function safeHref(href: string): boolean {
  return href.startsWith('/') && !href.startsWith('//') && !/[\\\p{Cc}]/u.test(href);
}

async function availableGroups(
  config: AppSwitcherConfig,
  suite: SuiteNavigationScope | null,
  targets: AppTargetLinksScope | null,
  local: AppSwitcherLocal | undefined,
  signal: AbortSignal,
): Promise<AvailableGroup[]> {
  if (!isGrouped(config)) {
    if (!suite) return [];
    const allowed = config.apps;
    const apps = (await suiteApps(suite, signal)).filter((app) => allowed === 'authorized' || allowed.includes(app.id));
    return apps.length >= (allowed === 'authorized' ? 2 : 1) ? [{ links: apps.map((app) => ({ label: app.name, href: app.href })) }] : [];
  }
  if (!targets && !local) return [];
  const groups = await Promise.all(
    config.groups.map(async (group) => {
      const links = await Promise.all(
        group.links.map(async (link) => {
          // parseAppTarget inside the checked resolver refuses runtime record bindings here too.
          const href = targets
            ? (await resolveAppTargetLink(targets, link.to, signal).catch(() => null))?.href
            : local
              ? localAppNavTarget(local.app, local.schema, link.to)
              : undefined;
          return href && safeHref(href) ? { label: link.label, href } : null;
        }),
      );
      return { label: group.label, links: links.filter((link) => link !== null) };
    }),
  );
  return groups.filter((group) => group.links.length > 0);
}

function Switcher({
  config,
  suite,
  targets,
  local,
}: {
  config: AppSwitcherConfig;
  suite: SuiteNavigationScope | null;
  targets: AppTargetLinksScope | null;
  local?: AppSwitcherLocal;
}) {
  useMessageLanguage();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<{ groups: AvailableGroup[]; offered: boolean; loading: boolean; failed: boolean }>({
    groups: [],
    offered: false,
    loading: true,
    failed: false,
  });
  const lifetime = useRef<{ active: boolean; controller?: AbortController }>({ active: false });
  const refresh = useCallback(() => {
    const live = lifetime.current;
    const current = () =>
      isGrouped(config)
        ? targets
          ? appTargetLinksCurrent(targets)
          : !!local && local.owner === captureSessionIdentity()
        : !!suite && suiteNavigationCurrent(suite);
    if (!live.active || !current()) return;
    live.controller?.abort();
    const controller = (live.controller = new AbortController());
    setView((was) => ({ ...was, groups: [], loading: true, failed: false }));
    void availableGroups(config, suite, targets, local, controller.signal)
      .then((groups) => {
        if (live.active && !controller.signal.aborted && current())
          setView({ groups, offered: groups.length > 0, loading: false, failed: false });
      })
      .catch(() => {
        if (live.active && !controller.signal.aborted && current())
          setView((was) => ({ ...was, groups: [], loading: false, failed: true }));
      });
  }, [config, suite, targets, local]);
  useEffect(() => {
    lifetime.current.active = true;
    refresh();
    addHostListener(window, 'focus', refresh);
    return () => {
      lifetime.current.active = false;
      lifetime.current.controller?.abort();
      removeHostListener(window, 'focus', refresh);
    };
  }, [refresh]);
  if (!view.offered) return null;
  const label = config.label ?? say('apps');
  const content = (
    <>
      {view.loading && <p role="status">{say('checking')}</p>}
      {view.failed && (
        <>
          <p role="status">{say('unavailable')}</p>
          <DropItem className="account-menu-signout" closeOnClick={false} onClick={refresh}>
            {say('refresh')}
          </DropItem>
        </>
      )}
      <div className={isGrouped(config) ? 'suite-switcher-groups' : undefined}>
        {view.groups.map((group, index) => {
          const links = group.links.map((link, linkIndex) => (
            <Menu.Item key={linkIndex} nativeButton={false} render={<a href={link.href} className="suite-switcher-link" />}>
              {link.label}
            </Menu.Item>
          ));
          return group.label ? (
            <DropGroup key={index} label={group.label} className="suite-switcher-group" labelClassName="suite-switcher-heading">
              {links}
            </DropGroup>
          ) : (
            <div key={index}>{links}</div>
          );
        })}
      </div>
    </>
  );
  // Mounted by the account popup itself: opening it starts fresh availability checks.
  // No second Menu.Root or nested dropdown can capture the account menu's keyboard.
  if (config.placement === 'account')
    return (
      <DropGroup className="suite-switcher-account" labelClassName="suite-switcher-title" label={label}>
        {content}
      </DropGroup>
    );
  return (
    <DropMenu
      className="suite-switcher"
      triggerClassName="ghost suite-switcher-trigger"
      triggerLabel={config.label ?? say('switchApp')}
      triggerTitle={label}
      label={
        <>
          {label} <span aria-hidden="true">▾</span>
        </>
      }
      popupClassName={`more-list suite-switcher-popup${isGrouped(config) ? ' suite-switcher-mega' : ''}`}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) refresh();
      }}
    >
      {content}
    </DropMenu>
  );
}
