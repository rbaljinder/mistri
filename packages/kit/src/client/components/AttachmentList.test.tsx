/**
 * The attachments list: files by name with a Download each, a preview for
 * what a browser can show, rename and remove where allowed, the cap said
 * before a byte is read, and a drop or a pick sending each file in turn.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AttachmentList, fileToBase64 } from './AttachmentList.js';
import { previewKind } from './filePreviewModel.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const items = [
  { id: '1', name: 'repro-steps.txt', href: '/api/file?table=attachment&key=%7B%22id%22%3A1%7D', meta: ['87 bytes', 'yesterday'] },
  { id: '2', name: 'layout', href: '/api/file?table=attachment&key=%7B%22id%22%3A2%7D', meta: [] },
];
const file = (name: string, size: number) => new File([new Uint8Array(size)], name, { type: 'text/plain' });

test('each file has a Download under its own name, with its size and when it came', () => {
  render(<AttachmentList items={items} emptyText="No attachments yet." />);
  const link = screen.getByRole('link', { name: 'Download repro-steps.txt' });
  expect(link).toHaveAttribute('href', items[0].href);
  expect(link).toHaveAttribute('download', 'repro-steps.txt');
  // A file with no viewer is its own download; one with a viewer opens in it.
  expect(screen.getByRole('link', { name: 'layout' })).toHaveAttribute('download', 'layout');
  expect(screen.getByRole('button', { name: 'repro-steps.txt' })).toBeInTheDocument();
  expect(screen.getByText('87 bytes · yesterday')).toBeInTheDocument();
  expect(screen.getByText('TXT')).toBeInTheDocument();
  expect(screen.getByText('FILE')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Attach/ })).toBeNull();
  // Nothing may be changed here, so no More menu is drawn.
  expect(screen.queryByRole('button', { name: /^More for/ })).toBeNull();
});

test('which viewer a file opens in comes from its name or its stored type; the rest are downloads', () => {
  expect(previewKind('photo.JPG')).toBe('image');
  expect(previewKind('scan', 'application/pdf')).toBe('pdf');
  expect(previewKind('crash-report.json')).toBe('text');
  expect(previewKind('notes', 'text/plain')).toBe('text');
  // A file name, not a selector: kept off the assertion's line so the absent-element check does not read it as one.
  const archive = 'bundle.zip';
  expect(previewKind(archive)).toBeUndefined();
  expect(previewKind('icon.svg')).toBeUndefined();
});

test('a text file previews its text, read from the download address', async () => {
  const fetched = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('line one\nline two', { status: 200 }));
  render(<AttachmentList items={items} emptyText="" />);
  fireEvent.click(screen.getByRole('button', { name: 'repro-steps.txt' }));
  expect(await screen.findByLabelText('repro-steps.txt')).toHaveTextContent('line one line two');
  expect(fetched).toHaveBeenCalledWith(items[0].href, expect.objectContaining({ credentials: 'same-origin' }));
  expect(screen.getByRole('dialog', { name: 'Preview of repro-steps.txt' })).toBeInTheDocument();
});

test('a file named as a PDF whose bytes are not one is refused, not framed', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>hi</html>', { status: 200 }));
  render(<AttachmentList items={[{ id: '9', name: 'invoice.pdf', href: '/api/file?p', meta: [] }]} emptyText="" />);
  fireEvent.click(screen.getByRole('button', { name: 'invoice.pdf' }));
  expect(await screen.findByText('This file is named as a PDF, but it is not one.')).toBeInTheDocument();
  expect(document.querySelector('iframe')).toBeNull();
});

test('rename edits the name in its row and says why the server refused', async () => {
  const rename = vi.fn(async (name: string) => (name === 'taken.txt' ? 'That name is taken.' : null));
  render(<AttachmentList items={[{ ...items[0], rename }]} emptyText="" />);
  fireEvent.click(screen.getByRole('button', { name: 'More for repro-steps.txt' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
  const box = await screen.findByLabelText('File name');
  fireEvent.change(box, { target: { value: 'taken.txt' } });
  fireEvent.submit(box.closest('form')!);
  expect(await screen.findByText('That name is taken.')).toBeInTheDocument();
  fireEvent.change(box, { target: { value: 'steps.txt' } });
  fireEvent.submit(box.closest('form')!);
  await vi.waitFor(() => expect(screen.queryByLabelText('File name')).toBeNull());
  expect(rename).toHaveBeenLastCalledWith('steps.txt');
});

test('remove asks first, says Undo cannot bring the file back, and Keep sends nothing', async () => {
  const remove = vi.fn(async () => null);
  render(<AttachmentList items={[{ ...items[0], remove }]} emptyText="" />);
  fireEvent.click(screen.getByRole('button', { name: 'More for repro-steps.txt' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove…' }));
  expect(await screen.findByText(/Undo cannot bring it back/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
  expect(remove).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(screen.queryByText(/Undo cannot bring it back/)).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'More for repro-steps.txt' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove…' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
  await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
});

test('a picked file past the cap is refused with the reason and never sent; the rest are sent in turn', async () => {
  const send = vi.fn(async () => null);
  render(<AttachmentList items={[]} emptyText="No attachments yet." upload={{ label: 'Attach file', maxBytes: 2048, send }} />);
  expect(screen.getByText('No attachments yet.')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Attach file'), { target: { files: [file('a.txt', 10), file('huge.bin', 5000)] } });
  expect(await screen.findByRole('alert')).toHaveTextContent('“huge.bin” is over the 2 kB limit for a file.');
  expect(send).toHaveBeenCalledTimes(1);
  expect((send.mock.calls[0] as unknown as [File])[0].name).toBe('a.txt');
});

test('files dropped on the list are sent, and a refusal from the server is said', async () => {
  const send = vi.fn(async (picked: File) => (picked.name === 'b.txt' ? 'This resource is read-only.' : null));
  render(<AttachmentList items={items} emptyText="" upload={{ label: 'Attach file', maxBytes: 1 << 20, send }} />);
  const list = document.querySelector('.attachments')!;
  fireEvent.dragOver(list, { dataTransfer: { types: ['Files'], files: [] } });
  expect(list).toHaveClass('is-over');
  fireEvent.drop(list, { dataTransfer: { types: ['Files'], files: [file('a.txt', 3)] } });
  expect(await screen.findByRole('status')).toHaveTextContent('Attached “a.txt”');
  expect(list).not.toHaveClass('is-over');
  fireEvent.drop(list, { dataTransfer: { types: ['Files'], files: [file('b.txt', 3)] } });
  expect(await screen.findByRole('alert')).toHaveTextContent('This resource is read-only.');
});

test('bytes cross as base64', async () => {
  expect(await fileToBase64(new Blob([new Uint8Array([0, 255, 104, 105])]))).toBe('AP9oaQ==');
});

test('authored empty guidance keeps the upload control usable', async () => {
  const send = vi.fn(async () => null);
  render(
    <AttachmentList
      items={[]}
      emptyText="No attachments yet."
      empty={
        <div>
          <h2>Add supporting documents</h2>
          <p>Attach a file to this record.</p>
        </div>
      }
      upload={{ label: 'Attach file', maxBytes: 2048, send }}
    />,
  );
  expect(screen.getByRole('heading', { name: 'Add supporting documents' })).toBeVisible();
  expect(screen.queryByText('No attachments yet.')).toBeNull();
  expect(screen.getByRole('button', { name: '+ Attach file' })).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Attach file'), { target: { files: [file('proof.txt', 10)] } });
  expect(await screen.findByRole('status')).toHaveTextContent('Attached “proof.txt”');
  expect(send).toHaveBeenCalledOnce();
});

test('a file on a tenant lease is saved from the lease, never followed to the file route (which a lease cannot open)', () => {
  const save = vi.fn().mockResolvedValue(undefined);
  const fetched = vi.spyOn(globalThis, 'fetch');
  render(<AttachmentList items={[{ ...items[0], save }]} emptyText="" />);
  const link = screen.getByRole('link', { name: 'Download repro-steps.txt' });
  // fireEvent.click returns false when the click's default (following the link) was prevented.
  expect(fireEvent.click(link)).toBe(false);
  expect(save).toHaveBeenCalledOnce();
  // No viewer either: a viewer reads its file by address, and a leased file has none.
  expect(screen.queryByRole('button', { name: 'repro-steps.txt' })).toBeNull();
  expect(fetched).not.toHaveBeenCalled();
});
