/**
 * Says, in the bar, that App logic is running as of another moment
 * (`mistri dev --as-of`, http/clock.ts): a person reading "due today" on a
 * seeded day should not have to remember the server was started that way.
 * Development and tests only — the server refuses the flag anywhere else, so
 * the payload carries no offset and this draws nothing.
 */
import { formatDateTime } from '../locale.js';
import { say } from '../copy/shell/components/AsOfChip.js';

export function AsOfChip({ offset }: { offset: number }) {
  if (!offset) return null;
  const moment = formatDateTime(new Date(Date.now() + offset), { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <span id="as-of-chip" className="as-of-chip" title={say('whyAsOf')}>
      {say('asOf', { moment })}
    </span>
  );
}
