/**
 * A public form over the record that sent you to it.
 *
 * A call to action on a headline — "Inquire about this car", "Schedule a test
 * drive" — used to navigate to the form's own page, which takes away the very
 * thing the form is about: the price, the photograph, the mileage. Opened
 * here, the record stays behind the dialog and the reader can look again
 * before they send.
 *
 * The form is the same one the page draws (FormSurface), loaded from the same
 * public endpoint, submitted the same way. What differs is where it sits and
 * how it starts: the action's `prefill` and `defaults` arrive as a query
 * string, exactly as they would in the address, so the two routes to the form
 * cannot drift apart.
 */
import { useQuery } from '@tanstack/react-query';
import { useId, useMemo } from 'react';
import { loadPublicForm } from '../publicForm.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { served } from '@mistriwork/kit/client/addressMount.js';
import { FormSurface, submitPublicForm } from './FormSurface.js';
import { Modal } from '@mistriwork/ui/Modal.js';
import './FormDialog.css';
import { say } from '../copy/forms/components/FormDialog.js';

const PlacedFormSurface = onDemand(() => import('./PlacedFormSurface.js'), 'PlacedFormSurface');

export function FormDialog({
  view,
  appId,
  prefill,
  onClose,
}: {
  view: string;
  appId?: string;
  /** The action's starting values as a query string ("stock_ref=ABC&message=…"). */
  prefill: string;
  onClose: () => void;
}) {
  const instance = useId();
  // Invalidation may ask again, but this opening owns one preparation. An
  // unanswered send is retained by the placed owner beyond this opening.
  const prepare = useMemo(() => {
    let answer: ReturnType<typeof loadPublicForm> | undefined;
    return () => (answer ??= loadPublicForm(view, { appId, fresh: true }));
  }, [appId, view]);
  const asked = useQuery({
    queryKey: ['public-form', window.location.origin, served('/'), appId, view, instance],
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    queryFn: async () => (await prepare()) ?? null,
  });
  const form = asked.data?.form;
  /* The App's name comes with the form, the way it does for the form's own
     page — reading it from the nav store instead would make this module part
     of a cycle (test/repo/runtime-cycles). */
  const appName = asked.data?.app.name ?? '';
  /* A tenant publishes its form with its intake address, `?via=…`; a
     submission carries it on, as it was, for the server to resolve — the same
     rule the form's own page follows (publicForm.js). */
  const via = new URLSearchParams(window.location.search).get('via') ?? undefined;
  return (
    <Modal className="form-dialog" onClose={onClose} ariaLabel={form?.label ?? say('form')}>
      {asked.isPending && <p className="form-dialog-waiting">{say('common.loading')}</p>}
      {asked.isError && <p className="form-dialog-failed">{(asked.error as Error).message}</p>}
      {asked.isSuccess && !form && <p className="form-dialog-failed">{say('thereIsNoSuch')}</p>}
      {form &&
        (asked.data?.placement ? (
          <PlacedFormSurface key={instance + appId + view} prepared={asked.data} prefill={prefill} onDismiss={onClose} />
        ) : (
          <FormSurface
            key={instance + appId + view}
            form={form}
            appName={appName}
            prefill={prefill}
            inDialog
            // A reference input's choices: what the App opens to a signed-out visitor, read as one (publicForm.js).
            visitor={{ app: asked.data!.app.id, ...(via ? { via } : {}) }}
            submit={(submission, input, guard) => submitPublicForm(form.id, submission, input, via, guard)}
          />
        ))}
    </Modal>
  );
}
