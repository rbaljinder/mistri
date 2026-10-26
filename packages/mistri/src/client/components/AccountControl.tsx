/**
 * Who is signed in, at the end of the toolbar: a menu of what the account can
 * do — its profile, a tenant's administration and invitations — and signing
 * out. Apart from the sign-in screen (SignIn.tsx), which a signed-out page
 * loads without the shell and without this menu's weight.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { beginSessionSignOut } from '@mistriwork/kit/client/sessionLifecycle.js';
import {
  captureAccountIdentity,
  sessionIdentity,
  subscribeSessionIdentity,
  type SessionIdentitySnapshot,
} from '@mistriwork/kit/client/sessionIdentity.js';
import { DropItem, DropMenu, DropSeparator } from '@mistriwork/ui/DropMenu.js';
import './AccountMenu.css';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { hasUnresolvedAdministration, TenantAdministrationController } from '../tenantAdministration.js';
import { hasUnresolvedInvitations, recipientStep, TenantInvitationsController } from '../tenantInvitations.js';
import { post, reload } from './authRequest.js';
import { menuItems, menuMode, setAccountMenu, whenMenuChanges } from '@mistriwork/kit/client/menu.js';
import { MenuRegistryItems } from '@mistriwork/kit/client/components/OverflowMenu.js';
import { InboxBell } from './InboxBell.js';
import type { AppSwitcherConfig, AppSwitcherLocal } from './SuiteAppSwitcher.js';
import { say } from '../copy/account/components/AccountControl.js';
import { shellById, shellQuery } from '@mistriwork/kit/client/shellHost.js';
import { subscribeTenantContextEntry, tenantContextEntry } from '../tenantContextEntry.js';

const looksLikeEmail = (value: string) => /^[^\s@]+@[^\s@]+$/.test(value);

/* The account's dialogs load the first time one opens. */
const AccountProfile = onDemand(() => import('./AccountProfile.js'), 'AccountProfile', { quiet: true });
const AccountAdministration = onDemand(() => import('./AccountAdministration.js'), 'AccountAdministration', { quiet: true });
const TenantAdministration = onDemand(() => import('./TenantAdministration.js'), 'TenantAdministration', { quiet: true });
const TenantInvitations = onDemand(() => import('./TenantInvitations.js'), 'TenantInvitations', { quiet: true });
const TenantApiTokens = onDemand(() => import('./TenantApiTokens.js'), 'TenantApiTokens', { quiet: true });
const SuiteAppSwitcher = onDemand(() => import('./SuiteAppSwitcher.js'), 'SuiteAppSwitcher', { quiet: true });

/** Identity is a menu trigger, never an implicit sign-out action. */
export function AccountControl({
  who,
  owner: suppliedOwner,
  appSwitcher,
  appSwitcherLocal,
  accountProfile = false,
  accountAdministration = false,
  tenantAdministration = false,
  tenantInvitations = false,
  apiTokens = false,
  inbox = false,
  onInvitationAccepted,
}: {
  who: string;
  accountProfile?: boolean;
  /** Captured by the shell before this optional control's code arrives. */
  owner?: SessionIdentitySnapshot;
  appSwitcher?: AppSwitcherConfig;
  appSwitcherLocal?: AppSwitcherLocal;
  /** An administrator's Accounts screen: the server's answer, asked again by every request the screen makes. */
  accountAdministration?: boolean;
  tenantAdministration?: boolean;
  tenantInvitations?: boolean;
  /** This member may make and end API tokens on their tenant's lease: the App payload's answer for the lease. */
  apiTokens?: boolean;
  /** The App keeps this account an inbox: the bell stands before the account menu. */
  inbox?: boolean;
  onInvitationAccepted?: () => void;
}) {
  const owner = useRef(suppliedOwner ?? captureAccountIdentity()).current;
  const host = useRef<HTMLSpanElement>(null);
  const [menuGeneration, setMenuGeneration] = useState(0);
  const [profileOpen, setProfileOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [tokensOpen, setTokensOpen] = useState(false);
  // Profile still uses the business snapshot's existing request lifetime.
  // Close its retired instance so the next menu click can open a fresh one.
  useEffect(
    () =>
      subscribeSessionIdentity(() => {
        setProfileOpen(false);
        setAccountsOpen(false);
        setTokensOpen(false);
      }),
    [],
  );
  const [administrationOpen, setAdministrationOpen] = useState(false);
  const [administration] = useState(() => new TenantAdministrationController(owner));
  const administrationView = useSyncExternalStore(administration.subscribe, administration.snapshot);
  const [invitationMode, setInvitationMode] = useState<'issuer' | 'recipient' | null>(null);
  const [invitations] = useState(() => new TenantInvitationsController(owner));
  const invitationView = useSyncExternalStore(invitations.subscribe, invitations.snapshot);
  const acceptedReceipt = useRef<string | null>(null);
  useEffect(() => {
    const result = invitationView.result;
    if (
      invitations.current() &&
      result &&
      'status' in result &&
      result.status === 'accepted' &&
      acceptedReceipt.current !== result.receiptId
    ) {
      acceptedReceipt.current = result.receiptId;
      onInvitationAccepted?.();
    }
  }, [invitations, invitationView.result, onInvitationAccepted]);
  const alive = useRef(false);
  /* Administration and invitations are opened when the reader reaches for
     this menu — a hover, a focus, the menu opening — not when the shell is
     drawn. Each open is a writer transaction of a hundred-odd statements; on
     entering a context they held the one writer in front of the member's
     first command, and at a real distance to the database for seconds. What
     each open decides is only whether its item is offered here. */
  const [reached, setReached] = useState(false);
  const [settled, setSettled] = useState({ administration: false, invitations: false });
  const reach = () => {
    if (!reached && (tenantAdministration || tenantInvitations)) setReached(true);
  };
  useEffect(() => {
    if (!reached) return;
    const done = (which: keyof typeof settled) => () => {
      if (alive.current) setSettled((was) => ({ ...was, [which]: true }));
    };
    if (tenantAdministration) void administration.open().finally(done('administration'));
    if (tenantInvitations) void invitations.openIssuer().finally(done('invitations'));
  }, [reached, administration, tenantAdministration, invitations, tenantInvitations]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // React's effect replay reuses this owner; an actual new mount does not.
      queueMicrotask(() => {
        if (!alive.current) {
          administration.retire();
          invitations.retire();
        }
      });
    };
  }, [administration, tenantAdministration, invitations, tenantInvitations]);
  /* In an App the reader's settings — Preferences, dark mode —
     are this menu's while someone is signed in, and the settings gear stands
     down (OverflowMenu.tsx): a gear beside the account was two menus at the
     bar's end, and which held what was a guess. The Workbench keeps its ···. */
  useEffect(() => {
    setAccountMenu(true);
    return () => setAccountMenu(false);
  }, []);
  const inApp = useSyncExternalStore(
    whenMenuChanges,
    () => menuMode() === 'app',
    () => false,
  );
  /* An App's settings record may be called "Your profile" too (a borrower's
     own record): then this item, the sign-in's name, email and password, is
     "Your account", and the menu never says one thing twice. */
  const profileTaken = useSyncExternalStore(
    whenMenuChanges,
    () =>
      (menuItems() as Array<{ label?: unknown }>).some(
        (item) => typeof item.label === 'string' && item.label.trim().toLowerCase() === say('yourProfile').toLowerCase(),
      ),
    () => false,
  );
  const profileLabel = profileTaken ? say('yourAccount') : say('yourProfile');
  /* The tenant context's control, as this menu's first item: drawn on a phone only, where the bar leaves it out (AccountMenu.css). */
  const context = useSyncExternalStore(subscribeTenantContextEntry, tenantContextEntry, () => undefined);
  const attempted = useRef(false);
  const signOut = async () => {
    // The lock can synchronously reenter handlers before React removes this menu.
    // An uncertain attempt stays spent; only session verification can continue.
    if (
      attempted.current ||
      owner.mode !== 'authenticated' ||
      captureAccountIdentity() !== owner ||
      hasUnresolvedAdministration() ||
      hasUnresolvedInvitations()
    )
      return;
    attempted.current = true;
    const account = owner.accountId;
    const previous = sessionIdentity();
    beginSessionSignOut();
    const locked = sessionIdentity();
    if (locked.mode !== 'locked' || locked.epoch !== previous.epoch + 1) return;
    const retry = shellQuery<HTMLButtonElement>('#session-lock button');
    const title = shellById('session-lock-title');
    if (retry) retry.disabled = true;
    try {
      await post('/api/auth/sign-out', {}, account ?? undefined);
      if (sessionIdentity() === locked) reload();
    } catch {
      // A later session (even one that has since locked) owns its own UI.
      if (sessionIdentity() !== locked) return;
      if (title) title.textContent = say('signOutCouldNotBeConfirmed');
      if (retry) retry.disabled = false;
    }
  };
  /* An account known only by its email is drawn as its avatar: a raw address
     in the bar reads as a form field, not a person. The address still says
     who is signed in, in the trigger's name and at the head of the menu. */
  const address = looksLikeEmail(who.trim());
  const initials = (address ? [who.trim()] : who.trim().split(/\s+/).slice(0, 2))
    .map((part) => Array.from(part)[0])
    .join('')
    .toUpperCase();
  return (
    <>
      {appSwitcher?.placement === 'navbar' && <SuiteAppSwitcher config={appSwitcher} local={appSwitcherLocal} placement="navbar" />}
      <span ref={host} className={inbox ? 'account-with-inbox' : undefined} onPointerEnter={reach} onFocusCapture={reach}>
        {inbox && <InboxBell />}
        <DropMenu
          className="account-menu"
          triggerClassName="ghost account"
          triggerTitle={say('account', { who })}
          triggerLabel={say('account', { who })}
          label={
            <>
              <span className="account-avatar" aria-hidden="true">
                {initials}
              </span>
              {!address && <span className="account-name">{who}</span>}
              <span className="account-caret" aria-hidden="true">
                ▾
              </span>
            </>
          }
          popupClassName="more-list account-menu-popup"
          onOpenChange={(open) => {
            if (open) {
              reach();
              if (appSwitcher?.placement === 'account') setMenuGeneration((generation) => generation + 1);
            }
          }}
        >
          <div className="account-menu-identity">
            <span>{say('signed')}</span>
            <span>{who}</span>
          </div>
          {context && (
            <DropItem className="account-menu-signout account-menu-context" disabled={context.busy} onClick={context.open}>
              {context.word && <span className="account-menu-context-word">{context.word} </span>}
              <bdi>{context.name}</bdi>
              {context.sandbox && <span className="tenant-sandbox-mark tone-warn">{context.sandbox}</span>}
            </DropItem>
          )}
          {context && <DropSeparator className="account-menu-context-sep" />}
          {appSwitcher?.placement === 'account' && (
            <SuiteAppSwitcher key={menuGeneration} config={appSwitcher} local={appSwitcherLocal} placement="account" />
          )}
          {accountProfile && (
            <DropItem
              className="account-menu-signout"
              onClick={() => {
                if (captureAccountIdentity() === owner && owner.mode === 'authenticated') setProfileOpen(true);
              }}
            >
              {profileLabel}
            </DropItem>
          )}
          {accountAdministration && (
            <DropItem
              className="account-menu-signout"
              onClick={() => {
                if (captureAccountIdentity() === owner && owner.mode === 'authenticated') setAccountsOpen(true);
              }}
            >
              {say('manageAccounts')}
            </DropItem>
          )}
          {tenantAdministration && administrationView.session && administration.current() && (
            <DropItem
              className="account-menu-signout"
              onClick={() => {
                if (administration.current()) setAdministrationOpen(true);
              }}
            >
              {say('manageTenants')}
            </DropItem>
          )}
          {tenantAdministration && reached && !settled.administration && !administrationView.session && administration.current() && (
            <DropItem className="account-menu-signout" disabled onClick={() => {}}>
              {say('checkingTenantAdministration')}
            </DropItem>
          )}
          {tenantAdministration && !administrationView.session && administrationView.message && administration.current() && (
            <DropItem className="account-menu-signout" onClick={() => void administration.open()}>
              {say('retryTenantAdministration')}
            </DropItem>
          )}
          {apiTokens && (
            <DropItem
              className="account-menu-signout"
              onClick={() => {
                if (captureAccountIdentity() === owner && owner.mode === 'authenticated') setTokensOpen(true);
              }}
            >
              {say('apiTokens')}
            </DropItem>
          )}
          {tenantInvitations && invitations.current() && (
            <>
              {invitationView.issuerSession && (
                <DropItem
                  className="account-menu-signout"
                  onClick={() => {
                    if (!invitations.current()) return;
                    setInvitationMode(invitations.locked() && recipientStep(invitationView.attempt?.intent) ? 'recipient' : 'issuer');
                  }}
                >
                  {say('manageInvitations')}
                </DropItem>
              )}
              <DropItem
                className="account-menu-signout"
                onClick={() => {
                  if (!invitations.current()) return;
                  setInvitationMode(invitations.locked() && !recipientStep(invitationView.attempt?.intent) ? 'issuer' : 'recipient');
                }}
              >
                {say('acceptInvitation')}
              </DropItem>
              {reached && !settled.invitations && !invitationView.issuerSession && (
                <DropItem className="account-menu-signout" disabled onClick={() => {}}>
                  {say('checkingInvitations')}
                </DropItem>
              )}
              {!invitationView.issuerSession && invitationView.message && (
                <DropItem className="account-menu-signout" onClick={() => void invitations.openIssuer()}>
                  {say('checkInvitationPermissions')}
                </DropItem>
              )}
            </>
          )}
          {inApp && (
            <div className="account-menu-settings">
              <MenuRegistryItems />
            </div>
          )}
          <DropItem className="account-menu-signout" onClick={() => void signOut()}>
            {say('signOut')}
          </DropItem>
        </DropMenu>
        {profileOpen && (
          <AccountProfile
            title={profileLabel}
            onClose={() => {
              setProfileOpen(false);
              queueMicrotask(() => {
                if (captureAccountIdentity() === owner) host.current?.querySelector('button')?.focus({ preventScroll: true });
              });
            }}
          />
        )}
        {tokensOpen && (
          <TenantApiTokens
            onClose={() => {
              setTokensOpen(false);
              queueMicrotask(() => {
                if (captureAccountIdentity() === owner) host.current?.querySelector('button')?.focus({ preventScroll: true });
              });
            }}
          />
        )}
        {accountsOpen && (
          <AccountAdministration
            onClose={() => {
              setAccountsOpen(false);
              queueMicrotask(() => {
                if (captureAccountIdentity() === owner) host.current?.querySelector('button')?.focus({ preventScroll: true });
              });
            }}
          />
        )}
        {administrationOpen && (
          <TenantAdministration
            controller={administration}
            onClose={() => {
              if (administration.locked()) return;
              setAdministrationOpen(false);
              queueMicrotask(() => {
                if (captureAccountIdentity() === owner) host.current?.querySelector('button')?.focus({ preventScroll: true });
              });
            }}
          />
        )}
        {invitationMode && (
          <TenantInvitations
            controller={invitations}
            mode={invitationMode}
            onClose={() => {
              if (invitations.locked()) return;
              setInvitationMode(null);
              queueMicrotask(() => {
                if (captureAccountIdentity() === owner) host.current?.querySelector('button')?.focus({ preventScroll: true });
              });
            }}
          />
        )}
      </span>
    </>
  );
}
