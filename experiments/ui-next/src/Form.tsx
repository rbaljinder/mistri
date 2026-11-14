import { type FormEvent, type ReactNode, type RefObject, useCallback, useRef, useState } from 'react';

/* What stands between a set of fields and something that takes their answers. The fields stay what they are (each
   has a `name` and takes an `error`); this holds what goes wrong and what the reader is told about it:

   - Answers are checked before they are sent (`validate`), and whatever takes them may still refuse (`submit`
     returns `{ fields, message }`), which is the same thing to the reader and is shown the same way.
   - A refusal puts each problem on its own field, says how many there are in one line over the form, and puts the
     keyboard on the first field that has one, so the reader is not left on a button looking for what went wrong.
   - A field's problem goes the moment the reader changes that field. It was about what they had typed, and they
     have typed something else.
   - While the answers are being taken the form is `busy`, and a second press of Enter does not send them twice.

   It knows nothing of where the answers go: a mistri command, a fetch, a function. */

export type FormRefusal = {
  /* What went wrong, by the name of the field it is about. */
  fields?: Readonly<Record<string, string>>;
  /* What went wrong that is about no one field. */
  message?: string;
};

export type FormAnswers = Record<string, string>;

export type UseFormOptions = {
  /* Checks the answers before they are sent: a problem for each field that has one. */
  validate?: (answers: FormAnswers) => Record<string, string | undefined> | undefined;
  /* Takes the answers. Returns nothing when they were taken, or what was refused. */
  submit: (answers: FormAnswers) => Promise<FormRefusal | undefined | void> | FormRefusal | undefined | void;
};

export type FormHold = {
  /* Spread on the `<form>`. */
  form: {
    ref: RefObject<HTMLFormElement | null>;
    noValidate: true;
    onSubmit: (event: FormEvent<HTMLFormElement>) => void;
    onInput: (event: FormEvent<HTMLFormElement>) => void;
    onChange: (event: FormEvent<HTMLFormElement>) => void;
    'aria-busy': boolean | undefined;
  };
  /* A field's problem, for its `error`. */
  problem: (name: string) => string | undefined;
  problems: Readonly<Record<string, string>>;
  /* What went wrong that is about no one field. */
  message: string | undefined;
  busy: boolean;
  /* Whether anything has been answered since the form was drawn or last taken: what a sheet's `unsaved` wants. */
  touched: boolean;
  /* Puts the keyboard on a field by its name. */
  focus: (name: string) => void;
  /* Forgets every problem and that anything was touched: for a form that is opened again. */
  reset: () => void;
};

export function useForm({ validate, submit }: UseFormOptions): FormHold {
  const ref = useRef<HTMLFormElement>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  /* A field's own control is not always the element that carries its name: a select and a number keep their value
     in a hidden input. The keyboard goes to whatever in the field can take it. */
  const focus = useCallback((name: string) => {
    const named = ref.current?.querySelector<HTMLElement>(`[name="${CSS.escape(name)}"]`);
    if (!named) return;
    const field = named.closest('[data-slot="field"]') ?? named.parentElement;
    const target =
      named.matches('input:not([type="hidden"]), textarea, select, button') && !named.hasAttribute('hidden')
        ? named
        : field?.querySelector<HTMLElement>(
            'input:not([type="hidden"]):not([hidden]), textarea, [role="combobox"], [role="spinbutton"], button, [tabindex="0"]',
          );
    target?.focus();
    target?.scrollIntoView({ block: 'nearest' });
  }, []);

  const refuse = (refusal: FormRefusal) => {
    const fields = Object.fromEntries(Object.entries(refusal.fields ?? {}).filter((entry): entry is [string, string] => Boolean(entry[1])));
    setProblems(fields);
    setMessage(refusal.message);
    // In the form's own order, so the keyboard lands on the first problem the reader meets reading down.
    const order = [...(ref.current?.querySelectorAll<HTMLElement>('[name]') ?? [])].map((el) => el.getAttribute('name'));
    const first = order.find((name) => name && fields[name]) ?? Object.keys(fields)[0];
    if (first) requestAnimationFrame(() => focus(first));
  };

  const forget = (event: FormEvent<HTMLFormElement>) => {
    setTouched(true);
    const name = (event.target as Element).closest('[data-slot="field"]')?.querySelector('[name]')?.getAttribute('name');
    const own = (event.target as Element).getAttribute('name') ?? name;
    if (own && problems[own]) setProblems(({ [own]: _gone, ...rest }) => rest);
  };

  return {
    form: {
      ref,
      noValidate: true,
      'aria-busy': busy || undefined,
      onInput: forget,
      onChange: forget,
      onSubmit: (event) => {
        event.preventDefault();
        if (busy || !ref.current) return;
        const answers: FormAnswers = {};
        for (const [name, value] of new FormData(ref.current)) if (typeof value === 'string') answers[name] = value;
        const found = Object.fromEntries(
          Object.entries(validate?.(answers) ?? {}).filter((entry): entry is [string, string] => Boolean(entry[1])),
        );
        if (Object.keys(found).length) return refuse({ fields: found });
        setBusy(true);
        setProblems({});
        setMessage(undefined);
        void Promise.resolve()
          .then(() => submit(answers))
          .then(
            (refusal) => {
              if (refusal && (refusal.message || Object.keys(refusal.fields ?? {}).length)) refuse(refusal);
              else setTouched(false);
            },
            (thrown: unknown) => refuse({ message: thrown instanceof Error ? thrown.message : 'It could not be sent. Try again.' }),
          )
          .finally(() => setBusy(false));
      },
    },
    problem: (name) => problems[name],
    problems,
    message,
    busy,
    touched,
    focus,
    reset: () => {
      setProblems({});
      setMessage(undefined);
      setTouched(false);
    },
  };
}

/* What went wrong, said once over the form: how many answers need another look, each a press from its field, and
   whatever is about no one field. It is an alert, so a screen reader hears it when it appears. */
export function FormProblems({
  hold,
  labels,
}: {
  hold: Pick<FormHold, 'problems' | 'message' | 'focus'>;
  /* What each field is called, by its name, for the list. */
  labels?: Readonly<Record<string, string>>;
}): ReactNode {
  const names = Object.keys(hold.problems);
  if (!names.length && !hold.message) return null;
  return (
    <div data-slot="form-problems" role="alert">
      {hold.message && <p>{hold.message}</p>}
      {names.length > 0 && (
        <>
          <p>{names.length === 1 ? 'One answer needs another look.' : `${names.length} answers need another look.`}</p>
          <ul>
            {names.map((name) => (
              <li key={name}>
                <button type="button" onClick={() => hold.focus(name)}>
                  {labels?.[name] ?? name}
                </button>
                : {hold.problems[name]}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
