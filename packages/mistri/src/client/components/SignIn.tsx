/**
 * The sign-in screen, for an app that signs people in.
 *
 * The server said 401 with what to draw: the app's name, which providers
 * it takes, whether anyone may sign up, and whether a forgotten password can
 * be reset by a link. Everything here talks to Better Auth's own routes under
 * /api/auth with plain fetch — a JSON body in, a session cookie out — so the
 * client carries no auth library. Wearing the app's dress (its accent, its
 * name), because the person is signing in to the app, not to the tool
 * underneath.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { Button } from '@mistriwork/ui/Button.js';
import { Field } from '@mistriwork/ui/Field.js';
import { AuthRefusal, post, reload } from './authRequest.js';
import { say } from '../copy/public/components/SignIn.js';
import { navReplace, navState } from '@mistriwork/kit/client/shellHost.js';

/* Account creation by invitation is an explicit choice, not every sign-in's first paint. */
const ClaimInvitation = onDemand(() => import('./ClaimInvitation.js'), 'ClaimInvitation');

export interface SignInInfo {
  app: string;
  look?: { logo?: string; icons?: Record<string, import('@mistriwork/engine/shared/iconGlyphs.js').IconGlyph> };
  providers: string[];
  /** `provider`: accounts are made at a first sign-in through an identity provider; email sign-up is closed. */
  signUp: 'open' | 'invite' | 'provider';
  /** An identity provider's button words, by how the providers list names it (`oidc:workforce`). */
  labels?: Record<string, string>;
  /** The App id an account-creating invitation is claimed into, when the tenant host offers claims. */
  invitationClaim?: string;
  /** `'link'`: a forgotten password is reset by a one-time link the server
      delivers. Absent: an administrator resets it, and the screen says so. */
  reset?: 'link';
}

/** Where the signed-out App lives beside this door — its landing or public pages — for the way back. */
export interface SignInHome {
  href: string;
}

const NAMES: Record<string, string> = { github: 'GitHub', google: say('google') };
/* The two providers the platform names itself get their mark at the button's start, drawn here and not
   from the App's icon payload: the sign-in screen is the one surface with no App payload yet. GitHub's is
   one path in the text colour, so every look and dark scheme reads it; Google's keeps its four colours, as
   its brand rules ask. An OpenID Connect provider is whatever its config calls it and gets no mark. */
const MARKS: Record<string, ReactNode> = {
  github: (
    <path
      fill="currentColor"
      d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
    />
  ),
  google: (
    <>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </>
  ),
};
/** Each tenant's own identity providers, of either kind: found by the domain of the email a person types, never listed. */
const TENANT_PROVIDERS = ['oidc:*', 'saml:*'];
/** The provider id Better Auth knows a listed provider by: `oidc:workforce` is `workforce`, `saml:okta` is `okta`. */
const providerId = (provider: string) => (provider.startsWith('oidc:') || provider.startsWith('saml:') ? provider.slice(5) : provider);

/* The codes a refused sign-in through a provider comes back with (auth/identityRoles.ts, and Better Auth's
   own). Only the code is read: the words beside it in the address are anyone's to write. */
const REFUSED: Record<string, (app: string) => string> = {
  no_role: (app) => say('refusedNoRole', { app }),
  sign_up_closed: (app) => say('refusedSignUpClosed', { app }),
  signup_disabled: (app) => say('refusedSignUpClosed', { app }),
  outside_domain: () => say('refusedOutsideDomain'),
  account_not_linked: () => say('refusedNotLinked'),
};

/** A refusal a provider's sign-in came back to this page with, said once and taken out of the address. */
function arrivedRefusal(app: string): string {
  if (typeof window === 'undefined') return '';
  const url = new URL(window.location.href);
  const code = url.searchParams.get('error');
  if (!code || url.searchParams.get('reset') === '1') return '';
  for (const name of ['error', 'error_description']) url.searchParams.delete(name);
  navReplace(`${url.pathname}${url.search}${url.hash}`, navState());
  return (REFUSED[code] ?? (() => say('refusedOther')))(app);
}
const MIN_PASSWORD = 8;

type Mode = 'in' | 'up' | 'claim' | 'forgot' | 'reset' | 'work';
type Problems = Partial<Record<'name' | 'email' | 'password' | 'confirm', string>>;

/* A server refusal that is about one field is said beside that field. The
   rest — a wrong email or password, which must not say which — stays the
   form's one sentence. */
const FIELD_OF: Record<string, keyof Problems> = {
  USER_ALREADY_EXISTS: 'email',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'email',
  INVALID_EMAIL: 'email',
  PASSWORD_TOO_SHORT: 'password',
  PASSWORD_TOO_LONG: 'password',
};
const SAID_OF: Record<string, string> = {
  USER_ALREADY_EXISTS: say('anAccountAlreadyUsesThisEmail'),
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: say('anAccountAlreadyUsesThisEmail'),
  INVALID_EMAIL: say('enterAnEmailAddress'),
  PASSWORD_TOO_SHORT: say('useAtLeastCharacters', { min: MIN_PASSWORD }),
};

const looksLikeEmail = (value: string) => /^[^\s@]+@[^\s@]+$/.test(value);

/** What a reset link brought back to this page: its token, or that it was refused. */
function arrivedReset(): { token?: string; failed?: true } | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get('reset') !== '1') return null;
  const token = params.get('token');
  if (token) return { token };
  return params.get('error') ? { failed: true } : null;
}

/** The address a reset link comes back to: this page, marked, so a stray `?token=` elsewhere is never read as one. */
function resetReturn(): string {
  const here = new URL(window.location.href);
  return `${here.origin}${here.pathname}?reset=1`;
}

/** Take the reset's words out of the address, so a reload or a shared link carries no token. */
function forgetResetAddress(): void {
  const url = new URL(window.location.href);
  for (const name of ['reset', 'token', 'error']) url.searchParams.delete(name);
  navReplace(`${url.pathname}${url.search}${url.hash}`, navState());
}

export function SignIn({
  info,
  home,
  start,
  lead,
}: {
  info: SignInInfo;
  home?: SignInHome;
  /** `'up'`: open on creating an account, where the App lets anyone make one — a saved form's "Create an account to track this". */
  start?: 'up';
  /** Why this door is here, said above the form: "Sign in to add your application to your account." */
  lead?: string;
}) {
  const [arrived] = useState(arrivedReset);
  const [mode, setMode] = useState<Mode>(() =>
    arrived?.token
      ? 'reset'
      : arrived?.failed
        ? 'forgot'
        : start === 'up' && info.signUp === 'open' && info.providers.includes('email')
          ? 'up'
          : 'in',
  );
  const token = useRef(arrived?.token ?? '');
  // The address an invitation claim just made an account for, handed to sign-in.
  const [claimed, setClaimed] = useState<string | null>(null);
  // A sentence the sign-in form opens with: an account made, a password changed.
  const [notice, setNotice] = useState('');
  const first = useRef<HTMLInputElement>(null);
  const [revealed, setRevealed] = useState(false);
  const [problems, setProblems] = useState<Problems>({});
  const [formProblem, setFormProblem] = useState(() => (arrived?.failed ? say('thatLinkHasExpired') : arrivedRefusal(info.app)));
  const [sentTo, setSentTo] = useState('');
  const email = info.providers.includes('email');
  const flips = info.signUp === 'open' && email;
  const claims = email && typeof info.invitationClaim === 'string' && !!info.invitationClaim;
  const fields = {
    name: useRef<HTMLInputElement>(null),
    email: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
    confirm: useRef<HTMLInputElement>(null),
  };

  useEffect(() => {
    if (arrived) forgetResetAddress();
  }, [arrived]);
  useEffect(() => {
    first.current?.focus();
  }, [mode]);

  const go = (next: Mode) => {
    setProblems({});
    setFormProblem('');
    setSentTo('');
    setNotice('');
    setRevealed(false);
    setMode(next);
  };

  /** Say what is wrong beside each field, and send the focus to the first. */
  const [fix, setFix] = useState<{ key: keyof Problems } | null>(null);
  useEffect(() => {
    if (fix) fields[fix.key].current?.focus();
  }, [fix]);
  const refuse = (found: Problems) => {
    setProblems(found);
    const at = (['name', 'email', 'password', 'confirm'] as const).find((key) => found[key]);
    // Once drawn, so the field is heard already saying it is invalid (docs/design.md, Access).
    if (at) setFix({ key: at });
    return !at;
  };
  /** A server refusal: beside its field when it names one, the form's sentence otherwise. */
  const refused = (error: unknown) => {
    const code = error instanceof AuthRefusal ? error.code : undefined;
    const field = code ? FIELD_OF[code] : undefined;
    if (field) {
      refuse({ [field]: SAID_OF[code!] ?? (error as Error).message });
      setFormProblem('');
    } else setFormProblem((error as Error).message);
  };

  const credentials = useMutation({
    mutationFn: async (form: { name: string; email: string; password: string }) =>
      mode === 'up'
        ? post('/api/auth/sign-up/email', form)
        : post('/api/auth/sign-in/email', { email: form.email, password: form.password, rememberMe: true }),
    onSuccess: reload,
    onError: refused,
  });

  const social = useMutation({
    /* A refusal comes back to this page, where it is said (arrivedRefusal). */
    mutationFn: ({ provider, hint }: { provider: string; hint?: string }) =>
      /* A SAML provider's sign-in names it and where to come back to, and nothing else (auth/samlSignIn.ts). */
      provider.startsWith('saml:')
        ? post('/api/auth/sign-in/sso', {
            providerId: providerId(provider),
            callbackURL: window.location.href,
            errorCallbackURL: window.location.href,
          })
        : post('/api/auth/sign-in/social', {
            provider: providerId(provider),
            callbackURL: window.location.href,
            errorCallbackURL: window.location.href,
            ...(hint ? { loginHint: hint } : {}),
          }),
    onSuccess: (data) => {
      if (typeof data.url === 'string') window.location.href = data.url;
    },
    onError: (error) => setFormProblem((error as Error).message),
  });

  /* "Sign in with your work email": the address's domain names its organization's provider, and the
     sign-in goes there with the address as a hint. */
  const realm = useMutation({
    mutationFn: async (address: string) => ({ address, found: await post('/api/auth/work-email', { email: address }) }),
    onSuccess: ({ address, found }) => {
      // The answer names the provider and its kind; the kind says which sign-in starts there.
      if (typeof found.provider === 'string')
        social.mutate({ provider: `${found.kind === 'saml' ? 'saml' : 'oidc'}:${found.provider}`, hint: address });
      else setFormProblem(say('noOrganizationSignsIn', { app: info.app, domain: address.slice(address.lastIndexOf('@') + 1) }));
    },
    onError: refused,
  });

  const recovery = useMutation({
    mutationFn: (address: string) => post('/api/auth/request-password-reset', { email: address, redirectTo: resetReturn() }),
    onSuccess: (_data, address) => setSentTo(address),
    onError: refused,
  });

  const choosing = useMutation({
    mutationFn: (password: string) => post('/api/auth/reset-password', { newPassword: password, token: token.current }),
    onSuccess: () => {
      token.current = '';
      go('in');
      setNotice(say('yourPasswordIsChanged'));
    },
    onError: (error) => {
      // A spent or expired token cannot be tried again: ask for a new link.
      if (error instanceof AuthRefusal && error.code === 'INVALID_TOKEN') {
        token.current = '';
        go('forgot');
        setFormProblem(say('thatLinkHasExpired'));
      } else refused(error);
    },
  });

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (credentials.isPending) return;
    const form = new FormData(e.currentTarget);
    const values = {
      name: String(form.get('name') ?? '').trim(),
      email: String(form.get('email') ?? '').trim(),
      password: String(form.get('password') ?? ''),
    };
    setFormProblem('');
    const found: Problems = {};
    if (mode === 'up' && !values.name) found.name = 'Enter your name.';
    if (!values.email) found.email = say('enterYourEmailAddress');
    else if (!looksLikeEmail(values.email)) found.email = say('enterAnEmailAddress');
    if (!values.password) found.password = mode === 'up' ? say('chooseAPassword') : say('enterYourPassword');
    else if (mode === 'up' && values.password.length < MIN_PASSWORD) found.password = say('useAtLeastCharacters', { min: MIN_PASSWORD });
    if (!refuse(found)) return;
    credentials.mutate(mode === 'up' ? values : { ...values, name: '' });
  };

  const work = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (realm.isPending || social.isPending) return;
    const address = String(new FormData(e.currentTarget).get('email') ?? '').trim();
    setFormProblem('');
    if (!refuse(!address ? { email: say('enterYourEmailAddress') } : !looksLikeEmail(address) ? { email: say('enterAnEmailAddress') } : {}))
      return;
    realm.mutate(address);
  };

  const ask = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (recovery.isPending) return;
    const address = String(new FormData(e.currentTarget).get('email') ?? '').trim();
    setFormProblem('');
    if (!refuse(!address ? { email: say('enterYourEmailAddress') } : !looksLikeEmail(address) ? { email: say('enterAnEmailAddress') } : {}))
      return;
    recovery.mutate(address);
  };

  const choose = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (choosing.isPending) return;
    const form = new FormData(e.currentTarget);
    const password = String(form.get('password') ?? ''),
      confirm = String(form.get('confirm') ?? '');
    setFormProblem('');
    if (
      !refuse(
        password.length < MIN_PASSWORD
          ? { password: say('useAtLeastCharacters', { min: MIN_PASSWORD }) }
          : password !== confirm
            ? { confirm: say('common.thePasswordsDoNotMatch') }
            : {},
      )
    )
      return;
    choosing.mutate(password);
  };

  /** A field's control, joined to the field's own ref and the one that takes the focus first. */
  const bind = (key: keyof Problems, focusFirst: boolean) => (node: HTMLInputElement | null) => {
    fields[key].current = node;
    if (focusFirst) first.current = node;
  };
  const clear = (key: keyof Problems) => () => {
    if (problems[key]) setProblems((before) => ({ ...before, [key]: undefined }));
  };

  const title =
    mode === 'up'
      ? say('createYourAccount', { app: info.app })
      : mode === 'claim'
        ? say('join', { app: info.app })
        : mode === 'forgot'
          ? say('resetYourPassword')
          : mode === 'reset'
            ? say('chooseANewPassword')
            : mode === 'work'
              ? say('workEmail')
              : say('sign', { app: info.app });
  const pending = credentials.isPending || recovery.isPending || choosing.isPending || realm.isPending;
  const listed = info.providers.filter((provider) => provider !== 'email' && !TENANT_PROVIDERS.includes(provider));
  const organizations = info.providers.some((provider) => TENANT_PROVIDERS.includes(provider));

  return (
    <div className="signin">
      {/* The way back to the App's public pages, when it has them: the door is not a dead end. */}
      {home && (
        <a className="signin-home" href={home.href} aria-label={say('back', { app: info.app })}>
          <span aria-hidden="true">←</span> {info.app}
        </a>
      )}
      <div className="signin-card">
        {/* The App's name is in the bar above; the heading says what this screen is for, in it. */}
        <h1 className="signin-title">{title}</h1>
        {mode === 'claim' && claims && (
          <ClaimInvitation
            appId={info.invitationClaim!}
            onClaimed={(address) => {
              setClaimed(address);
              go('in');
              setNotice(say('yourAccountIsReady'));
            }}
            onCancel={() => go('in')}
          />
        )}
        {notice && mode === 'in' && (
          <p className="signin-notice" role="status">
            {notice}
          </p>
        )}
        {lead && !notice && (mode === 'in' || mode === 'up') && <p className="signin-notice">{lead}</p>}
        {email && (mode === 'in' || mode === 'up') && (
          <form className="signin-form" onSubmit={submit} noValidate key={claimed ?? ''}>
            {mode === 'up' && (
              <Field label={say('common.name')} problem={problems.name}>
                <input
                  ref={bind('name', true)}
                  type="text"
                  name="name"
                  className="field-control signin-input"
                  autoComplete="name"
                  required
                  placeholder={say('yourName')}
                  onInput={clear('name')}
                />
              </Field>
            )}
            <Field label={say('common.email')} problem={problems.email}>
              <input
                ref={bind('email', mode !== 'up')}
                type="email"
                name="email"
                className="field-control signin-input"
                autoComplete="email"
                required
                placeholder={say('youExampleCom')}
                defaultValue={mode === 'in' ? (claimed ?? undefined) : undefined}
                onInput={clear('email')}
              />
            </Field>
            <Field
              label={say('common.password')}
              id="signin-password"
              problem={problems.password}
              hint={mode === 'up' ? say('atLeastCharacters', { min: MIN_PASSWORD }) : undefined}
            >
              {(control) => (
                <span className="signin-secret">
                  <input
                    {...control}
                    ref={bind('password', false)}
                    type={revealed ? 'text' : 'password'}
                    name="password"
                    className="field-control signin-input"
                    autoComplete={mode === 'up' ? 'new-password' : 'current-password'}
                    required
                    onInput={clear('password')}
                  />
                  {/* Named "Show"/"Hide", not "Show password": the field's own name stays the only "Password" on the page.
                      Beside the field, not drawn over its right end: two controls in one box, one tapped for the other. */}
                  <Button
                    intent="quiet"
                    className="signin-reveal"
                    aria-pressed={revealed}
                    aria-controls="signin-password"
                    onClick={() => setRevealed((on) => !on)}
                  >
                    {revealed ? say('hide') : say('show')}
                  </Button>
                </span>
              )}
            </Field>
            {/* The refusal stands with the fields it is about, above the button that was just pressed, in a line held
                even while empty: below the links it arrived after the button and pushed "Create an account" down. */}
            <p className="signin-problem signin-problem-held" role="alert">
              {formProblem && !credentials.isPending ? formProblem : null}
            </p>
            {/* Busy, not disabled: a disabled button drops the focus it holds, and a
                refused sign-in left the reader on the page itself. submit refuses a second press. */}
            <Button intent="primary" size="large" block type="submit" className="signin-submit" busy={credentials.isPending}>
              {mode === 'up' ? say('createAccount') : say('common.signIn')}
            </Button>
            {mode === 'in' && (
              <Button intent="quiet" className="signin-forgot" onClick={() => go('forgot')}>
                {say('forgotPassword')}
              </Button>
            )}
          </form>
        )}
        {mode === 'forgot' &&
          (info.reset === 'link' ? (
            sentTo ? (
              <p className="signin-notice" role="status">
                {say('ifAnAccountUses', { sentTo })}
              </p>
            ) : (
              <form className="signin-form" onSubmit={ask} noValidate>
                <p className="signin-lede">{say('enterTheEmailAddress')}</p>
                <Field label={say('common.email')} problem={problems.email}>
                  <input
                    ref={bind('email', true)}
                    type="email"
                    name="email"
                    className="field-control signin-input"
                    autoComplete="email"
                    required
                    placeholder={say('youExampleCom')}
                    onInput={clear('email')}
                  />
                </Field>
                <Button intent="primary" size="large" block type="submit" busy={recovery.isPending}>
                  {say('sendResetLink')}
                </Button>
              </form>
            )
          ) : (
            <p className="signin-lede">{say('passwordResetsForAreMade', { app: info.app })}</p>
          ))}
        {mode === 'reset' && (
          <form className="signin-form" onSubmit={choose} noValidate>
            <Field label={say('newPassword')} problem={problems.password} hint={say('atLeastCharacters', { min: MIN_PASSWORD })}>
              <input
                ref={bind('password', true)}
                type="password"
                name="password"
                className="field-control signin-input"
                autoComplete="new-password"
                required
                onInput={clear('password')}
              />
            </Field>
            <Field label={say('confirmNewPassword')} problem={problems.confirm}>
              <input
                ref={bind('confirm', false)}
                type="password"
                name="confirm"
                className="field-control signin-input"
                autoComplete="new-password"
                required
                onInput={clear('confirm')}
              />
            </Field>
            <Button intent="primary" size="large" block type="submit" busy={choosing.isPending}>
              {say('changePassword')}
            </Button>
          </form>
        )}
        {mode === 'work' && (
          <form className="signin-form" onSubmit={work} noValidate>
            <p className="signin-lede">{say('workEmailLede')}</p>
            <Field label={say('common.email')} problem={problems.email}>
              <input
                ref={bind('email', true)}
                type="email"
                name="email"
                className="field-control signin-input"
                autoComplete="email"
                required
                placeholder={say('youExampleCom')}
                onInput={clear('email')}
              />
            </Field>
            <Button intent="primary" size="large" block type="submit" busy={realm.isPending || social.isPending}>
              {say('findMyOrganization')}
            </Button>
          </form>
        )}
        {(mode === 'in' || mode === 'up') && (listed.length > 0 || organizations) && (
          <div className="signin-social-row">
            {listed.map((provider) => (
              <Button
                key={provider}
                intent="secondary"
                size="large"
                block
                className="signin-social"
                busy={social.isPending}
                onClick={() => social.mutate({ provider })}
              >
                {MARKS[provider] && (
                  <svg className="signin-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    {MARKS[provider]}
                  </svg>
                )}
                {say('continue')} {info.labels?.[provider] ?? NAMES[provider] ?? providerId(provider)}
              </Button>
            ))}
            {organizations && (
              <Button intent="secondary" size="large" block className="signin-social" onClick={() => go('work')}>
                {say('workEmail')}
              </Button>
            )}
          </div>
        )}
        {mode !== 'claim' && !(email && (mode === 'in' || mode === 'up')) && (
          <p className="signin-problem" role="alert" hidden={!formProblem || pending}>
            {formProblem}
          </p>
        )}
        {(mode === 'forgot' || mode === 'reset' || mode === 'work') && (
          <Button intent="quiet" className="signin-flip" onClick={() => go('in')}>
            {say('common.backToSign')}
          </Button>
        )}
        {claims && (mode === 'in' || mode === 'up') && (
          <Button
            intent="quiet"
            className="signin-flip"
            onClick={() => {
              setClaimed(null);
              go('claim');
            }}
          >
            {say('haveAnInvitationCreate')}
          </Button>
        )}
        {mode !== 'in' && mode !== 'up' ? null : flips ? (
          <Button intent="quiet" className="signin-flip" onClick={() => go(mode === 'up' ? 'in' : 'up')}>
            {mode === 'up' ? say('haveAnAccountSign') : say('newHereCreateAnAccount')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
