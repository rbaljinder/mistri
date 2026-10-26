/* The Manage tenants dialog: draws what TenantAdministrationController holds and sends what the operator asks it to do. */
import { useEffect, useId, useState, useSyncExternalStore, type FormEvent } from 'react';
import type {
  AdministrationImportPlan,
  AdministrationDecisionUsageRow,
  AdministrationUsageRow,
  AdministrationIntent,
  AdministrationMembershipImage,
  AdministrationOperation,
  AdministrationTenantTarget,
} from '../../shared/tenantAdministration.js';
import { consentReference, TenantAdministrationController, type AdministrationView } from '../tenantAdministration.js';
import { ASSISTANT_CONSENT_MOST } from '../../shared/tenantAdministration.js';
import { Modal } from '@mistriwork/ui/Modal.js';
import { DateField } from '@mistriwork/kit/client/components/DateField.js';
import './TenantAdministration.css';
import { formatDateTime, formatMoney, formatNumber } from '@mistriwork/kit/client/locale.js';
import { say } from '../copy/tenancy/components/TenantAdministration.js';
import { roleName } from '../tenantNames.js';

const names: Record<AdministrationOperation, string> = {
  createTenant: say('createTenant'),
  setTenantStatus: say('changeTenantStatus'),
  grantMembership: say('grantMembership'),
  replaceMembership: say('replaceMembership'),
  revokeMembership: say('revokeMembership'),
  setTenantAssistant: say('setTheAssistant'),
  setTenantDecisions: say('setTheDecisions'),
  cloneTenant: say('cloneTenant'),
  importTenant: say('importSandbox'),
};
/* The words for a provider id the platform knows; any other is said as it is named. */
const providerName = (provider: string) =>
  provider === 'jev' ? say('providerJev') : provider === 'anthropic' ? say('providerAnthropic') : provider;
const localTime = (value: number) => {
  const date = new Date(value);
  return new Date(value - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 23);
};
/* A person may type the space where the calendar writes a T; every engine reads the T form as local time. */
const parseLocal = (value: string) => Date.parse(value.replace(' ', 'T'));

export function TenantAdministration({ controller, onClose }: { controller: TenantAdministrationController; onClose: () => void }) {
  const view = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [, tick] = useState(0);
  const [section, setSection] = useState<'tenants' | 'usage' | 'decisionUsage'>('tenants');
  useEffect(() => {
    if (!controller.snapshot().page && !controller.snapshot().loading && !controller.locked()) void controller.loadTenants();
    const expiry = controller.snapshot().session?.expiresAt;
    const timer = expiry ? setTimeout(() => tick((n) => n + 1), Math.max(0, expiry - Date.now()) + 10) : undefined;
    return () => clearTimeout(timer);
  }, [controller, view.session]);
  if (!controller.current() || !view.session) return null;
  const locked = controller.locked(),
    expired = view.session.expiresAt <= Date.now();
  const close = () => {
    if (controller.current() && !controller.locked()) onClose();
  };
  return (
    <Modal className="tenant-administration" aria-label={say('manageTenants')} fullscreen="mobile" onClose={close} closeDisabled={locked}>
      <header>
        <h2>{say('manageTenants')}</h2>
        <button type="button" className="ghost" aria-label={say('closeTenantAdministration')} onClick={close} disabled={locked}>
          ×
        </button>
      </header>
      <p className="note">{say('manageAuthorizedTenantsAndMemberships')}</p>
      <p className="note">
        {say('accessExpiresMaximumMembership', { expiresAt: formatDateTime(view.session.expiresAt) })}{' '}
        {view.session.maxMembershipLifetimeMs / 60_000} {say('minutes')}
      </p>
      {view.message && <p role={view.phase === 'unknown' ? 'alert' : 'status'}>{view.message}</p>}
      {view.result && (
        <p className="administration-receipt">
          {say('receiptConfirmed', {
            receiptId: view.result.receiptId,
            at: formatDateTime(new Date(view.result.completedAt)),
            names: names[view.result.change.operation],
          })}
        </p>
      )}
      {view.loading && <p role="status">{say('loadingAuthorizedInformation')}</p>}
      {expired && (
        <div>
          <p role="alert">{say('administrationAccessHasExpired')}</p>
          <button
            type="button"
            className="ghost"
            disabled={view.loading || view.phase === 'executing' || view.phase === 'checking'}
            onClick={() => void controller.recoverContext()}
          >
            {say('refreshAdministrationAccess')}
          </button>
        </div>
      )}
      {view.attempt && <Review view={view} controller={controller} expired={expired} />}
      {/* The assistant's bill, for an operator who may set some tenant's assistant: beside the tenants, not in them. */}
      {(view.page?.usage || view.page?.decisionUsage || section !== 'tenants') && (
        <div className="administration-actions" role="tablist" aria-label={say('administrationSections')}>
          {(
            [
              'tenants',
              ...(view.page?.usage || section === 'usage' ? (['usage'] as const) : []),
              ...(view.page?.decisionUsage || section === 'decisionUsage' ? (['decisionUsage'] as const) : []),
            ] as const
          ).map((each) => (
            <button
              key={each}
              type="button"
              role="tab"
              className="ghost"
              aria-selected={section === each}
              disabled={locked || view.phase === 'review'}
              onClick={() => {
                setSection(each);
                if (each === 'usage') void controller.loadUsage();
                else if (each === 'decisionUsage') void controller.loadDecisionUsage();
                else void controller.loadTenants();
              }}
            >
              {each === 'tenants' ? say('tenants') : each === 'usage' ? say('assistantUsage') : say('decisionUsage')}
            </button>
          ))}
        </div>
      )}
      {section === 'usage' && !locked && view.phase !== 'review' && (
        <Usage view={view} disabled={expired || view.loading} onRefresh={() => void controller.loadUsage()} />
      )}
      {section === 'decisionUsage' && !locked && view.phase !== 'review' && (
        <DecisionUsage view={view} disabled={expired || view.loading} onRefresh={() => void controller.loadDecisionUsage()} />
      )}
      <div hidden={locked || view.phase === 'review' || section !== 'tenants'}>
        <nav className="administration-paging" aria-label={say('tenantPages')}>
          <button type="button" className="ghost" disabled={expired || view.loading} onClick={() => void controller.loadTenants()}>
            {say('refreshTenants')}
          </button>
          {view.page?.next && (
            <button
              type="button"
              className="ghost"
              disabled={expired || view.loading}
              onClick={() => void controller.loadTenants(view.page!.next!)}
            >
              {say('nextTenants')}
            </button>
          )}
        </nav>
        {view.page && (
          <section aria-label={say('authorizedTenants')} className="administration-targets">
            {!view.page.items.length && <p>{say('noAuthorizedTenantTargets')}</p>}
            <ul>
              {view.page.items.map((target) => (
                <li key={target.tenantId}>
                  <button
                    type="button"
                    className="ghost"
                    aria-pressed={view.target?.tenantId === target.tenantId}
                    disabled={expired}
                    onClick={() => controller.select(target.tenantId)}
                  >
                    <span>
                      <bdi>{target.name ?? target.tenantId}</bdi>
                    </span>
                    <span>{target.tenant?.status ?? say('notCreated')}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {view.target && <Target key={view.target.tenantId} target={view.target} view={view} controller={controller} expired={expired} />}
      </div>
      <footer>
        <button type="button" className="ghost" disabled={locked} onClick={close}>
          {say('common.close')}
        </button>
      </footer>
    </Modal>
  );
}

/* A review confirms the exact change, so an instant is said both ways: in
   the reader's words, and to the millisecond the form took and will submit. */
function Instant({ at }: { at: number }) {
  const exact = new Date(at).toISOString();
  return (
    <>
      <time dateTime={exact}>{formatDateTime(at)}</time> · {exact}
    </>
  );
}

function Review({ view, controller, expired }: { view: AdministrationView; controller: TenantAdministrationController; expired: boolean }) {
  const intent = view.attempt!.intent;
  const destructive = intent.operation === 'revokeMembership' || (intent.operation === 'setTenantStatus' && intent.status === 'closed');
  return (
    <section className="administration-review" aria-label={say('reviewTenantChange')}>
      <h3>{view.phase === 'review' ? say('reviewChange') : say('retainedAttempt')}</h3>
      <dl>
        <dt>{say('operation')}</dt>
        <dd>{names[intent.operation]}</dd>
        <dt>{say('tenant')}</dt>
        <dd>
          <bdi>{(view.target?.tenantId === intent.tenantId && view.target.name) || intent.tenantId}</bdi>
        </dd>
        {intent.operation === 'cloneTenant' && (
          <>
            <dt>{say('copyOf')}</dt>
            <dd>
              <bdi>{(view.target?.tenantId === intent.sourceTenantId && view.target.name) || intent.sourceTenantId}</bdi>
            </dd>
            <dt>{say('expectedSourceVersion')}</dt>
            <dd>{intent.expectedSourceVersion}</dd>
            <dt>{say('samples')}</dt>
            <dd>{intent.samples ? say('samplesIncluded') : say('configurationOnly')}</dd>
          </>
        )}
        {intent.operation === 'importTenant' && (
          <>
            <dt>{say('fromSandbox')}</dt>
            <dd>
              <bdi>{intent.sandboxTenantId}</bdi>
            </dd>
            <dt>{say('expectedSandboxVersion')}</dt>
            <dd>{intent.expectedSandboxVersion}</dd>
            {view.importPlan?.sandbox.tenantId === intent.sandboxTenantId && (
              <>
                <dt>{say('importChanges')}</dt>
                <dd>{say('importCounts', importCounts(view.importPlan.plan))}</dd>
              </>
            )}
          </>
        )}
        {intent.operation === 'setTenantAssistant' && (
          <>
            <dt>{say('assistant')}</dt>
            <dd>{intent.enabled ? say('on') : say('off')}</dd>
            {intent.consent && (
              <>
                <dt>{say('consentReference')}</dt>
                <dd>{intent.consent}</dd>
              </>
            )}
          </>
        )}
        {intent.operation === 'setTenantDecisions' && (
          <>
            <dt>{say('decisionsProvider')}</dt>
            <dd>{providerName(intent.provider)}</dd>
            <dt>{say('decisions')}</dt>
            <dd>{intent.enabled ? say('on') : say('off')}</dd>
            {intent.consent && (
              <>
                <dt>{say('consentReference')}</dt>
                <dd>{intent.consent}</dd>
              </>
            )}
          </>
        )}
        {'status' in intent && (
          <>
            <dt>{say('newStatus')}</dt>
            <dd>{intent.status}</dd>
          </>
        )}
        {'accountId' in intent && (
          <>
            <dt>{say('nativeAccountId')}</dt>
            <dd>{intent.accountId}</dd>
          </>
        )}
        {'membershipId' in intent && (
          <>
            <dt>{say('membershipId')}</dt>
            <dd>{intent.membershipId}</dd>
          </>
        )}
        {'roles' in intent && (
          <>
            <dt>{say('roles')}</dt>
            <dd>{intent.roles.map(roleName).join(', ')}</dd>
            <dt>{say('validUntil')}</dt>
            <dd>
              <Instant at={intent.validUntil} />
            </dd>
          </>
        )}
        {'expectedTenantVersion' in intent && (
          <>
            <dt>{say('expectedTenantVersion')}</dt>
            <dd>{intent.expectedTenantVersion}</dd>
          </>
        )}
        {'expectedMembershipVersion' in intent && (
          <>
            <dt>{say('expectedMembershipVersion')}</dt>
            <dd>{intent.expectedMembershipVersion}</dd>
          </>
        )}
        <dt>{say('attemptKey')}</dt>
        <dd>{view.attempt!.idempotencyKey}</dd>
      </dl>
      {destructive && (
        <p className="administration-warning">
          {intent.operation === 'revokeMembership' ? say('revocationIsPermanentForThisMembership') : say('closingATenantIsPermanent')}
        </p>
      )}
      {view.phase === 'review' && (
        <div className="administration-actions">
          <button type="button" className="ghost" onClick={() => controller.cancelReview()}>
            {say('backToEdit')}
          </button>
          <button type="button" className={destructive ? 'danger' : 'primary'} disabled={expired} onClick={() => void controller.execute()}>
            {destructive ? say('confirm') + names[intent.operation].toLowerCase() : say('applyChange')}
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

function Target({
  target,
  view,
  controller,
  expired,
}: {
  target: AdministrationTenantTarget;
  view: AdministrationView;
  controller: TenantAdministrationController;
  expired: boolean;
}) {
  const [operation, setOperation] = useState<AdministrationOperation | null>(null);
  const [member, setMember] = useState<AdministrationMembershipImage | null>(null);
  const memberOperation = operation === 'replaceMembership' || operation === 'revokeMembership';
  const choose = (next: AdministrationOperation) => {
    controller.clearOperation();
    setMember(null);
    setOperation(next);
    if (next === 'replaceMembership' || next === 'revokeMembership') void controller.loadMemberships(next);
  };
  const available = target.capabilities.filter(({ operation: op }) =>
    op === 'createTenant'
      ? !target.tenant
      : op === 'revokeMembership'
        ? !!target.tenant
        : op === 'setTenantStatus' || op === 'setTenantAssistant' || op === 'setTenantDecisions'
          ? target.tenant && target.tenant.status !== 'closed'
          : op === 'cloneTenant'
            ? target.tenant?.status === 'active' && !target.sandbox
            : op === 'importTenant'
              ? target.tenant?.status === 'active' && !!target.sandboxes?.length
              : target.tenant?.status === 'active',
  );
  return (
    <section className="administration-editor" aria-label={say('manage', { tenantId: target.name ?? target.tenantId })}>
      <h3>
        <bdi>{target.name ?? target.tenantId}</bdi>
      </h3>
      {target.tenant && <p className="note">{say('tenantVersion', { status: target.tenant.status, version: target.tenant.version })}</p>}
      {target.assistant && <p className="note">{target.assistant.enabled ? say('assistantOn') : say('assistantOff')}</p>}
      {target.decisions?.map(({ provider, enabled }) => (
        <p key={provider} className="note">
          {say(enabled ? 'decisionsOn' : 'decisionsOff', { provider: providerName(provider) })}
        </p>
      ))}
      {target.sandbox && <p className="note">{say('sandboxOf', { tenantId: target.sandbox.sourceTenantId })}</p>}
      <div className="administration-actions" aria-label={say('tenantOperations')}>
        {available.map((capability) => (
          <button
            key={capability.operation}
            type="button"
            className="ghost"
            aria-pressed={operation === capability.operation}
            disabled={expired}
            onClick={() => choose(capability.operation)}
          >
            {names[capability.operation]}
          </button>
        ))}
      </div>
      {!available.length && <p>{say('noChangesAreAvailable')}</p>}
      {memberOperation && view.memberships?.operation === operation && (
        <section aria-label={say('authorizedMemberships')}>
          <p className="note">{say('membershipsAuthorizedForOnly', { names: names[operation].toLowerCase() })}</p>
          <ul className="administration-memberships">
            {view.memberships.items.map((item) => (
              <li key={item.membershipId}>
                <button
                  type="button"
                  className="ghost"
                  aria-pressed={member?.membershipId === item.membershipId}
                  disabled={expired || item.status === 'revoked' || (operation === 'replaceMembership' && item.status !== 'active')}
                  onClick={() => setMember(item)}
                >
                  <span>{item.accountId}</span>
                  <span>
                    {item.membershipId} · {item.status} · {item.roles.map(roleName).join(', ')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {!view.memberships.items.length && <p>{say('noAuthorizedMembershipsOnThisPage')}</p>}
          <nav className="administration-paging" aria-label={say('membershipPages')}>
            <button
              type="button"
              className="ghost"
              disabled={expired || view.loading}
              onClick={() => {
                setMember(null);
                void controller.loadMemberships(operation);
              }}
            >
              {say('firstMemberships')}
            </button>
            {view.memberships.next && (
              <button
                type="button"
                className="ghost"
                disabled={expired || view.loading}
                onClick={() => {
                  setMember(null);
                  void controller.loadMemberships(operation, view.memberships!.next!);
                }}
              >
                {say('nextMemberships')}
              </button>
            )}
          </nav>
        </section>
      )}
      {operation && (!memberOperation || (member && view.memberships?.items.includes(member))) && (
        <OperationForm
          key={`${operation}:${member?.membershipId ?? ''}:${member?.version ?? ''}`}
          target={target}
          operation={operation}
          member={member}
          view={view}
          controller={controller}
          disabled={expired || view.loading}
        />
      )}
    </section>
  );
}

function OperationForm({
  target,
  operation,
  member,
  view,
  controller,
  disabled,
}: {
  target: AdministrationTenantTarget;
  operation: AdministrationOperation;
  member: AdministrationMembershipImage | null;
  view: AdministrationView;
  controller: TenantAdministrationController;
  disabled: boolean;
}) {
  const ceiling = target.capabilities.find((c) => c.operation === operation)!.roles;
  const [selectedRoles, setRoles] = useState<readonly string[]>(member?.roles ?? []);
  const [account, setAccount] = useState('');
  const [status, setStatus] = useState<'active' | 'suspended' | 'closed'>(target.tenant?.status === 'active' ? 'suspended' : 'active');
  const [until, setUntil] = useState(() =>
    localTime(member?.validUntil ?? Date.now() + Math.min(view.session!.maxMembershipLifetimeMs, 86_400_000)),
  );
  const [enabled, setEnabled] = useState(!target.assistant?.enabled);
  const [consent, setConsent] = useState('');
  const [provider, setProvider] = useState(target.decisions?.[0]?.provider ?? '');
  const [decisionOn, setDecisionOn] = useState(!target.decisions?.[0]?.enabled);
  const [sandboxId, setSandboxId] = useState(`${target.tenantId}-sandbox`.slice(0, 128));
  const [samples, setSamples] = useState(false);
  const [error, setError] = useState('');
  const read = operation === 'importTenant' ? view.importPlan : null;
  const fieldId = useId();
  const editableMembership = operation === 'grantMembership' || operation === 'replaceMembership';
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (disabled) return;
    const tenantId = target.tenantId;
    const expectedTenantVersion =
      (operation === 'replaceMembership' || operation === 'revokeMembership' ? view.memberships?.tenant : target.tenant)?.version ?? '';
    let intent: AdministrationIntent;
    switch (operation) {
      case 'createTenant':
        intent = { operation, tenantId };
        break;
      case 'setTenantStatus':
        intent = { operation, tenantId, expectedTenantVersion, status };
        break;
      case 'grantMembership':
        intent = { operation, tenantId, expectedTenantVersion, accountId: account, roles: selectedRoles, validUntil: parseLocal(until) };
        break;
      case 'replaceMembership':
        intent = {
          operation,
          tenantId,
          expectedTenantVersion,
          membershipId: member!.membershipId,
          expectedMembershipVersion: member!.version,
          roles: selectedRoles,
          validUntil: parseLocal(until),
        };
        break;
      case 'revokeMembership':
        intent = {
          operation,
          tenantId,
          expectedTenantVersion,
          membershipId: member!.membershipId,
          expectedMembershipVersion: member!.version,
        };
        break;
      case 'setTenantAssistant':
        intent = { operation, tenantId, expectedTenantVersion, enabled, consent: consent.trim() };
        break;
      case 'setTenantDecisions':
        intent = { operation, tenantId, expectedTenantVersion, provider, enabled: decisionOn, consent: consent.trim() };
        break;
      case 'cloneTenant':
        intent = {
          operation,
          tenantId: sandboxId.trim(),
          sourceTenantId: tenantId,
          expectedSourceVersion: expectedTenantVersion,
          samples,
        };
        break;
      case 'importTenant':
        if (!read) return setError(say('chooseASandbox'));
        intent = {
          operation,
          tenantId,
          expectedTenantVersion,
          sandboxTenantId: read.sandbox.tenantId,
          expectedSandboxVersion: read.sandbox.version,
        };
        break;
    }
    if (!controller.prepare(intent)) setError(say('checkTheAccountId'));
  };
  return (
    <form onSubmit={submit} className="administration-form">
      <fieldset disabled={disabled}>
        <legend>{names[operation]}</legend>
        {operation === 'grantMembership' && (
          <label className="administration-field">
            <span>{say('nativeAccountId')}</span>
            <input
              required
              value={account}
              maxLength={1024}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setAccount(event.target.value)}
            />
          </label>
        )}
        {operation === 'setTenantStatus' && (
          <fieldset className="administration-options">
            <legend>{say('newTenantStatus')}</legend>
            {(['active', 'suspended', 'closed'] as const).map((value) => (
              <label key={value}>
                <input type="radio" name="tenant-status" value={value} checked={status === value} onChange={() => setStatus(value)} />
                {value}
              </label>
            ))}
          </fieldset>
        )}
        {operation === 'setTenantAssistant' && (
          <>
            <fieldset className="administration-options">
              <legend>{say('turnTheAssistant')}</legend>
              {([true, false] as const).map((value) => (
                <label key={String(value)}>
                  <input type="radio" name="tenant-assistant" checked={enabled === value} onChange={() => setEnabled(value)} />
                  {value ? say('on') : say('off')}
                </label>
              ))}
            </fieldset>
            <label className="administration-field">
              <span>{say('consentReference')}</span>
              <input
                value={consent}
                required={enabled}
                maxLength={ASSISTANT_CONSENT_MOST}
                autoComplete="off"
                aria-invalid={consent !== '' && !consentReference(consent.trim(), enabled)}
                onChange={(event) => setConsent(event.target.value)}
              />
            </label>
            <p className="note">{say('consentReferenceHint')}</p>
            <p className="note">{say('assistantOffOnlyForDelegates')}</p>
          </>
        )}
        {operation === 'setTenantDecisions' && (
          <>
            <fieldset className="administration-options">
              <legend>{say('decisionsProvider')}</legend>
              {(target.decisions ?? []).map((entry) => (
                <label key={entry.provider}>
                  <input
                    type="radio"
                    name="tenant-decisions-provider"
                    checked={provider === entry.provider}
                    onChange={() => (setProvider(entry.provider), setDecisionOn(!entry.enabled))}
                  />
                  {providerName(entry.provider)}
                </label>
              ))}
            </fieldset>
            <fieldset className="administration-options">
              <legend>{say('turnTheDecisions')}</legend>
              {([true, false] as const).map((value) => (
                <label key={String(value)}>
                  <input type="radio" name="tenant-decisions" checked={decisionOn === value} onChange={() => setDecisionOn(value)} />
                  {value ? say('on') : say('off')}
                </label>
              ))}
            </fieldset>
            <label className="administration-field">
              <span>{say('consentReference')}</span>
              <input
                value={consent}
                required={decisionOn}
                maxLength={ASSISTANT_CONSENT_MOST}
                autoComplete="off"
                aria-invalid={consent !== '' && !consentReference(consent.trim(), decisionOn)}
                onChange={(event) => setConsent(event.target.value)}
              />
            </label>
            <p className="note">{say('decisionsConsentHint')}</p>
            <p className="note">{say('decisionsOffOnlyForDelegates')}</p>
          </>
        )}
        {operation === 'cloneTenant' && (
          <>
            <label className="administration-field">
              <span>{say('sandboxId')}</span>
              <input
                required
                value={sandboxId}
                maxLength={128}
                pattern="[a-z0-9][a-z0-9_\-]*"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setSandboxId(event.target.value)}
              />
            </label>
            <label>
              <input type="checkbox" checked={samples} onChange={(event) => setSamples(event.target.checked)} />
              {say('includeSamples')}
            </label>
            <p className="note">{say('cloneHint')}</p>
          </>
        )}
        {operation === 'importTenant' && (
          <>
            <fieldset className="administration-options">
              <legend>{say('sandboxToImport')}</legend>
              {(target.sandboxes ?? []).map((sandbox) => (
                <label key={sandbox.tenantId}>
                  <input
                    type="radio"
                    name="tenant-sandbox"
                    checked={read?.sandbox.tenantId === sandbox.tenantId}
                    onChange={() => void controller.loadImportPlan(sandbox.tenantId)}
                  />
                  <bdi>{sandbox.tenantId}</bdi>
                </label>
              ))}
            </fieldset>
            {read && <ImportPlanView plan={read.plan} />}
          </>
        )}
        {editableMembership && (
          <>
            <fieldset className="administration-options">
              <legend>{say('rolesForThisOperation')}</legend>
              {ceiling.map((role) => (
                <label key={role}>
                  <input
                    type="checkbox"
                    checked={selectedRoles.includes(role)}
                    onChange={(event) =>
                      setRoles(event.target.checked ? [...selectedRoles, role] : selectedRoles.filter((r) => r !== role))
                    }
                  />
                  {roleName(role)}
                </label>
              ))}
            </fieldset>
            {/* A local wall time, read by Date.parse in the browser's zone, so the calendar's today is the browser's too. */}
            <label className="administration-field">
              <span>{say('validUntilLocalTime')}</span>
              <DateField
                id={`${fieldId}-until`}
                withTime
                required
                value={until}
                aria-label={say('validUntilLocalTime')}
                max={localTime(Date.now() + view.session!.maxMembershipLifetimeMs)}
                onChange={setUntil}
              />
            </label>
          </>
        )}
        {member && (
          <p className="note">
            {say('accountMembershipVersion', { accountId: member.accountId, membershipId: member.membershipId, version: member.version })}
          </p>
        )}
        <button type="submit" className="primary" disabled={operation === 'importTenant' && (!read || read.plan.conflicts.length > 0)}>
          {say('reviewChange')}
        </button>
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

const importCounts = (plan: AdministrationImportPlan) => ({
  inserted: formatNumber(plan.inserted),
  updated: formatNumber(plan.updated),
  deleted: formatNumber(plan.deleted),
});
const conflictWords = (reason: AdministrationImportPlan['conflicts'][number]['reason']) =>
  reason === 'changed'
    ? say('conflictChanged')
    : reason === 'removed'
      ? say('conflictRemoved')
      : reason === 'taken'
        ? say('conflictTaken')
        : say('conflictReference');

/* What an import would do, read before it is asked for: the counts, and each
   row that conflicts. Any conflict means nothing is applied, so the review is
   not offered until the sandbox or the live tenant is set right. */
function ImportPlanView({ plan }: { plan: AdministrationImportPlan }) {
  return (
    <section className="administration-import" aria-label={say('importChanges')}>
      <p className="note">{say('importCounts', importCounts(plan))}</p>
      {plan.conflicts.length > 0 && (
        <>
          <p className="administration-warning">
            {plan.truncated
              ? say('importConflictsMore', { count: formatNumber(plan.conflicts.length) })
              : say('importConflicts', { count: formatNumber(plan.conflicts.length) })}
          </p>
          <ul className="administration-conflicts">
            {plan.conflicts.map((conflict) => (
              <li key={`${conflict.resource}\n${conflict.key}`}>
                <bdi>{conflict.resource}</bdi> · <code>{conflict.key}</code> · {conflictWords(conflict.reason)}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/* A CSV cell that cannot be read as a formula when the file is opened in a spreadsheet. */
const cell = (value: string) =>
  /[",\n\r]/.test(value) || /^[=+\-@\t]/.test(value) ? `"${value.replace(/^([=+\-@\t])/, "'$1").replace(/"/g, '""')}"` : value;
function saveCsv(name: string, csv: string) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

/* What the assistant cost each tenant, by day or by month, and the same as a CSV for the bill. Months are summed here
   from the days the server counted (UTC days, so a month is the UTC month). */
function Usage({ view, disabled, onRefresh }: { view: AdministrationView; disabled: boolean; onRefresh: () => void }) {
  const [by, setBy] = useState<'day' | 'month'>('day');
  const rows = view.usage?.rows ?? [];
  const named = (tenantId: string) => view.page?.items.find((item) => item.tenantId === tenantId)?.name ?? tenantId;
  const totals = new Map<string, AdministrationUsageRow>();
  for (const row of rows) {
    const period = by === 'day' ? row.day : row.day.slice(0, 7);
    const key = `${period}\n${row.tenantId}`;
    const was = totals.get(key);
    totals.set(key, { tenantId: row.tenantId, day: period, tokens: (was?.tokens ?? 0) + row.tokens });
  }
  const shown = [...totals.values()];
  const download = () => {
    const csv = [
      ['tenant_id', 'tenant', by, 'tokens'].join(','),
      ...shown.map((row) => [cell(row.tenantId), cell(named(row.tenantId)), row.day, String(row.tokens)].join(',')),
    ].join('\r\n');
    saveCsv(`assistant-usage-by-${by}.csv`, csv);
  };
  return (
    <section className="administration-usage" aria-label={say('assistantUsage')}>
      <div className="administration-actions">
        {(['day', 'month'] as const).map((each) => (
          <button key={each} type="button" className="ghost" aria-pressed={by === each} onClick={() => setBy(each)}>
            {each === 'day' ? say('byDay') : say('byMonth')}
          </button>
        ))}
        <button type="button" className="ghost" disabled={disabled} onClick={onRefresh}>
          {say('refreshUsage')}
        </button>
        <button type="button" className="ghost" disabled={disabled || !shown.length} onClick={download}>
          {say('downloadCsv')}
        </button>
      </div>
      {view.usage && !shown.length && <p>{say('noAssistantUsageYet')}</p>}
      {view.usage?.truncated && <p className="note">{say('usageTruncated', { count: String(rows.length) })}</p>}
      {shown.length > 0 && (
        <table className="administration-usage-table">
          <thead>
            <tr>
              <th scope="col">{by === 'day' ? say('day') : say('month')}</th>
              <th scope="col">{say('tenant')}</th>
              <th scope="col">{say('tokens')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={`${row.day}\n${row.tenantId}`}>
                <td>{row.day}</td>
                <td>
                  <bdi>{named(row.tenantId)}</bdi>
                </td>
                <td>{formatNumber(row.tokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/* What the decisions cost each tenant: calls, units and cost, by day or by month, and the same as a CSV for the bill.
   Months are summed here from the UTC days the server counted, as the assistant's are. */
function DecisionUsage({ view, disabled, onRefresh }: { view: AdministrationView; disabled: boolean; onRefresh: () => void }) {
  const [by, setBy] = useState<'day' | 'month'>('day');
  const rows = view.decisionUsage?.rows ?? [];
  const named = (tenantId: string) => view.page?.items.find((item) => item.tenantId === tenantId)?.name ?? tenantId;
  const totals = new Map<string, AdministrationDecisionUsageRow>();
  for (const row of rows) {
    const period = by === 'day' ? row.day : row.day.slice(0, 7);
    const key = `${period}\n${row.tenantId}`;
    const was = totals.get(key);
    totals.set(key, {
      tenantId: row.tenantId,
      day: period,
      calls: (was?.calls ?? 0) + row.calls,
      units: (was?.units ?? 0) + row.units,
      costMicros: (was?.costMicros ?? 0) + row.costMicros,
    });
  }
  const shown = [...totals.values()];
  // Dollars from millionths, to the cent at least and to the ten-thousandth where a call cost less.
  const dollars = (micros: number) => formatMoney(micros / 1e6, 'USD', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  const download = () => {
    const csv = [
      ['tenant_id', 'tenant', by, 'calls', 'units', 'cost_usd'].join(','),
      ...shown.map((row) =>
        [cell(row.tenantId), cell(named(row.tenantId)), row.day, String(row.calls), String(row.units), String(row.costMicros / 1e6)].join(
          ',',
        ),
      ),
    ].join('\r\n');
    saveCsv(`decision-usage-by-${by}.csv`, csv);
  };
  return (
    <section className="administration-usage" aria-label={say('decisionUsage')}>
      <div className="administration-actions">
        {(['day', 'month'] as const).map((each) => (
          <button key={each} type="button" className="ghost" aria-pressed={by === each} onClick={() => setBy(each)}>
            {each === 'day' ? say('byDay') : say('byMonth')}
          </button>
        ))}
        <button type="button" className="ghost" disabled={disabled} onClick={onRefresh}>
          {say('refreshUsage')}
        </button>
        <button type="button" className="ghost" disabled={disabled || !shown.length} onClick={download}>
          {say('downloadCsv')}
        </button>
      </div>
      {view.decisionUsage && !shown.length && <p>{say('noDecisionUsageYet')}</p>}
      {view.decisionUsage?.truncated && <p className="note">{say('usageTruncated', { count: String(rows.length) })}</p>}
      {shown.length > 0 && (
        <table className="administration-usage-table">
          <thead>
            <tr>
              <th scope="col">{by === 'day' ? say('day') : say('month')}</th>
              <th scope="col">{say('tenant')}</th>
              <th scope="col">{say('calls')}</th>
              <th scope="col">{say('units')}</th>
              <th scope="col">{say('cost')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={`${row.day}\n${row.tenantId}`}>
                <td>{row.day}</td>
                <td>
                  <bdi>{named(row.tenantId)}</bdi>
                </td>
                <td>{formatNumber(row.calls)}</td>
                <td>{formatNumber(row.units)}</td>
                <td>{dollars(row.costMicros)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
