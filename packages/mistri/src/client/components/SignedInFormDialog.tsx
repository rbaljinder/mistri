/**
 * A signed-in form over the page a component sent the reader to it from: the
 * form its room draws (FormBody), submitted through the same signed-in
 * command route under the reader's own session and grant. "Join to react"
 * on a post opens the Join form here rather than in its room, so the reader
 * who joins is still on the post, whose reads the submit refreshes.
 *
 * Its own module, fetched the first time a component opens one: the form's
 * room reads the nav store, which the public form's dialog must not
 * (FormDialog.tsx), and nothing on a first paint needs either.
 */
import { FormBody } from './FormRoom.js';
import type { ServedForm as RoomForm } from '@mistriwork/kit/client/components/appRooms.js';
import type { AppPayloadApp } from '../../shared/appPayload.js';

/** A signed-in form as the App serves it: the whole form, which the kit's room type reads only part of. */
type ServedForm = RoomForm<AppPayloadApp>;
import { Modal } from '@mistriwork/ui/Modal.js';
import './FormDialog.css';

export function SignedInFormDialog({
  form,
  appName,
  prefill,
  onClose,
}: {
  form: ServedForm;
  appName: string;
  prefill: string;
  onClose: () => void;
}) {
  return (
    <Modal className="form-dialog" onClose={onClose} ariaLabel={form.label}>
      <FormBody form={form} appName={appName} prefill={prefill} onDismiss={onClose} />
    </Modal>
  );
}
