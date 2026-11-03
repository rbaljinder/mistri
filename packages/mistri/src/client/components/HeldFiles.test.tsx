/**
 * A command form's files and signature (HeldFiles.tsx): each file is sent as
 * it is picked, dropped or pasted, to the form's own holding address, with
 * its progress shown; the field keeps the ids it is answered, says a refusal
 * in the server's words, takes no more than its `max`, and lets a file go
 * before the form is sent. A signature is the pad, kept by holding its PNG.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { setAppRequestScope } from '../../../../kit/src/client/requestIdentity.js';
import { HeldFilesInput, HeldSignatureInput, type HeldTarget } from './HeldFiles.js';

class FakeXhr {
  static sent: FakeXhr[] = [];
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  responseText = '';
  url = '';
  headers: Record<string, string> = {};
  body = '';
  withCredentials = false;
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: string) {
    this.body = body;
    FakeXhr.sent.push(this);
  }
  abort() {
    this.onabort?.();
  }
  answer(status: number, data: Record<string, unknown>) {
    this.status = status;
    this.responseText = JSON.stringify(data);
    act(() => this.onload?.());
  }
  get sentBody() {
    return JSON.parse(this.body) as { command?: string; field: string; file: { name: string; type: string; data: string } };
  }
}

const ID = (n: number) => `${String(n).repeat(43)}`.slice(0, 43);
const png = (name: string) => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });

function Files({ target, max = 5, start = [] }: { target?: HeldTarget; max?: number; start?: string[] }) {
  const [ids, setIds] = useState<string[]>(start);
  return (
    <>
      <HeldFilesInput
        id="photos"
        invalid={false}
        disabled={false}
        label="Photos"
        name="photos"
        target={target}
        value={ids}
        max={max}
        onChange={setIds}
      />
      <output data-testid="ids">{ids.join(',')}</output>
    </>
  );
}

const sent = async (count: number) => {
  await waitFor(() => expect(FakeXhr.sent).toHaveLength(count));
  return FakeXhr.sent[count - 1];
};

beforeEach(() => {
  FakeXhr.sent = [];
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  URL.createObjectURL = vi.fn((blob: Blob) => `blob:${(blob as File).name}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setAppRequestScope(null);
});

describe('a files input', () => {
  test('sends each file to the public form with its progress, keeps the ids, and lets one go', async () => {
    const { container, getByRole, getByTestId, queryByRole } = render(<Files target={{ form: 'repair' }} />);
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [png('front.png'), png('back.png')] } });
    const first = await sent(1);
    expect(first.url).toBe('/api/forms/repair/files');
    expect(first.sentBody).toEqual({ field: 'photos', file: { name: 'front.png', type: 'image/png', data: 'iVBORw==' } });
    act(() => first.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 }));
    expect(getByRole('progressbar', { name: 'Sending front.png, 50%' })).toBeTruthy();
    // One at a time: the second goes once the first is held.
    expect(FakeXhr.sent).toHaveLength(1);
    first.answer(200, { id: ID(1), name: 'front.png', type: 'image/png', size: 4 });
    (await sent(2)).answer(200, { id: ID(2), name: 'back.png', type: 'image/png', size: 4 });
    await waitFor(() => expect(getByTestId('ids').textContent).toBe(`${ID(1)},${ID(2)}`));
    expect(queryByRole('progressbar')).toBeNull();
    expect(getByRole('button', { name: 'Preview front.png' })).toBeTruthy();
    fireEvent.click(getByRole('button', { name: 'Remove front.png' }));
    expect(getByTestId('ids').textContent).toBe(ID(2));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:front.png');
  });

  test("says the server's refusal, and takes no more files than its max", async () => {
    const { container, getByRole, getByTestId } = render(<Files target={{ form: 'repair' }} max={1} />);
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [png('a.png'), png('b.png')] } });
    (await sent(1)).answer(415, { code: 'unsupported_type', error: 'This field does not take this type of file.' });
    await waitFor(() =>
      expect(getByRole('alert').textContent).toBe(
        'Photos takes at most 1 file. a.png was not sent: This field does not take this type of file.',
      ),
    );
    expect(FakeXhr.sent).toHaveLength(1);
    expect(getByTestId('ids').textContent).toBe('');
  });

  test('takes a pasted file, and sends a signed-in form’s to its command on the App', async () => {
    setAppRequestScope(true);
    const { getByRole, getByTestId } = render(<Files target={{ command: 'log_repair', connection: 'fleet' }} />);
    fireEvent.paste(getByRole('group'), { clipboardData: { files: [png('pasted.png')] } });
    const xhr = await sent(1);
    expect(xhr.url).toBe('/api/commands/files?app=fleet');
    expect(xhr.sentBody).toMatchObject({ command: 'log_repair', field: 'photos' });
    xhr.answer(200, { id: ID(3), name: 'pasted.png', type: 'image/png', size: 4 });
    await waitFor(() => expect(getByTestId('ids').textContent).toBe(ID(3)));
  });

  test('says where no file can be sent, and names a file held before this page by no name of its own', () => {
    const { getByText, unmount } = render(<Files />);
    expect(getByText('Files cannot be sent from this form.')).toBeTruthy();
    unmount();
    const { getByText: text } = render(<Files target={{ form: 'repair' }} start={[ID(9)]} />);
    expect(text('A file sent earlier')).toBeTruthy();
  });
});

describe('a signature input', () => {
  test('holds the drawing as a PNG, and shows it kept', async () => {
    HTMLCanvasElement.prototype.toBlob = function (done: BlobCallback) {
      done(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }));
    };
    function Signature() {
      const [held, setHeld] = useState<string | undefined>();
      return (
        <HeldSignatureInput
          id="signed"
          invalid={false}
          disabled={false}
          label="Signature"
          name="signature"
          target={{ form: 'repair' }}
          value={held}
          onChange={(next) => setHeld(next ?? undefined)}
        />
      );
    }
    const { getByRole, getByPlaceholderText } = render(<Signature />);
    fireEvent.click(getByRole('button', { name: 'Type instead' }));
    fireEvent.change(getByPlaceholderText('Type your full name'), { target: { value: 'Ana Ruiz' } });
    fireEvent.click(getByRole('button', { name: 'Use this signature' }));
    const xhr = await sent(1);
    expect(xhr.sentBody).toEqual({ field: 'signature', file: { name: 'signature.png', type: 'image/png', data: 'iVBORw==' } });
    xhr.answer(200, { id: ID(4), name: 'signature.png', type: 'image/png', size: 4 });
    await waitFor(() => expect(getByRole('img', { name: 'Signature: the kept signature' })).toHaveAttribute('src', 'blob:signature.png'));
    expect(getByRole('button', { name: 'Sign again' })).toBeEnabled();
  });
});
