/** Tabbed account, security session, API token, verified domain, and team role settings surface. */
'use client';

import { Icon } from '../Icon.js';
import { type FormEvent, type Ref, useEffect, useMemo, useRef, useState } from 'react';
import { Button, IconButton } from '../primitives/actions.js';
import { Avatar, Badge, Code, Person, StatusDot } from '../primitives/display.js';
import { Input } from '../primitives/inputs.js';
import { Tabs, type TabItemDefinition } from '../primitives/navigation.js';
import { Checkbox, Select, Switch, type SelectOption } from '../primitives/selection.js';
import { cx } from '../internal/cx.js';

/** Tab identifier for `AccountSettingsView`. */
export type AccountSettingsTab = 'profile' | 'sessions' | 'tokens' | 'team';

/** Workspace role option in `AccountSettingsView`. */
export type AccountTeamRole = 'Owner' | 'Admin' | 'Builder' | 'Viewer';

/** Personal profile and security settings data for `AccountSettingsView`. */
export interface AccountProfileData {
  name: string;
  email: string;
  role: AccountTeamRole;
  avatarUrl?: string;
  workspaceName?: string;
  twoFactorEnabled: boolean;
  passkeyRegistered: boolean;
  passkeyLabel?: string;
}

/** Active device session entry in `AccountSettingsView`. */
export interface AccountSessionItem {
  id: string;
  deviceType: 'laptop' | 'desktop' | 'mobile';
  client: string;
  ip: string;
  location: string;
  lastActive: string;
  current?: boolean;
}

/** Scoped API service token entry in `AccountSettingsView`. */
export interface AccountApiToken {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  lastUsed: string;
}

/** Workspace team member entry in `AccountSettingsView`. */
export interface AccountTeamMember {
  id: string;
  name: string;
  email: string;
  role: AccountTeamRole;
  avatarUrl?: string;
  status?: 'active' | 'invited';
}

/** Verified custom domain entry in `AccountSettingsView`. */
export interface AccountDomainItem {
  id: string;
  domain: string;
  cnameTarget: string;
  verified: boolean;
  tlsStatus: 'active' | 'provisioning' | 'pending';
  primary?: boolean;
}

/** Props for the `AccountSettingsView` surface. */
export interface AccountSettingsViewProps {
  layout?: 'tabs' | 'stacked';
  activeTab?: AccountSettingsTab;
  defaultTab?: AccountSettingsTab;
  onTabChange?: (tab: AccountSettingsTab) => void;
  /* Initial / Controlled Data */
  profile?: AccountProfileData;
  sessions?: ReadonlyArray<AccountSessionItem>;
  tokens?: ReadonlyArray<AccountApiToken>;
  availableScopes?: ReadonlyArray<{ value: string; label: string }>;
  members?: ReadonlyArray<AccountTeamMember>;
  domains?: ReadonlyArray<AccountDomainItem>;
  defaultCnameTarget?: string;
  /* Callbacks. Each may return a promise: the view draws the change at once, and where the promise rejects it puts
     the change back and says the action failed. A handler that returns nothing is taken at its word. */
  onSaveProfile?: (next: AccountProfileData) => void | Promise<unknown>;
  onRevokeSession?: (sessionId: string) => void | Promise<unknown>;
  /**
   * Creates the token and returns (or resolves to) the secret to show once. The secret is the server's to mint: it
   * is what the server will later check, and the browser cannot be the one that knows it first. `rawSecret` is a
   * placeholder drawn in the browser, shown only when the host returns no secret of its own; a host that mints
   * its own ignores it.
   */
  onCreateToken?: (token: AccountApiToken, rawSecret: string) => string | void | Promise<string | void>;
  onRevokeToken?: (tokenId: string) => void | Promise<unknown>;
  onInviteMember?: (email: string, role: AccountTeamRole) => void | Promise<unknown>;
  onMemberRoleChange?: (memberId: string, role: AccountTeamRole) => void | Promise<unknown>;
  onRemoveMember?: (memberId: string) => void | Promise<unknown>;
  onAddDomain?: (domain: string) => void | Promise<unknown>;
  onRemoveDomain?: (domainId: string) => void | Promise<unknown>;
  /* Whether each section draws its own border, radius and shadow. `false` inside a Card or Panel, which already
     draws them: a card in a card is one box too many. */
  framed?: boolean;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

const EMPTY_PROFILE: AccountProfileData = {
  name: '',
  email: '',
  role: 'Viewer',
  twoFactorEnabled: false,
  passkeyRegistered: false,
};

const EMPTY_SESSIONS: ReadonlyArray<AccountSessionItem> = [];
const EMPTY_SCOPES: ReadonlyArray<{ value: string; label: string }> = [];
const EMPTY_TOKENS: ReadonlyArray<AccountApiToken> = [];
const EMPTY_MEMBERS: ReadonlyArray<AccountTeamMember> = [];
const EMPTY_DOMAINS: ReadonlyArray<AccountDomainItem> = [];

const ROLE_OPTIONS: SelectOption<AccountTeamRole>[] = [
  { value: 'Owner', label: 'Owner', description: 'Full billing, domain & IAM access' },
  { value: 'Admin', label: 'Admin', description: 'Manage members, tokens & schemas' },
  { value: 'Builder', label: 'Builder', description: 'Configure views & workflows' },
  { value: 'Viewer', label: 'Viewer', description: 'Read-only operational access' },
];

const EXPIRATION_OPTIONS: SelectOption<string>[] = [
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '1y', label: '1 year' },
  { value: 'never', label: 'No expiration' },
];

/* A stand-in secret for a host that returns none from `onCreateToken`. The host should mint the secret on its
   server and return it; this exists so a view wired to nothing still has something to show. It is drawn from the
   platform's cryptographic generator and never from `Math.random`, whose output can be predicted from a few
   samples, and where there is no such generator there is no stand-in at all. */
function fallbackTokenSecret(): string | null {
  const source = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (!source?.getRandomValues) return null;
  const bytes = source.getRandomValues(new Uint8Array(20));
  return `token_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/* What the tokens list shows of a secret: its first characters, enough to tell two tokens apart and no more. */
function tokenPrefixOf(secret: string): string {
  return `${secret.slice(0, 12)}••••••••`;
}

type AccountSection = 'profile' | 'sessions' | 'tokens' | 'team';

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';

function putBack<T extends { id: string }>(list: T[], item: T, at: number): T[] {
  if (list.some((entry) => entry.id === item.id)) return list;
  const next = [...list];
  next.splice(Math.min(Math.max(0, at), next.length), 0, item);
  return next;
}

function SectionFailure({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <div role="alert" className="nx-account-error">
      <Icon name="warning" size={15} weight="bold" />
      <span>{message}</span>
    </div>
  );
}

function expirationText(code: string): string {
  switch (code) {
    case '30d':
      return 'In 30 days';
    case '90d':
      return 'In 90 days';
    case '1y':
      return 'In 1 year';
    default:
      return 'Never';
  }
}

function SessionDeviceIcon({ deviceType }: { deviceType: AccountSessionItem['deviceType'] }) {
  if (deviceType === 'mobile') return <Icon name="device-mobile" size={17} />;
  if (deviceType === 'desktop') return <Icon name="monitor" size={17} />;
  return <Icon name="laptop" size={17} />;
}

/** Tabbed account, security session, API token, verified domain, and team role settings surface. */
export function AccountSettingsView({
  layout = 'tabs',
  activeTab: controlledTab,
  defaultTab = 'profile',
  onTabChange,
  profile: initialProfile = EMPTY_PROFILE,
  sessions: initialSessions = EMPTY_SESSIONS,
  tokens: initialTokens = EMPTY_TOKENS,
  availableScopes = EMPTY_SCOPES,
  members: initialMembers = EMPTY_MEMBERS,
  domains: initialDomains = EMPTY_DOMAINS,
  defaultCnameTarget = 'cname.example.com',
  onSaveProfile,
  onRevokeSession,
  onCreateToken,
  onRevokeToken,
  onInviteMember,
  onMemberRoleChange,
  onRemoveMember,
  onAddDomain,
  onRemoveDomain,
  framed = true,
  className,
  ref,
}: AccountSettingsViewProps) {
  /* --- State --- */
  const [profileState, setProfileState] = useState<AccountProfileData>(initialProfile);
  const [profileSaved, setProfileSaved] = useState(false);
  const profileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [sessionList, setSessionList] = useState<AccountSessionItem[]>(() => [...initialSessions]);

  const [tokenList, setTokenList] = useState<AccountApiToken[]>(() => [...initialTokens]);
  const [newTokenName, setNewTokenName] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<string[]>(() => availableScopes.slice(0, 2).map((s) => s.value));
  const [tokenExpiry, setTokenExpiry] = useState<string>('90d');
  const [revealedSecret, setRevealedSecret] = useState<{
    name: string;
    secret: string;
  } | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [creatingToken, setCreatingToken] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [failures, setFailures] = useState<Partial<Record<AccountSection, string>>>({});

  const [memberList, setMemberList] = useState<AccountTeamMember[]>(() => [...initialMembers]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<AccountTeamRole>('Builder');

  const [domainList, setDomainList] = useState<AccountDomainItem[]>(() => [...initialDomains]);
  const [newDomainInput, setNewDomainInput] = useState('');

  useEffect(() => {
    return () => {
      if (profileTimerRef.current !== null) clearTimeout(profileTimerRef.current);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    setProfileState(initialProfile);
  }, [initialProfile]);
  useEffect(() => {
    setSessionList([...initialSessions]);
  }, [initialSessions]);
  useEffect(() => {
    setTokenList([...initialTokens]);
  }, [initialTokens]);
  useEffect(() => {
    setMemberList([...initialMembers]);
  }, [initialMembers]);
  useEffect(() => {
    setDomainList([...initialDomains]);
  }, [initialDomains]);

  /* --- Handlers --- */

  /* Every change here is drawn before the host has answered, so each one needs a way back. `attempt` calls the
     handler and, where it returns a promise that rejects (or throws), undoes the change with `undo` and says so in
     the section it happened in; `done` runs once the handler has answered without failing. The view used to draw
     the change and stop: a revoke the server refused stayed revoked on screen until the next reload. */
  const attempt = <R,>(section: AccountSection, call: () => R, failed: string, undo: () => void, done?: (answer: Awaited<R>) => void) => {
    setFailures((prev) => ({ ...prev, [section]: undefined }));
    const fail = () => {
      undo();
      setFailures((prev) => ({ ...prev, [section]: failed }));
    };
    let returned: R;
    try {
      returned = call();
    } catch {
      fail();
      return;
    }
    if (isThenable(returned)) {
      returned.then((answer) => done?.(answer as Awaited<R>), fail);
    } else {
      done?.(returned as Awaited<R>);
    }
  };

  const handleProfileSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (profileSaving) return;
    setProfileSaved(false);
    const showSaved = () => {
      setProfileSaving(false);
      setProfileSaved(true);
      if (profileTimerRef.current !== null) clearTimeout(profileTimerRef.current);
      profileTimerRef.current = setTimeout(() => setProfileSaved(false), 2000);
    };
    setProfileSaving(true);
    attempt(
      'profile',
      () => onSaveProfile?.(profileState),
      'Your profile could not be saved. Your changes are still in the form; try again.',
      () => setProfileSaving(false),
      showSaved,
    );
  };

  const revokeSession = (session: AccountSessionItem, at: number) => {
    setSessionList((prev) => prev.filter((s) => s.id !== session.id));
    attempt(
      'sessions',
      () => onRevokeSession?.(session.id),
      `The session on ${session.client} could not be revoked and is still signed in.`,
      () => setSessionList((prev) => putBack(prev, session, at)),
    );
  };

  const handleRevokeSession = (id: string) => {
    const at = sessionList.findIndex((s) => s.id === id);
    if (at >= 0) revokeSession(sessionList[at]!, at);
  };

  const handleRevokeOtherSessions = () => {
    sessionList.forEach((session, at) => {
      if (!session.current) revokeSession(session, at);
    });
  };

  const toggleScope = (scopeVal: string, checked: boolean) => {
    setSelectedScopes((prev) => {
      if (checked) {
        return prev.includes(scopeVal) ? prev : [...prev, scopeVal];
      }
      return prev.filter((s) => s !== scopeVal);
    });
  };

  const handleGenerateToken = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = newTokenName.trim();
    if (creatingToken || !trimmed || (availableScopes.length > 0 && selectedScopes.length === 0)) return;

    const standIn = fallbackTokenSecret();
    const created: AccountApiToken = {
      id: `tok-${Date.now().toString(36)}`,
      name: trimmed,
      prefix: standIn ? tokenPrefixOf(standIn) : '',
      scopes: [...selectedScopes],
      createdAt: 'Just now',
      expiresAt: expirationText(tokenExpiry),
      lastUsed: 'Never used',
    };

    setTokenList((prev) => [created, ...prev]);
    setRevealedSecret(null);
    setCopyState('idle');
    setNewTokenName('');
    setCreatingToken(true);
    attempt(
      'tokens',
      () => onCreateToken?.(created, standIn ?? ''),
      `The token "${trimmed}" could not be created.`,
      () => {
        setCreatingToken(false);
        setTokenList((prev) => prev.filter((t) => t.id !== created.id));
        setNewTokenName(trimmed);
      },
      (answer) => {
        setCreatingToken(false);
        /* The host's secret is the real one; the stand-in is shown only where the host gave none. */
        const minted = typeof answer === 'string' && answer !== '' ? answer : null;
        const secret = minted ?? standIn;
        if (minted) setTokenList((prev) => prev.map((t) => (t.id === created.id ? { ...t, prefix: tokenPrefixOf(minted) } : t)));
        if (secret) setRevealedSecret({ name: trimmed, secret });
      },
    );
  };

  /* "Copied" is said only once the clipboard has taken the secret. It is shown once, so a copy that silently did
     nothing (no clipboard on an insecure origin, a refused permission) left the person with a token they believed
     they had and did not. */
  const handleCopySecret = () => {
    if (!revealedSecret) return;
    const settle = (state: 'copied' | 'failed') => {
      setCopyState(state);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      if (state === 'copied') copyTimerRef.current = setTimeout(() => setCopyState('idle'), 1500);
    };
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard?.writeText) {
      settle('failed');
      return;
    }
    let written: Promise<void>;
    try {
      written = clipboard.writeText(revealedSecret.secret);
    } catch {
      settle('failed');
      return;
    }
    written.then(
      () => settle('copied'),
      () => settle('failed'),
    );
  };

  const handleRevokeToken = (tokenId: string) => {
    const at = tokenList.findIndex((t) => t.id === tokenId);
    if (at < 0) return;
    const token = tokenList[at]!;
    setTokenList((prev) => prev.filter((t) => t.id !== tokenId));
    attempt(
      'tokens',
      () => onRevokeToken?.(tokenId),
      `The token "${token.name}" could not be revoked and is still active.`,
      () => setTokenList((prev) => putBack(prev, token, at)),
    );
  };

  const handleInviteSubmit = (e: FormEvent) => {
    e.preventDefault();
    const email = inviteEmail.trim();
    if (!email || !email.includes('@')) return;

    const localPart = email.split('@')[0] ?? 'Member';
    const prettyName = localPart
      .split(/[._-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');

    const added: AccountTeamMember = {
      id: `mem-${Date.now().toString(36)}`,
      name: prettyName || email,
      email,
      role: inviteRole,
      status: 'invited',
    };

    setMemberList((prev) => [...prev, added]);
    setInviteEmail('');
    attempt(
      'team',
      () => onInviteMember?.(email, inviteRole),
      `The invitation to ${email} could not be sent.`,
      () => {
        setMemberList((prev) => prev.filter((m) => m.id !== added.id));
        setInviteEmail(email);
      },
    );
  };

  const handleRoleChange = (memberId: string, nextRole: AccountTeamRole) => {
    const member = memberList.find((m) => m.id === memberId);
    if (!member || member.role === nextRole) return;
    const before = member.role;
    setMemberList((prev) => prev.map((m) => (m.id === memberId ? { ...m, role: nextRole } : m)));
    attempt(
      'team',
      () => onMemberRoleChange?.(memberId, nextRole),
      `${member.name}'s role could not be changed and is still ${before}.`,
      () => setMemberList((prev) => prev.map((m) => (m.id === memberId ? { ...m, role: before } : m))),
    );
  };

  const handleRemoveMember = (memberId: string) => {
    const at = memberList.findIndex((m) => m.id === memberId);
    if (at < 0) return;
    const member = memberList[at]!;
    setMemberList((prev) => prev.filter((m) => m.id !== memberId));
    attempt(
      'team',
      () => onRemoveMember?.(memberId),
      `${member.name} could not be removed and is still a member.`,
      () => setMemberList((prev) => putBack(prev, member, at)),
    );
  };

  const handleAddDomainSubmit = (e: FormEvent) => {
    e.preventDefault();
    const cleaned = newDomainInput
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
    if (!cleaned || !cleaned.includes('.')) return;

    /* A domain typed a moment ago has been neither verified nor issued a certificate: it is drawn as pending until
       the host's `domains` say otherwise. */
    const created: AccountDomainItem = {
      id: `dom-${Date.now().toString(36)}`,
      domain: cleaned,
      cnameTarget: defaultCnameTarget,
      verified: false,
      tlsStatus: 'pending',
    };

    setDomainList((prev) => [...prev, created]);
    setNewDomainInput('');
    attempt(
      'team',
      () => onAddDomain?.(cleaned),
      `${cleaned} could not be added.`,
      () => {
        setDomainList((prev) => prev.filter((d) => d.id !== created.id));
        setNewDomainInput(cleaned);
      },
    );
  };

  const handleRemoveDomain = (domainId: string) => {
    const at = domainList.findIndex((d) => d.id === domainId);
    if (at < 0) return;
    const domain = domainList[at]!;
    setDomainList((prev) => prev.filter((d) => d.id !== domainId));
    attempt(
      'team',
      () => onRemoveDomain?.(domainId),
      `${domain.domain} could not be removed and is still configured.`,
      () => setDomainList((prev) => putBack(prev, domain, at)),
    );
  };

  /* --- Section 1: Profile & Security --- */
  const hasProfileIdentity = Boolean(profileState.name || profileState.email || profileState.avatarUrl || profileState.workspaceName);

  const profileSection = (
    <div className="nx-account-panel-stack">
      <form className="nx-account-card" onSubmit={handleProfileSubmit}>
        <div className="nx-account-card-head">
          <div>
            <h3 className="nx-account-card-title">Personal profile</h3>
            <p className="nx-account-card-desc">Manage how your identity appears across audit trails, comments, and review queues.</p>
          </div>
          <Badge tone="accent" pill>
            {profileState.role}
          </Badge>
        </div>

        {hasProfileIdentity ? (
          <div className="nx-account-profile-hero">
            <Avatar size="lg" name={profileState.name || profileState.email || '?'} src={profileState.avatarUrl} status="online" />
            <div className="nx-account-profile-meta">
              {profileState.name ? <div className="nx-account-profile-name">{profileState.name}</div> : null}
              {profileState.email || profileState.workspaceName ? (
                <div className="nx-account-profile-sub">{[profileState.email, profileState.workspaceName].filter(Boolean).join(' · ')}</div>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="nx-account-form-grid">
          <Input
            label="Display name"
            placeholder="Full name"
            required
            value={profileState.name}
            onValueChange={(val) => setProfileState((prev) => ({ ...prev, name: val }))}
          />
          <Input
            label="Work email"
            type="email"
            placeholder="name@example.com"
            required
            value={profileState.email}
            onValueChange={(val) => setProfileState((prev) => ({ ...prev, email: val }))}
          />
        </div>

        <SectionFailure message={failures.profile} />

        <div className="nx-account-card-foot">
          <span className="nx-account-foot-hint">
            {profileSaved ? 'Profile changes saved.' : 'Workspace role managed by organization owners.'}
          </span>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={profileSaving}
            leadingIcon={profileSaved ? <Icon name="check" size={14} weight="bold" /> : undefined}
          >
            {profileSaved ? 'Saved' : 'Save profile'}
          </Button>
        </div>
      </form>

      {/* Passkey & 2FA Card */}
      <section className="nx-account-card">
        <div className="nx-account-card-head">
          <div>
            <h3 className="nx-account-card-title">Authentication and hardware security</h3>
            <p className="nx-account-card-desc">
              Protect your operator credentials with WebAuthn passkeys and time-based two-factor verification.
            </p>
          </div>
          <StatusDot tone={profileState.passkeyRegistered || profileState.twoFactorEnabled ? 'good' : 'warning'}>
            {profileState.passkeyRegistered && profileState.twoFactorEnabled ? 'Strong protection' : 'Standard protection'}
          </StatusDot>
        </div>

        <div className="nx-account-security-rows">
          <div className="nx-account-security-row">
            <div className="nx-account-security-icon" aria-hidden="true">
              <Icon name="fingerprint" size={18} />
            </div>
            <div className="nx-account-security-copy">
              <div className="nx-account-security-title-line">
                <span className="nx-account-security-title">WebAuthn passkeys</span>
                <Badge tone={profileState.passkeyRegistered ? 'good' : 'neutral'}>
                  {profileState.passkeyRegistered ? 'Passkey active' : 'Not configured'}
                </Badge>
              </div>
              <p className="nx-account-security-sub">
                {profileState.passkeyRegistered
                  ? (profileState.passkeyLabel ?? 'Hardware biometric passkey registered')
                  : 'Sign in passwordlessly using Touch ID, Windows Hello, or a YubiKey.'}
              </p>
            </div>
            <Button
              size="sm"
              variant={profileState.passkeyRegistered ? 'secondary' : 'primary'}
              onClick={() =>
                setProfileState((prev) => ({
                  ...prev,
                  passkeyRegistered: !prev.passkeyRegistered,
                  passkeyLabel: !prev.passkeyRegistered ? 'Hardware security key · added just now' : undefined,
                }))
              }
            >
              {profileState.passkeyRegistered ? 'Replace passkey' : 'Register passkey'}
            </Button>
          </div>

          <div className="nx-account-security-row">
            <div className="nx-account-security-icon" aria-hidden="true">
              <Icon name="shield-check" size={18} />
            </div>
            <div className="nx-account-security-copy">
              <div className="nx-account-security-title-line">
                <span className="nx-account-security-title">Two-factor authenticator (TOTP)</span>
                <Badge tone={profileState.twoFactorEnabled ? 'good' : 'warning'}>
                  {profileState.twoFactorEnabled ? '2FA Enabled' : 'Disabled'}
                </Badge>
              </div>
              <p className="nx-account-security-sub">Require a 6-digit authenticator code when signing in from an unrecognized device.</p>
            </div>
            <Switch
              checked={profileState.twoFactorEnabled}
              onCheckedChange={(checked) =>
                setProfileState((prev) => ({
                  ...prev,
                  twoFactorEnabled: Boolean(checked),
                }))
              }
              ariaLabel="Toggle two-factor authenticator"
            />
          </div>
        </div>
      </section>
    </div>
  );

  /* --- Section 2: Active Sessions --- */
  const otherSessionCount = sessionList.filter((s) => !s.current).length;

  const sessionsSection = (
    <section className="nx-account-card">
      <div className="nx-account-card-head">
        <div>
          <h3 className="nx-account-card-title">Active device sessions</h3>
          <p className="nx-account-card-desc">
            Browsers and devices currently signed into your account. Revoke any unrecognized session immediately.
          </p>
        </div>
        {otherSessionCount > 0 && (
          <Button size="sm" variant="danger-soft" onClick={handleRevokeOtherSessions}>
            Revoke {otherSessionCount} other {otherSessionCount === 1 ? 'session' : 'sessions'}
          </Button>
        )}
      </div>

      <SectionFailure message={failures.sessions} />

      {sessionList.length === 0 ? (
        <p className="nx-account-empty">No active sessions.</p>
      ) : (
        <ul className="nx-account-list">
          {sessionList.map((sess) => (
            <li key={sess.id} className="nx-account-list-row">
              <div className="nx-account-row-icon" aria-hidden="true">
                <SessionDeviceIcon deviceType={sess.deviceType} />
              </div>

              <div className="nx-account-row-copy">
                <div className="nx-account-row-title-line">
                  <span className="nx-account-row-title">{sess.client}</span>
                  {sess.current && (
                    <Badge tone="good" pill>
                      Current session
                    </Badge>
                  )}
                </div>
                <div className="nx-account-row-meta">
                  <span className="nx-account-mono">{sess.ip}</span>
                  <span>·</span>
                  <span>{sess.location}</span>
                  <span>·</span>
                  <span>{sess.lastActive}</span>
                </div>
              </div>

              {!sess.current && (
                <Button size="xs" variant="outline" onClick={() => handleRevokeSession(sess.id)}>
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  /* --- Section 3: API Service Tokens --- */
  const tokensSection = (
    <div className="nx-account-panel-stack">
      <SectionFailure message={failures.tokens} />
      <form className="nx-account-card" onSubmit={handleGenerateToken}>
        <div className="nx-account-card-head">
          <div>
            <h3 className="nx-account-card-title">Create API service token</h3>
            <p className="nx-account-card-desc">
              Issue scoped bearer tokens for background workers, ETL pipelines, and webhook integrations.
            </p>
          </div>
        </div>

        <div className="nx-account-token-create-grid">
          <Input label="Token name" placeholder="token_..." value={newTokenName} onValueChange={setNewTokenName} />
          <Select<string>
            label="Expiration"
            options={EXPIRATION_OPTIONS}
            value={tokenExpiry}
            onValueChange={(next) => {
              if (next !== null) setTokenExpiry(next);
            }}
          />
        </div>

        {availableScopes.length > 0 ? (
          <div className="nx-account-scopes-block">
            <span className="nx-account-scopes-label">Permissions and scopes</span>
            <div className="nx-account-scopes-grid">
              {availableScopes.map((sc) => {
                const isChecked = selectedScopes.includes(sc.value);
                return (
                  <label key={sc.value} data-checked={isChecked ? '' : undefined} className="nx-account-scope-chip">
                    <Checkbox size="sm" checked={isChecked} onCheckedChange={(checked) => toggleScope(sc.value, Boolean(checked))} />
                    <span className="nx-account-mono">{sc.label}</span>
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="nx-account-card-foot">
          <span className="nx-account-foot-hint">
            {availableScopes.length > 0
              ? `${selectedScopes.length} ${selectedScopes.length === 1 ? 'scope' : 'scopes'} selected`
              : 'Enter a token name to generate'}
          </span>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            leadingIcon={<Icon name="key" size={14} weight="bold" />}
            loading={creatingToken}
            disabled={!newTokenName.trim() || (availableScopes.length > 0 && selectedScopes.length === 0)}
          >
            Generate token
          </Button>
        </div>
      </form>

      {/* One-Time Revealed Secret Callout */}
      {revealedSecret && (
        <div className="nx-account-secret-banner" role="region" aria-label="Generated API token secret">
          <div className="nx-account-secret-top">
            <div>
              <div className="nx-account-secret-heading">
                <Icon name="key" size={15} weight="bold" />
                <span>
                  New token created: <strong>{revealedSecret.name}</strong>
                </span>
              </div>
              <p className="nx-account-secret-warning">
                Copy your secret token now — for security, the full value will not be displayed again.
              </p>
            </div>
            <Button size="xs" variant="ghost" onClick={() => setRevealedSecret(null)}>
              Dismiss
            </Button>
          </div>

          <div className="nx-account-secret-box">
            <code className="nx-account-secret-code">{revealedSecret.secret}</code>
            <Button
              size="xs"
              variant="secondary"
              leadingIcon={copyState === 'copied' ? <Icon name="check" size={13} weight="bold" /> : <Icon name="copy" size={13} />}
              onClick={handleCopySecret}
            >
              {copyState === 'copied' ? 'Copied' : 'Copy secret'}
            </Button>
          </div>
          {copyState === 'failed' ? (
            <p role="alert" className="nx-account-secret-warning">
              The token could not be copied to the clipboard. Select it above and copy it by hand before dismissing this.
            </p>
          ) : null}
        </div>
      )}

      {/* Active Tokens List */}
      <section className="nx-account-card">
        <div className="nx-account-card-head">
          <div>
            <h3 className="nx-account-card-title">Active service tokens</h3>
            <p className="nx-account-card-desc">Revoking a token immediately invalidates in-flight API requests authenticated with it.</p>
          </div>
          <Badge tone="neutral" pill>
            {tokenList.length} active
          </Badge>
        </div>

        {tokenList.length === 0 ? (
          <p className="nx-account-empty">No active tokens.</p>
        ) : (
          <ul className="nx-account-list">
            {tokenList.map((tok) => (
              <li key={tok.id} className="nx-account-list-row">
                <div className="nx-account-row-icon" aria-hidden="true">
                  <Icon name="key" size={16} />
                </div>

                <div className="nx-account-row-copy">
                  <div className="nx-account-row-title-line">
                    <span className="nx-account-row-title">{tok.name}</span>
                    <Code>{tok.prefix}</Code>
                  </div>

                  <div className="nx-account-token-scopes">
                    {tok.scopes.map((sc) => (
                      <Badge key={sc} tone="neutral">
                        {sc}
                      </Badge>
                    ))}
                  </div>

                  <div className="nx-account-row-meta">
                    <span>Last used: {tok.lastUsed}</span>
                    <span>·</span>
                    <span>Expires: {tok.expiresAt}</span>
                  </div>
                </div>

                <Button size="xs" variant="danger-soft" onClick={() => handleRevokeToken(tok.id)}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );

  /* --- Section 4: Team & Custom Domains --- */
  const teamAndDomainsSection = (
    <div className="nx-account-panel-stack">
      <SectionFailure message={failures.team} />
      {/* Workspace Team */}
      <section className="nx-account-card">
        <div className="nx-account-card-head">
          <div>
            <h3 className="nx-account-card-title">Workspace team and roles</h3>
            <p className="nx-account-card-desc">
              Invite teammates and assign granular RBAC permissions across views, automations, and settings.
            </p>
          </div>
          <Badge tone="neutral" pill>
            {memberList.length} members
          </Badge>
        </div>

        {/* Invite Member Bar */}
        <form className="nx-account-invite-bar" onSubmit={handleInviteSubmit}>
          <div className="nx-account-invite-email">
            <Input
              type="email"
              leadingIcon={<Icon name="envelope" size={15} />}
              placeholder="name@example.com"
              value={inviteEmail}
              onValueChange={setInviteEmail}
              ariaLabel="Teammate email address"
            />
          </div>
          <div className="nx-account-invite-role">
            <Select<AccountTeamRole>
              options={ROLE_OPTIONS}
              value={inviteRole}
              onValueChange={(next) => {
                if (next !== null) setInviteRole(next);
              }}
              ariaLabel="Invite role"
            />
          </div>
          <Button
            type="submit"
            variant="primary"
            leadingIcon={<Icon name="user-plus" size={14} weight="bold" />}
            disabled={!inviteEmail.trim()}
          >
            Invite
          </Button>
        </form>

        {memberList.length === 0 ? (
          <p className="nx-account-empty">No team members.</p>
        ) : (
          <ul className="nx-account-list">
            {memberList.map((member) => (
              <li key={member.id} className="nx-account-list-row">
                <div className="nx-account-member-info">
                  <Person size="sm" name={member.name} email={member.email} src={member.avatarUrl} />
                  {member.status === 'invited' && (
                    <Badge tone="warning" pill>
                      Pending invite
                    </Badge>
                  )}
                </div>

                <div className="nx-account-member-controls">
                  <div className="nx-account-role-select">
                    <Select<AccountTeamRole>
                      size="sm"
                      options={ROLE_OPTIONS}
                      value={member.role}
                      onValueChange={(next) => {
                        if (next !== null) handleRoleChange(member.id, next);
                      }}
                      ariaLabel={`Role for ${member.name}`}
                    />
                  </div>
                  <IconButton
                    size="sm"
                    variant="ghost"
                    ariaLabel={`Remove ${member.name}`}
                    icon={<Icon name="trash" size={14} />}
                    onClick={() => handleRemoveMember(member.id)}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Custom Domains */}
      <section className="nx-account-card">
        <div className="nx-account-card-head">
          <div>
            <h3 className="nx-account-card-title">Custom domains and TLS</h3>
            <p className="nx-account-card-desc">
              Serve your workspace under verified custom hostnames with automatic managed Let&apos;s Encrypt TLS certificates.
            </p>
          </div>
        </div>

        <form className="nx-account-domain-bar" onSubmit={handleAddDomainSubmit}>
          <div className="nx-account-invite-email">
            <Input
              leadingIcon={<Icon name="globe" size={15} />}
              placeholder="portal.example.com"
              value={newDomainInput}
              onValueChange={setNewDomainInput}
              ariaLabel="Custom domain hostname"
            />
          </div>
          <Button
            type="submit"
            variant="secondary"
            leadingIcon={<Icon name="plus" size={14} weight="bold" />}
            disabled={!newDomainInput.trim()}
          >
            Add domain
          </Button>
        </form>

        {domainList.length === 0 ? (
          <p className="nx-account-empty">No custom domains configured.</p>
        ) : (
          <ul className="nx-account-list">
            {domainList.map((dom) => (
              <li key={dom.id} className="nx-account-list-row">
                <div className="nx-account-row-icon" aria-hidden="true">
                  <Icon name="globe" size={16} />
                </div>

                <div className="nx-account-row-copy">
                  <div className="nx-account-row-title-line">
                    <span className="nx-account-domain-host">{dom.domain}</span>
                    {dom.primary && <Badge tone="accent">Primary</Badge>}
                    {dom.verified ? (
                      <Badge tone="good" icon={<Icon name="check" size={10.5} weight="bold" />}>
                        Verified
                      </Badge>
                    ) : (
                      <Badge tone="warning">DNS pending</Badge>
                    )}
                    <Badge tone={dom.tlsStatus === 'active' ? 'good' : 'info'} icon={<Icon name="lock" size={11} weight="bold" />} pill>
                      {dom.tlsStatus === 'active' ? 'TLS active' : 'Provisioning TLS'}
                    </Badge>
                  </div>
                  <div className="nx-account-row-meta">
                    <span>CNAME →</span>
                    <Code>{dom.cnameTarget}</Code>
                  </div>
                </div>

                {!dom.primary && (
                  <IconButton
                    size="sm"
                    variant="ghost"
                    ariaLabel={`Remove domain ${dom.domain}`}
                    icon={<Icon name="trash" size={14} />}
                    onClick={() => handleRemoveDomain(dom.id)}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );

  const tabItems = useMemo<TabItemDefinition<AccountSettingsTab>[]>(
    () => [
      {
        value: 'profile',
        label: 'Profile and security',
        icon: <Icon name="shield-check" size={15} />,
        content: profileSection,
      },
      {
        value: 'sessions',
        label: 'Active sessions',
        icon: <Icon name="laptop" size={15} />,
        count: sessionList.length,
        content: sessionsSection,
      },
      {
        value: 'tokens',
        label: 'API service tokens',
        icon: <Icon name="key" size={15} />,
        count: tokenList.length,
        content: tokensSection,
      },
      {
        value: 'team',
        label: 'Team and domains',
        icon: <Icon name="users" size={15} />,
        count: memberList.length,
        content: teamAndDomainsSection,
      },
    ],
    [memberList.length, profileSection, sessionList.length, sessionsSection, teamAndDomainsSection, tokenList.length, tokensSection],
  );

  if (layout === 'stacked') {
    return (
      <div ref={ref} className={cx('nx-account-settings', className)} data-layout="stacked" data-framed={framed ? undefined : 'false'}>
        {profileSection}
        {sessionsSection}
        {tokensSection}
        {teamAndDomainsSection}
      </div>
    );
  }

  return (
    <div ref={ref} className={cx('nx-account-settings', className)} data-layout="tabs" data-framed={framed ? undefined : 'false'}>
      <Tabs<AccountSettingsTab>
        variant="underline"
        value={controlledTab}
        defaultValue={defaultTab}
        onValueChange={(next) => {
          if (next !== null) onTabChange?.(next);
        }}
        items={tabItems}
      />
    </div>
  );
}
