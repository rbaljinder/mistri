/**
 * The signed-out half of an account-creating invitation: the token the
 * inviter handed over, a name, and a password typed twice. Drawn in the
 * sign-in card, in its fields and words, because the person is joining the
 * App, not operating the tool. Secrets never outlive a submission: both
 * passwords are cleared whatever the answer, and the token once it is spent.
 */
import { useRef, useState, type FormEvent } from 'react';
import { claimInvitation, type ClaimOutcome } from '../invitationClaim.js';
import { parseInvitationTokenId } from '../tenantInvitations.js';
import { Button } from '@mistriwork/ui/Button.js';
import { Field as FormField } from '@mistriwork/ui/Field.js';
import { say } from '../copy/public/components/ClaimInvitation.js';

type Field = 'token' | 'name' | 'password' | 'confirm';
const SAID: Record<Exclude<ClaimOutcome['kind'], 'claimed' | 'limited'>, string> = {
  invalid: say('enterANameOf1'),
  refused: say('thisInvitationTokenCannot'),
  existing: say('anAccountAlreadyUses'),
  incomplete: say('yourAccountWasCreated'),
  unknown: say('theRequestCouldNotBeConfirmed'),
};

export function ClaimInvitation({
  appId,
  onClaimed,
  onCancel,
}: {
  appId: string;
  onClaimed: (email: string) => void;
  onCancel: () => void;
}) {
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [problem, setProblem] = useState<{ field?: Field; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fields = {
    token: useRef<HTMLInputElement>(null),
    name: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
    confirm: useRef<HTMLInputElement>(null),
  };
  const stop = (text: string, field?: Field) => {
    setProblem({ text, ...(field ? { field } : {}) });
    if (field) fields[field].current?.focus();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (!parseInvitationTokenId(token.trim())) return stop(say('enterTheInvitationToken'), 'token');
    if (!name.trim()) return stop(say('enterYourName'), 'name');
    if (password.length < 8 || password.length > 128) return stop(say('chooseAPasswordOf8'), 'password');
    if (password !== confirm) return stop(say('common.thePasswordsDoNotMatch'), 'confirm');
    setBusy(true);
    setProblem(null);
    const sent = { token: token.trim(), name: name.trim(), password };
    setPassword('');
    setConfirm('');
    const outcome = await claimInvitation(appId, sent);
    setBusy(false);
    if (outcome.kind === 'claimed') {
      setToken('');
      onClaimed(outcome.email);
      return;
    }
    if (outcome.kind === 'limited') return stop(say('tooManyAttemptsTry', { retryAfter: outcome.retryAfter }));
    if (outcome.kind === 'existing' || outcome.kind === 'incomplete') setToken('');
    stop(SAID[outcome.kind], outcome.kind === 'invalid' ? 'name' : outcome.kind === 'refused' ? 'token' : undefined);
  };
  /* A problem about one field is said beside it (components/Field.tsx); the
     form's alert says only what belongs to no one field. */
  const said = (field: Field) => (problem?.field === field ? problem.text : undefined);

  return (
    <form className="signin-form" onSubmit={(event) => void submit(event)} aria-describedby="claim-note" noValidate>
      <p id="claim-note" className="note">
        {say('pasteTheOneTime')}
      </p>
      <FormField label={say('invitationToken')} required problem={said('token')}>
        <input
          ref={fields.token}
          type="password"
          name="token"
          className="field-control signin-input"
          autoComplete="off"
          spellCheck={false}
          required
          maxLength={85}
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
      </FormField>
      <FormField label={say('common.name')} required problem={said('name')}>
        <input
          ref={fields.name}
          type="text"
          name="name"
          className="field-control signin-input"
          autoComplete="name"
          required
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </FormField>
      <FormField label={say('common.password')} required problem={said('password')} hint={say('n8To128Characters')}>
        <input
          ref={fields.password}
          type="password"
          name="password"
          className="field-control signin-input"
          autoComplete="new-password"
          required
          minLength={8}
          maxLength={128}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </FormField>
      <FormField label={say('confirmPassword')} required problem={said('confirm')}>
        <input
          ref={fields.confirm}
          type="password"
          name="confirm"
          className="field-control signin-input"
          autoComplete="new-password"
          required
          minLength={8}
          maxLength={128}
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
      </FormField>
      {/* Busy, not disabled, as on the sign-in form: a disabled button drops its focus. */}
      <Button intent="primary" size="large" block type="submit" className="signin-submit" busy={busy}>
        {say('createAccountAndJoin')}
      </Button>
      <p className="signin-problem" role="alert" hidden={!problem || Boolean(problem.field)}>
        {problem && !problem.field ? problem.text : ''}
      </p>
      <Button intent="quiet" className="signin-flip" onClick={onCancel}>
        {say('common.backToSign')}
      </Button>
    </form>
  );
}
