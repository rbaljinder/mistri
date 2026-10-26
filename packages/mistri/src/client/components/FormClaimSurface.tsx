/**
 * The account screen a saved form's done screen leads to
 * (`/{app}/form/{key}/claim`): "Add application APP-… to this account?"
 *
 * The claim the submit left in this browser is spent here and nowhere else —
 * never by a sign-in on its own, because the next person at a shared
 * computer must not inherit it (server/forms/formLink.ts). Signed out, the
 * page is the App's sign-in (or its sign-up, from "Create an account"), and
 * comes back here once there is a session. Yes adds it; No burns the claim.
 */
import { useEffect, useId, useState } from 'react';
import { Button } from '@mistriwork/ui/Button.js';
import { answerClaim, readClaim, type SavedFormFailure } from './savedFormApi.js';
import './FormSurface.css';
import { say } from '../copy/public/components/FormClaimSurface.js';

type Phase =
  | { kind: 'asking' }
  | { kind: 'question'; reference: string }
  | { kind: 'none' }
  | { kind: 'added'; reference: string }
  | { kind: 'declined' };

export function FormClaimSurface({
  form,
  appName,
  statusHref,
  onSignIn,
}: {
  form: { id: string; label: string };
  appName: string;
  /** The form's status check page, when it has one: where an added application is followed. */
  statusHref?: string;
  /** Nobody is signed in: draw the App's sign-in here instead. */
  onSignIn: () => void;
}) {
  const id = useId();
  const [phase, setPhase] = useState<Phase>({ kind: 'asking' });
  const [failure, setFailure] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let live = true;
    readClaim(form.id).then(
      (found) => {
        if (!live) return;
        if (!found.signedIn) {
          onSignIn();
          return;
        }
        setPhase(found.reference ? { kind: 'question', reference: found.reference } : { kind: 'none' });
      },
      (error) => {
        if (live) {
          setFailure((error as Error).message);
          setPhase({ kind: 'none' });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [form.id, onSignIn]);

  const answer = async (said: 'yes' | 'no') => {
    if (pending || phase.kind !== 'question') return;
    setPending(true);
    setFailure('');
    try {
      const reference = await answerClaim(form.id, said);
      setPhase(said === 'yes' ? { kind: 'added', reference: reference ?? phase.reference } : { kind: 'declined' });
    } catch (error) {
      setFailure((error as SavedFormFailure).message);
      setPhase({ kind: 'none' });
    } finally {
      setPending(false);
    }
  };

  const title =
    phase.kind === 'added'
      ? say('addedToYourAccountTitle')
      : phase.kind === 'declined'
        ? say('notAdded')
        : phase.kind === 'question'
          ? say('addItToYourAccount')
          : phase.kind === 'none'
            ? say('nothingToAdd')
            : form.label;
  return (
    <section className="form-page form-page-done" aria-labelledby={`${id}-title`}>
      <p className="eyebrow">{appName}</p>
      <h1
        id={`${id}-title`}
        tabIndex={-1}
        ref={(node) => {
          if (phase.kind !== 'asking') node?.focus();
        }}
      >
        {title}
      </h1>
      {phase.kind === 'asking' && (
        <p className="form-page-description" role="status">
          {say('lookingForTheApplication')}
        </p>
      )}
      {phase.kind === 'question' && (
        <>
          <p className="form-page-done-message">
            {say('addApplication')} <strong>{phase.reference}</strong> {say('toTheAccountYouAreSigned')}
          </p>
          <div className="form-claim-actions">
            <Button intent="primary" onClick={() => void answer('yes')} busy={pending}>
              {say('yesAdd')}
            </Button>
            <Button intent="secondary" onClick={() => void answer('no')} disabled={pending}>
              {say('common.no')}
            </Button>
          </div>
        </>
      )}
      {phase.kind === 'added' && (
        <p className="form-page-done-message" role="status">
          {say('isInYourAccount', { reference: phase.reference })}
          {statusHref && (
            <>
              {' '}
              <a href={statusHref}>{say('seeItsStatus')}</a>.
            </>
          )}
        </p>
      )}
      {phase.kind === 'declined' && (
        <p className="form-page-done-message" role="status">
          {say('itWasNotAdded')}
        </p>
      )}
      {phase.kind === 'none' && !failure && <p className="form-page-done-message">{say('thereIsNoApplication')}</p>}
      <p className="form-page-failure" role="alert" aria-live="assertive" hidden={!failure}>
        {failure}
      </p>
    </section>
  );
}
