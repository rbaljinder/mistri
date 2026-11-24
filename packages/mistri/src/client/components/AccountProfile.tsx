import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { PROFILE_NAME_LIMIT, profileName, type AccountProfile as Profile } from '../../shared/accountProfile.js';
import { AccountProfileError, loadAccountProfile, requestEmailChange, saveAccountProfile } from '../accountProfile.js';
import { sessionIdentity, subscribeSessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { Modal } from '@mistriwork/ui/Modal.js';
import { Button } from '@mistriwork/ui/Button.js';
import { Field } from '@mistriwork/ui/Field.js';
import { ConnectedClients } from './ConnectedClients.js';
import './AccountProfile.css';
import { say } from '../copy/account/components/AccountProfile.js';

const PROVIDERS: Record<string, string> = { email: say('emailAndPassword'), github: 'GitHub', google: say('google') };

/** A session-owned dialog; a profile save never changes authentication identity,
 * grants, account ownership, or another session's UI. */
export function AccountProfile({
  onClose,
  title = say('yourProfile'),
  embedded = false,
  focus = !embedded,
}: {
  onClose: () => void;
  title?: string;
  /** Drawn in a page (the settings room) and not as a dialog: no head, no Close, nothing round it. */
  embedded?: boolean;
  /** Whether the name takes the focus once the profile has loaded: a dialog's does, a page's only when opened at it. */
  focus?: boolean;
}) {
  const owner = useRef(sessionIdentity()).current;
  const identity = useSyncExternalStore(subscribeSessionIdentity, sessionIdentity);
  const alive = useRef(true),
    pending = useRef(false),
    input = useRef<HTMLInputElement>(null);
  const [data, setData] = useState<Profile | null>(null);
  const [name, setName] = useState('');
  const [phase, setPhase] = useState<'loading' | 'idle' | 'saving' | 'unknown' | 'checking' | 'failed'>('loading');
  const [message, setMessage] = useState('');
  // What is wrong with the typed name, said beside it rather than in the dialog's status.
  const [problem, setProblem] = useState('');
  /* Changing the address: a link goes to the new one, so the form is here only where the App sends mail. */
  const [newEmail, setNewEmail] = useState('');
  const [emailPhase, setEmailPhase] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const [emailMessage, setEmailMessage] = useState('');
  const current = () => alive.current && sessionIdentity() === owner && owner.mode === 'authenticated';
  const load = async (recovery = false) => {
    if (pending.current || !current()) return;
    pending.current = true;
    setPhase(recovery ? 'checking' : 'loading');
    setMessage('');
    try {
      const result = await loadAccountProfile(owner);
      if (!current()) return;
      setData(result);
      setName(result.name);
      setPhase('idle');
      if (recovery) setMessage(say('currentProfileLoadedReview'));
    } catch (error) {
      if (!current()) return;
      setPhase(recovery ? 'unknown' : 'failed');
      setMessage(error instanceof Error ? error.message : say('yourProfileCouldNotBe'));
    } finally {
      pending.current = false;
    }
  };
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!data) return;
    // A menu item opened this dialog: finish the menu's focus restoration
    // before handing focus to the asynchronously loaded editable field.
    const frame = requestAnimationFrame(() => {
      if (focus && current()) input.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [data]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending.current || !current() || phase !== 'idle' || !data) return;
    const captured = profileName(name);
    if (captured === undefined) {
      setProblem(say('enterANameBetween'));
      input.current?.focus();
      return;
    }
    setProblem('');
    if (captured === data.name) return;
    pending.current = true;
    setPhase('saving');
    setMessage('');
    try {
      const result = await saveAccountProfile(owner, captured);
      if (!current()) return;
      setData(result);
      setName(result.name);
      setPhase('idle');
      setMessage(say('nameSaved'));
    } catch (error) {
      if (!current()) return;
      setPhase(error instanceof AccountProfileError && error.outcome === 'not_applied' ? 'idle' : 'unknown');
      setMessage(error instanceof Error ? error.message : say('theProfileSaveCouldNotBeConfirmed'));
    } finally {
      pending.current = false;
    }
  };
  const changeEmail = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (emailPhase === 'sending' || !current()) return;
    setEmailPhase('sending');
    setEmailMessage('');
    try {
      await requestEmailChange(owner, newEmail);
      if (!current()) return;
      setEmailPhase('sent');
      setEmailMessage(say('checkYourInboxFor', { email: newEmail.trim() }));
      setNewEmail('');
    } catch (error) {
      if (!current()) return;
      setEmailPhase('failed');
      setEmailMessage(error instanceof Error ? error.message : say('theEmailChangeCouldNotBeRequested'));
    }
  };
  if (identity !== owner || owner.mode !== 'authenticated') return null;
  const uncertain = phase === 'unknown' || phase === 'checking';
  const body = (
    <>
      {phase === 'loading' && <p role="status">{say('loadingProfile')}</p>}
      {data && (
        <form onSubmit={(event) => void submit(event)} noValidate>
          <Field label={say('common.name')} className="account-profile-field" problem={problem}>
            <input
              ref={input}
              name="name"
              data-slot="input"
              autoComplete="name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (problem) setProblem('');
              }}
              maxLength={PROFILE_NAME_LIMIT}
              required
              disabled={phase !== 'idle'}
            />
          </Field>
          <Field label={say('common.email')} className="account-profile-field">
            <input data-slot="input" value={data.email} readOnly autoComplete="email" />
          </Field>
          <div className="account-profile-field">
            <span>{say('signInMethods')}</span>
            <p>
              {data.providers.map((provider) => (Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider] : provider)).join(', ') ||
                say('managedAccount')}
            </p>
          </div>
          <footer className="form-actions">
            {!embedded && (
              <Button variant="secondary" onClick={onClose} disabled={phase === 'saving'}>
                {say('common.close')}
              </Button>
            )}
            {/* Nothing to save yet: a quiet key, not a greyed primary that reads as a fault. It fills once the name differs. */}
            <Button
              variant={profileName(name) === data.name ? 'secondary' : 'primary'}
              type="submit"
              loading={phase === 'saving'}
              loadingLabel={say('common.saving')}
              disabled={(phase !== 'idle' && phase !== 'saving') || profileName(name) === data.name}
            >
              {say('saveName')}
            </Button>
          </footer>
        </form>
      )}
      {data?.emailChange && (
        <form className="account-profile-email" onSubmit={(event) => void changeEmail(event)} noValidate>
          <Field label={say('changeEmail')} className="account-profile-field">
            <input
              name="newEmail"
              type="email"
              data-slot="input"
              autoComplete="email"
              value={newEmail}
              placeholder={say('newEmailAddress')}
              onChange={(event) => {
                setNewEmail(event.target.value);
                if (emailPhase !== 'sending') setEmailPhase('idle');
              }}
              required
              disabled={emailPhase === 'sending'}
            />
          </Field>
          <p className="note">{say('weSendALinkToTheNewAddress')}</p>
          <footer className="form-actions">
            <Button
              variant="secondary"
              type="submit"
              loading={emailPhase === 'sending'}
              loadingLabel={say('sending')}
              disabled={!newEmail.trim() || emailPhase === 'sending'}
            >
              {say('sendLink')}
            </Button>
          </footer>
          {emailMessage && <p role={emailPhase === 'failed' ? 'alert' : 'status'}>{emailMessage}</p>}
        </form>
      )}
      {data?.connectedClients && <ConnectedClients />}
      {message && <p role={uncertain || phase === 'failed' ? 'alert' : 'status'}>{message}</p>}
      {(uncertain || phase === 'failed') && (
        <Button
          variant="secondary"
          loading={phase === 'checking'}
          loadingLabel={say('common.checking')}
          onClick={() => void load(uncertain)}
        >
          {say('checkCurrentProfile')}
        </Button>
      )}
    </>
  );
  if (embedded) return <div className="account-profile account-profile-embedded">{body}</div>;
  return (
    <Modal className="account-profile" ariaLabel={title} onClose={onClose} closeDisabled={phase === 'saving'} initialFocus={input}>
      <header>
        <h2>{title}</h2>
        <Button variant="ghost" onClick={onClose} disabled={phase === 'saving'} ariaLabel={say('closeProfile')}>
          ×
        </Button>
      </header>
      <p className="note">{say('yourNameIsEditable')}</p>
      {body}
    </Modal>
  );
}
