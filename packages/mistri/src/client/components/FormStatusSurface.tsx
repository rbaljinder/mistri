/**
 * A saved form's status check, as a page of its own (`/{app}/form/{key}/status`):
 * the receipt and the details that confirm it, and the state it answers.
 *
 * The server answers every wrong detail with one sentence in one time
 * (server/forms/statusCheck.ts); the page keeps it that way. It never says
 * which detail was wrong — no field turns red for a refusal, nothing typed
 * is cleared or kept selectively, and the only per-field word is "enter it"
 * for one left blank, which knows nothing of the application. What it shows
 * back is the state, never an input: the details stay in the fields they
 * were typed in, and in this page's memory while an "Add to my account"
 * may need them again.
 *
 * Signed in, a form that allows it adds the application to the account
 * (formLinkHttp.ts), and the account's own applications are listed above.
 * Where the form links by email, the applications that captured the
 * account's verified address are offered — each added only by its own Yes.
 * A step-up (statusStepUp.ts) opens more than the state: a code to the email
 * on the application, then the details the form declares.
 */
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Button } from '@mistriwork/ui/Button.js';
import { Field } from '@mistriwork/ui/Field.js';
import type { FormPresentation } from './FormSurface.js';
import {
  addByStatus,
  askStepUpCode,
  checkStatus,
  claimFound,
  foundByEmail,
  myApplications,
  openStepUp,
  type ApplicationStatus,
  type SavedFormFailure,
} from './savedFormApi.js';
import './FormSurface.css';
import { say } from '../copy/public/components/FormStatusSurface.js';

/** A form with a status check: the details it asks, and whether a signed-in check may add the application to the account. */
export type StatusFormPresentation = FormPresentation & {
  save: {
    statusCheck: { confirm: Array<{ name: string; label: string }>; stepUp?: true };
    link?: { sameDevice?: true; statusCheck?: true; email?: { prove?: string } };
  };
};

const RECEIPT = 'receipt';
const said = (name: string) => name.replace(/_/g, ' ').replace(/^./, (first) => first.toUpperCase());

/** The state, as the check answered it: each shown column in the author's words. */
function Status({ status }: { status: ApplicationStatus }) {
  return (
    <dl className="form-status">
      {Object.entries(status).map(([name, words]) => (
        <div key={name}>
          <dt>{said(name)}</dt>
          <dd>{words ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/** More than the state: a code to the email on the application, then the details the form declares. */
function StepUp({ form, details }: { form: string; details: () => { receipt: string; confirm: Record<string, string> } }) {
  const id = useId();
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [shown, setShown] = useState<ApplicationStatus | null>(null);
  const [failure, setFailure] = useState('');
  const [pending, setPending] = useState(false);
  const run = async (work: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    setFailure('');
    try {
      await work();
    } catch (error) {
      setFailure((error as SavedFormFailure).message);
    } finally {
      setPending(false);
    }
  };
  const ask = () =>
    run(async () => {
      await askStepUpCode(form, details());
      setSent(true);
      setCode('');
    });
  const open = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      setShown((await openStepUp(form, details(), code.trim())).details);
    });
  };
  return (
    <section aria-labelledby={`${id}-more`} className="form-status-more">
      <h2 id={`${id}-more`}>{say('moreDetails')}</h2>
      {shown ? (
        <Status status={shown} />
      ) : !sent ? (
        <>
          <p className="form-page-done-message">{say('weCanEmailACode')}</p>
          <div>
            <Button intent="secondary" onClick={() => void ask()} busy={pending}>
              {say('emailMeACode')}
            </Button>
          </div>
        </>
      ) : (
        <form noValidate onSubmit={open} className="command-fields">
          <Field label={say('codeFromTheEmail')} required>
            <input
              className="field-control"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.currentTarget.value)}
            />
          </Field>
          <div className="form-claim-actions">
            <Button intent="primary" type="submit" busy={pending}>
              {say('showDetails')}
            </Button>
            <Button intent="quiet" size="compact" onClick={() => void ask()}>
              {say('sendAnotherCode')}
            </Button>
          </div>
        </form>
      )}
      <p className="form-page-failure" role="alert" hidden={!failure}>
        {failure}
      </p>
    </section>
  );
}

/** Signed in: the applications that captured the account's verified email, each added only by its own Yes. */
function FoundByEmail({ form, onAdded }: { form: string; onAdded: () => void }) {
  const id = useId();
  const [found, setFound] = useState<{ linked: string[]; found: string[]; verify: boolean } | null>(null);
  const [declined, setDeclined] = useState<string[]>([]);
  const [failure, setFailure] = useState('');
  const [pending, setPending] = useState('');
  useEffect(() => {
    let live = true;
    foundByEmail(form).then(
      (answer) => {
        if (!live) return;
        setFound(answer);
        if (answer?.linked.length) onAdded();
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [form]);
  if (!found) return null;
  if (found.verify) return <p className="form-page-done-message">{say('confirmYourAccountsEmail')}</p>;
  const open = found.found.filter((reference) => !declined.includes(reference));
  const yes = async (reference: string) => {
    setPending(reference);
    setFailure('');
    try {
      await claimFound(form, reference);
      setFound(
        (before) =>
          before && { ...before, linked: [...before.linked, reference], found: before.found.filter((item) => item !== reference) },
      );
      onAdded();
    } catch (error) {
      setFailure((error as SavedFormFailure).message);
    } finally {
      setPending('');
    }
  };
  return (
    <>
      {found.linked.length > 0 && (
        <p className="form-page-done-message" role="status">
          {say('addedToYourAccount', { linked: found.linked.join(', ') })}
        </p>
      )}
      {open.length > 0 && (
        <section className="form-account" aria-labelledby={`${id}-found`}>
          <h2 id={`${id}-found`}>
            {open.length === 1 ? say('weFound1Application') : say('weFoundApplicationsSubmitted', { openCount: open.length })}
          </h2>
          <p className="form-page-done-message">{say('sayYesOnlyToOne')}</p>
          <ul>
            {open.map((reference) => (
              <li key={reference}>
                <strong>{reference}</strong>
                <span className="form-claim-actions">
                  <Button intent="secondary" size="compact" busy={pending === reference} onClick={() => void yes(reference)}>
                    {say('yesItsMine')}
                  </Button>
                  <Button intent="quiet" size="compact" onClick={() => setDeclined((before) => [...before, reference])}>
                    {say('common.no')}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="form-page-failure" role="alert" hidden={!failure}>
        {failure}
      </p>
    </>
  );
}

export function FormStatusSurface({
  form,
  appName,
  onSignIn,
}: {
  form: StatusFormPresentation;
  appName: string;
  /** Draw the App's sign-in here; after it the page comes back to this check. */
  onSignIn?: () => void;
}) {
  const id = useId();
  const asked = [{ name: RECEIPT, label: say('reference') }, ...form.save.statusCheck.confirm];
  const [values, setValues] = useState<Record<string, string>>({});
  const [blank, setBlank] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState('');
  const [answer, setAnswer] = useState<ApplicationStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [added, setAdded] = useState('');
  /** The account's own applications: undefined until asked, null when nobody is signed in. */
  const [mine, setMine] = useState<Array<{ reference: string; status: ApplicationStatus }> | null | undefined>(
    form.save.link ? undefined : null,
  );
  const linkable = Boolean(form.save.link?.statusCheck);
  // Already the account's own: nothing to add.
  const owned = (reference: string) => Boolean(mine?.some((item) => item.reference === reference));

  useEffect(() => {
    if (!form.save.link) return;
    let live = true;
    myApplications(form.id).then(
      (list) => {
        if (live) setMine(list);
      },
      () => {
        if (live) setMine(null);
      },
    );
    return () => {
      live = false;
    };
  }, [form.id, form.save.link]);

  const details = () => ({
    receipt: (values[RECEIPT] ?? '').trim(),
    confirm: Object.fromEntries(form.save.statusCheck.confirm.map((item) => [item.name, (values[item.name] ?? '').trim()])),
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const missing = Object.fromEntries(
      asked
        .filter((item) => !(values[item.name] ?? '').trim())
        .map((item) => [item.name, say('enter', { label: item.label.toLowerCase() })]),
    );
    setBlank(missing);
    if (Object.keys(missing).length) return;
    setPending(true);
    setFailure('');
    setAnswer(null);
    setAdded('');
    try {
      setAnswer(await checkStatus(form.id, details()));
    }
    // The server's one sentence, whichever detail it was: never a field of its own.
    catch (error) {
      setFailure((error as SavedFormFailure).message);
    } finally {
      setPending(false);
    }
  };

  const add = async () => {
    if (pending) return;
    setPending(true);
    setFailure('');
    try {
      const reference = await addByStatus(form.id, details());
      setAdded(say('isNowInYourAccount', { reference }));
      setMine(await myApplications(form.id).catch(() => mine ?? null));
    } catch (error) {
      setFailure((error as SavedFormFailure).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="form-page" aria-labelledby={`${id}-title`}>
      <p className="eyebrow">{appName}</p>
      <h1 id={`${id}-title`}>{say('checkYourApplication')}</h1>
      <p className="form-page-description">{say('enterTheReferenceYouWereGiven', { label: form.label })}</p>
      {form.save.link?.email && mine !== null && (
        <FoundByEmail
          form={form.id}
          onAdded={() => {
            myApplications(form.id).then(setMine, () => {});
          }}
        />
      )}
      {mine && mine.length > 0 && (
        <section className="form-account" aria-labelledby={`${id}-mine`}>
          <h2 id={`${id}-mine`}>{say('yourApplications')}</h2>
          <ul>
            {mine.map((item) => (
              <li key={item.reference}>
                <strong>{item.reference}</strong>
                <Status status={item.status} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <form noValidate onSubmit={submit} className="command-fields">
        {asked.map((item) => (
          <Field key={item.name} label={item.label} problem={blank[item.name]} required>
            <input
              className="field-control"
              name={item.name}
              autoComplete="off"
              spellCheck={false}
              value={values[item.name] ?? ''}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setValues((before) => ({ ...before, [item.name]: value }));
                setBlank((before) => {
                  const { [item.name]: _gone, ...rest } = before;
                  return rest;
                });
              }}
            />
          </Field>
        ))}
        <div>
          <Button intent="primary" type="submit" busy={pending && !answer}>
            {say('checkStatus')}
          </Button>
        </div>
      </form>
      <p className="form-page-failure" role="alert" aria-live="assertive" hidden={!failure}>
        {failure}
      </p>
      {answer && (
        <section aria-labelledby={`${id}-answer`} className="form-status-answer">
          <h2 id={`${id}-answer`}>{say('common.status')}</h2>
          <Status status={answer} />
          {linkable &&
            !added &&
            !owned((values[RECEIPT] ?? '').trim()) &&
            (mine === null
              ? onSignIn && (
                  <p className="form-page-done-message">
                    {say('signInToAdd')}{' '}
                    <Button intent="quiet" size="compact" onClick={onSignIn}>
                      {say('signIn')}
                    </Button>
                  </p>
                )
              : mine !== undefined && (
                  <div>
                    <Button intent="secondary" onClick={add} busy={pending}>
                      {say('addToMyAccount')}
                    </Button>
                  </div>
                ))}
          {added && (
            <p className="form-page-done-message" role="status">
              {added}
            </p>
          )}
        </section>
      )}
      {answer && form.save.statusCheck.stepUp && <StepUp form={form.id} details={details} />}
    </section>
  );
}
