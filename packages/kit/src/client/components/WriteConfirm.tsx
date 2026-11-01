/**
 * A real confirmation before write mode, naming the database. "Are you
 * sure?" teaches nothing; the name of the thing you are about to be able to
 * change does, and so do the terms.
 */
import { useRef } from 'react';
import { Button } from '@mistriwork/ui/Button.js';
import { Modal, type ModalHandle } from '@mistriwork/ui/Modal.js';
import { say } from '../copy/record/components/WriteConfirm.js';

export function WriteConfirmDialog({ label, onDone }: { label: string; onDone: (ok: boolean) => void }) {
  const dialog = useRef<ModalHandle>(null);
  const settled = useRef(false);
  const finish = (ok: boolean) => {
    if (settled.current) return;
    settled.current = true;
    onDone(ok);
  };
  return (
    <Modal className="confirm" ref={dialog} onClose={() => finish(false)} ariaLabel={say('enableWriteMode')}>
      <h2>{say('enableWriteMode')}</h2>
      <p>
        {say('enableEditingOfExisting')} <strong>{label}</strong>?
      </p>
      <ul className="confirm-terms">
        <li>{say('fieldChangesStayPending')}</li>
        <li>{say('theReviewNamesTheRecord')}</li>
        <li>{say('anUpdateThatWould')}</li>
        <li>{say('writeModeStaysOnForThisDatabase')}</li>
        <li>{say('itAppliesToThisDatabase')}</li>
      </ul>
      <div className="confirm-actions">
        <Button
          onClick={() => {
            finish(false);
            dialog.current?.close();
          }}
        >
          {say('keepViewing')}
        </Button>
        <Button
          intent="primary"
          onClick={() => {
            finish(true);
            dialog.current?.close();
          }}
        >
          {say('enableWriteModeButton')}
        </Button>
      </div>
    </Modal>
  );
}
