import { createElement } from 'react';
import { TenantChooser, TenantControl, type TenantControlAction } from './components/TenantChooser.js';
import { element, mount } from '@mistriwork/kit/client/components/mount.js';
import {
  captureSessionIdentity,
  captureTenantLease,
  establishTenantSelection,
  requireTenantSelection,
  sessionIdentity,
  subscribeSessionIdentity,
} from '@mistriwork/kit/client/sessionIdentity.js';
import {
  chooseTenant,
  discoverTenants,
  enterTenant,
  recoverTenant,
  releaseTenant,
  resumeTenant,
  type TenantEntry,
} from './tenantTransport.js';
import { adoptTenantBoot } from './tenantBootLoad.js';
import { soleTenant } from '../shared/tenantBoot.js';
import { checkSessionIdentity, invalidateSession } from '@mistriwork/kit/client/sessionLifecycle.js';
import { startTenantRenewal, type TenantRenewalOptions } from './tenantRenewal.js';
import { tenantSuspensionOverlay } from './tenantSuspension.js';
import { PLATFORM_TENANT_ID, type TenantContextReply } from '../shared/tenantContext.js';
import type { SupportSessionView } from '../shared/tenantSupport.js';
import { enterDealer, showSupportLog, showSupportSession, showSupportSessions, supportStatus } from './tenantSupport.js';
import { say } from './copy/tenancy/tenantBrowser.js';
import { tenantNames, tenantSandboxes } from './tenantNames.js';
import { tenancyNoun } from './tenancyNoun.js';
import { addHostListener, shellById } from '@mistriwork/kit/client/shellHost.js';

let appName = '',
  tenantIds: readonly string[] = [],
  platformLabel: string | undefined,
  tenantLabel: string | undefined;
/** Present when the deployment offers audited support: the account's email, for a password sign-in. */
let support: { readonly who: string } | undefined;
export function configureTenantSupport(options: { readonly who: string } | undefined): void {
  support = options;
}
let discoveryRefresh: (() => Promise<void>) | undefined;
/** Refresh choices after account enrollment without granting a business context. */
export async function refreshTenantDiscovery(): Promise<void> {
  await discoveryRefresh?.();
}
function ownDiscoveryRefresh(owner: ReturnType<typeof sessionIdentity>, refresh: () => Promise<void>) {
  discoveryRefresh = refresh;
  const unsubscribe = subscribeSessionIdentity(() => {
    if (sessionIdentity() === owner) return;
    if (discoveryRefresh === refresh) discoveryRefresh = undefined;
    unsubscribe();
  });
}
let renewal: ReturnType<typeof startTenantRenewal> | undefined;
let disposeRenewal: (() => void) | undefined;
let onResume: TenantRenewalOptions['onResume'];
export function configureTenantResume(listener: NonNullable<typeof onResume>) {
  onResume = listener;
}
export function suspendBrowserTenant(owner = captureSessionIdentity()): void {
  if (renewal?.owner === owner) renewal.suspend();
}
export async function checkBrowserTenant(owner = captureSessionIdentity()): Promise<void> {
  if (!renewal || renewal.owner !== owner) throw new Error(say('tenantRenewalIsUnavailable'));
  await renewal.check();
}
/* The context this browser tab holds, by App and account, for its next page
   to resume (resumeTenant) when the reader chooses the same tenant again. */
const KEPT = 'mistri.tenant-context';
function keep(reply: TenantContextReply): void {
  try {
    sessionStorage.setItem(
      KEPT,
      JSON.stringify({ appId: reply.appId, accountId: reply.accountId, tenantId: reply.tenantId, tabId: reply.tabId }),
    );
  } catch {
    /* Without storage every page opens its own context, and lets it go as it leaves. */
  }
}
function kept(owner: ReturnType<typeof captureSessionIdentity>, tenantId: string): string | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEPT) ?? 'null') as {
      appId?: unknown;
      accountId?: unknown;
      tenantId?: unknown;
      tabId?: unknown;
    } | null;
    return value &&
      value.appId === owner.appId &&
      value.accountId === owner.accountId &&
      value.tenantId === tenantId &&
      typeof value.tabId === 'string'
      ? value.tabId
      : undefined;
  } catch {
    return undefined;
  }
}
/* The context this tab kept, whichever tenant it was for: an enter request names it for the host to resume where
   it is the tenant the person is entered in. */
function keptHere(owner: ReturnType<typeof captureSessionIdentity>): { tenantId: string; tabId: string } | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEPT) ?? 'null') as { tenantId?: unknown } | null;
    const tenantId = value?.tenantId;
    if (typeof tenantId !== 'string' || tenantId === PLATFORM_TENANT_ID) return undefined;
    const tabId = kept(owner, tenantId);
    return tabId ? { tenantId, tabId } : undefined;
  } catch {
    return undefined;
  }
}
/* Leases entered with their page's boot already held (`/api/tenant/enter`): the shell asks no boot of its own. */
const bootedLeases = new WeakSet<TenantContextReply>();
/** Whether the page's boot came with `reply`, entered in the same request as discovery. */
export const enteredWithBoot = (reply: TenantContextReply): boolean => bootedLeases.has(reply);
let departing = false;
/* A page that is going (not into the back-forward cache, from which it
   would return holding its lease) lets its context go. */
function releaseOnDeparture(): void {
  if (departing || typeof window === 'undefined') return;
  departing = true;
  addHostListener(window, 'pagehide', (event) => {
    if (event.persisted) return;
    const lease = captureTenantLease();
    if (lease) releaseTenant(lease);
  });
}
/** The context for a choice: the one this tab's last page let go, where it was for this tenant, or a new one. */
async function contextFor(owner: ReturnType<typeof captureSessionIdentity>, tenantId: string): Promise<TenantContextReply> {
  const tabId = kept(owner, tenantId);
  if (tabId) {
    try {
      return await resumeTenant(tenantId, tabId);
    } catch {
      /* Gone, expired, or held by another page: a new one. */
    }
  }
  return chooseTenant(tenantId);
}

function remember(reply: TenantContextReply, expected: ReturnType<typeof captureSessionIdentity>) {
  const selected = establishTenantSelection(reply, expected);
  keep(reply);
  releaseOnDeparture();
  disposeRenewal?.();
  const overlay = tenantSuspensionOverlay(() => {
    void checkSessionIdentity();
  });
  const controller = startTenantRenewal({ onState: overlay.update, onResume: (owner) => onResume?.(owner), onWake: checkSessionIdentity });
  renewal = controller;
  const unsubscribe = subscribeSessionIdentity(() => {
    if (sessionIdentity() !== selected) dispose();
  });
  const dispose = () => {
    controller.stop();
    overlay.close(false);
    unsubscribe();
    if (renewal === controller) {
      renewal = undefined;
      disposeRenewal = undefined;
    }
  };
  disposeRenewal = dispose;
  return selected;
}

/** A chooser never adopts an URL/cookie tenant hint as authority. */
export async function initialTenantSelection(
  host: HTMLElement,
  name: string,
  requestedTenant?: string,
  label?: string,
  tenantWord?: string,
  /** The page's inside address, where it is known: the first look then asks to enter as well as discover. */
  page?: { readonly path: string; readonly search: string },
): Promise<TenantContextReply> {
  appName = name;
  platformLabel = label;
  tenantLabel = tenantWord;
  tenantIds = [];
  const owner = requireTenantSelection();
  let busy = true,
    selecting = false,
    generation = 0,
    error: string | undefined;
  // Held once a resumed support session stands where the chooser was; resuming while one is being opened.
  let held = false,
    resuming = false;
  let finish!: (reply: TenantContextReply) => void;
  const selected = new Promise<TenantContextReply>((resolve) => {
    finish = resolve;
  });
  const current = () => sessionIdentity() === owner;
  /* Someone in one tenant goes straight in: a chooser with one button asks
     nothing. Its one choice is still discovery's answer, never the address's
     — a link that names another tenant keeps the chooser and says whose the
     link is. Only the chooser's first answer is read so: a choice that failed
     leaves the chooser, with why, and a tenant joined from the chooser later
     (an invitation accepted there) is offered, not entered. A sole platform
     membership is chosen by hand, where a support session of this login may
     stand instead (below). Nothing is drawn until discovery first answers:
     the chooser appears only where it will be used, never for a moment, busy,
     before a sole membership is entered (the page would show it and then the
     workspace in its place). */
  let answered = false,
    shown = false;
  const sole = (): string | undefined =>
    error === undefined
      ? soleTenant(
          tenantIds.filter((tenantId) => tenantId !== PLATFORM_TENANT_ID),
          tenantIds.includes(PLATFORM_TENANT_ID),
          requestedTenant,
        )
      : undefined;
  const draw = () => {
    if (!current() || held) return;
    shown = true;
    mount(
      host,
      createElement(TenantChooser, {
        appName,
        tenantIds,
        names: tenantNames(),
        sandboxes: tenantSandboxes(),
        platformLabel,
        tenantLabel,
        requestedTenant,
        busy: busy || resuming,
        error,
        onSelect: (tenantId) => {
          void select(tenantId);
        },
        onRetry: () => {
          void refresh();
        },
      }),
    );
  };
  const refresh = async () => {
    if (!current() || selecting) return;
    const ticket = ++generation;
    busy = true;
    error = undefined;
    // A retry says it is checking in the chooser already drawn; the first look draws nothing until it is answered.
    if (shown) draw();
    /* The first look, where the page's address is known, asks the host to enter the person's one tenant in the
       same request (tenantTransport.ts `enterTenant`); an answer that enters nothing is discovery's, read as ever. */
    const entering = !answered && page !== undefined && requestedTenant !== PLATFORM_TENANT_ID;
    let entry: TenantEntry | undefined;
    try {
      if (entering) {
        try {
          entry = await enterTenant(page, requestedTenant, keptHere(owner));
        } catch {
          /* Discovery alone, as the chooser always asked it. */
        }
      }
      const found = entry?.tenants ?? (await discoverTenants());
      if (current() && ticket === generation) tenantIds = found;
    } catch {
      if (current() && ticket === generation) error = say('tenantAccessCouldNotBeChecked');
    } finally {
      if (current() && ticket === generation) {
        busy = false;
        const only = answered ? undefined : sole();
        if (error === undefined) answered = true;
        if (only !== undefined && entry?.lease?.tenantId === only) enter(entry.lease, entry.boot);
        else {
          /* A lease this page will not take is let go, as a page leaving lets its own go. */
          if (entry?.lease) releaseTenant(entry.lease);
          if (only === undefined) draw();
          else void select(only);
        }
      }
    }
  };
  /* Entered by the host with discovery's answer: as a choice that succeeded, its boot held before the shell asks. */
  const enter = (reply: TenantContextReply, boot: Record<string, unknown> | undefined) => {
    selecting = true;
    busy = true;
    try {
      const chosen = remember(reply, owner);
      /* Held on the lease as the session holds it, the one each read is asked on (tenantTransport.ts `carriedOn`). */
      const held = captureTenantLease(chosen);
      if (boot && held) {
        adoptTenantBoot(boot, held);
        bootedLeases.add(reply);
      }
      finish(reply);
    } catch {
      if (current()) {
        selecting = false;
        busy = false;
        error = say('theSelectionWasNotConfirmed');
        draw();
      }
    }
  };
  const select = async (tenantId: string) => {
    if (busy || held || resuming || !current() || !tenantIds.includes(tenantId)) return;
    selecting = true;
    busy = true;
    error = undefined;
    // A sole membership entered at once is entered from nothing drawn: the chooser shows only if it fails.
    if (shown) draw();
    try {
      const reply = await contextFor(owner, tenantId);
      remember(reply, owner);
      finish(reply);
    } catch {
      if (current()) {
        selecting = false;
        busy = false;
        error = say('theSelectionWasNotConfirmed');
        draw();
      }
    }
  };
  ownDiscoveryRefresh(owner, refresh);
  /* A live support session of this very login resumes where the chooser
     would be; any other answer, or none, leaves the ordinary choices. The
     choices do not wait for it: the status is a writer transaction, asked
     only for an account discovery finds on the platform (a support session
     stands on a platform membership), or when discovery could not say. It is
     asked first without resuming, which opens nothing, and only a live
     session found while nothing has been chosen is resumed, the chooser
     busy meanwhile. A choice made first stands: the session stays live, and
     the platform's commands meet its refusal until the session ends. */
  const discovered = refresh();
  if (support)
    void (async () => {
      await discovered;
      if (!current() || selecting || (!tenantIds.includes(PLATFORM_TENANT_ID) && error === undefined)) return;
      try {
        const found = await supportStatus();
        if (!current() || selecting || found.session?.state !== 'active') return;
        resuming = true;
        draw();
        const status = await supportStatus({ resume: true });
        if (current() && status.session?.state === 'active' && status.context) {
          held = true;
          let dispose = () => {};
          dispose = showSupportSession(host, status.session, {
            platformLabel: platformLabel ?? say('platform'),
            leave: async () => {
              const reply = await chooseTenant(PLATFORM_TENANT_ID);
              dispose();
              remember(reply, owner);
              finish(reply);
            },
          });
          return;
        }
      } catch {
        /* The chooser still offers every choice. */
      }
      if (resuming) {
        resuming = false;
        draw();
      }
    })();
  return selected;
}

/** The App host owns clearing and rebuilding the entire mounted data surface.
 * Retire first; a failed/lost CAS keeps that surface empty until explicit recovery. */
export function tenantControl(
  before: () => Promise<boolean>,
  clear: () => Promise<void>,
  rebuild: () => Promise<void>,
  supportLog = false,
  /** A platform lease whose role may read every tenant's support sessions (`supportAudit` on the App payload). */
  supportAudit = false,
): HTMLElement {
  const owner = sessionIdentity();
  const selected = sessionIdentity().tenant;
  if (!selected) throw new Error(say('chooseATenantBeforeMounting'));
  let busy = false;
  /* What the bar offers beside the control, offered in its dialog too: on a
     phone the bar is one row and keeps only the control (style.css). */
  let actions: TenantControlAction[] = [];
  const control = element(
    'span',
    createElement(TenantControl, {
      appName,
      tenantIds,
      names: tenantNames(),
      sandboxes: tenantSandboxes(),
      platformLabel,
      tenantLabel,
      currentTenant: selected.tenantId,
      onSelect: (tenantId) => {
        void switchTo(tenantId);
      },
    }),
    'tenant-control-host',
  );
  let refreshGeneration = 0,
    refreshing = false,
    refreshError: string | undefined;
  const drawControl = () => {
    if (sessionIdentity() !== owner) return;
    mount(
      control,
      createElement(TenantControl, {
        appName,
        tenantIds,
        names: tenantNames(),
        sandboxes: tenantSandboxes(),
        platformLabel,
        tenantLabel,
        busy: busy || refreshing,
        error: refreshError,
        actions,
        currentTenant: selected.tenantId,
        onSelect: (tenantId) => {
          void switchTo(tenantId);
        },
        onRetry: () => {
          void refresh();
        },
      }),
    );
  };
  const refresh = async () => {
    if (busy || sessionIdentity() !== owner) return;
    const ticket = ++refreshGeneration;
    refreshing = true;
    refreshError = undefined;
    drawControl();
    try {
      const found = await discoverTenants();
      if (sessionIdentity() === owner && ticket === refreshGeneration) tenantIds = found;
    } catch {
      if (sessionIdentity() === owner && ticket === refreshGeneration) refreshError = say('tenantAccessCouldNotBe');
    } finally {
      if (sessionIdentity() === owner && ticket === refreshGeneration) {
        refreshing = false;
        drawControl();
      }
    }
  };
  ownDiscoveryRefresh(owner, refresh);
  const switchTo = async (tenantId: string) => {
    if (busy || refreshing || sessionIdentity().tenant !== selected || tenantId === selected.tenantId || !tenantIds.includes(tenantId))
      return;
    busy = true;
    try {
      if (!(await before())) {
        busy = false;
        return;
      }
    } catch {
      busy = false;
      return;
    }
    if (sessionIdentity().tenant !== selected) return;
    // The stable control owner has no lease fields. Capture the latest exact
    // lease after the exit guard and immediately before retirement.
    const previous = captureTenantLease();
    if (!previous) {
      busy = false;
      return;
    }
    const pending = requireTenantSelection();
    try {
      await clear();
    } catch {
      if (sessionIdentity() === pending) invalidateSession('unavailable', false);
      return;
    }
    const host = shellById('content');
    if (!host || sessionIdentity() !== pending) return;
    let error: string | undefined;
    const draw = () => {
      if (sessionIdentity() === pending)
        mount(
          host,
          createElement(TenantChooser, {
            appName,
            tenantIds: [],
            names: tenantNames(),
            sandboxes: tenantSandboxes(),
            platformLabel,
            tenantLabel,
            busy,
            error,
            onSelect: () => {},
            onRetry: () => {
              void recover();
            },
          }),
        );
    };
    const restore = async (reply: TenantContextReply) => {
      const restoredOwner = remember(reply, pending);
      try {
        await rebuild();
      } catch {
        if (sessionIdentity() === restoredOwner) invalidateSession('unavailable', false);
      }
    };
    const recover = async () => {
      if (busy || sessionIdentity() !== pending) return;
      busy = true;
      error = undefined;
      draw();
      try {
        const reply = await recoverTenant(selected.tabId);
        if ('context' in reply) {
          await restore(reply);
          return;
        }
        error = say('thePreviousContextIsInactive');
      } catch {
        error = say('theTenantSelectionIsStill');
      } finally {
        busy = false;
        draw();
      }
    };
    draw();
    try {
      await restore(await chooseTenant(tenantId, previous));
    } catch {
      if (sessionIdentity() === pending) {
        busy = false;
        error = say('theTenantSwitchWasNotConfirmed');
        draw();
      }
    }
  };
  // The tenant's side of the same feature, in the same place the platform's
  // "Enter {tenant}" sits: a way to see the visits that were made into here. The
  // grant is the member's role's, and it reaches the browser on the App
  // payload, which is loaded before this control is built.
  if (selected.tenantId !== PLATFORM_TENANT_ID) {
    if (!supportLog) return control;
    const log = document.createElement('button');
    log.type = 'button';
    log.className = 'ghost tenant-support-log';
    log.textContent = say('supportVisits');
    const openLog = () => {
      if (sessionIdentity() !== owner || sessionIdentity().tenant !== selected) return;
      showSupportLog();
    };
    log.addEventListener('click', openLog);
    actions = [{ label: log.textContent, onClick: openLog }];
    drawControl();
    const both = document.createElement('span');
    both.className = 'tenant-control-host tenant-control-with-support';
    control.className = 'tenant-control-inner';
    both.append(control, log);
    return both;
  }
  /* The platform's audit of every tenant's visits sits beside Enter, on the same platform lease that reads it. */
  const audit = supportAudit ? document.createElement('button') : undefined;
  if (audit) {
    audit.type = 'button';
    audit.className = 'ghost tenant-support-sessions';
    audit.textContent = say('supportSessions');
    audit.addEventListener('click', () => {
      if (sessionIdentity() !== owner || sessionIdentity().tenant !== selected) return;
      showSupportSessions();
    });
  }
  const openAudit = () => audit?.click();
  if (!support) {
    if (!audit) return control;
    actions = [{ label: audit.textContent!, onClick: openAudit }];
    drawControl();
    const both = document.createElement('span');
    both.className = 'tenant-control-host tenant-control-with-support';
    control.className = 'tenant-control-inner';
    both.append(control, audit);
    return both;
  }
  // Entering a tenant replaces this surface with the support screen; leaving
  // it opens the platform afresh. A support lease never switches.
  const enterSupport = async (session: SupportSessionView) => {
    const pending = requireTenantSelection();
    try {
      await clear();
    } catch {
      if (sessionIdentity() === pending) invalidateSession('unavailable', false);
      return;
    }
    const host = shellById('content');
    if (!host || sessionIdentity() !== pending) return;
    let dispose = () => {};
    dispose = showSupportSession(host, session, {
      platformLabel: platformLabel ?? say('platform'),
      leave: async () => {
        const reply = await chooseTenant(PLATFORM_TENANT_ID);
        dispose();
        const restoredOwner = remember(reply, pending);
        try {
          await rebuild();
        } catch {
          if (sessionIdentity() === restoredOwner) invalidateSession('unavailable', false);
        }
      },
    });
  };
  const entry = document.createElement('button');
  entry.type = 'button';
  entry.className = 'ghost tenant-support-entry';
  entry.textContent = say('enterTenant', { name: tenancyNoun(tenantLabel, say('tenant')).name });
  const openEntry = () => {
    if (busy || refreshing || sessionIdentity() !== owner || sessionIdentity().tenant !== selected) return;
    enterDealer({
      who: support!.who,
      platformLabel: platformLabel ?? say('platform'),
      ...(tenantLabel ? { tenantLabel } : {}),
      before,
      enter: (session) => enterSupport(session),
    });
  };
  entry.addEventListener('click', openEntry);
  actions = [{ label: entry.textContent, onClick: openEntry }, ...(audit ? [{ label: audit.textContent!, onClick: openAudit }] : [])];
  drawControl();
  const both = document.createElement('span');
  both.className = 'tenant-control-host tenant-control-with-support';
  control.className = 'tenant-control-inner';
  both.append(control, entry, ...(audit ? [audit] : []));
  return both;
}
