/**
 * The one row of counted tabs: the generated list's tablist (AppList.test.tsx drives it there) and a page's counted
 * Choose, a group of toggle buttons. One markup under both, so a look's tab dress lands on either.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FilterTabs } from './FilterTabs.js';

afterEach(cleanup);

const TABS = [
  { key: 'all', label: 'All', count: { total: 1204, capped: false } },
  { key: 'open', label: 'Open', count: { total: 10000, capped: true } },
  { key: 'mine', label: 'Mine', count: null },
];

describe('FilterTabs', () => {
  test('as a tablist: tabs, the lit one selected, each count in its own box', () => {
    const onPick = vi.fn();
    render(<FilterTabs tabs={TABS} lit={1} onPick={onPick} />);
    const list = screen.getByRole('tablist');
    expect(list.closest('.tabs.folds')).not.toBeNull();
    expect(screen.getByRole('tab', { name: /Open/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /All/ })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: /Open/ }).querySelector('.tab-count')).toHaveTextContent('10,000+');
    // A tab with no count keeps the box, empty, so the row does not shift when the number lands.
    expect(screen.getByRole('tab', { name: 'Mine' }).querySelector('.tab-count')).toBeEmptyDOMElement();
    fireEvent.click(screen.getByRole('tab', { name: /All/ }));
    expect(onPick).toHaveBeenCalledWith(0);
  });

  test('as a group: toggle buttons the control names, each named with the count it shows', () => {
    render(<FilterTabs tabs={TABS} lit={0} onPick={() => {}} semantics="group" name="Status" />);
    expect(screen.getByRole('group', { name: 'Status' })).toBeInTheDocument();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByRole('button', { name: 'All, 1,204' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Open, 10,000+' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Mine' })).not.toHaveAttribute('aria-label');
  });

  test('omits the badge box when count is undefined', () => {
    render(
      <FilterTabs
        tabs={[
          { key: 'all', label: 'All' },
          { key: 'open', label: 'Open' },
        ]}
        lit={0}
        onPick={() => {}}
      />,
    );
    expect(document.querySelectorAll('.tab-count')).toHaveLength(0);
  });
});
