/**
 * The authoring loop, closed in the browser: every problem the startup log
 * and mistri check name rides /api/app, and the shell shows a quiet count
 * beside the menu whenever there are any. Click for the list — each line
 * names its fix — save the file, and hot reload clears it. Absent entirely
 * for a clean app and for readers: no chrome for a problem nobody has.
 */
import { useRef, useState } from 'react';
import { Modal, type ModalHandle } from '@mistriwork/ui/Modal.js';
import { say } from '../copy/shell/components/AppIssues.js';

export function AppIssues({ name, problems }: { name: string; problems: string[] }) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<ModalHandle>(null);
  if (!problems.length) return null;
  return (
    <>
      <button type="button" id="app-issues" className="app-issues" title={say('problemsInThisApps')} onClick={() => setOpen(true)}>
        <span>{say('issues', { problemsCount: problems.length })}</span>
      </button>
      {open ? (
        <Modal className="app-issues-dialog" ref={dialog} onClose={() => setOpen(false)} aria-label={say('problemsIn', { name })}>
          <h2>{`${say('problems', { count: problems.length })} in ${name}`}</h2>
          <ol className="app-issues-list">
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ol>
          <p className="note">{say('eachLineNamesItsFix')}</p>
          <button type="button" className="ghost" onClick={() => dialog.current?.close()}>
            {say('common.close')}
          </button>
        </Modal>
      ) : null}
    </>
  );
}
