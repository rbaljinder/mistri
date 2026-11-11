/**
 * `useFile` in a tenant App. A field report: a free-form page's pictures stayed empty, because the address it gave
 * was the file route (`/api/file?table=…`), and an `<img>` sends no lease, so a tenant's server refuses it. On a
 * lease the file is read as the shell's own attachments are (`/api/file/read`, under the reader's grants) into a blob,
 * and the page draws again with the blob's address; on an App's own server it is still the file route.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  identity: { tenantRequired: true } as { tenantRequired: boolean },
  reads: [] as unknown[],
}));
vi.mock('@mistriwork/kit/client/sessionIdentity.js', async (original) => ({
  ...(await original<object>()),
  captureSessionIdentity: () => mocks.identity,
}));
vi.mock('@mistriwork/kit/client/core.js', async (original) => ({
  ...(await original<object>()),
  api: async (path: string, body: unknown) => {
    mocks.reads.push([path, body]);
    return { name: 'face.png', type: 'image/png', data: btoa('png') };
  },
}));

const { state } = await import('@mistriwork/kit/client/core.js');
const { useFile } = await import('./hooks.js');
await import('./host.js');

let blobs = 0;
URL.createObjectURL = () => `blob:test/${++blobs}`;
URL.revokeObjectURL = () => {};
(state as { schema: unknown }).schema = {
  tables: [{ id: 'photo', name: 'photo', columns: [{ name: 'id', type: 'integer', pk: true }] }],
  foreignKeys: [],
};

function Face({ id, thumbnail }: { id: number; thumbnail?: boolean }) {
  const file = useFile('photo');
  const src = file({ id }, { thumbnail });
  return src ? <img alt={`face ${id}`} src={src} /> : <span>reading {id}</span>;
}

afterEach(() => {
  cleanup();
  mocks.reads.length = 0;
});

describe('a free-form page draws a file', () => {
  test("in a tenant App, from a blob read on the reader's lease, and once", async () => {
    mocks.identity = { tenantRequired: true };
    render(
      <>
        <Face id={4} />
        <Face id={4} />
        <Face id={5} thumbnail />
      </>,
    );
    expect(screen.getAllByText(/reading/)).toHaveLength(3);
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(3));
    const drawn = screen.getAllByRole('img').map((img) => img.getAttribute('src'));
    expect(drawn.every((src) => src?.startsWith('blob:'))).toBe(true);
    expect(drawn[0]).toBe(drawn[1]);
    expect(mocks.reads).toEqual([
      ['/api/file/read', { table: 'photo', key: { id: 4 }, inline: true }],
      ['/api/file/read', { table: 'photo', key: { id: 5 }, inline: true, variant: 'thumb' }],
    ]);
  });

  test("on an App's own server, by the file route, with nothing read first", () => {
    mocks.identity = { tenantRequired: false };
    render(<Face id={4} thumbnail />);
    const src = screen.getByRole('img').getAttribute('src')!;
    expect(src).toMatch(/^\/api\/file\?/);
    expect(Object.fromEntries(new URL(src, 'http://x').searchParams)).toMatchObject({
      table: 'photo',
      key: '{"id":4}',
      inline: '1',
      variant: 'thumb',
    });
    expect(mocks.reads).toEqual([]);
  });
});
