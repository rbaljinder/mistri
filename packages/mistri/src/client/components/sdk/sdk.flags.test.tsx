import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { startTransition, StrictMode, Suspense } from 'react';
import { renderToString } from 'react-dom/server';
import type { AppFlagReader } from '../../../shared/appFlagValues.js';
import { createAppFlagsState } from '../../appFlags.js';
import { UiHostContext } from './context.js';
import { fixtureHost, fixtures } from './fixture.js';
import { renderSection } from './testing.js';
import { useVisitor, useFlags } from './hooks.js';

afterEach(cleanup);

test('visitor hook waits for an explicit authored action', async () => {
  const establishVisitor = vi.fn(async () => {}),
    fixture = fixtureHost(fixtures({}), {}, []);
  function OptIn() {
    const visitor = useVisitor();
    return (
      <button
        onClick={() => {
          void visitor.start();
        }}
      >
        Start preview
      </button>
    );
  }
  render(
    <UiHostContext.Provider value={{ ...fixture, flags: { ...fixture.flags, establishVisitor } }}>
      <OptIn />
    </UiHostContext.Provider>,
  );
  expect(establishVisitor).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start preview' }));
  });
  expect(establishVisitor).toHaveBeenCalledTimes(1);
});

function Component() {
  const flags = useFlags<{ copy: 'a' | 'b'; enabled: boolean }>();
  return <p>{flags.ready ? `${flags.get('copy')}:${flags.get('enabled')}` : 'Loading flags'}</p>;
}
test('SDK fixture flags use the same readonly get API without exposure side effects', () => {
  renderSection(Component, { component: { id: 'flags' } }, { flags: { copy: 'b', enabled: false } });
  expect(screen.getByText('b:false')).toBeInTheDocument();
});
test('hook subscribes to lazy state and retires rendered values synchronously with the owner', async () => {
  let active = true;
  const read = vi.fn(async () => ({ values: { copy: 'a', enabled: true }, version: { global: 1, tenant: null } }));
  const source = createAppFlagsState({ capture: () => ({ appId: 'desk', current: () => active }), read });
  const host = { ...fixtureHost(fixtures({}), {}, []), flags: source };
  render(
    <UiHostContext.Provider value={host}>
      <Component />
    </UiHostContext.Provider>,
  );
  expect(await screen.findByText('a:true')).toBeInTheDocument();
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => {
    active = false;
    source.retire();
  });
  expect(screen.getByText('Loading flags')).toBeInTheDocument();
  expect(read).toHaveBeenCalledTimes(1);
});

const receipt = (name: string) => `ar1.${'a'.repeat(50)}${name}`;
async function exposureHost() {
  const send = vi.fn(async (receipts: readonly string[]) => ({
    outcomes: receipts.map(() => 'recorded'),
    coverage: { received: receipts.length, recorded: receipts.length, duplicate: 0, failed: 0, unknown: 0, dropped: 0 },
  }));
  const source = createAppFlagsState({
    capture: () => ({ appId: 'desk', current: () => true }),
    read: async () => ({
      values: { visible: 'a', abandoned: 'b', next: 'c', untracked: false },
      version: { global: 1, tenant: null },
      assignmentReceipts: { visible: receipt('visible'), abandoned: receipt('abandoned'), next: receipt('next') },
    }),
    exposure: () => ({ current: () => true, send }),
  });
  await source.load();
  return { source, send, host: { ...fixtureHost(fixtures({}), {}, []), flags: source } };
}

test('only committed get reads report; StrictMode/repeated reads dedupe, imperative reads and SSR are passive', async () => {
  const { source, send, host } = await exposureHost();
  let retained!: AppFlagReader;
  function Consumer() {
    const flags = (retained = useFlags());
    const value = flags.get('visible');
    flags.get('visible');
    flags.get('untracked');
    return <span>{String(value)}</span>;
  }
  source.get('next');
  source.snapshot().get('abandoned');
  const html = renderToString(
    <UiHostContext.Provider value={host}>
      <Consumer />
    </UiHostContext.Provider>,
  );
  expect(html).not.toContain('ar1.');
  await Promise.resolve();
  expect(send).not.toHaveBeenCalled();
  const view = render(
    <StrictMode>
      <UiHostContext.Provider value={host}>
        <Consumer />
        <Consumer />
      </UiHostContext.Provider>
    </StrictMode>,
  );
  await act(async () => {});
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toEqual([receipt('visible')]);
  retained.get('next');
  source.get('abandoned');
  await act(async () => {});
  expect(send).toHaveBeenCalledTimes(1);
  view.rerender(
    <StrictMode>
      <UiHostContext.Provider value={host}>
        <Consumer />
      </UiHostContext.Provider>
    </StrictMode>,
  );
  await act(async () => {});
  expect(send).toHaveBeenCalledTimes(1);
});

test('a genuinely attempted suspended transition does not contaminate the committed render consumption set', async () => {
  const { send, host } = await exposureHost(),
    never = new Promise<void>(() => {});
  let abandonedReads = 0;
  function Consumer({ name, suspend = false }: { name: string; suspend?: boolean }) {
    const flags = useFlags(),
      value = flags.get(name);
    if (suspend) {
      abandonedReads++;
      throw never;
    }
    return <span>{String(value)}</span>;
  }
  const tree = (name: string, suspend = false) => (
    <UiHostContext.Provider value={host}>
      <Suspense fallback={<p>Waiting</p>}>
        <Consumer name={name} suspend={suspend} />
      </Suspense>
    </UiHostContext.Provider>
  );
  const view = render(tree('visible'));
  await act(async () => {});
  await act(async () => {
    startTransition(() => {
      view.rerender(tree('abandoned', true));
    });
  });
  expect(abandonedReads).toBeGreaterThan(0);
  expect(screen.getByText('a')).toBeInTheDocument();
  expect(send.mock.calls.flatMap((call) => call[0])).toEqual([receipt('visible')]);
  await act(async () => {
    view.rerender(tree('next'));
  });
  expect(screen.getByText('c')).toBeInTheDocument();
  expect(send.mock.calls.flatMap((call) => call[0])).toEqual([receipt('visible'), receipt('next')]);
});

test('initial suspended render and retired retained lifecycle readers produce no observation', async () => {
  const { source, send, host } = await exposureHost(),
    never = new Promise<void>(() => {});
  function Suspended(): never {
    useFlags().get('abandoned');
    throw never;
  }
  const view = render(
    <UiHostContext.Provider value={host}>
      <Suspense fallback={<p>Suspended</p>}>
        <Suspended />
      </Suspense>
    </UiHostContext.Provider>,
  );
  await act(async () => {});
  expect(send).not.toHaveBeenCalled();
  view.unmount();
  const reader = source.snapshot();
  source.retire();
  source.commitUse(reader, ['visible']);
  await Promise.resolve();
  expect(send).not.toHaveBeenCalled();
});
