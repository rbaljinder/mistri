/**
 * Export's place while its part is on the way: the held trigger is drawn
 * unseen, and the real control takes its place once the part has arrived.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';

const part = vi.hoisted(() => {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { gate, open };
});
vi.mock('./Export.js', async () => {
  await part.gate;
  return {
    ExportControl: () => (
      <div className="export" data-stub="export">
        the control
      </div>
    ),
  };
});

const { ExportControl } = await import('./ExportHold.js');

afterEach(cleanup);

test('the held trigger stands in until the part arrives, then the real control replaces it', async () => {
  const { container } = render(
    <ExportControl entry={{ table: 'lead', query: 'lead' } as never} data={{ table: 'lead', columns: [], rows: [] } as never} />,
  );
  const held = container.querySelector('.export') as HTMLElement;
  expect(held).not.toBeNull();
  expect(held).toHaveAttribute('aria-hidden', 'true');
  expect(held.style.visibility).toBe('hidden');
  expect(container.querySelector('[data-stub="export"]')).toBeNull();
  await act(async () => part.open());
  await waitFor(() => expect(container.querySelector('[data-stub="export"]')).not.toBeNull());
  expect(container.querySelectorAll('.export')).toHaveLength(1);
  expect(container.querySelector('[aria-hidden="true"].export')).toBeNull();
});
