/**
 * A public form's page loads the App's own input components from where its payload says they are served: a field
 * drawn by one shows the platform's control until the module arrives, then the component, and an id the payload does
 * not serve stays the platform's.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, renderHook, screen } from '@testing-library/react';
import { resetShell, shell } from '@mistriwork/kit/client/shellMode.js';
import { InputSlot } from '@mistriwork/kit/client/components/inputRenderers.js';

const loaded: Array<[string, unknown]> = [];
vi.mock('./componentLoader.js', () => ({
  loadServedComponent: (id: string, entry: unknown) => {
    loaded.push([id, entry]);
    return Promise.resolve(({ label, value }: { label: string; value: unknown }) => (
      <output data-swatch={id}>
        {label}: {String(value)}
      </output>
    ));
  },
}));

afterEach(() => {
  cleanup();
  resetShell();
  loaded.length = 0;
});

test('the served ids load from their payload address; any other is the shell’s as before', async () => {
  const { installPublicInputs } = await import('./publicInputs.js');
  installPublicInputs({
    swatch: { href: '/paints/_components/swatch-0123456789ab.js', css: '/paints/_components/swatch-0123456789ab.css' },
  });
  render(
    <InputSlot
      component="swatch"
      fallback={<input aria-label="Color" />}
      value="tomato"
      onChange={() => {}}
      id="c-color"
      invalid={false}
      disabled={false}
      required={false}
      label="Color"
      field={{ name: 'color' }}
      context="command"
    />,
  );
  // The platform's control stands in until the module is here.
  expect(screen.getByLabelText('Color')).toBeInTheDocument();
  expect(await screen.findByText('Color: tomato')).toHaveAttribute('data-swatch', 'swatch');
  expect(loaded).toEqual([
    ['swatch', { href: '/paints/_components/swatch-0123456789ab.js', css: '/paints/_components/swatch-0123456789ab.css' }],
  ]);
  await expect(shell().components.load('dial')).resolves.toBeNull();
  expect(loaded).toHaveLength(1);
});

test('a form that draws one installs the loader as it arrives; one that draws none fetches nothing', async () => {
  const { formArrives } = await import('../FormSurface.js');
  const before = shell().components;
  await formArrives({ input: [] });
  expect(shell().components).toBe(before);
  await formArrives({ input: [], components: { swatch: { href: '/paints/_components/swatch-0123456789ab.js' } } });
  expect(shell().components).not.toBe(before);
  await shell().components.load('swatch');
  expect(loaded.map(([id]) => id)).toEqual(['swatch']);
});

test('a component on a public form says the catalog served beside it, in the visitor’s words', async () => {
  const { formArrives } = await import('../FormSurface.js');
  const { useHostIfAny } = await import('./context.js');
  await import('./host.js');
  const said = () => renderHook(() => useHostIfAny()).result.current?.message('swatch.pick', { count: 2 });
  // No App payload reaches the page, and nothing was served beside the form: the key is said as itself.
  expect(said()).toBe('swatch.pick');
  await formArrives({
    input: [],
    components: { swatch: { href: '/paints/_components/swatch-0123456789ab.js' } },
    messages: {
      'swatch.pick': [
        { type: 0, value: 'Elige ' },
        { type: 1, value: 'count' },
      ],
    },
  });
  expect(said()).toBe('Elige 2');
});
