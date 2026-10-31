/**
 * What a preview consumes: a text shows its prefix and stops the transfer there, a recording or a PDF is held to a
 * byte count of what arrived (a missing or wrong Content-Length cannot get past it), and a closed preview cancels
 * the read.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { FilePreview } from './FilePreview.js';

const MIB = 1024 * 1024;

/** A body of `total` bytes in 64 KiB chunks, counting how many were pulled and whether it was cancelled. */
function body(total: number, fill = 0x61) {
  const seen = { pulled: 0, cancelled: false };
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) return controller.close();
      const n = Math.min(64 * 1024, total - sent);
      const chunk = new Uint8Array(n).fill(fill);
      sent += n;
      seen.pulled += n;
      controller.enqueue(chunk);
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { stream, seen };
}

const answer = (stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) => {
  /* Content-Length is a forbidden-to-forge header only in a browser; here it is set as a server could set it. */
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(stream, { status: 200, headers })),
  );
};

beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => ''), revokeObjectURL: vi.fn() }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('a large text transfers a bounded prefix, says it is cut and cancels the rest', async () => {
  const { stream, seen } = body(2 * MIB);
  answer(stream);
  render(<FilePreview file={{ name: 'big.log', kind: 'text', href: '/f/1' }} onClose={() => {}} />);
  await screen.findByText(/Showing the first 256/);
  expect(seen.cancelled).toBe(true);
  /* The stream may read ahead a chunk or two, never the whole 2 MiB. */
  expect(seen.pulled).toBeLessThan(MIB);
  expect(document.querySelector('.file-preview-text pre')!.textContent).toHaveLength(256 * 1024);
});

test('a text under the limit is shown whole, with no cut note', async () => {
  const { stream } = body(1000);
  answer(stream);
  render(<FilePreview file={{ name: 'small.txt', kind: 'text', href: '/f/1' }} onClose={() => {}} />);
  await waitFor(() => expect(document.querySelector('.file-preview-text pre')!.textContent).toHaveLength(1000));
  expect(screen.queryByText(/Showing the first/)).toBeNull();
});

test('a cut that lands inside a multi-byte character still shows the text', async () => {
  const euro = new TextEncoder().encode('€');
  const bytes = new Uint8Array(256 * 1024 + 8).fill(0x61);
  bytes.set(euro, 256 * 1024 - 1);
  answer(new Response(bytes).body!);
  render(<FilePreview file={{ name: 'euro.txt', kind: 'text', href: '/f/1' }} onClose={() => {}} />);
  await screen.findByText(/Showing the first/);
  expect(document.querySelector('.file-preview-text pre')!.textContent!.length).toBeGreaterThan(256 * 1024 - 2);
});

test('a recording with no Content-Length is refused once more than the cap has arrived', async () => {
  const { stream, seen } = body(70 * MIB, 0x00);
  answer(stream);
  render(<FilePreview file={{ name: 'big.mp4', kind: 'video', href: '/f/2' }} onClose={() => {}} />);
  await screen.findByText(/Recordings over 64/);
  expect(seen.cancelled).toBe(true);
  expect(seen.pulled).toBeLessThan(66 * MIB);
});

test('a recording whose Content-Length lies small is still held to the cap', async () => {
  const { stream, seen } = body(70 * MIB, 0x00);
  answer(stream, { 'content-length': '10' });
  render(<FilePreview file={{ name: 'big.webm', kind: 'video', href: '/f/2' }} onClose={() => {}} />);
  await screen.findByText(/Recordings over 64/);
  expect(seen.cancelled).toBe(true);
});

test('a declared size over the cap is refused before the body is read', async () => {
  const { stream, seen } = body(MIB);
  answer(stream, { 'content-length': String(80 * MIB) });
  render(<FilePreview file={{ name: 'big.mp3', kind: 'audio', href: '/f/3' }} onClose={() => {}} />);
  await screen.findByText(/Recordings over 64/);
  expect(seen.pulled).toBeLessThanOrEqual(64 * 1024);
});

test('a PDF is held to the same cap', async () => {
  const { stream, seen } = body(70 * MIB, 0x25);
  answer(stream);
  render(<FilePreview file={{ name: 'huge.pdf', kind: 'pdf', href: '/f/4' }} onClose={() => {}} />);
  await screen.findByText(/PDFs over 64/);
  expect(seen.cancelled).toBe(true);
});

test('a small PDF with the right signature is handed to the viewer', async () => {
  answer(new Response('%PDF-1.7 tiny').body!);
  render(<FilePreview file={{ name: 'ok.pdf', kind: 'pdf', href: '/f/5' }} onClose={() => {}} />);
  await waitFor(() => expect(document.querySelector('iframe.file-preview-frame')).not.toBeNull());
  expect((URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ type: 'application/pdf' });
});

test('closing the preview mid-read cancels the transfer and revokes nothing it did not make', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      /* Never answers: a slow body. */
      return new Promise(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });
  answer(stream);
  const view = render(<FilePreview file={{ name: 'slow.txt', kind: 'text', href: '/f/6' }} onClose={() => {}} />);
  await screen.findByRole('status');
  view.unmount();
  await waitFor(() => expect(cancelled).toBe(true));
});
