/* `useReadAudit(filters)`: the Reads room's log through the page's query cache, a page at a time below `next`, the
   route's refusal heard as an error with no lines drawn, and an empty log outside a tenant App. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { fixtureHost, fixtures } from './fixture.js';
import { UiHostContext } from './context.js';
import { useReadAudit } from './readAudit.js';
import type { ReadAuditAccess, ReadAuditLine, ReadAuditPage } from '../../readAuditTypes.js';

const wrapperFor = (reads?: ReadAuditAccess) => {
  const host = fixtureHost(fixtures({}), { look: 'mono', ...(reads ? { reads } : {}) }, []);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>
      <UiHostContext.Provider value={host}>{children}</UiHostContext.Provider>
    </QueryClientProvider>
  );
};

const line = (id: number, extra: Partial<ReadAuditLine> = {}): ReadAuditLine => ({
  id,
  at: `2026-11-01T00:0${id}:00.000Z`,
  actor: 'alice',
  person: 'Alice North',
  roles: ['viewer'],
  membership: 'north-alice',
  resource: 'patient',
  route: 'page',
  kind: 'opened',
  record: '7',
  ...extra,
});

/** Two pages below the newest: 4 and 3, then 2 and 1. */
const paged = (): ReadAuditAccess & { asked: unknown[] } => {
  const asked: unknown[] = [];
  return {
    asked,
    read: async (filters) => {
      asked.push(filters);
      const page: ReadAuditPage =
        filters.before === undefined
          ? { reads: [line(4), line(3, { route: 'command', command: 'close' })], next: 3, resources: ['patient'] }
          : { reads: [line(2, { actor: 'api-token:tok-1', person: undefined }), line(1)], resources: ['patient'] };
      return page;
    },
  };
};

test('outside a tenant App the log is empty and nothing is wrong', async () => {
  const { result } = renderHook(() => useReadAudit(), { wrapper: wrapperFor() });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current).toMatchObject({ reads: [], next: undefined, error: null });
});

test('it says the lines, with the filters asked, and reads the page below `next` onto the end', async () => {
  const access = paged();
  const { result } = renderHook(() => useReadAudit({ resource: 'patient', record: '7' }), { wrapper: wrapperFor(access) });
  await waitFor(() => expect(result.current.reads).toHaveLength(2));
  expect(access.asked[0]).toEqual({ actor: undefined, resource: 'patient', record: '7', since: undefined, until: undefined });
  expect(result.current.next).toBe(3);
  expect(result.current.reads[1]).toMatchObject({
    id: 3,
    route: 'command',
    command: 'close',
    roles: ['viewer'],
    membership: 'north-alice',
  });
  act(() => result.current.more());
  await waitFor(() => expect(result.current.reads.map((read) => read.id)).toEqual([4, 3, 2, 1]));
  expect(access.asked[1]).toMatchObject({ resource: 'patient', record: '7', before: 3 });
  expect(result.current.next).toBeUndefined();
  // The last page has been read: asking for more asks nothing.
  act(() => result.current.more());
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(access.asked).toHaveLength(2);
});

test('a page asked from a line reads below it', async () => {
  const access = paged();
  const { result } = renderHook(() => useReadAudit({ before: 3 }), { wrapper: wrapperFor(access) });
  await waitFor(() => expect(result.current.reads.map((read) => read.id)).toEqual([2, 1]));
  expect(access.asked[0]).toMatchObject({ before: 3 });
});

function Log() {
  const { reads, error } = useReadAudit({ record: '7' });
  if (error) return <p role="alert">{error.message}</p>;
  return (
    <ul>
      {reads.map((read) => (
        <li key={read.id}>{read.person ?? read.actor}</li>
      ))}
    </ul>
  );
}

test("a reader outside the admins' gate hears the route's refusal and is given no lines", async () => {
  const refused = Object.assign(new Error("Only this organization's admins may read who saw its records."), {
    status: 403,
    code: 'forbidden',
  });
  const read = vi.fn(async () => Promise.reject(refused));
  const Wrapper = wrapperFor({ read });
  render(
    <Wrapper>
      <Log />
    </Wrapper>,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent("Only this organization's admins may read who saw its records.");
  expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  // Refused once, not retried: the refusal is the answer.
  expect(read).toHaveBeenCalledTimes(1);
  const { result } = renderHook(() => useReadAudit({ record: '7' }), { wrapper: wrapperFor({ read }) });
  await waitFor(() => expect(result.current.error).toBe(refused));
  expect(result.current).toMatchObject({ reads: [], next: undefined, loading: false });
  expect((result.current.error as Error & { status?: number }).status).toBe(403);
});
