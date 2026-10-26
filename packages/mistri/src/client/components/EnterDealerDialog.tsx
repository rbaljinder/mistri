import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { SUPPORT_REASON_MAX_BYTES, type SupportStatusReply } from '../../shared/tenantSupport.js';
import { Modal } from '@mistriwork/ui/Modal.js';
import './TenantSupport.css';
import { say } from '../copy/tenancy/components/EnterDealerDialog.js';
import { roleName } from '../tenantNames.js';
import { tenancyNoun } from '../tenancyNoun.js';

export interface EnterDealerInput {
  tenantId: string;
  dealerRole: string;
  reason: string;
  password?: string;
}
export interface EnterDealerDialogProps {
  /** What this login may open, from the server; null while it is being asked. */
  status: SupportStatusReply | null;
  busy?: boolean;
  error?: string;
  /** A submitted attempt whose outcome is unknown: it is checked, never resent as new. */
  unconfirmed?: boolean;
  onSubmit: (input: EnterDealerInput) => void;
  onCheck?: () => void;
  /** A login an identity provider opened: confirm it there, afresh (the page leaves for the provider). */
  onReauthenticate?: (provider: string) => void;
  onClose: () => void;
  /** What the App calls a tenant (`auth.tenancy.label`, "Customer"); "tenant" where it names none. */
  tenantLabel?: string;
}
type Problem = 'dealer' | 'role' | 'reason' | 'password';
const bytes = (text: string) => new TextEncoder().encode(text).length;

/** Presentation and local validation only: the server decides every grant,
 * the five-minute sign-in and the session's end. A click never pretends a
 * session opened. */
export function EnterDealerDialog({
  status,
  busy = false,
  error,
  unconfirmed = false,
  onSubmit,
  onCheck,
  onReauthenticate,
  onClose,
  tenantLabel,
}: EnterDealerDialogProps) {
  const noun = tenancyNoun(tenantLabel, say('tenant'));
  const words = { name: noun.name, names: noun.names };
  const title = say(noun.vowel ? 'enterATenantVowel' : 'enterATenant', words);
  const heading = useId(),
    reasonHelp = useId();
  const [tenantId, setTenant] = useState<string>();
  const [dealerRole, setRole] = useState<string>();
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<Problem>();
  const refs = {
    dealer: useRef<HTMLInputElement>(null),
    role: useRef<HTMLInputElement>(null),
    reason: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
  };
  const choices = status?.choices ?? [];
  const chosen = choices.find((choice) => choice.tenantId === tenantId);
  const roles = chosen?.roles ?? [];
  const signIn = status?.signInRequired === true,
    password_ = status?.passwordSignIn === true;
  const locked = busy || unconfirmed,
    blocked = !choices.length || (signIn && !password_);
  // A step that will not go on sends the focus to the field to fix.
  useEffect(() => {
    if (problem) refs[problem].current?.focus();
  }, [problem]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (locked || blocked) return;
    const text = reason.trim();
    const found: Problem | undefined = !tenantId
      ? 'dealer'
      : !dealerRole || !roles.includes(dealerRole)
        ? 'role'
        : !text || /\p{Cc}/u.test(text) || bytes(text) > SUPPORT_REASON_MAX_BYTES
          ? 'reason'
          : signIn && !password
            ? 'password'
            : undefined;
    setProblem(found);
    if (found) return;
    onSubmit({ tenantId: tenantId!, dealerRole: dealerRole!, reason: text, ...(signIn ? { password } : {}) });
  };
  return (
    <Modal className="enter-dealer" aria-label={title} fullscreen="mobile" closeDisabled={busy} onClose={onClose}>
      <form onSubmit={submit} noValidate aria-labelledby={heading}>
        <h2 id={heading}>{title}</h2>
        <p className="note">{say('youSeeTheTenants', words)}</p>
        {status === null && <p role="status">{say('checkingWhichTenantsYouMay', words)}</p>}
        {status !== null && !choices.length && <p>{say('noTenantIsOpen', words)}</p>}
        {choices.length > 0 && (
          <fieldset aria-invalid={problem === 'dealer' || undefined}>
            <legend>{noun.Name}</legend>
            <div className="enter-dealer-list">
              {choices.map((choice, index) => (
                <label key={choice.tenantId}>
                  <input
                    ref={index === 0 ? refs.dealer : undefined}
                    type="radio"
                    name="support-dealer"
                    value={choice.tenantId}
                    checked={tenantId === choice.tenantId}
                    disabled={locked}
                    onChange={() => {
                      setTenant(choice.tenantId);
                      setRole(choice.roles.length === 1 ? choice.roles[0] : undefined);
                    }}
                  />
                  <bdi>{choice.name ?? choice.tenantId}</bdi>
                </label>
              ))}
            </div>
            {problem === 'dealer' && (
              <p className="enter-dealer-problem" role="alert">
                {say('chooseATenantProblem', words)}
              </p>
            )}
          </fieldset>
        )}
        {tenantId && (
          <fieldset aria-invalid={problem === 'role' || undefined}>
            <legend>
              {say('role')} <bdi>{chosen?.name ?? tenantId}</bdi>
            </legend>
            {roles.map((role, index) => (
              <label key={role}>
                <input
                  ref={index === 0 ? refs.role : undefined}
                  type="radio"
                  name="support-role"
                  value={role}
                  checked={dealerRole === role}
                  disabled={locked}
                  onChange={() => setRole(role)}
                />
                <bdi>{roleName(role)}</bdi>
              </label>
            ))}
            {problem === 'role' && (
              <p className="enter-dealer-problem" role="alert">
                {say('chooseTheRoleToEnter')}
              </p>
            )}
          </fieldset>
        )}
        <label className="enter-dealer-field">
          <span>{say('reason')}</span>
          <input
            ref={refs.reason}
            type="text"
            value={reason}
            disabled={locked}
            aria-required="true"
            aria-invalid={problem === 'reason' || undefined}
            aria-describedby={reasonHelp}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <p id={reasonHelp} className="note">
          {problem === 'reason' ? (
            <span className="enter-dealer-problem" role="alert">
              {say('giveAReasonOfOne', { max: SUPPORT_REASON_MAX_BYTES })}
            </span>
          ) : (
            say('oneLineKeptInTheSupport')
          )}
        </p>
        {signIn && (
          <section className="enter-dealer-sign-in" aria-label={say('confirmItIsYou')}>
            <p className="note">{say('enteringATenantNeeds')}</p>
            {password_ ? (
              <label className="enter-dealer-field">
                <span>{say('common.password')}</span>
                <input
                  ref={refs.password}
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  disabled={locked}
                  aria-required="true"
                  aria-invalid={problem === 'password' || undefined}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            ) : status?.reauthenticate ? (
              <>
                <p className="note">{say('yourProviderAsksAgain', words)}</p>
                <button
                  type="button"
                  className="ghost"
                  aria-disabled={locked}
                  onClick={() => {
                    if (!locked) onReauthenticate?.(status.reauthenticate!);
                  }}
                >
                  {say('confirmAtYourProvider')}
                </button>
              </>
            ) : (
              <p className="note">{say('signOutAndSign', words)}</p>
            )}
            {problem === 'password' && (
              <p className="enter-dealer-problem" role="alert">
                {say('enterYourPasswordToSign')}
              </p>
            )}
          </section>
        )}
        {error && <p role="alert">{error}</p>}
        {unconfirmed && (
          <div>
            <p role="status">{say('theLastAttemptsResult')}</p>
            <button
              type="button"
              className="ghost"
              aria-disabled={busy}
              onClick={() => {
                if (!busy) onCheck?.();
              }}
            >
              {say('checkTheAttempt')}
            </button>
          </div>
        )}
        <footer>
          <button
            type="button"
            className="ghost"
            aria-disabled={busy}
            onClick={() => {
              if (!busy) onClose();
            }}
          >
            {say('common.cancel')}
          </button>
          <button type="submit" aria-disabled={locked || blocked}>
            {say('enterTenant', words)}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
