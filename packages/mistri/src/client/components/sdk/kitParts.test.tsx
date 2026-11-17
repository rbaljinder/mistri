/**
 * The parts a field report asked for, each as a page meets it: `Stat`'s delta and link, `Sparkline`, `MiniBars` (with
 * the table a screen reader reads), `Tile`, `DateNav` (its steps, its `T` key and `skip`) and `useNotice`.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderPage, renderSection } from './testing.js';
import { definePage } from './page.js';
import { MiniBars, Sparkline, Stat, Tile } from './kit.js';
import { DateNav, stepDay } from './DateNav.js';
import { useNotice } from './index.js';

afterEach(cleanup);
const drawn = (children: React.ReactNode, more: object = {}) =>
  renderSection(() => <>{children}</>, { component: { id: 'parts' }, ...more });

describe('Stat', () => {
  test('a delta is signed and toned by which way is good', () => {
    drawn(
      <>
        <Stat label="Revenue" value="$1" delta={{ value: 12, good: 'up' }} />
        <Stat label="Churn" value="3%" delta={{ value: -2, good: 'up' }} />
        <Stat label="Wait" value="4m" delta={{ value: -1, good: 'down' }} />
      </>,
    );
    const news = [...document.querySelectorAll('.kit-stat-change')];
    expect(news.map((each) => each.textContent)).toEqual(['+12', '−2', '−1']);
    expect(news.map((each) => each.className)).toEqual([
      'kit-stat-change kit-stat-good',
      'kit-stat-change kit-stat-bad',
      'kit-stat-change kit-stat-good',
    ]);
  });

  test('with href the whole stat is a link', () => {
    drawn(<Stat label="Open" value="14" href="/leads" />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/leads');
    expect(link.textContent).toContain('14');
  });

  test('a stat with none of the new props is as it was', () => {
    drawn(<Stat label="Open" value="14" />);
    expect(document.querySelector('a')).toBeNull();
    expect(document.querySelector('.kit-stat-change')).toBeNull();
  });
});

describe('Sparkline and MiniBars', () => {
  test('a sparkline names its values for a screen reader', () => {
    drawn(<Sparkline values={[1, 3, 2, 5, 4]} label="Orders" />);
    expect(document.querySelector('svg')?.getAttribute('aria-label')).toBe('trend: 1, 3, 2, 5, 4');
    expect(screen.getByRole('group', { name: 'Orders' })).not.toBeNull();
  });

  test('mini bars are drawn to the tallest, the highlight lit, and read out as a table', () => {
    drawn(<MiniBars values={[2, 4, 1]} labels={['Mon', 'Tue', 'Wed']} highlight={1} />);
    const bars = [...document.querySelectorAll<HTMLElement>('.kit-minibars-bars > i')];
    expect(bars.map((bar) => bar.style.height)).toEqual(['50%', '100%', '25%']);
    expect(bars.map((bar) => bar.classList.contains('is-lit'))).toEqual([false, true, false]);
    const rows = [...document.querySelectorAll('tr')].map((row) => row.textContent);
    expect(rows).toEqual(['Mon2', 'Tue4', 'Wed1']);
    expect(document.querySelector('.kit-minibars-bars')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('Tile', () => {
  test('it is a button, says it is selected, and is a card, not a control', () => {
    const press = vi.fn();
    drawn(
      <Tile onPress={press} selected>
        Chosen
      </Tile>,
    );
    const tile = screen.getByRole('button', { name: 'Chosen' });
    expect(tile.getAttribute('data-slot')).toBe('tile');
    expect(tile.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(tile);
    expect(press).toHaveBeenCalledTimes(1);
  });

  test('with href it is a link, and disabled it does not press', () => {
    const press = vi.fn();
    drawn(
      <>
        <Tile href="/a">Link</Tile>
        <Tile onPress={press} disabled>
          Off
        </Tile>
      </>,
    );
    expect(screen.getByRole('link', { name: 'Link' }).getAttribute('href')).toBe('/a');
    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    expect(press).not.toHaveBeenCalled();
  });
});

describe('DateNav', () => {
  test('stepping skips the days it is told to, in either direction, and is bounded', () => {
    const weekend = (day: string) => [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
    expect(stepDay('2026-11-13', 1, weekend)).toBe('2026-11-16'); // Friday to Monday
    expect(stepDay('2026-11-16', -1, weekend)).toBe('2026-11-13');
    expect(stepDay('2026-11-13', 1, () => true)).toBe('2026-11-28');
  });

  test('previous, next and a week at a time, and T goes to today unless a box is being typed in', () => {
    const seen: string[] = [];
    drawn(<DateNav value="2026-11-13" onChange={(day) => seen.push(day)} step="week" />);
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    expect(seen).toEqual(['2026-11-20', '2026-11-06']);
    const before = seen.length;
    fireEvent.keyDown(document.body, { key: 't' });
    expect(seen).toHaveLength(before + 1);
    fireEvent.keyDown(document.body, { key: 'T', metaKey: true });
    const prevented = new KeyboardEvent('keydown', { key: 't', bubbles: true, cancelable: true });
    prevented.preventDefault();
    document.body.dispatchEvent(prevented);
    expect(seen).toHaveLength(before + 1);
    const box = document.createElement('input');
    document.body.append(box);
    fireEvent.keyDown(box, { key: 't' });
    box.remove();
    expect(seen).toHaveLength(before + 1);
  });
});

describe('useNotice', () => {
  test('raises the platform notice with its tone', () => {
    const announced: { text: string; tone: 'ok' | 'error' }[] = [];
    function Raise() {
      const notice = useNotice();
      return (
        <button type="button" onClick={() => notice({ text: 'Not that day', tone: 'error' })}>
          go
        </button>
      );
    }
    renderPage(definePage({ label: 'Desk', reads: [], commands: [], component: () => <Raise /> }), { announced });
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(announced).toEqual([{ text: 'Not that day', tone: 'error' }]);
  });
});
