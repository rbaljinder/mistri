/** The quiet line over an intake form's progress bar: an App icon and a sentence ("Your information is stored securely"). */
import type { AppIconName } from '@mistriwork/engine/shared/appIcons.js';
import { Icon } from '@mistriwork/kit/client/components/Icon.js';

export function IntakeNote({ note }: { note: { icon?: AppIconName; text: string } | undefined }) {
  if (!note) return null;
  return (
    <p className="intake-note">
      {note.icon && <Icon name={note.icon} size={16} />}
      <span>{note.text}</span>
    </p>
  );
}
