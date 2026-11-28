/**
 * A row of filter tabs with counts, folding what does not fit under More (useTabFold.ts): the generated list's tabs
 * (AppList.tsx) and a page's counted `<Choose>` (sdk/paramControls.tsx) are this one row, so a look that dresses one
 * dresses both.
 *
 * Two semantics over one markup. The list's tabs are a `tablist` that switches what the list below shows; a page's
 * Choose is a group of toggle buttons (`aria-pressed`) that set a param, named by the page, each named with its count
 * ("Working, 12") so a screen reader hears the number it sees. The lit dress keys on either state (style.css).
 */
import type { ReactNode } from 'react';
import { DropItem, DropMenu } from '@mistriwork/ui/DropMenu.js';
import { formatNumber } from '../locale.js';
import { message } from '../messages.js';
import { useTabFold } from './useTabFold.js';

/** A tab's count: the total, and whether it is a floor ("10,000+"). */
export interface Counted {
  total: number;
  capped: boolean;
}

export const sayCount = (counted: Counted): string => `${formatNumber(counted.total)}${counted.capped ? '+' : ''}`;

/** A tab's badge. `null` is a current result with no count, not permission to show an older one. */
export function TabCount({ counted }: { counted?: Counted | null }) {
  const said = counted == null ? '' : sayCount(counted);
  /* The number in a box of its own, over the room a tab keeps for it (features.css). */
  return <span className="tab-count">{said && <span>{said}</span>}</span>;
}

interface FilterTab {
  key: string;
  label: string;
  count?: Counted | null;
}

/** What the fold marks an item with: its place in the strip, and whether it is folded under More. */
type FoldMark = (at: number) => { 'data-fold': number; 'data-folded': '' | undefined; 'aria-hidden': true | undefined };

interface FilterTabsProps {
  tabs: readonly FilterTab[];
  /** The lit tab's index, -1 for none (a saved view may be the lit one). */
  lit: number;
  onPick(index: number): void;
  /** `tablist` for tabs that switch a view; `group` for a control's toggle buttons, which `name` names. */
  semantics?: 'tablist' | 'group';
  name?: string;
  /**
   * More items after the tabs, in the same fold (a list's saved views): how many, which of them is lit (-1 for none),
   * what the row draws for them with their fold marks (counted from 0 after the tabs), and what More lists for the
   * folded ones.
   */
  extra?: {
    count: number;
    lit: number;
    row(mark: FoldMark): ReactNode;
    more(folded: (at: number) => boolean): ReactNode;
  };
}

export function FilterTabs({ tabs, lit, onPick, semantics = 'tablist', name, extra }: FilterTabsProps) {
  const after = tabs.length;
  const { strip, folded } = useTabFold(after + (extra?.count ?? 0), extra && extra.lit !== -1 ? after + extra.lit : lit);
  const foldMark: FoldMark = (at) => ({
    'data-fold': at,
    'data-folded': folded.has(at) ? '' : undefined,
    'aria-hidden': folded.has(at) || undefined,
  });
  const group = semantics === 'group';
  return (
    <div className="tabs folds" ref={strip}>
      <div className="tabs-row" {...(group ? { role: 'group', 'aria-label': name } : { role: 'tablist' })}>
        {tabs.map((tab, i) => (
          <button
            key={tab.key}
            type="button"
            role={group ? undefined : 'tab'}
            className="tab"
            aria-selected={group ? undefined : i === lit}
            aria-pressed={group ? i === lit : undefined}
            aria-label={group && tab.count != null ? `${tab.label}, ${sayCount(tab.count)}` : undefined}
            onClick={() => onPick(i)}
            {...foldMark(i)}
          >
            <span>{tab.label}</span>
            {tab.count !== undefined && <TabCount counted={tab.count} />}
          </button>
        ))}
        {extra?.row((at) => foldMark(after + at))}
      </div>
      <div className="tab-more" data-fold-more="" data-folded={folded.size ? undefined : ''} aria-hidden={!folded.size || undefined}>
        <DropMenu
          className="tab-more-menu"
          triggerClassName="tab"
          label={message('common.more')}
          popupClassName="page-actions-popup"
          align="end"
        >
          {tabs.map((tab, i) =>
            folded.has(i) ? (
              <DropItem key={tab.key} className="page-actions-item" onClick={() => onPick(i)}>
                <span>{tab.label}</span>
                {tab.count !== undefined && <TabCount counted={tab.count} />}
              </DropItem>
            ) : null,
          )}
          {extra?.more((at) => folded.has(after + at))}
        </DropMenu>
      </div>
    </div>
  );
}
