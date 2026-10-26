import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { APP_ICON_GLYPHS } from '../../../../engine/src/shared/iconGlyphs.js';
import { Icon, registerIcons, type IconName, type IconWeight } from './Icon.js';

afterEach(cleanup);

test('decorative icons inherit color and reserve equal dimensions without becoming focus targets', () => {
  const { container } = render(
    <button aria-label="Back">
      <Icon name="arrow-left" />
    </button>,
  );
  const icon = container.querySelector('svg')!;
  expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
  expect(screen.queryByRole('img')).toBeNull();
  expect(icon).toHaveAttribute('aria-hidden', 'true');
  expect(icon).toHaveAttribute('focusable', 'false');
  expect(icon).not.toHaveAttribute('tabindex');
  expect(icon).toHaveAttribute('width', '1em');
  expect(icon).toHaveAttribute('height', '1em');
  expect(icon).toHaveAttribute('fill', 'currentColor');
});

test('a meaningful icon exposes its label; blank labels remain decorative', () => {
  const { rerender } = render(<Icon name="caret-down" label="Expand" size="0.75rem" className="utility" />);
  const icon = screen.getByRole('img', { name: 'Expand' });
  expect(icon).not.toHaveAttribute('aria-hidden');
  expect(icon).toHaveClass('tw-icon', 'utility');
  expect(icon).toHaveAttribute('width', '0.75rem');
  expect(icon).toHaveAttribute('height', '0.75rem');
  rerender(<Icon name="caret-down" label="  " />);
  expect(screen.queryByRole('img')).toBeNull();
});

test.each<IconName>(['arrow-left', 'caret-down', 'caret-right'])('%s draws regular by default and bold when asked', (name) => {
  const { container, rerender } = render(<Icon name={name} size={16} />);
  const defaultDrawing = container.querySelector('svg')!.innerHTML;
  const weights: IconWeight[] = ['regular', 'bold'];
  for (const weight of weights) {
    rerender(<Icon name={name} size={16} weight={weight} />);
    const icon = container.querySelector('svg')!;
    expect(icon.querySelector('path')).not.toBeNull();
    expect(icon).toHaveAttribute('width', '16');
    expect(icon).toHaveAttribute('height', '16');
    if (weight === 'regular') expect(icon.innerHTML).toBe(defaultDrawing);
    else expect(icon.innerHTML).not.toBe(defaultDrawing);
  }
});

test('an App icon the server sent draws at once; one it did not is fetched, keeping its box meanwhile', async () => {
  registerIcons({ kanban: APP_ICON_GLYPHS.kanban });
  const sent = render(<Icon name="kanban" />);
  expect(sent.container.querySelector('path')?.getAttribute('d')).toBe(APP_ICON_GLYPHS.kanban[0][0]);
  const missing = render(<Icon name="truck" size={20} />);
  const box = missing.container.querySelector('svg')!;
  expect(box).toHaveAttribute('width', '20');
  await waitFor(() => expect(box.querySelector('path')?.getAttribute('d')).toBe(APP_ICON_GLYPHS.truck[0][0]));
});

test("a theme's icon weight draws every icon that says none, once its drawings arrive; a logo's bold stays bold", async () => {
  const { ICON_WEIGHT_GLYPHS } = await import('../../../../engine/src/shared/iconWeights.js');
  const { wearIconWeight } = await import('../iconWeight.js');
  const { CHROME_ICON_GLYPHS } = await import('./chromeIcons.js');
  const paths = (svg: Element) => [...svg.querySelectorAll('path')].map((path) => path.getAttribute('d'));
  try {
    await wearIconWeight('fill');
    const { container } = render(
      <>
        <Icon name="gear" />
        <Icon name="gear" weight="bold" />
      </>,
    );
    const [themed, logo] = [...container.querySelectorAll('svg')];
    expect(paths(themed!)).toEqual(ICON_WEIGHT_GLYPHS.gear![1]);
    expect(paths(logo!)).toEqual(CHROME_ICON_GLYPHS.gear[1]);
    // Bold is in every glyph already: wearing it fetches nothing.
    expect(wearIconWeight('bold')).toBeUndefined();
    await waitFor(() => expect(paths(container.querySelector('svg')!)).toEqual(CHROME_ICON_GLYPHS.gear[1]));
  } finally {
    wearIconWeight(undefined);
  }
});
