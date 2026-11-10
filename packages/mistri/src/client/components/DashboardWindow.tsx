/**
 * A dashboard's window control: the picker for the time window its dated sections share, in the segmented row or the
 * single button a phone and a portal's header keep, and the phrase the unpicked state stands for. Pure presentation of
 * what the dashboard (Dashboard.tsx) hands it.
 */
import { windowPhraseOf } from '@mistriwork/engine/shared/autoBucket.js';
import { Icon } from '@mistriwork/kit/client/components/Icon.js';
import { appNow, formatDate } from '@mistriwork/kit/client/locale.js';
import { dateWindow } from '@mistriwork/engine/shared/queryDates.js';
import { DropItem, DropMenu } from '@mistriwork/ui/DropMenu.js';
import { say as sayCopy } from '../copy/dashboards/components/DashboardWindow.js';

/** The window every dated section keeps when none is picked: their one phrase (`last 90 days`); null where some keep
    different ones, or others keep none, so no one phrase says what the unpicked state is; undefined where none keeps one. */
export function ownWindowOf(sections: Array<{ query?: string; over?: string; windowBase?: string }>): string | null | undefined {
  const dated = sections.filter((section) => section.over);
  const kept = dated.filter((section) => section.windowBase !== undefined);
  if (!kept.length) return undefined;
  const phrases = new Set(kept.map((section) => windowPhraseOf(section.query, section.over)?.toLowerCase() ?? ''));
  const [only] = phrases;
  return kept.length === dated.length && phrases.size === 1 && only ? only : null;
}

/**
 * The window picker: the unpicked state and the dashboard's offered phrases.
 * Unpicked is "All time" only when it is: where a section keeps a window of
 * its own (`close_date = last 90 days`), the pressed "All time" sat over
 * figures still counting their ninety days, so it says the window they keep
 * ("Last 90 days"), or "Default" where the sections keep different ones, and
 * each figure says its own window (windowTitle, metricWindow).
 */
export function WindowRow({
  windows,
  current,
  onPick,
  ownWindow,
  control = 'segmented',
}: {
  windows: string[];
  current: string | null;
  onPick: (w: string | null) => void;
  /** What the unpicked state is: undefined where no section keeps a window (all time), the phrase they all keep, or null where they differ. */
  ownWindow: string | null | undefined;
  control?: 'segmented' | 'button';
}) {
  const said = (phrase: string) => phrase.charAt(0).toUpperCase() + phrase.slice(1);
  const word = (w: string | null) =>
    w ? said(w) : ownWindow ? said(ownWindow) : sayCopy(ownWindow === null ? 'defaultWindow' : 'allTimeWindow');
  /* Where every dated section keeps one window, the unpicked state is that window, and the same phrase offered
     beside it would be a second entry reading alike that means the same: it is the unpicked one, so it is not listed. */
  const offered = [null, ...windows.filter((w) => !ownWindow || w.toLowerCase() !== ownWindow)];
  const pressed = (w: string | null) => (w === null ? !current || (!!ownWindow && current.toLowerCase() === ownWindow) : w === current);
  if (control === 'button') {
    /* The dates the window covers, its last day inclusive (the window's end is the next day's start); a phrase the
       calendar cannot place is said as itself. */
    const span = current ? dateWindow(current, appNow()) : undefined;
    const shown = span
      ? sayCopy('windowRange', {
          from: formatDate(span.start, { month: 'short', day: 'numeric' }),
          to: formatDate(new Date(span.end.getTime() - 86_400_000), { month: 'short', day: 'numeric', year: 'numeric' }),
        })
      : word(current);
    return (
      <DropMenu
        className="dash-window-menu"
        triggerClassName="dash-window-button"
        triggerLabel={sayCopy('pickWindow', { window: word(current) })}
        label={
          <>
            <Icon name="calendar-blank" size={15} className="dash-window-icon" />
            <span className="dash-window-range">{shown}</span>
            <Icon name="caret-down" size={12} className="dash-window-caret" />
          </>
        }
        popupClassName="more-list dash-window-list"
        align="end"
      >
        {offered.map((w) => (
          <DropItem key={w ?? ''} className="more-item" onClick={() => onPick(w)}>
            <span className="more-tick" aria-hidden="true">
              {pressed(w) ? '✓' : ''}
            </span>
            <span className="more-label">{word(w)}</span>
          </DropItem>
        ))}
      </DropMenu>
    );
  }
  return (
    <div className="dash-windows" role="group" aria-label={sayCopy('timeWindow')}>
      {offered.map((w) => (
        <button key={w ?? ''} type="button" className="dash-window" aria-pressed={pressed(w)} onClick={() => onPick(w)}>
          {word(w)}
        </button>
      ))}
    </div>
  );
}
