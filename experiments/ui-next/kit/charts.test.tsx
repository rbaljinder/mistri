import { act } from 'react';
import { afterEach, expect, test } from 'vitest';
import { Scrub, ScrubTrack } from '../src/behaviors/Scrub';
import { BarList, Chart, Funnel, Metrics, niceTicks, SegmentBar } from '../src/charts';
import { all, clear, draw, focus, key, labelled } from './testing';

afterEach(clear);

const press = (part: Element) => act(() => part.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));

/* ---------- the scrub primitive ---------- */

test('a scrub track is a slider whose value text is what is at each place', () => {
  const heard: string[] = [];
  const picked: number[] = [];
  draw(
    <Scrub
      count={3}
      text={(at) => ['Jan: 4', 'Feb: 9', 'Mar: 2'][at] as string}
      onValueChange={(at, details) => heard.push(`${at} ${details.reason}`)}
      onPick={(at) => picked.push(at)}
    >
      {(at) => <ScrubTrack aria-label="Repairs">{at === null ? 'nothing read' : `reading ${at}`}</ScrubTrack>}
    </Scrub>,
  );
  const track = labelled('Repairs');
  expect(track.getAttribute('role')).toBe('slider');
  expect(track.getAttribute('aria-valuemax')).toBe('2');
  expect(track.textContent).toBe('nothing read');
  // The first arrow reads the place the keyboard arrived at; the next ones move.
  key(track, 'ArrowRight');
  expect(track.getAttribute('aria-valuetext')).toBe('Jan: 4');
  key(track, 'ArrowRight');
  expect(track.getAttribute('aria-valuetext')).toBe('Feb: 9');
  expect(track.textContent).toBe('reading 1');
  key(track, 'End');
  key(track, 'ArrowRight');
  expect(track.getAttribute('aria-valuenow')).toBe('2');
  key(track, 'Enter');
  expect(picked).toEqual([2]);
  key(track, 'Escape');
  expect(track.textContent).toBe('nothing read');
  // The place last read is kept, so the keyboard comes back to it.
  key(track, 'ArrowLeft');
  expect(track.getAttribute('aria-valuetext')).toBe('Mar: 2');
  expect(heard).toEqual(['0 move-key', '1 move-key', '2 move-key', 'null escape-key', '2 move-key']);
});

/* ---------- charts ---------- */

test('ticks are round numbers that hold the least and the most', () => {
  expect(niceTicks(0, 72640)).toEqual([0, 20000, 40000, 60000, 80000]);
  expect(niceTicks(0, 22)).toEqual([0, 10, 20, 30]);
  expect(niceTicks(-3, 7)).toEqual([-5, -2.5, 0, 2.5, 5, 7.5]);
  expect(niceTicks(0, 0)).toEqual([0, 0.25, 0.5, 0.75, 1]);
});

const MONTHS = ['Sep', 'Oct', 'Nov'];
const RENT = [
  { id: 'collected', label: 'Collected', values: [70250, 71900, 72640] },
  { id: 'owed', label: 'Owed', values: [1700, null, 2645] },
];
const money = (value: number) => `$${value.toLocaleString('en-US')}`;

test('a chart says each place to the keyboard, every series in it, and a value not known as none', () => {
  draw(<Chart title="Rent charged" kind="stacked" categories={MONTHS} series={RENT} format={money} />);
  const track = labelled('Rent charged');
  key(track, 'ArrowRight');
  expect(track.getAttribute('aria-valuetext')).toBe('Sep: Collected $70,250; Owed $1,700');
  key(track, 'ArrowRight');
  expect(track.getAttribute('aria-valuetext')).toBe('Oct: Collected $71,900; Owed none');
  // The readout is the same words, drawn, with the two added up.
  const tip = document.querySelector('[data-slot="chart-tip"]');
  expect(tip?.querySelector('strong')?.textContent).toBe('Oct');
  expect([...(tip?.querySelectorAll('dd') ?? [])].map((value) => value.textContent)).toEqual(['$71,900', 'none', '$71,900']);
});

test('a series taken out of a chart keeps its colour for the rest, and the last one stays', () => {
  draw(<Chart title="Rent charged" categories={MONTHS} series={RENT} format={money} />);
  const fills = () => [...new Set([...document.querySelectorAll('[data-slot="chart-bar"]')].map((mark) => mark.getAttribute('fill')))];
  expect(fills()).toEqual(['var(--m-series-1)', 'var(--m-series-2)']);
  const legend = [...document.querySelectorAll<HTMLElement>('[data-slot="chart-legend"] button')];
  press(legend[0]!);
  expect(legend[0]!.getAttribute('aria-pressed')).toBe('false');
  // What is left is still the second colour: a colour belongs to a series, not to its place among those shown.
  expect(fills()).toEqual(['var(--m-series-2)']);
  press(legend[1]!);
  expect(legend[1]!.getAttribute('aria-pressed')).toBe('true');
  expect(fills()).toEqual(['var(--m-series-2)']);
});

test('the same numbers are a table a press away, with the series taken out still in it', () => {
  draw(<Chart title="Rent charged" categories={MONTHS} series={RENT} format={money} />);
  press(document.querySelector('[data-slot="chart-legend"] button')!);
  press(labelled('Show as a table'));
  const rows = [...document.querySelectorAll('[data-slot="chart-table"] tbody tr')].map((row) =>
    [...row.children].map((cell) => cell.textContent).join(' '),
  );
  expect(rows).toEqual(['Sep $70,250 $1,700', 'Oct $71,900 none', 'Nov $72,640 $2,645']);
  expect(labelled('Show as a chart').getAttribute('aria-pressed')).toBe('true');
});

test('a ninth series is not given a colour: the eighth and on are one sum', () => {
  const many = Array.from({ length: 10 }, (_, at) => ({ id: `s${at}`, label: `Building ${at + 1}`, values: [at + 1] }));
  draw(<Chart title="By building" categories={['Nov']} series={many} />);
  const names = [...document.querySelectorAll('[data-slot="chart-legend"] button')].map((button) => button.textContent);
  expect(names).toEqual(['Building 1', 'Building 2', 'Building 3', 'Building 4', 'Building 5', 'Building 6', 'Building 7', 'Other']);
  const track = labelled('By building');
  key(track, 'ArrowRight');
  expect(track.getAttribute('aria-valuetext')).toContain('Other 27');
});

test('a chart with nothing in it says so and has no plot to stop on', () => {
  draw(<Chart title="Rent charged" categories={MONTHS} series={[{ id: 'a', label: 'Collected', values: [null, null, null] }]} />);
  expect(document.querySelector('[data-slot="chart-empty"]')?.textContent).toBe('Nothing to chart yet.');
  expect(all('slider')).toEqual([]);
});

/* ---------- figures ---------- */

test('a figure says which way it moved in words, and its colour is whether that is good', () => {
  draw(
    <Metrics
      label="This month"
      items={[
        { label: 'Collected', value: '$72,640', delta: 0.0103, against: 'vs October' },
        { label: 'Repairs open', value: '9', delta: -0.25, upIsGood: false },
        { label: 'Owed', value: '$2,645', delta: 0.102, upIsGood: false },
        { label: 'Homes lived in', value: '96%', delta: 0 },
      ]}
    />,
  );
  const deltas = [...document.querySelectorAll<HTMLElement>('[data-slot="metric-delta"]')];
  expect(deltas.map((delta) => delta.textContent)).toEqual(['up1.0%vs October', 'down25.0%', 'up10.2%', 'no change']);
  expect(deltas.map((delta) => (delta.hasAttribute('data-good') ? 'good' : delta.hasAttribute('data-bad') ? 'bad' : 'flat'))).toEqual([
    'good',
    'good',
    'bad',
    'flat',
  ]);
});

test('a bar list puts the largest first, folds the tail, and says each share', () => {
  const picked: string[] = [];
  draw(
    <BarList
      label="By building"
      share
      most={2}
      onPick={(row) => picked.push(row.id)}
      rows={[
        { id: 'c', label: 'Cedar Mews', value: 25 },
        { id: 'a', label: 'Alder Court', value: 50 },
        { id: 'b', label: 'Birch House', value: 25 },
      ]}
    />,
  );
  const rows = () => [...document.querySelectorAll('[data-slot="bar-list"] li')].map((row) => row.textContent);
  expect(rows()).toEqual(['Alder Court5050%', 'Cedar Mews2525%']);
  const more = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Show all 3')!;
  press(more);
  expect(rows().length).toBe(3);
  expect(more.getAttribute('aria-expanded')).toBe('true');
  press(document.querySelector('[data-slot="bar-list"] li button')!);
  expect(picked).toEqual(['a']);
});

test('a funnel says how much of the step before came through, and how much end to end', () => {
  draw(
    <Funnel
      label="Enquiry to lease"
      stages={[
        { id: 'e', label: 'Enquiries', value: 200 },
        { id: 'v', label: 'Viewings', value: 100 },
        { id: 'l', label: 'Leases', value: 25 },
      ]}
    />,
  );
  expect([...document.querySelectorAll('[data-slot="funnel"] li')].map((row) => row.textContent)).toEqual([
    'Enquiries200',
    'Viewings10050% of the step before',
    'Leases2525% of the step before',
  ]);
  expect(document.querySelector('[data-slot="funnel-through"]')?.textContent).toBe('13% came through end to end.');
});

test('a split whole names every part with its amount and share, a part at nothing included', () => {
  draw(
    <SegmentBar
      label="Charges"
      parts={[
        { id: 'p', label: 'Paid', value: 75 },
        { id: 'o', label: 'Owed', value: 25 },
        { id: 'w', label: 'Waived', value: 0 },
      ]}
    />,
  );
  expect(document.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Charges: Paid 75, 75%; Owed 25, 25%; Waived 0, 0%');
  expect(document.querySelectorAll('[data-slot="segment-bar"] span').length).toBe(2);
});

test('the keyboard on a chart arrives where it last read', () => {
  draw(<Chart title="Rent charged" categories={MONTHS} series={RENT} format={money} />);
  const track = labelled('Rent charged');
  focus(track);
  key(track, 'End');
  key(track, 'Escape');
  key(track, 'ArrowLeft');
  expect(track.getAttribute('aria-valuetext')).toBe('Nov: Collected $72,640; Owed $2,645');
});
