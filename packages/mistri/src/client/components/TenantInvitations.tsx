/**
 * The tenant administration invitation panel: an operator issues, reissues and
 * revokes an App's account- or email-addressed invitations and reads their
 * state, through the controller that speaks to the tenant host.
 */
import { useEffect, useId, useState, useSyncExternalStore, type FormEvent } from 'react';
import type {
  InvitationIssuerIntent,
  InvitationIssuerOperation,
  InvitationOperation,
  InvitationPair,
  InvitationTarget,
} from '../../shared/tenantInvitations.js';
import { recipientStep, TenantInvitationsController } from '../tenantInvitations.js';
import { Modal } from '@mistriwork/ui/Modal.js';
import { DateField } from '@mistriwork/kit/client/components/DateField.js';
import './TenantAdministration.css';
import { formatDateTime } from '@mistriwork/kit/client/locale.js';
import { say } from '../copy/tenancy/components/TenantInvitations.js';
import { roleName } from '../tenantNames.js';

type View = ReturnType<TenantInvitationsController['snapshot']>;
const names: Record<InvitationOperation, string> = {
  issueInvitation: say('issueInvitation'),
  revokeInvitation: say('revokeInvitation'),
  reissueInvitation: say('reissueInvitation'),
  acceptInvitation: say('acceptInvitation'),
  claimInvitation: say('acceptInvitation'),
};
const localTime = (value: number) => new Date(value - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 23);
/* A person may type the space where the calendar writes a T; every engine reads the T form as local time. */
const parseLocal = (value: string) => Date.parse(value.replace(' ', 'T'));

/** Account-owned enrollment: accepting does not select a tenant or open its data. */
export function TenantInvitations({
  controller,
  mode,
  onClose,
}: {
  controller: TenantInvitationsController;
  mode: 'issuer' | 'recipient';
  onClose: () => void;
}) {
  const view = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [, tick] = useState(0);
  const session = mode === 'issuer' ? view.issuerSession : view.recipientSession;
  useEffect(() => {
    if (mode === 'issuer' && view.issuerSession && !view.targets && !view.loading && !controller.locked()) void controller.loadTargets();
  }, [controller, mode, view.issuerSession]);
  useEffect(() => {
    const timer = session ? setTimeout(() => tick((n) => n + 1), Math.max(0, session.expiresAt - Date.now()) + 10) : undefined;
    return () => clearTimeout(timer);
  }, [session]);
  if (!controller.current()) return null;
  const locked = controller.locked(),
    expired = !!session && session.expiresAt <= Date.now();
  const close = () => {
    if (!controller.current() || controller.locked()) return;
    controller.clearSecret();
    controller.clearOperation();
    onClose();
  };
  const title = mode === 'issuer' ? say('manageInvitations') : say('acceptInvitation');
  return (
    <Modal className="tenant-administration" ariaLabel={title} fullscreen="mobile" onClose={close} closeDisabled={locked}>
      <header>
        <h2>{title}</h2>
        <button type="button" className="ghost" aria-label={say('closeInvitations')} onClick={close} disabled={locked}>
          ×
        </button>
      </header>
      <p className="note">{say('invitationsEnrollAnExisting')}</p>
      {view.message && <p role={view.phase === 'unknown' ? 'alert' : 'status'}>{view.message}</p>}
      {view.loading && <p role="status">{say('loadingInvitationInformation')}</p>}
      {view.result && (
        <p className="administration-receipt">
          {say('receiptChangeConfirmed', { receiptId: view.result.receiptId, at: formatDateTime(new Date(view.result.completedAt)) })}
          {'status' in view.result && say('chooseATenantSeparately')}
        </p>
      )}
      {view.handoffToken && (
        <section aria-label={say('oneTimeInvitationHandoff')}>
          <p className="note">{say('localFixtureHandoffOnly')}</p>
          <label className="administration-field">
            <span>{say('oneTimeInvitationToken')}</span>
            <input readOnly autoComplete="off" spellCheck={false} value={view.handoffToken} onFocus={(e) => e.target.select()} />
          </label>
          <button type="button" className="ghost" onClick={() => controller.clearSecret()}>
            {say('clearToken')}
          </button>
        </section>
      )}
      {expired && <p role="alert">{say('invitationAccessHasExpired')}</p>}
      {(expired || view.phase === 'unknown') && (
        <button
          type="button"
          className="ghost"
          disabled={view.loading || view.phase === 'executing' || view.phase === 'checking'}
          onClick={() => void controller.recoverContext()}
        >
          {say('refreshInvitationAccess')}
        </button>
      )}
      {view.attempt && <Review view={view} controller={controller} expired={expired} />}
      {!locked &&
        view.phase !== 'review' &&
        (mode === 'recipient' ? (
          <RecipientForm controller={controller} disabled={view.loading} />
        ) : (
          <Issuer view={view} controller={controller} disabled={expired || view.loading} />
        ))}
      <footer>
        <button type="button" className="ghost" disabled={locked} onClick={close}>
          {say('common.close')}
        </button>
      </footer>
    </Modal>
  );
}

function RecipientForm({ controller, disabled }: { controller: TenantInvitationsController; disabled: boolean }) {
  const [token, setToken] = useState('');
  return (
    <form
      className="administration-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        const submitted = token;
        setToken('');
        void controller.previewToken(submitted);
      }}
    >
      <label className="administration-field">
        <span>{say('invitationToken')}</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          required
          maxLength={85}
          value={token}
          disabled={disabled}
          onChange={(event) => setToken(event.target.value)}
        />
      </label>
      <button type="submit" className="primary" disabled={disabled}>
        {say('reviewInvitation')}
      </button>
    </form>
  );
}

function Review({ view, controller, expired }: { view: View; controller: TenantInvitationsController; expired: boolean }) {
  const intent = view.attempt!.intent,
    preview = recipientStep(intent) ? view.preview : null;
  const roles = 'roles' in intent ? intent.roles : preview?.roles;
  const validUntil = 'validUntil' in intent ? intent.validUntil : preview?.validUntil;
  const redeemUntil = 'redeemUntil' in intent ? intent.redeemUntil : preview?.redeemUntil;
  return (
    <section className="administration-review" aria-label={say('reviewInvitationChange')}>
      <h3>{view.phase === 'review' ? say('reviewChange') : say('retainedAttempt')}</h3>
      <dl>
        <dt>{say('operation')}</dt>
        <dd>{names[intent.operation]}</dd>
        <dt>{say('tenant')}</dt>
        <dd>
          <bdi>{(view.target?.tenantId === intent.tenantId && view.target.name) || intent.tenantId}</bdi>
        </dd>
        {'accountId' in intent && (
          <>
            <dt>{say('nativeAccountId')}</dt>
            <dd>{intent.accountId}</dd>
          </>
        )}
        {'email' in intent && (
          <>
            <dt>{say('emailAddress')}</dt>
            <dd>{intent.email}</dd>
          </>
        )}
        {'invitationId' in intent && (
          <>
            <dt>{say('invitationId')}</dt>
            <dd>{intent.invitationId}</dd>
          </>
        )}
        {roles && (
          <>
            <dt>{say('roles')}</dt>
            <dd>{roles.map(roleName).join(', ')}</dd>
          </>
        )}
        {redeemUntil !== undefined && (
          <>
            <dt>{say('redeemBefore')}</dt>
            <dd>{formatDateTime(redeemUntil)}</dd>
          </>
        )}
        {validUntil !== undefined && (
          <>
            <dt>{say('membershipValidUntil')}</dt>
            <dd>{formatDateTime(validUntil)}</dd>
          </>
        )}
        <dt>{say('expectedTenantVersion')}</dt>
        <dd>{intent.expectedTenantVersion}</dd>
        <dt>{say('attemptKey')}</dt>
        <dd>{view.attempt!.idempotencyKey}</dd>
      </dl>
      {(intent.operation === 'reissueInvitation' || intent.operation === 'revokeInvitation') && (
        <p className="administration-warning">
          {say('theOldInvitationAndPending')}
          {intent.operation === 'reissueInvitation' && say('reissueCreatesANew')}
        </p>
      )}
      {view.phase === 'review' && (
        <div className="administration-actions">
          <button type="button" className="ghost" onClick={() => controller.cancelReview()}>
            {say('cancelReview')}
          </button>
          <button
            type="button"
            className={intent.operation === 'revokeInvitation' ? 'danger' : 'primary'}
            disabled={expired || view.loading}
            onClick={() => void controller.execute()}
          >
            {names[intent.operation]}
          </button>
        </div>
      )}
      {(view.phase === 'executing' || view.phase === 'checking') && (
        <p role="status">{view.phase === 'executing' ? say('applyingChange') : say('checkingThisAttempt')}</p>
      )}
      {view.phase === 'unknown' && (
        <button type="button" className="primary" disabled={expired || view.loading} onClick={() => void controller.check()}>
          {say('checkAttemptStatus')}
        </button>
      )}
    </section>
  );
}

function Issuer({ view, controller, disabled }: { view: View; controller: TenantInvitationsController; disabled: boolean }) {
  if (!view.issuerSession)
    return (
      <button type="button" className="ghost" disabled={view.loading} onClick={() => void controller.openIssuer()}>
        {say('checkInvitationPermissions')}
      </button>
    );
  return (
    <>
      <nav className="administration-paging" aria-label={say('invitationTenantPages')}>
        <button type="button" className="ghost" disabled={disabled} onClick={() => void controller.loadTargets()}>
          {say('refreshTenants')}
        </button>
        {view.targets?.next && (
          <button type="button" className="ghost" disabled={disabled} onClick={() => void controller.loadTargets(view.targets!.next!)}>
            {say('nextTenants')}
          </button>
        )}
      </nav>
      {view.targets && (
        <section className="administration-targets" aria-label={say('invitationTargets')}>
          {!view.targets.items.length && <p>{say('noAuthorizedInvitationTargets')}</p>}
          <ul>
            {view.targets.items.map((target) => (
              <li key={target.tenantId}>
                <button
                  type="button"
                  className="ghost"
                  disabled={disabled}
                  aria-pressed={view.target?.tenantId === target.tenantId}
                  onClick={() => controller.select(target.tenantId)}
                >
                  <span>
                    <bdi>{target.name ?? target.tenantId}</bdi>
                  </span>
                  <span>{target.tenant?.status ?? say('unavailable')}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {view.target && <Target key={view.target.tenantId} target={view.target} view={view} controller={controller} disabled={disabled} />}
    </>
  );
}

function Target({
  target,
  view,
  controller,
  disabled,
}: {
  target: InvitationTarget;
  view: View;
  controller: TenantInvitationsController;
  disabled: boolean;
}) {
  const [operation, setOperation] = useState<InvitationIssuerOperation | null>(null);
  const [pair, setPair] = useState<InvitationPair | null>(null);
  const listOperation = operation === 'revokeInvitation' || operation === 'reissueInvitation';
  const available = target.capabilities.filter((c) =>
    c.operation === 'revokeInvitation' ? !!target.tenant : target.tenant?.status === 'active',
  );
  return (
    <section className="administration-editor" aria-label={say('invitations', { tenantId: target.name ?? target.tenantId })}>
      <h3>
        <bdi>{target.name ?? target.tenantId}</bdi>
      </h3>
      <div className="administration-actions">
        {available.map((c) => (
          <button
            type="button"
            className="ghost"
            key={c.operation}
            disabled={disabled}
            aria-pressed={operation === c.operation}
            onClick={() => {
              controller.clearOperation();
              setPair(null);
              setOperation(c.operation);
              if (c.operation !== 'issueInvitation') void controller.loadInvitations(c.operation);
            }}
          >
            {names[c.operation]}
          </button>
        ))}
      </div>
      {!available.length && <p>{say('noInvitationChangesAreAvailable')}</p>}
      {listOperation && view.invitations?.operation === operation && (
        <section aria-label={say('pendingInvitations')}>
          <ul className="administration-memberships">
            {view.invitations.items.map((item) => (
              <li key={item.invitation.invitationId}>
                <button
                  type="button"
                  className="ghost"
                  disabled={disabled || item.invitation.status !== 'pending'}
                  aria-pressed={pair === item}
                  onClick={() => setPair(item)}
                >
                  <span>{item.invitation.accountId}</span>
                  <span>
                    {item.invitation.invitationId} · {item.invitation.status} · {item.invitation.roles.map(roleName).join(', ')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {!view.invitations.items.length && <p>{say('noAuthorizedPendingInvitations')}</p>}
          <nav className="administration-paging" aria-label={say('invitationPages')}>
            <button
              type="button"
              className="ghost"
              disabled={disabled}
              onClick={() => {
                setPair(null);
                void controller.loadInvitations(operation);
              }}
            >
              {say('firstInvitations')}
            </button>
            {view.invitations.next && (
              <button
                type="button"
                className="ghost"
                disabled={disabled}
                onClick={() => {
                  setPair(null);
                  void controller.loadInvitations(operation, view.invitations!.next!);
                }}
              >
                {say('nextInvitations')}
              </button>
            )}
          </nav>
        </section>
      )}
      {operation && (!listOperation || (pair && view.invitations?.items.includes(pair))) && (
        <InvitationForm
          key={`${operation}:${pair?.invitation.invitationId ?? ''}:${pair?.invitation.version ?? ''}`}
          target={target}
          operation={operation}
          pair={pair}
          view={view}
          controller={controller}
          disabled={disabled}
        />
      )}
    </section>
  );
}

function InvitationForm({
  target,
  operation,
  pair,
  view,
  controller,
  disabled,
}: {
  target: InvitationTarget;
  operation: InvitationIssuerOperation;
  pair: InvitationPair | null;
  view: View;
  controller: TenantInvitationsController;
  disabled: boolean;
}) {
  const session = view.issuerSession!;
  const [by, setBy] = useState<'account' | 'email'>('account');
  const [account, setAccount] = useState('');
  const [email, setEmail] = useState('');
  const [roles, setRoles] = useState<readonly string[]>(pair?.invitation.roles ?? []);
  const [until, setUntil] = useState(() => localTime(Date.now() + Math.min(session.maxMembershipLifetimeMs, 86_400_000)));
  const [redeem, setRedeem] = useState(() =>
    localTime(Date.now() + Math.min(session.maxRedemptionLifetimeMs, session.maxMembershipLifetimeMs, 86_400_000)),
  );
  const [error, setError] = useState('');
  const fieldId = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (disabled) return;
    const expectedTenantVersion = (operation === 'issueInvitation' ? target.tenant : view.invitations?.tenant)?.version ?? '';
    const base = { tenantId: target.tenantId, expectedTenantVersion };
    const terms = { roles, validUntil: parseLocal(until), redeemUntil: parseLocal(redeem) };
    let intent: InvitationIssuerIntent;
    if (operation === 'issueInvitation')
      intent =
        by === 'email'
          ? { ...base, operation, email: email.trim().toLowerCase(), ...terms }
          : { ...base, operation, accountId: account, ...terms };
    else {
      const previous = {
        invitationId: pair!.invitation.invitationId,
        expectedInvitationVersion: pair!.invitation.version,
        membershipId: pair!.membership.membershipId,
        expectedMembershipVersion: pair!.membership.version,
      };
      intent = operation === 'reissueInvitation' ? { ...base, operation, ...previous, ...terms } : { ...base, operation, ...previous };
    }
    if (!controller.prepare(intent)) setError(say('checkTheExactAccount'));
  };
  return (
    <form className="administration-form" onSubmit={submit}>
      <fieldset disabled={disabled}>
        <legend>{names[operation]}</legend>
        {operation === 'issueInvitation' && (
          <fieldset className="administration-options">
            <legend>{say('invite')}</legend>
            <label>
              <input type="radio" name={`${fieldId}-by`} checked={by === 'account'} onChange={() => setBy('account')} />
              {say('byAccountId')}
            </label>
            <label>
              <input type="radio" name={`${fieldId}-by`} checked={by === 'email'} onChange={() => setBy('email')} />
              {say('byEmailAddress')}
            </label>
          </fieldset>
        )}
        {operation === 'issueInvitation' && by === 'account' && (
          <label className="administration-field">
            <span>{say('nativeAccountId')}</span>
            <input
              required
              autoComplete="off"
              spellCheck={false}
              maxLength={1024}
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            />
          </label>
        )}
        {operation === 'issueInvitation' && by === 'email' && (
          <>
            <label className="administration-field">
              <span>{say('emailAddress')}</span>
              <input
                type="email"
                required
                autoComplete="off"
                spellCheck={false}
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <p className="note">{say('thePersonCreatesTheir')}</p>
          </>
        )}
        {pair && (
          <p className="note">
            {say('accountMembership', { accountId: pair.invitation.accountId, membershipId: pair.membership.membershipId })}
          </p>
        )}
        {operation !== 'revokeInvitation' && (
          <>
            <fieldset className="administration-options">
              <legend>{say('rolesForThisInvitation')}</legend>
              {target.capabilities
                .find((c) => c.operation === operation)!
                .roles.map((role) => (
                  <label key={role}>
                    <input
                      type="checkbox"
                      checked={roles.includes(role)}
                      onChange={(e) => setRoles(e.target.checked ? [...roles, role] : roles.filter((r) => r !== role))}
                    />
                    {roleName(role)}
                  </label>
                ))}
            </fieldset>
            {/* Local wall times, read by Date.parse in the browser's zone, so the calendar's today is the browser's too. */}
            <label className="administration-field">
              <span>{say('redeemBeforeLocalTime')}</span>
              <DateField
                id={`${fieldId}-redeem`}
                withTime
                required
                value={redeem}
                aria-label={say('redeemBeforeLocalTime')}
                max={localTime(Date.now() + session.maxRedemptionLifetimeMs)}
                onChange={setRedeem}
              />
            </label>
            <label className="administration-field">
              <span>{say('membershipValidUntilLocal')}</span>
              <DateField
                id={`${fieldId}-until`}
                withTime
                required
                value={until}
                aria-label={say('membershipValidUntilLocal')}
                max={localTime(Date.now() + session.maxMembershipLifetimeMs)}
                onChange={setUntil}
              />
            </label>
          </>
        )}
        <button type="submit" className="primary">
          {say('reviewChange')}
        </button>
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
