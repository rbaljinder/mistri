/**
 * The query history panel: what ran, how long ago, and one button to
 * forget it all. The store, the ↑/↓ stepping and the panel's open state
 * stay in `history.js`, which draws this into the panel it owns.
 */
import { say } from '../copy/workbench/components/History.js';

interface HistoryEntry {
  q: string;
  at?: number;
}

function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return say('justNow');
  if (seconds < 3600) return say('minutesAgo', { minutes: Math.round(seconds / 60) });
  if (seconds < 86400) return say('hoursAgo', { hours: Math.round(seconds / 3600) });
  return say('daysAgo', { days: Math.round(seconds / 86400) });
}

export function HistoryPanel({ entries, onRun, onClear }: { entries: HistoryEntry[]; onRun: (q: string) => void; onClear: () => void }) {
  if (!entries.length) return <p className="history-empty">{say('nothingYetQueriesAppear')}</p>;
  return (
    <>
      <ul className="history-list">
        {entries.map((entry) => (
          <li key={entry.q}>
            <button type="button" className="history-item" onClick={() => onRun(entry.q)}>
              <span className="history-q">{entry.q}</span>
              <span className="history-age">{ago(entry.at ?? Date.now())}</span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="history-clear" onClick={onClear}>
        {say('clearQueries', { count: entries.length })}
      </button>
    </>
  );
}
