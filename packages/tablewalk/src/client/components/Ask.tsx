/**
 * The query bar, in the middle of the screen.
 *
 * The bar in the header is right for refining what you are already looking
 * at; it is the wrong surface for *writing* a query — a single line ninety
 * characters wide sharing the header with everything else. This is the same
 * input given room: centred, wrapped, nothing else on screen, on ⌘/ beside
 * ⌘K. **⌘K goes to things, ⌘/ asks things.**
 *
 * It does not run the query itself. Which endpoint answers a line — a `by`
 * clause means a breakdown, everything else a view — is decided in one
 * place, and the caller hands that in as `onRun`. A textarea so a long line
 * wraps rather than scrolls; the language is single-line, so Enter runs and
 * a pasted newline is flattened rather than sent to a parser that has no
 * idea what to do with it.
 */
import { useRef } from 'react';
import { Modal, type ModalHandle } from '@mistriwork/ui/Modal.js';
import { say } from '../copy/workbench/components/Ask.js';

export function AskDialog({ initial = '', onRun, onClose }: { initial?: string; onRun?: (text: string) => void; onClose: () => void }) {
  const dialog = useRef<ModalHandle>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const run = () => {
    const text = (input.current?.value ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    dialog.current?.close();
    onRun?.(text);
  };
  return (
    <Modal className="ask" ref={dialog} onClose={onClose} initialFocus={input} aria-label={say('writeAQuery')} plain>
      {/* Arrives selected, so typing replaces it and an arrow key keeps it. */}
      <textarea
        ref={input}
        className="ask-input"
        rows={3}
        spellCheck={false}
        autoComplete="off"
        aria-label={say('query')}
        placeholder="customer active = true sort name limit 20"
        defaultValue={initial}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            run();
          }
        }}
      />
      <div className="ask-foot">
        {/* What the language can do that the placeholder cannot show: `by` is the newest clause and the least guessable. */}
        <span className="ask-hint">
          <code>{say('by')}</code>
          {say('groups')}
          <code>invoice count by status</code>
        </span>
        <span className="ask-keys">{say('enterToRunEsc')}</span>
      </div>
    </Modal>
  );
}
