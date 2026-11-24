/**
 * Integration tests for @mistriwork/ui charts, primitives, and composite views.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import * as chartsMod from './charts.js';
import * as primMod from './primitives.js';
import * as viewsMod from './views.js';

describe('@mistriwork/ui subpaths (charts, primitives, views)', () => {
  it('renders zero-dependency SVG charts, gauges, and heatmaps', () => {
    const { container } = render(
      <div>
        <chartsMod.Sparkline data={[10, 24, 18, 32]} />
        <chartsMod.RadialGauge value={94} label="Uptime" />
        <chartsMod.HeatmapMatrix
          rows={['Mon', 'Tue']}
          columns={['00h', '06h']}
          values={[
            [2, 5],
            [8, 4],
          ]}
        />
      </div>,
    );
    expect(container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2);
  });

  it('mounts composite views and dark-themed islands via standard data-theme', () => {
    render(
      <div data-theme="dark" data-testid="island">
        <viewsMod.PageHeader title="Dispatch Queue" description="Live operations" />
        <primMod.Button variant="primary">Scoped Action</primMod.Button>
      </div>,
    );
    expect(screen.getByText('Dispatch Queue')).toBeTruthy();
    expect(screen.getByText('Scoped Action')).toBeTruthy();
    expect(Object.keys(viewsMod).length).toBeGreaterThanOrEqual(20);
  });

  it('unifies slotted primitives across @mistriwork/ui and @mistriwork/ui/primitives.js with zero duplicate implementations', async () => {
    const rootMod = await import('./index.js');
    expect(primMod.Button).toBe(rootMod.Button);
    expect(primMod.ButtonLink).toBe(rootMod.ButtonLink);
    expect(primMod.Modal).toBe(rootMod.Modal);
    expect(primMod.Drawer).toBe(rootMod.Drawer);
    expect(primMod.Popover).toBe(rootMod.Popover);
    expect(primMod.Tooltip).toBe(rootMod.Tooltip);
    expect(primMod.Field).toBe(rootMod.Field);
    expect(primMod.TextField).toBe(rootMod.TextField);
    expect(primMod.Select).toBe(rootMod.Select);
    expect(primMod.Checkbox).toBe(rootMod.Checkbox);
    expect(primMod.Switch).toBe(rootMod.Switch);
    expect(primMod.Tabs).toBe(rootMod.Tabs);
    expect(primMod.Avatar).toBe(rootMod.Avatar);
    expect(primMod.Badge).toBe(rootMod.Badge);
  });
});
