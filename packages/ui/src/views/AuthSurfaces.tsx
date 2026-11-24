/** Sign-in, magic-link/OTP verification, OAuth scope consent, and workspace invitation acceptance cards. */
'use client';

import { Icon } from '../Icon.js';
import { type ComponentProps, type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Button, SegmentedControl, type SegmentedControlOption } from '../primitives/actions.js';
import { Avatar, AvatarGroup, type AvatarGroupMember, Badge } from '../primitives/display.js';
import { Input, PasswordInput } from '../primitives/inputs.js';
import { OTPInput } from '../primitives/numericAndTokenInputs.js';
import { Separator } from '../primitives/layout.js';
import { Checkbox } from '../primitives/selection.js';
import { cx } from '../internal/cx.js';
import { resolveLocale } from '../internal/locale.js';

/* ============================================================================
 * Provider Vector Marks (Zero external asset dependencies)
 * ========================================================================== */

function GithubMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 1.75C6.34 1.75 1.75 6.34 1.75 12c0 4.53 2.94 8.37 7.01 9.73.51.09.7-.22.7-.49 0-.24-.01-1.04-.01-1.88-2.85.62-3.45-1.21-3.45-1.21-.47-1.18-1.14-1.5-1.14-1.5-.93-.64.07-.63.07-.63 1.03.07 1.57 1.06 1.57 1.06.91 1.57 2.39 1.12 2.98.85.09-.66.36-1.12.65-1.37-2.28-.26-4.67-1.14-4.67-5.07 0-1.12.4-2.03 1.05-2.75-.11-.26-.46-1.31.1-2.72 0 0 .86-.28 2.82 1.05a9.8 9.8 0 0 1 5.14 0c1.96-1.33 2.82-1.05 2.82-1.05.56 1.41.21 2.46.1 2.72.66.72 1.05 1.63 1.05 2.75 0 3.94-2.4 4.81-4.69 5.06.37.32.7.94.7 1.9 0 1.37-.01 2.47-.01 2.81 0 .27.18.59.71.49A10.26 10.26 0 0 0 22.25 12c0-5.66-4.59-10.25-10.25-10.25Z" />
    </svg>
  );
}

function GoogleMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.5h3.24c1.9-1.75 2.98-4.33 2.98-7.35Z"
        fill="currentColor"
        opacity="0.9"
      />
      <path
        d="M12 22c2.7 0 4.96-.9 6.62-2.42l-3.24-2.5c-.9.6-2.04.96-3.38.96-2.6 0-4.8-1.76-5.59-4.12H3.07v2.58A10 10 0 0 0 12 22Z"
        fill="currentColor"
        opacity="0.72"
      />
      <path d="M6.41 13.92a6.02 6.02 0 0 1 0-3.84V7.5H3.07a10 10 0 0 0 0 9l3.34-2.58Z" fill="currentColor" opacity="0.55" />
      <path
        d="M12 5.96c1.47 0 2.79.5 3.83 1.5l2.87-2.87C16.95 2.98 14.7 2 12 2A10 10 0 0 0 3.07 7.5l3.34 2.58C7.2 7.72 9.4 5.96 12 5.96Z"
        fill="currentColor"
        opacity="0.82"
      />
    </svg>
  );
}

function extractWorkspaceMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'WS';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0] ?? ''}${words[1]![0] ?? ''}`.toUpperCase();
}

function formatExactCount(count: number | string, locale?: string): string {
  const tag = resolveLocale(locale);
  if (typeof count === 'number') {
    return Number.isFinite(count) ? new Intl.NumberFormat(tag).format(count) : String(count);
  }
  const trimmed = count.trim();
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    try {
      return new Intl.NumberFormat(tag).format(trimmed as Intl.StringNumericLiteral);
    } catch {
      return trimmed;
    }
  }
  return count;
}

/* ============================================================================
 * 1. SignInCard
 * ========================================================================== */

/** Authentication method tab in `SignInCard`. */
export type SignInMode = 'password' | 'magic-link' | 'passkey' | 'otp';

/** External SSO or OAuth provider button option in `SignInCard`. */
export interface AuthProviderOption {
  id: string;
  label: string;
  kind?: 'github' | 'google' | 'saml' | 'custom';
  icon?: ReactNode;
}

/** Submitted credentials payload emitted by `SignInCard`. */
export interface SignInCredentials {
  mode: SignInMode;
  email?: string;
  password?: string;
  otpCode?: string;
  rememberDevice?: boolean;
}

/**
 * What a `SignInCard` handler reports of the attempt it was handed. The card knows nothing of an attempt's outcome
 * but this: `ok: false` (or an `error`) is shown as the failure, `next: '2fa'` moves on to the code step, and
 * `ok: true` is the only thing that makes it say the attempt succeeded (in `message`, where given).
 */
export interface SignInOutcome {
  ok?: boolean;
  error?: ReactNode;
  next?: '2fa';
  message?: ReactNode;
}

/** What a `SignInCard` handler may return: nothing (the card then claims nothing), an outcome, or a promise of either. */
export type SignInResult = void | SignInOutcome | Promise<void | SignInOutcome>;

/** Props for the `SignInCard` component. */
export interface SignInCardProps extends Omit<ComponentProps<'div'>, 'title' | 'onChange' | 'aria-label' | 'inlist'> {
  logo?: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  providers?: ReadonlyArray<AuthProviderOption>;
  hideProviders?: boolean;
  mode?: SignInMode;
  defaultMode?: SignInMode;
  onModeChange?: (mode: SignInMode) => void;
  defaultEmail?: string;
  /**
   * Ask for a code after every password, without waiting to be told (default false). A host that learns from its
   * server whether an account has a second factor leaves this off and returns `{ next: '2fa' }` from `onSignIn`.
   */
  require2FA?: boolean;
  error?: ReactNode;
  securityNote?: ReactNode;
  footer?: ReactNode;
  ariaLabel?: string;
  onProviderClick?: (providerId: string) => void;
  /** Each handler may return a `SignInOutcome`, or a promise of one; the card waits for it and shows what it says. */
  onSignIn?: (credentials: SignInCredentials) => SignInResult;
  onVerifyOtp?: (code: string, email: string) => SignInResult;
  /** Sends a fresh code. "Resend code" is offered only where this is given: the card cannot send one itself. */
  onResendCode?: (email: string) => SignInResult;
  onForgotPassword?: (email: string) => SignInResult;
  onPasskeySignIn?: (email: string) => SignInResult;
}

type SignInBanner = { tone: 'good' | 'info'; content: ReactNode };
type SignInPending = 'sign-in' | 'verify' | 'resend' | 'reset';

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';

const failed = (outcome: void | SignInOutcome): outcome is SignInOutcome =>
  Boolean(outcome) &&
  ((outcome as SignInOutcome).ok === false ||
    ((outcome as SignInOutcome).ok !== true &&
      (outcome as SignInOutcome).error !== undefined &&
      (outcome as SignInOutcome).error !== null));

/* Two handlers are told of one attempt (the step's own, and `onSignIn`): the attempt failed if either says so, and
   otherwise it is whichever of them said anything. */
function firstFailure(outcomes: ReadonlyArray<void | SignInOutcome>): void | SignInOutcome {
  return outcomes.find(failed) ?? outcomes.find((outcome) => outcome && typeof outcome === 'object');
}

const EMPTY_AUTH_PROVIDERS: ReadonlyArray<AuthProviderOption> = [];

const SIGN_IN_MODE_OPTIONS: ReadonlyArray<SegmentedControlOption<SignInMode>> = [
  { value: 'password', label: 'Password' },
  { value: 'magic-link', label: 'Magic link' },
  { value: 'passkey', label: 'Passkey' },
  { value: 'otp', label: '2FA Code' },
];

function renderProviderIcon(provider: AuthProviderOption): ReactNode {
  if (provider.icon) return provider.icon;
  switch (provider.kind) {
    case 'github':
      return <GithubMark />;
    case 'google':
      return <GoogleMark />;
    case 'saml':
    default:
      return <Icon name="buildings" size={15} weight="bold" />;
  }
}

/** Multi-mode sign-in card supporting SSO providers, password, magic link, WebAuthn passkeys, and TOTP 2FA. */
export function SignInCard({
  logo,
  title = 'Sign in',
  subtitle,
  providers = EMPTY_AUTH_PROVIDERS,
  hideProviders = false,
  mode,
  defaultMode = 'password',
  onModeChange,
  defaultEmail = '',
  require2FA = false,
  error,
  securityNote,
  footer,
  ariaLabel,
  onProviderClick,
  onSignIn,
  onVerifyOtp,
  onResendCode,
  onForgotPassword,
  onPasskeySignIn,
  className,
  ...props
}: SignInCardProps) {
  const [internalMode, setInternalMode] = useState<SignInMode>(defaultMode);
  const [email, setEmail] = useState(defaultEmail);
  const [password, setPassword] = useState('');
  const [rememberDevice, setRememberDevice] = useState(true);
  const [otpCode, setOtpCode] = useState('');
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [statusBanner, setStatusBanner] = useState<SignInBanner | null>(null);
  const [validationError, setValidationError] = useState<ReactNode>(null);
  const [pending, setPending] = useState<SignInPending | null>(null);
  /* The attempt whose answer is still wanted. A slow answer to an attempt the person has since left (another mode,
     another submit) is dropped rather than drawn over what they are doing now. */
  const attempt = useRef(0);

  const activeMode = mode ?? internalMode;

  /* The password is held only while its own form is on screen: left in state after the step to the code (or a
     change of method), it outlived the one submit it was typed for. */
  useEffect(() => {
    if (activeMode !== 'password') setPassword('');
  }, [activeMode]);

  const switchMode = (next: SignInMode) => {
    attempt.current += 1;
    setPending(null);
    if (mode === undefined) setInternalMode(next);
    setStatusBanner(null);
    setValidationError(null);
    setResetSent(false);
    if (next !== 'magic-link') setMagicLinkSent(false);
    onModeChange?.(next);
  };

  /* Hands an attempt to the host and reads back what became of it. The card verifies nothing itself, so it says
     nothing of the outcome until the handler has: a handler that returns nothing leaves the card where it was, a
     failure (an outcome with `ok: false` or an `error`, a rejected promise, a throw) is shown, and `done` is
     given the outcome otherwise. A handler that answers at once is settled in the same tick, so a synchronous host
     sees no pending state at all. */
  const run = (kind: SignInPending, call: () => SignInResult, failure: string, done: (outcome: SignInOutcome) => void) => {
    const mine = (attempt.current += 1);
    setValidationError(null);
    const settle = (result: void | SignInOutcome) => {
      if (attempt.current !== mine) return;
      setPending(null);
      const outcome: SignInOutcome = result && typeof result === 'object' ? result : {};
      if (outcome.ok === false || (outcome.ok !== true && outcome.error !== undefined && outcome.error !== null)) {
        setStatusBanner(null);
        setValidationError(outcome.error ?? failure);
        return;
      }
      done(outcome);
    };
    const fail = (thrown: unknown) => {
      if (attempt.current !== mine) return;
      setPending(null);
      setStatusBanner(null);
      setValidationError(thrown instanceof Error && thrown.message ? thrown.message : failure);
    };
    let returned: SignInResult;
    try {
      returned = call();
    } catch (thrown) {
      fail(thrown);
      return;
    }
    if (isThenable(returned)) {
      setPending(kind);
      returned.then(settle, fail);
    } else {
      settle(returned);
    }
  };

  const handlePasswordSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const address = email.trim();
    if (!address || !password) {
      setValidationError('Enter your email address and password to sign in.');
      return;
    }
    run(
      'sign-in',
      () => onSignIn?.({ mode: 'password', email: address, password, rememberDevice }),
      'Sign-in failed. Check your email address and password, then try again.',
      (outcome) => {
        if (outcome.next === '2fa' || (require2FA && outcome.ok !== true)) {
          setOtpCode('');
          switchMode('otp');
          return;
        }
        setStatusBanner(outcome.ok === true ? { tone: 'good', content: outcome.message ?? `Signed in as ${address}.` } : null);
      },
    );
  };

  const sendMagicLink = () => {
    const address = email.trim();
    run(
      'sign-in',
      () => onSignIn?.({ mode: 'magic-link', email: address }),
      'The sign-in link could not be sent. Try again.',
      () => setMagicLinkSent(true),
    );
  };

  const handleMagicLinkSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    if (!email.trim()) {
      setValidationError('Enter your email address to receive a sign-in link.');
      return;
    }
    sendMagicLink();
  };

  const handlePasskeyAction = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const trimmedEmail = email.trim();
    setStatusBanner({ tone: 'info', content: 'Waiting for device passkey verification…' });
    run(
      'sign-in',
      () => {
        const first = onPasskeySignIn?.(trimmedEmail);
        const second = onSignIn?.({ mode: 'passkey', email: trimmedEmail || undefined });
        return isThenable(first) || isThenable(second) ? Promise.all([first, second]).then(firstFailure) : firstFailure([first, second]);
      },
      'Passkey verification failed. Try again.',
      (outcome) => {
        if (outcome.ok === true) setStatusBanner({ tone: 'good', content: outcome.message ?? 'Passkey verified.' });
      },
    );
  };

  const handleOtpSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    if (otpCode.length < 6) {
      setValidationError('Enter the 6-digit verification code.');
      return;
    }
    const address = email.trim();
    run(
      'verify',
      () => {
        const first = onVerifyOtp?.(otpCode, address);
        const second = onSignIn?.({ mode: 'otp', email: address || undefined, otpCode });
        return isThenable(first) || isThenable(second) ? Promise.all([first, second]).then(firstFailure) : firstFailure([first, second]);
      },
      'That code was not accepted. Check it and try again.',
      (outcome) => {
        setStatusBanner(outcome.ok === true ? { tone: 'good', content: outcome.message ?? 'Two-factor verification complete.' } : null);
      },
    );
  };

  const handleResendCode = () => {
    if (pending || !onResendCode) return;
    setStatusBanner(null);
    run(
      'resend',
      () => onResendCode(email.trim()),
      'A new code could not be sent. Try again.',
      (outcome) => {
        setStatusBanner(
          outcome.ok === true
            ? { tone: 'good', content: outcome.message ?? 'A new verification code was sent.' }
            : { tone: 'info', content: 'A new verification code was requested.' },
        );
      },
    );
  };

  const handleForgotClick = () => {
    if (pending) return;
    setResetSent(false);
    setStatusBanner(null);
    run(
      'reset',
      () => onForgotPassword?.(email.trim()),
      'The password reset link could not be sent. Try again.',
      () => setResetSent(true),
    );
  };

  const displayedError = error ?? validationError;
  const resolvedFooter = footer ?? (securityNote ? <span className="nx-auth-footer-note">{securityNote}</span> : null);

  return (
    <div data-slot="sign-in-card" aria-label={ariaLabel} className={cx('nx-auth-card', className)} {...props}>
      {/* Brand Header */}
      <div className="nx-auth-header">
        {logo ? <div className="nx-auth-brand-mark">{logo}</div> : null}
        <h2 className="nx-auth-title">{title}</h2>
        {subtitle ? <p className="nx-auth-subtitle">{subtitle}</p> : null}
      </div>

      {/* SSO / Social Providers */}
      {!hideProviders && providers.length > 0 ? (
        <>
          <div className="nx-auth-providers">
            {providers.map((prov) => (
              <Button
                key={prov.id}
                variant="secondary"
                size="md"
                block
                leadingIcon={renderProviderIcon(prov)}
                onClick={() => {
                  setStatusBanner({ tone: 'info', content: `Redirecting to ${prov.label}…` });
                  onProviderClick?.(prov.id);
                }}
                className="nx-auth-provider-btn"
              >
                {prov.label}
              </Button>
            ))}
          </div>
          <Separator label="or continue with" className="nx-auth-divider" />
        </>
      ) : null}

      {/* Mode Switcher */}
      <SegmentedControl<SignInMode>
        size="xs"
        block
        value={activeMode}
        onValueChange={(val) => {
          if (val) switchMode(val);
        }}
        options={SIGN_IN_MODE_OPTIONS}
        ariaLabel="Authentication method"
        className="nx-auth-mode-switch"
      />

      {/* Feedback / Error Banners */}
      {displayedError ? (
        <div role="alert" className="nx-auth-banner" data-tone="critical">
          <Icon name="warning" size={15} weight="bold" />
          <span>{displayedError}</span>
        </div>
      ) : null}

      {resetSent ? (
        <div role="status" className="nx-auth-banner" data-tone="info">
          <Icon name="envelope" size={15} weight="bold" />
          <span>Password reset link sent{email.trim() ? ` to ${email.trim()}` : ' to your email'}.</span>
        </div>
      ) : null}

      {statusBanner ? (
        <div role="status" className="nx-auth-banner" data-tone={statusBanner.tone}>
          <Icon name={statusBanner.tone === 'good' ? 'check-circle' : 'info'} size={15} weight="bold" />
          <span>{statusBanner.content}</span>
        </div>
      ) : null}

      {/* Active Mode Form */}
      {activeMode === 'password' ? (
        <form onSubmit={handlePasswordSubmit} noValidate className="nx-auth-form">
          <Input
            label="Email"
            type="email"
            autoComplete="email"
            placeholder="name@example.com"
            value={email}
            onValueChange={(next) => {
              setEmail(next);
              if (validationError) setValidationError(null);
            }}
            leadingIcon={<Icon name="envelope" size={15} />}
            required
          />

          <PasswordInput
            label="Password"
            autoComplete="current-password"
            placeholder="Enter your password"
            value={password}
            onValueChange={(next) => {
              setPassword(next);
              if (validationError) setValidationError(null);
            }}
            leadingIcon={<Icon name="lock" size={15} />}
            required
            labelTrailing={
              <button type="button" onClick={handleForgotClick} className="nx-auth-inline-link nx-focusable">
                Forgot password?
              </button>
            }
          />

          <Checkbox
            size="sm"
            checked={rememberDevice}
            onCheckedChange={(checked) => setRememberDevice(Boolean(checked))}
            label="Keep me signed in on this device for 30 days"
          />

          <Button
            type="submit"
            variant="primary"
            size="md"
            block
            loading={pending === 'sign-in'}
            trailingIcon={<Icon name="arrow-right" size={14} weight="bold" />}
          >
            Sign in
          </Button>
        </form>
      ) : activeMode === 'magic-link' ? (
        magicLinkSent ? (
          <div className="nx-auth-state-box">
            <span className="nx-auth-state-icon" aria-hidden="true">
              <Icon name="envelope" size={20} weight="bold" />
            </span>
            <h3 className="nx-auth-state-title">Check your inbox</h3>
            <p className="nx-auth-state-copy">
              We sent a single-use sign-in link to <strong>{email}</strong>. The link expires in 15 minutes.
            </p>
            <div className="nx-auth-state-actions">
              <Button variant="secondary" size="sm" loading={pending === 'sign-in'} onClick={sendMagicLink}>
                Resend link
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setMagicLinkSent(false)}>
                Use another email
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleMagicLinkSubmit} noValidate className="nx-auth-form">
            <Input
              label="Email"
              type="email"
              autoComplete="email"
              placeholder="name@example.com"
              hint="We will email you a one-click login link."
              value={email}
              onValueChange={(next) => {
                setEmail(next);
                if (validationError) setValidationError(null);
              }}
              leadingIcon={<Icon name="envelope" size={15} />}
              required
            />
            <Button
              type="submit"
              variant="primary"
              size="md"
              block
              loading={pending === 'sign-in'}
              trailingIcon={<Icon name="arrow-right" size={14} weight="bold" />}
            >
              Send magic link
            </Button>
          </form>
        )
      ) : activeMode === 'passkey' ? (
        <form onSubmit={handlePasskeyAction} className="nx-auth-form">
          <div className="nx-auth-passkey-box">
            <span className="nx-auth-passkey-icon" aria-hidden="true">
              <Icon name="fingerprint" size={24} weight="bold" />
            </span>
            <div className="nx-auth-passkey-copy">
              <div className="nx-auth-passkey-title">Hardware key or biometric passkey</div>
              <p className="nx-auth-passkey-desc">Sign in phish-free with Touch ID, Windows Hello, or a FIDO2 security key.</p>
            </div>
          </div>
          <Input
            label="Account email"
            optional
            type="email"
            autoComplete="username webauthn"
            placeholder="name@example.com"
            value={email}
            onValueChange={(next) => setEmail(next)}
            leadingIcon={<Icon name="key" size={15} />}
          />
          <Button
            type="submit"
            variant="primary"
            size="md"
            block
            loading={pending === 'sign-in'}
            leadingIcon={<Icon name="fingerprint" size={16} weight="bold" />}
          >
            Authenticate with Passkey
          </Button>
        </form>
      ) : (
        <form onSubmit={handleOtpSubmit} noValidate className="nx-auth-form nx-auth-otp-form">
          <div className="nx-auth-otp-intro">
            <div className="nx-auth-otp-title">Two-factor verification</div>
            <p className="nx-auth-otp-desc">
              Enter the 6-digit verification code from your authenticator app
              {email.trim() ? ` for ${email.trim()}` : ''}.
            </p>
          </div>

          <div className="nx-auth-otp-center">
            <OTPInput
              length={6}
              separatorAfter={3}
              size="lg"
              value={otpCode}
              onValueChange={(val) => {
                setOtpCode(val);
                if (validationError) setValidationError(null);
              }}
              ariaLabel="6-digit verification code"
            />
          </div>

          <Button
            type="submit"
            variant="primary"
            size="md"
            block
            loading={pending === 'verify'}
            leadingIcon={<Icon name="shield-check" size={16} weight="bold" />}
          >
            Verify 6-digit code
          </Button>

          <div className="nx-auth-otp-links">
            <button type="button" onClick={() => switchMode('password')} className="nx-auth-inline-link nx-focusable">
              <Icon name="arrow-left" size={12} />
              <span>Back to password</span>
            </button>
            {onResendCode ? (
              <button type="button" onClick={handleResendCode} disabled={pending !== null} className="nx-auth-inline-link nx-focusable">
                Resend code
              </button>
            ) : null}
          </div>
        </form>
      )}

      {/* Card Footer */}
      {resolvedFooter ? <div className="nx-auth-footer">{resolvedFooter}</div> : null}
    </div>
  );
}

/* ============================================================================
 * 2. InviteAcceptCard (Workspace ClaimInvitation Parity)
 * ========================================================================== */

/** Resolution status of an `InviteAcceptCard`. */
export type InviteAcceptStatus = 'pending' | 'accepted' | 'declined';

/** Workspace member preview avatar in `InviteAcceptCard`. */
export interface InviteTeamMember {
  id?: string;
  name: string;
  avatarSrc?: string;
}

/** Props for the `InviteAcceptCard` component. */
export interface InviteAcceptCardProps extends Omit<ComponentProps<'div'>, 'onChange' | 'aria-label' | 'inlist'> {
  workspaceName: string;
  workspaceSlug?: string;
  workspaceMonogram?: string;
  workspacePlan?: string;
  inviterName: string;
  inviterEmail?: string;
  inviterAvatarSrc?: string;
  role?: string;
  memberCount?: number | string;
  locale?: string;
  teamMembers?: ReadonlyArray<InviteTeamMember>;
  expiresIn?: string;
  note?: ReactNode;
  status?: InviteAcceptStatus;
  defaultStatus?: InviteAcceptStatus;
  ariaLabel?: string;
  onAccept?: () => void;
  onDecline?: () => void;
}

/** Workspace invitation claim card displaying inviter details, assigned role, and accept/decline actions. */
export function InviteAcceptCard({
  workspaceName,
  workspaceSlug,
  workspaceMonogram,
  workspacePlan,
  inviterName,
  inviterEmail,
  inviterAvatarSrc,
  role,
  memberCount,
  locale,
  teamMembers,
  expiresIn,
  note,
  status,
  defaultStatus = 'pending',
  ariaLabel,
  onAccept,
  onDecline,
  className,
  ...props
}: InviteAcceptCardProps) {
  const [internalStatus, setInternalStatus] = useState<InviteAcceptStatus>(defaultStatus);
  const currentStatus = status ?? internalStatus;
  const monogram = workspaceMonogram ?? extractWorkspaceMonogram(workspaceName);

  const avatarGroupItems = useMemo<AvatarGroupMember[] | undefined>(
    () =>
      teamMembers?.map((m, idx) => ({
        id: m.id ?? `${m.name}-${idx}`,
        name: m.name,
        src: m.avatarSrc,
      })),
    [teamMembers],
  );

  const handleAccept = () => {
    if (status === undefined) setInternalStatus('accepted');
    onAccept?.();
  };

  const handleDecline = () => {
    if (status === undefined) setInternalStatus('declined');
    onDecline?.();
  };

  const hasMemberInfo = memberCount !== undefined || Boolean(avatarGroupItems && avatarGroupItems.length > 0);
  const hasFacts = Boolean(role) || hasMemberInfo || Boolean(expiresIn);
  const formattedCount = memberCount !== undefined ? formatExactCount(memberCount, locale) : null;

  return (
    <div
      data-slot="invite-accept-card"
      data-status={currentStatus}
      aria-label={ariaLabel}
      className={cx('nx-auth-card nx-invite-card', className)}
      {...props}
    >
      <div className="nx-invite-workspace-head">
        <div className="nx-invite-monogram" aria-hidden="true">
          {monogram}
        </div>
        <div className="nx-invite-workspace-copy">
          <div className="nx-invite-workspace-row">
            <h3 className="nx-invite-workspace-name">{workspaceName}</h3>
            {workspacePlan ? <Badge tone="neutral">{workspacePlan}</Badge> : null}
          </div>
          {workspaceSlug ? <span className="nx-invite-slug">{workspaceSlug}</span> : null}
        </div>
      </div>

      <div className="nx-invite-inviter">
        <Avatar name={inviterName} src={inviterAvatarSrc} size="md" status="online" />
        <div className="nx-invite-inviter-copy">
          <div className="nx-invite-inviter-line">
            <strong>{inviterName}</strong> invited you to collaborate
          </div>
          {inviterEmail ? <span className="nx-invite-inviter-email">{inviterEmail}</span> : null}
        </div>
      </div>

      {note !== undefined ? <blockquote className="nx-invite-note">{note}</blockquote> : null}

      {hasFacts ? (
        <div className="nx-invite-facts">
          {role ? (
            <div className="nx-invite-fact">
              <span className="nx-invite-fact-label">Assigned role</span>
              <Badge tone="accent" pill>
                {role}
              </Badge>
            </div>
          ) : null}

          {hasMemberInfo ? (
            <div className="nx-invite-fact">
              <span className="nx-invite-fact-label">Workspace members</span>
              <div className="nx-invite-members">
                {avatarGroupItems && avatarGroupItems.length > 0 ? (
                  <AvatarGroup items={avatarGroupItems} max={3} size="xs" />
                ) : (
                  <Icon name="users" size={14} className="nx-invite-fact-icon" />
                )}
                {formattedCount !== null ? (
                  <span className="nx-invite-member-count">
                    {formattedCount} {formattedCount === '1' ? 'member' : 'members'}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}

          {expiresIn ? (
            <div className="nx-invite-fact">
              <span className="nx-invite-fact-label">Invitation window</span>
              <span className="nx-invite-expiry">
                <Icon name="clock" size={13} />
                <span>{expiresIn}</span>
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="nx-invite-actions">
        {currentStatus === 'pending' ? (
          <>
            <Button variant="outline" size="md" onClick={handleDecline}>
              Decline
            </Button>
            <Button
              variant="primary"
              size="md"
              leadingIcon={<Icon name="check" size={15} weight="bold" />}
              onClick={handleAccept}
              className="nx-invite-accept-btn"
            >
              Accept invitation
            </Button>
          </>
        ) : currentStatus === 'accepted' ? (
          <div className="nx-invite-result" data-tone="good">
            <Icon name="check-circle" size={16} weight="bold" />
            <span>
              Joined <strong>{workspaceName}</strong>
              {role ? ` as ${role}` : ''}.
            </span>
          </div>
        ) : (
          <div className="nx-invite-result" data-tone="muted">
            <Icon name="x" size={15} weight="bold" />
            <span>Invitation declined.</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================================
 * 3. OAuthConsentCard (OAuth 2.1 / MCP Client Permission Grant)
 * ========================================================================== */

/** Risk classification for an `OAuthScopeItem`. */
export type OAuthScopeRisk = 'low' | 'elevated';

/** Requested permission scope item in `OAuthConsentCard`. */
export interface OAuthScopeItem {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  required?: boolean;
  defaultGranted?: boolean;
  risk?: OAuthScopeRisk;
}

/** Resolution status of an `OAuthConsentCard`. */
export type OAuthConsentStatus = 'pending' | 'authorized' | 'denied';

/** Props for the `OAuthConsentCard` component. */
export interface OAuthConsentCardProps extends Omit<ComponentProps<'div'>, 'onChange' | 'aria-label' | 'inlist'> {
  appName: string;
  appVendor?: string;
  appIcon?: ReactNode;
  clientType?: string;
  verified?: boolean;
  userName: string;
  userEmail: string;
  userAvatarSrc?: string;
  workspaceName?: string;
  workspaceIcon?: ReactNode;
  scopes?: ReadonlyArray<OAuthScopeItem>;
  redirectUri?: string;
  securityNote?: ReactNode;
  status?: OAuthConsentStatus;
  defaultStatus?: OAuthConsentStatus;
  ariaLabel?: string;
  onAuthorize?: (grantedScopeIds: string[]) => void;
  onDeny?: () => void;
  onSwitchAccount?: () => void;
}

const EMPTY_OAUTH_SCOPES: ReadonlyArray<OAuthScopeItem> = [];

/** OAuth 2.1 and MCP client permission consent card with granular optional scope toggles. */
export function OAuthConsentCard({
  appName,
  appVendor,
  appIcon,
  clientType,
  verified = false,
  userName,
  userEmail,
  userAvatarSrc,
  workspaceName,
  workspaceIcon,
  scopes = EMPTY_OAUTH_SCOPES,
  redirectUri,
  securityNote,
  status,
  defaultStatus = 'pending',
  ariaLabel,
  onAuthorize,
  onDeny,
  onSwitchAccount,
  className,
  ...props
}: OAuthConsentCardProps) {
  const [internalStatus, setInternalStatus] = useState<OAuthConsentStatus>(defaultStatus);
  const [grantedMap, setGrantedMap] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const s of scopes) {
      init[s.id] = s.required !== false ? true : (s.defaultGranted ?? true);
    }
    return init;
  });

  const currentStatus = status ?? internalStatus;

  const toggleOptionalScope = (scopeId: string, nextChecked: boolean) => {
    setGrantedMap((prev) => ({ ...prev, [scopeId]: nextChecked }));
  };

  const handleAuthorize = () => {
    const grantedIds = scopes.filter((s) => s.required !== false || grantedMap[s.id]).map((s) => s.id);
    if (status === undefined) setInternalStatus('authorized');
    onAuthorize?.(grantedIds);
  };

  const handleDeny = () => {
    if (status === undefined) setInternalStatus('denied');
    onDeny?.();
  };

  const showTargetBridge = Boolean(workspaceIcon || workspaceName);

  return (
    <div
      data-slot="oauth-consent-card"
      data-status={currentStatus}
      aria-label={ariaLabel}
      className={cx('nx-auth-card nx-consent-card', className)}
      {...props}
    >
      {/* App <-> Workspace Bridge Header */}
      <div className="nx-consent-bridge">
        <div className="nx-consent-node" title={appName}>
          {appIcon ?? <Icon name="terminal" size={20} weight="bold" />}
        </div>
        {showTargetBridge ? (
          <>
            <div className="nx-consent-connector" aria-hidden="true">
              <span className="nx-consent-line" />
              <span className="nx-consent-link-pill">
                <Icon name="link" size={12} weight="bold" />
              </span>
              <span className="nx-consent-line" />
            </div>
            <div className="nx-consent-node nx-consent-node-brand" title={workspaceName}>
              {workspaceIcon ?? (workspaceName ? extractWorkspaceMonogram(workspaceName) : null)}
            </div>
          </>
        ) : null}
      </div>

      <div className="nx-consent-heading">
        {clientType || verified ? (
          <div className="nx-consent-badges">
            {clientType ? (
              <Badge tone="accent" pill>
                {clientType}
              </Badge>
            ) : null}
            {verified ? (
              <Badge tone="good" pill icon={<Icon name="shield-check" size={11.5} weight="bold" />}>
                Verified
              </Badge>
            ) : null}
          </div>
        ) : null}
        <h2 className="nx-auth-title">Authorize {appName}</h2>
        <p className="nx-auth-subtitle">
          <strong>{appName}</strong>
          {appVendor ? ` (${appVendor})` : ''} is requesting access
          {workspaceName ? (
            <>
              {' '}
              to <strong>{workspaceName}</strong>
            </>
          ) : (
            ' to your account'
          )}
          .
        </p>
      </div>

      {/* Signed-in Account Bar */}
      <div className="nx-consent-account">
        <Avatar name={userName} src={userAvatarSrc} size="sm" />
        <div className="nx-consent-account-copy">
          <span className="nx-consent-account-name">{userName}</span>
          <span className="nx-consent-account-email">{userEmail}</span>
        </div>
        {onSwitchAccount ? (
          <button type="button" onClick={onSwitchAccount} className="nx-auth-inline-link nx-focusable">
            Switch
          </button>
        ) : workspaceName ? (
          <Badge tone="neutral">{workspaceName}</Badge>
        ) : null}
      </div>

      {/* Granular Scopes List */}
      {scopes.length > 0 ? (
        <div className="nx-consent-scopes" role="list" aria-label="Requested permissions">
          <div className="nx-consent-scopes-header">Requested permissions</div>
          {scopes.map((scope) => {
            const isRequired = scope.required !== false;
            const isChecked = isRequired ? true : Boolean(grantedMap[scope.id]);

            return (
              <div key={scope.id} role="listitem" data-checked={isChecked ? '' : undefined} className="nx-consent-scope-row">
                <span className="nx-consent-scope-icon" aria-hidden="true">
                  {scope.icon ?? <Icon name="shield-check" size={15} weight="bold" />}
                </span>
                <div className="nx-consent-scope-copy">
                  <div className="nx-consent-scope-title-row">
                    <span className="nx-consent-scope-label">{scope.label}</span>
                    {scope.risk === 'elevated' ? <Badge tone="warning">Elevated</Badge> : null}
                    {isRequired ? <span className="nx-consent-scope-req">Required</span> : null}
                  </div>
                  {scope.description ? <p className="nx-consent-scope-desc">{scope.description}</p> : null}
                </div>
                {!isRequired ? (
                  <Checkbox
                    size="sm"
                    checked={isChecked}
                    disabled={currentStatus !== 'pending'}
                    ariaLabel={typeof scope.label === 'string' ? scope.label : scope.id}
                    onCheckedChange={(checked) => toggleOptionalScope(scope.id, Boolean(checked))}
                  />
                ) : (
                  <span className="nx-consent-scope-lock" aria-label="Required scope">
                    <Icon name="check" size={13} weight="bold" />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ) : null}

      {/* Security & Redirect Audit Box */}
      {securityNote || redirectUri ? (
        <div className="nx-consent-security">
          <Icon name="shield-check" size={16} weight="bold" className="nx-consent-security-icon" />
          <div className="nx-consent-security-copy">
            {securityNote ? <p className="nx-consent-security-note">{securityNote}</p> : null}
            {redirectUri ? (
              <div className="nx-consent-redirect">
                <span>Callback URI:</span>
                <code>{redirectUri}</code>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Authorize / Deny Footer */}
      <div className="nx-consent-actions">
        {currentStatus === 'pending' ? (
          <>
            <Button variant="outline" size="md" onClick={handleDeny}>
              Deny
            </Button>
            <Button
              variant="primary"
              size="md"
              leadingIcon={<Icon name="shield-check" size={16} weight="bold" />}
              onClick={handleAuthorize}
              className="nx-consent-authorize-btn"
            >
              Authorize {appName}
            </Button>
          </>
        ) : currentStatus === 'authorized' ? (
          <div className="nx-invite-result" data-tone="good">
            <Icon name="check-circle" size={16} weight="bold" />
            <span>
              Access granted to <strong>{appName}</strong>. Redirecting…
            </span>
          </div>
        ) : (
          <div className="nx-invite-result" data-tone="muted">
            <Icon name="x" size={15} weight="bold" />
            <span>Authorization request denied.</span>
          </div>
        )}
      </div>
    </div>
  );
}
