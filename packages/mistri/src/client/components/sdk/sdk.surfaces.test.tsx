/**
 * `@mistriwork/mistri/ui` past sections and values: a command recorded rather than
 * sent (and granted to no signed-out reader), a list component handed a page
 * of rows and a selection only when the list offers one, a free-form page
 * keeping its place in its address, drawn with its loader's data and reading
 * and running only what it declared, an input handing
 * its value back to the form, an input that throws giving way to the
 * platform's control, and a breakdown keyed as the server keys one.
 */
import { describe, expect, test, vi } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import { fixtures, renderInput, renderList, renderPage, renderSection } from './testing.js';
import { useBreakdown, useCommand } from './hooks.js';
import { CommandForm, definePage } from './page.js';

describe('commands, inputs, lists and pages', () => {
  test('a command is recorded, not sent, and a signed-out reader is granted none', async () => {
    const Ask = () => {
      const react = useCommand('react');
      return (
        <button
          type="button"
          disabled={!react.granted || react.available({ id: 1 }) !== true}
          onClick={() => {
            void react.run({ id: 1 }, { kind: 'like' });
          }}
        >
          {react.label}
        </button>
      );
    };
    const signedIn = renderSection(
      Ask,
      { component: { id: 'ask' } },
      { viewer: { signedIn: true, account: 'a' }, commands: { react: { label: 'React' } } },
    );
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'React' })).not.toBeDisabled());
    screen.getByRole('button', { name: 'React' }).click();
    expect(signedIn.commands).toEqual([{ command: 'react', mode: 'run', key: { id: 1 }, input: { kind: 'like' } }]);
    renderSection(Ask, { component: { id: 'ask' } }, { commands: { react: { label: 'React' } } });
    await new Promise((done) => setTimeout(done, 20));
    expect(screen.getByRole('button', { name: 'React' })).toBeDisabled();
  });

  test('a command says why it cannot be run before any click: signed out, not granted, or its `when` not holding', async () => {
    const Why = () => {
      const react = useCommand('react');
      return <p>{[1, 2].map((id) => `${id}:${react.reason({ id }) ?? 'ok'}`).join(' ')}</p>;
    };
    const served = { react: { label: 'React', available: (key: Readonly<Record<string, unknown>>) => key.id === 1 } };
    renderSection(Why, { component: { id: 'why' } }, { viewer: { signedIn: true, account: 'a' }, commands: served });
    // Until the server has said, nothing is said; then only the record whose `when` fails is unavailable.
    expect(await screen.findByText('1:ok 2:unavailable')).toBeInTheDocument();
    renderSection(Why, { component: { id: 'why' } }, { viewer: { signedIn: true, account: 'b' }, commands: {} });
    expect(await screen.findByText('1:not-granted 2:not-granted')).toBeInTheDocument();
    renderSection(Why, { component: { id: 'why' } }, { commands: served });
    expect(await screen.findByText('1:signed-out 2:signed-out')).toBeInTheDocument();
  });

  test('a list component is handed a page of rows with its show, and a selection only when the list offers one', () => {
    const Rows = ({
      rows,
      page,
      selection,
    }: {
      rows: Array<{ id: number; name: string }>;
      page: { index: number; more: boolean };
      selection?: { count: number };
    }) => (
      <p>
        {rows.map((row) => row.name).join(',')} page={page.index} more={String(page.more)} select={selection ? selection.count : 'none'}
      </p>
    );
    const view = { from: 'person', presentation: { component: { id: 'rows' }, show: ['name'] }, sort: 'name' };
    const data = fixtures({
      person: [
        { id: 1, name: 'Cy' },
        { id: 2, name: 'Ann' },
        { id: 3, name: 'Bo' },
      ],
    });
    renderList(Rows, view, { data, page: { index: 0, size: 2 } });
    expect(screen.getByText('Ann,Bo page=0 more=true select=none')).toBeInTheDocument();
    renderList(Rows, view, { data, page: { index: 1, size: 2 }, selection: true });
    expect(screen.getByText('Cy page=1 more=false select=0')).toBeInTheDocument();
  });

  test('a page keeps its place in its address, reads only what it declared, and refuses a parameter it did not', async () => {
    const walk = (fields: { reads: string[]; params: string[] }) => {
      const page = definePage({
        label: 'Walk',
        ...fields,
        component: (): ReactElement => {
          const [step, setStep] = page.useParam('step');
          const people = page.useRows('person', { show: ['name'] });
          return (
            <button type="button" onClick={() => setStep(Number(step ?? 0) + 1)}>
              step {step ?? 'none'} of {people.data?.length ?? '…'}
            </button>
          );
        },
      });
      return page;
    };
    renderPage(walk({ reads: ['person'], params: ['step'] }), { data: fixtures({ person: [{ name: 'Ann' }] }), address: { step: '2' } });
    await screen.findByText('step 2 of 1');
    screen.getByRole('button').click();
    expect(await screen.findByText('step 3 of 1')).toBeInTheDocument();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderPage(walk({ reads: ['task'], params: ['step'] }))).toThrow(/reads "task"; "person" is not one of them/);
    expect(() => renderPage(walk({ reads: ['person'], params: [] }))).toThrow(/keeps no parameters in its address; add "step"/);
    errors.mockRestore();
  });

  test("a page is drawn with its loader's data, and runs only the commands it declared", async () => {
    const page = definePage<{ waiting: number }>({
      label: 'Floor',
      reads: ['pick_list'],
      commands: ['pickList'],
      loader: 'floor',
      component: ({ data }) => (
        <>
          <p>{data.waiting} waiting</p>
          <CommandForm command="pickList" record={{ id: 7 }} />
        </>
      ),
    });
    const drawn = renderPage(page, {
      loaded: { waiting: 3 },
      viewer: { signedIn: true, account: 'a' },
      commands: { pickList: { label: 'Pick' } },
    });
    expect(screen.getByText('3 waiting')).toBeInTheDocument();
    (await screen.findByRole('button', { name: 'Pick' })).click();
    expect(drawn.commands).toEqual([{ command: 'pickList', mode: 'open', key: { id: 7 } }]);
    const stray = definePage({ label: 'Stray', reads: ['pick_list'], component: () => <CommandForm command="pickList" /> });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderPage(stray)).toThrow(/runs no commands; "pickList" is not one of them/);
    expect(() => definePage({ label: 'X', reads: [], rooms: [], component: () => null })).toThrow(/definePage has no "rooms"/);
    // The file's name is the page's path, so a page does not say one.
    expect(() => definePage({ path: 'x', label: 'X', reads: [], component: () => null })).toThrow(/definePage has no "path"/);
    errors.mockRestore();
  });

  test('an input hands its value back to the form, which keeps it', () => {
    const Swatch = ({ value, onChange, label }: { value: string | null; onChange(value: string): void; label: string }) => (
      <button type="button" aria-label={label} onClick={() => onChange(value === 'red' ? 'blue' : 'red')}>
        {value}
      </button>
    );
    const view = renderInput(Swatch, { id: 'swatch' }, { value: 'red', name: 'color', label: 'Color' });
    screen.getByRole('button', { name: 'Color' }).click();
    expect(view.changes).toEqual(['blue']);
    expect(view.value()).toBe('blue');
  });

  test("an input slot draws the platform's control until the module arrives, and for good when it throws", async () => {
    vi.resetModules();
    const Throws = () => {
      throw new Error('input broke');
    };
    vi.doMock('./componentLoader.js', () => ({ loadComponent: () => Promise.resolve(Throws) }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { InputSlot } = await import('../../../../../kit/src/client/components/inputRenderers.js');
    /* The App shell's components (appnav.js), installed into the module graph just reset. */
    const { installShell } = await import('../../../../../kit/src/client/shellMode.js');
    installShell({ components: (await import('./appComponents.js')).appComponents });
    render(
      <InputSlot
        component="broken"
        fallback={<input aria-label="plain" />}
        value="x"
        onChange={() => {}}
        id="i"
        invalid={false}
        disabled={false}
        required={false}
        label="Color"
        field={{ name: 'color' }}
        context="edit"
      />,
    );
    expect(screen.getByLabelText('plain')).toBeInTheDocument();
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(expect.stringContaining('the input "broken" threw'), expect.anything()));
    expect(screen.getByLabelText('plain')).toBeInTheDocument();
    errors.mockRestore();
    vi.doUnmock('./componentLoader.js');
  });

  test('a breakdown is keyed as the server keys one', async () => {
    const Counted = () => {
      const got = useBreakdown('move', { by: 'product_id, day moved_at', measure: 'max after' });
      return <p>{JSON.stringify(got.data ?? null)}</p>;
    };
    renderSection(
      Counted,
      { component: { id: 'c' } },
      {
        data: fixtures({
          move: [
            { product_id: 1, moved_at: '2026-09-01T10:00:00Z', after: 4 },
            { product_id: 1, moved_at: '2026-09-01T12:00:00Z', after: 9 },
          ],
        }),
      },
    );
    expect(await screen.findByText('[{"product_id":1,"day(moved_at)":"2026-09-01","max(after)":9}]')).toBeInTheDocument();
  });
});
