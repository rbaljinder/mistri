/**
 * A value's copy button (a display rule's `copy`), shared by the record's Value and the custom components' Value. It
 * reads no global of the walk: what it says when the copy is done or refused goes to the caller's `announce` (the
 * shell's toast on a record, the host's announcement in a component), so the SDK can draw it too.
 */
import { Icon } from './Icon.js';
import { say } from '../copy/record/components/CopyValue.js';

/** The stored value to the clipboard, as stored: an id past 2^53 arrives as a string and is copied as one. */
export function CopyValue({
  value,
  label,
  announce,
}: {
  value: unknown;
  label: string;
  announce: (text: string, tone: 'ok' | 'error') => void;
}) {
  const named = say('copyValue', { label });
  return (
    <button
      type="button"
      className="value-copy"
      aria-label={named}
      title={named}
      onClick={(event) => {
        /* A copy is never also the click of what holds it: a table row, a link's row. */
        event.stopPropagation();
        const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
        /* No clipboard at all (an insecure origin) is a refusal too, said the same way rather than thrown. */
        Promise.resolve()
          .then(() => navigator.clipboard.writeText(text))
          .then(() => announce(say('copiedValue', { label }), 'ok'))
          /* The clipboard can be refused — an insecure origin, a permission denied; the value is on screen. */
          .catch(() => announce(say('common.theBrowserRefusedClipboard'), 'error'));
      }}
    >
      <Icon name="copy" size={16} />
    </button>
  );
}
