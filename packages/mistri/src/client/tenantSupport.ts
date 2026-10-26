/**
 * The browser's half of audited support ("enter as dealer"): the three
 * support requests, strict readings of their replies, and the screen a tab
 * shows while it holds a support lease. The server decides everything; a
 * reply is used only once its shape is exactly what was asked for.
 *
 * A support lease grants no business access in this release, so the screen
 * shows no dealer data: the banner, a plain notice and Exit. Leaving always
 * goes back to the platform through an ordinary, freshly opened platform
 * lease: a support lease never switches.
 */
import { createElement } from 'react';
import { PLATFORM_TENANT_ID, TENANT_HTTP_HEADERS as names, type TenantContextReply } from '../shared/tenantContext.js';
import {
  SUPPORT_HTTP_ROOT,
  SUPPORT_REFUSAL_CODES,
  type SupportAttempt,
  type SupportChoice,
  type SupportExitIntent,
  type SupportExitReply,
  type SupportOpenIntent,
  type SupportOpenReply,
  type SupportReceiptView,
  type SupportSessionView,
  type SupportStatusReply,
} from '../shared/tenantSupport.js';
import { captureSessionIdentity, assertSessionCurrent, type SessionIdentitySnapshot } from '@mistriwork/kit/client/sessionIdentity.js';
import { EnterDealerDialog, type EnterDealerInput } from './components/EnterDealerDialog.js';
import { SupportScreen } from './components/SupportBanner.js';
import { element, mount, unmount } from '@mistriwork/kit/client/components/mount.js';
import { say } from './copy/tenancy/tenantSupport.js';
import { addTenantNames, isTenantName, tenantNames } from './tenantNames.js';
import { portalRoot } from '@mistriwork/kit/client/shellHost.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';

class SupportRequestError extends Error {
  constructor(
    message: string,
    readonly outcome: 'not_applied' | 'unknown',
    readonly code?: string,
  ) {
    super(message);
    this.name = 'SupportRequestError';
  }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024;
const invalid = (outcome: 'not_applied' | 'unknown') => new SupportRequestError(say('theSupportReplyCould'), outcome);

function supportSession(value: unknown): SupportSessionView {
  if (
    !object(value) ||
    Object.keys(value).length !== 10 ||
    !['supportId', 'version', 'tenantId', 'dealerRole', 'operatorName', 'reason', 'openedAt'].every((key) => text(value[key])) ||
    !Number.isSafeInteger(value.validUntil) ||
    !Number.isSafeInteger(value.remainingMs) ||
    (value.remainingMs as number) < 0 ||
    !['active', 'expired', 'ended'].includes(value.state as string) ||
    value.tenantId === PLATFORM_TENANT_ID
  )
    throw invalid('unknown');
  return Object.freeze({ ...value }) as unknown as SupportSessionView;
}
function receipt(value: unknown): SupportReceiptView {
  if (
    !object(value) ||
    Object.keys(value).length !== 4 ||
    !['openSupport', 'exitSupport'].includes(value.operation as string) ||
    !text(value.receiptId) ||
    !text(value.completedAt)
  )
    throw invalid('unknown');
  return Object.freeze({
    operation: value.operation,
    receiptId: value.receiptId,
    completedAt: value.completedAt,
    session: supportSession(value.session),
  }) as SupportReceiptView;
}
function choices(value: unknown): readonly SupportChoice[] {
  if (!Array.isArray(value) || value.length > 200) throw invalid('unknown');
  return Object.freeze(
    value.map((choice) => {
      if (
        !object(choice) ||
        Object.keys(choice).some((key) => !['tenantId', 'roles', 'name'].includes(key)) ||
        !text(choice.tenantId) ||
        choice.tenantId === PLATFORM_TENANT_ID ||
        !Array.isArray(choice.roles) ||
        !choice.roles.length ||
        !choice.roles.every(text) ||
        ('name' in choice && !isTenantName(choice.name))
      )
        throw invalid('unknown');
      return Object.freeze({
        tenantId: choice.tenantId,
        roles: Object.freeze([...choice.roles]) as string[],
        ...(typeof choice.name === 'string' ? { name: choice.name } : {}),
      });
    }),
  );
}
/** A support lease is its realm's, in the dealer the session is inside. */
function lease(value: unknown, snapshot: SessionIdentitySnapshot, tenantId: string, response: Response): TenantContextReply {
  if (
    !object(value) ||
    value.realm !== 'support' ||
    value.tenantId !== tenantId ||
    value.appId !== snapshot.appId ||
    value.accountId !== snapshot.accountId ||
    !text(value.tabId) ||
    !text(value.context) ||
    !Number.isSafeInteger(value.revision) ||
    !Number.isSafeInteger(value.expiresAt) ||
    response.headers.get(names.realm) !== 'support' ||
    response.headers.get(names.tab) !== value.tabId ||
    response.headers.get(names.context) !== value.context
  )
    throw invalid('unknown');
  return Object.freeze({ ...value }) as unknown as TenantContextReply;
}

async function post(operation: 'open' | 'exit' | 'status', body: Record<string, unknown>) {
  const snapshot = captureSessionIdentity();
  assertSessionCurrent(snapshot);
  if (snapshot.mode !== 'authenticated' || !snapshot.appId || !snapshot.accountId)
    throw new SupportRequestError(say('signInAgain'), 'not_applied');
  const failure: 'not_applied' | 'unknown' = operation === 'status' ? 'not_applied' : 'unknown';
  let response: Response;
  try {
    response = await fetchServer(`${SUPPORT_HTTP_ROOT}/${operation}?${new URLSearchParams({ app: snapshot.appId })}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', [names.account]: snapshot.accountId, [names.app]: snapshot.appId },
    });
  } catch {
    throw new SupportRequestError(say('theSupportRequestCould'), failure);
  }
  // A reply to a login or selection that has moved on is not read, and its
  // body is let go rather than left holding the connection: a status asked
  // beside the chooser often lands after a choice.
  try {
    assertSessionCurrent(snapshot);
  } catch (error) {
    void response.body?.cancel().catch(() => {});
    throw error;
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw invalid(failure);
  }
  if (!object(value)) throw invalid(failure);
  if (!response.ok) {
    throw new SupportRequestError(
      typeof value.error === 'string' ? value.error : say('theSupportSessionCould'),
      value.outcome === 'not_applied' ? 'not_applied' : 'unknown',
      typeof value.code === 'string' ? value.code : undefined,
    );
  }
  return { value, response, snapshot };
}

export async function supportStatus(options: { resume?: true; attempt?: SupportAttempt } = {}): Promise<SupportStatusReply> {
  const { value, response, snapshot } = await post('status', { ...options });
  const session = value.session === null ? null : supportSession(value.session);
  if (
    typeof value.signInRequired !== 'boolean' ||
    typeof value.passwordSignIn !== 'boolean' ||
    (value.reauthenticate !== undefined &&
      (typeof value.reauthenticate !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(value.reauthenticate))) ||
    (value.reauthenticateKind !== undefined && (value.reauthenticateKind !== 'saml' || value.reauthenticate === undefined)) ||
    ('recovered' in value && !options.attempt) ||
    ('context' in value && (!options.resume || !session))
  )
    throw invalid('not_applied');
  const offered = choices(value.choices);
  // What the dialog and the banner call each (tenantNames.ts).
  addTenantNames(offered.flatMap((choice) => (choice.name === undefined ? [] : [[choice.tenantId, choice.name] as const])));
  return Object.freeze({
    session,
    choices: offered,
    signInRequired: value.signInRequired,
    passwordSignIn: value.passwordSignIn,
    ...(typeof value.reauthenticate === 'string' ? { reauthenticate: value.reauthenticate } : {}),
    ...(value.reauthenticateKind === 'saml' ? { reauthenticateKind: 'saml' as const } : {}),
    ...(options.attempt ? { recovered: value.recovered === null || value.recovered === undefined ? null : receipt(value.recovered) } : {}),
    ...('context' in value ? { context: lease(value.context, snapshot, session!.tenantId, response) } : {}),
  });
}
async function openSupport(attempt: SupportAttempt<SupportOpenIntent>): Promise<SupportOpenReply> {
  const { value, response, snapshot } = await post('open', { ...attempt });
  const opened = receipt(value.receipt);
  if (typeof value.replayed !== 'boolean' || opened.operation !== 'openSupport' || opened.session.tenantId !== attempt.intent.tenantId)
    throw invalid('unknown');
  return Object.freeze({
    receipt: opened,
    replayed: value.replayed,
    ...('context' in value ? { context: lease(value.context, snapshot, opened.session.tenantId, response) } : {}),
  });
}
async function exitSupport(attempt: SupportAttempt<SupportExitIntent>): Promise<SupportExitReply> {
  const { value } = await post('exit', { ...attempt });
  const ended = receipt(value.receipt);
  if (typeof value.replayed !== 'boolean' || ended.operation !== 'exitSupport' || ended.session.supportId !== attempt.intent.supportId)
    throw invalid('unknown');
  return Object.freeze({ receipt: ended, replayed: value.replayed });
}
/** A real sign-in: the native session it creates is what opening checks is recent. */
async function signInAgain(email: string, password: string): Promise<void> {
  let response: Response;
  try {
    response = await fetchServer('/api/auth/sign-in/email', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new SupportRequestError(say('signInCouldNotBeConfirmed'), 'not_applied');
  }
  if (!response.ok) throw new SupportRequestError(say('thatPasswordWasNotAccepted'), 'not_applied');
}

interface SupportEntryOptions {
  /** The account's email, which a password sign-in needs; never shown to the dealer. */
  readonly who: string;
  readonly platformLabel: string;
  /** What the App calls a tenant (`auth.tenancy.label`), said by the dialog. */
  readonly tenantLabel?: string;
  /** Leave the current surface; false keeps it (an unsaved edit, a declined exit). */
  readonly before: () => Promise<boolean>;
  /** Show a live session in place of the current surface. */
  readonly enter: (session: SupportSessionView, context: TenantContextReply | undefined) => Promise<void>;
}
/** A dealer's own log of visits into it, mounted over the page until it closes.
 * It reads on the dealer's ordinary tenant lease, so unlike the dialogs above
 * it needs no support status and opens nothing. */
export function showSupportLog(): void {
  const host = element('div', null, 'support-log-host');
  portalRoot().append(host);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    unmount(host);
    host.remove();
  };
  // Loaded the first time it opens, as the account's dialogs are: a log most
  // members never read should not sit in the shell's first paint.
  void import('./components/SupportLog.js')
    .then(({ SupportLog }) => {
      if (!closed) mount(host, createElement(SupportLog, { onClose: close }));
    })
    .catch(() => close());
}

/** The platform's audit of every tenant's support sessions, loaded the first time it opens, as the dealer's log is. */
export function showSupportSessions(): void {
  const host = element('div', null, 'support-log-host');
  portalRoot().append(host);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    unmount(host);
    host.remove();
  };
  void import('./components/SupportSessions.js')
    .then(({ SupportSessions }) => {
      if (!closed) mount(host, createElement(SupportSessions, { onClose: close }));
    })
    .catch(() => close());
}

/** The Enter dialog ("Enter customer"), mounted over the page until it closes or a session opens. */
export function enterDealer(options: SupportEntryOptions): void {
  const host = element('div', null, 'enter-dealer-host');
  portalRoot().append(host);
  let status: SupportStatusReply | null = null,
    busy = false,
    error: string | undefined;
  let attempt: SupportAttempt<SupportOpenIntent> | undefined,
    unconfirmed = false,
    closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    unmount(host);
    host.remove();
  };
  const draw = () => {
    if (!closed)
      mount(
        host,
        createElement(EnterDealerDialog, {
          status,
          busy,
          error,
          unconfirmed,
          onSubmit: (input) => {
            void submit(input);
          },
          onCheck: () => {
            void check();
          },
          onReauthenticate: (provider) => {
            void reauthenticate(provider);
          },
          onClose: close,
          ...(options.tenantLabel ? { tenantLabel: options.tenantLabel } : {}),
        }),
      );
  };
  /* A fresh sign-in at the identity provider this login came through; it comes back to this page, where
     entering the dealer is asked for again. A SAML provider is asked through its own route; whether it
     authenticates afresh is its policy, and its AuthnInstant says whether it did. */
  const reauthenticate = async (provider: string) => {
    if (busy) return;
    busy = true;
    error = undefined;
    draw();
    try {
      const back = { callbackURL: window.location.href, errorCallbackURL: window.location.href };
      const saml = status?.reauthenticate === provider && status.reauthenticateKind === 'saml';
      const response = await fetchServer(saml ? '/api/auth/sign-in/sso' : '/api/auth/sign-in/social', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(saml ? { providerId: provider, ...back } : { provider, ...back, additionalParams: { mistri_step_up: '1' } }),
      });
      const answer = (await response.json().catch(() => null)) as { url?: unknown } | null;
      if (!response.ok || typeof answer?.url !== 'string') throw new Error();
      window.location.href = answer.url;
    } catch {
      busy = false;
      error = say('signInCouldNotBeConfirmed');
      draw();
    }
  };
  const load = async () => {
    try {
      status = await supportStatus();
      error = undefined;
    } catch {
      error = say('supportAccessCouldNotBeChecked');
    }
    draw();
  };
  const opened = async (session: SupportSessionView, context?: TenantContextReply) => {
    close();
    await options.enter(session, context);
  };
  const submit = async (input: EnterDealerInput) => {
    if (busy || unconfirmed) return;
    busy = true;
    error = undefined;
    draw();
    // Leaving the platform's surface is asked first: once the session opens it replaces the page.
    if (!(await options.before().catch(() => false))) {
      busy = false;
      draw();
      return;
    }
    try {
      if (input.password !== undefined) {
        await signInAgain(options.who, input.password);
        status = await supportStatus();
        if (status.signInRequired) throw new SupportRequestError(say('thatSignInWasNotRecent'), 'not_applied');
      }
      attempt = {
        idempotencyKey: crypto.randomUUID(),
        intent: { operation: 'openSupport', tenantId: input.tenantId, dealerRole: input.dealerRole, reason: input.reason },
      };
      const reply = await openSupport(attempt);
      await opened(reply.receipt.session, reply.context);
    } catch (failure) {
      busy = false;
      const known = failure instanceof SupportRequestError ? failure : undefined;
      unconfirmed = !!attempt && known?.outcome !== 'not_applied';
      error =
        known?.code === SUPPORT_REFUSAL_CODES.signInRequired
          ? known.message
          : unconfirmed
            ? say('theSessionMayHaveOpened')
            : (known?.message ?? say('theSessionCouldNotBeOpened'));
      if (known?.code === SUPPORT_REFUSAL_CODES.signInRequired) status = await supportStatus().catch(() => status);
      if (!unconfirmed) attempt = undefined;
      draw();
    }
  };
  const check = async () => {
    if (busy || !attempt) return;
    busy = true;
    error = undefined;
    draw();
    try {
      const reply = await supportStatus({ resume: true, attempt });
      if (!reply.recovered) {
        unconfirmed = false;
        attempt = undefined;
        busy = false;
        error = say('thatAttemptDidNotOpen');
        draw();
        return;
      }
      if (reply.session?.supportId === reply.recovered.session.supportId && reply.session.state === 'active') {
        await opened(reply.session, reply.context);
        return;
      }
      unconfirmed = false;
      attempt = undefined;
      busy = false;
      error = say('thatSessionHasAlready');
      draw();
    } catch {
      busy = false;
      error = say('theAttemptCouldNotBeChecked');
      draw();
    }
  };
  draw();
  void load();
}

interface SupportScreenOptions {
  readonly platformLabel: string;
  /** Back to the platform: an ordinary platform lease, freshly opened. */
  readonly leave: () => Promise<void>;
}
/** The support screen in `host`, until the operator exits or returns. */
export function showSupportSession(host: HTMLElement, session: SupportSessionView, options: SupportScreenOptions): () => void {
  let current = session,
    deadline = Date.now() + session.remainingMs,
    busy = false,
    error: string | undefined;
  let ended = session.state !== 'active',
    exitAttempt: SupportAttempt<SupportExitIntent> | undefined,
    disposed = false;
  const draw = () => {
    if (!disposed)
      mount(
        host,
        createElement(SupportScreen, {
          session: current,
          deadline,
          platformLabel: options.platformLabel,
          tenantName: tenantNames()[current.tenantId],
          busy,
          error,
          ended,
          onExit: () => {
            void exit();
          },
          onReturn: () => {
            void leave();
          },
        }),
      );
  };
  const leave = async () => {
    if (busy) return;
    busy = true;
    error = undefined;
    draw();
    try {
      await options.leave();
    } catch {
      busy = false;
      error = say('couldNotBeOpened', { platformLabel: options.platformLabel });
      draw();
    }
  };
  const exit = async () => {
    if (busy) return;
    busy = true;
    error = undefined;
    draw();
    exitAttempt ??= {
      idempotencyKey: crypto.randomUUID(),
      intent: {
        operation: 'exitSupport',
        tenantId: current.tenantId,
        supportId: current.supportId,
        expectedSupportVersion: current.version,
      },
    };
    try {
      try {
        await exitSupport(exitAttempt);
      } catch (failure) {
        // An exit whose answer was lost is checked, never sent as a new one.
        if (!(failure instanceof SupportRequestError) || failure.outcome !== 'unknown') throw failure;
        const reply = await supportStatus({ attempt: exitAttempt });
        if (!reply.recovered) throw failure;
      }
      busy = false;
      await leave();
    } catch {
      // Whatever the server says now is what the screen says.
      const status = await supportStatus().catch(() => undefined);
      busy = false;
      if (status && (!status.session || status.session.supportId !== current.supportId || status.session.state !== 'active')) ended = true;
      else error = say('theExitCouldNotBeConfirmed');
      draw();
    }
  };
  draw();
  return () => {
    disposed = true;
    unmount(host);
  };
}
