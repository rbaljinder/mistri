/**
 * One attached file, looked at without leaving the record: a picture as the
 * lightbox draws a photo, a PDF in the browser's own viewer, and text as
 * text, on the lightbox's deep ground with the file's name, a Download and
 * Close in its bar.
 *
 * The file route answers everything but a picture as a download, sandboxed
 * and never sniffed, and that stays so: a stored type is only the
 * uploader's claim. So a PDF or a text file is read here as bytes and shown
 * only when the bytes are what the viewer expects — a PDF must begin
 * `%PDF-`, text must hold no NUL — and handed to the viewer as a Blob of
 * that one type, made by this page. Nothing the file says can make it HTML.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import './FilePreview.css';
import { Modal, type ModalHandle } from '@mistriwork/ui/Modal.js';
import { Empty, Problem } from './Notes.js';
import { formatBytes } from '../locale.js';
import type { PreviewFile } from './filePreviewModel.js';
import { say } from '../copy/record/components/FilePreview.js';

/** Past this, a recording is a download: its bytes are read whole before they are played. */
const MEDIA_PREVIEW_BYTES = 64 * 1024 * 1024;

/** Past this, a text file shows its beginning and says so: the rest is a download. */
const TEXT_PREVIEW_BYTES = 256 * 1024;

type Loaded =
  | { state: 'loading' }
  | { state: 'pdf'; url: string }
  | { state: 'text'; text: string; cut: boolean }
  | { state: 'media'; url: string }
  | { state: 'refused'; why: string }
  | { state: 'failed'; why: string };

const startsPdf = (bytes: Uint8Array) => bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-';

const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));

/**
 * The type a recording's bytes say it is, from their signature — never from its name or its stored type, which are
 * only the uploader's claim — or undefined where they are not a recording a browser plays.
 */
export function mediaType(bytes: Uint8Array, kind: 'video' | 'audio'): string | undefined {
  if (bytes.length < 12) return undefined;
  if (ascii(bytes, 4, 4) === 'ftyp') return kind === 'video' ? 'video/mp4' : 'audio/mp4';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return `${kind}/webm`;
  if (ascii(bytes, 0, 4) === 'OggS') return `${kind}/ogg`;
  if (kind === 'audio') {
    if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return 'audio/wav';
    if (ascii(bytes, 0, 4) === 'fLaC') return 'audio/flac';
    if (ascii(bytes, 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) return 'audio/mpeg';
  }
  return undefined;
}

async function load(file: PreviewFile, signal: AbortSignal): Promise<Loaded> {
  const res = await fetch(file.href, { credentials: 'same-origin', signal });
  if (!res.ok) return { state: 'failed', why: res.status === 404 ? say('thisFileIsNoLonger') : say('thisFileCouldNotBeRead') };
  if ((file.kind === 'video' || file.kind === 'audio') && Number(res.headers.get('content-length')) > MEDIA_PREVIEW_BYTES)
    return { state: 'refused', why: say('tooLargeToPlay', { size: formatBytes(MEDIA_PREVIEW_BYTES) }) };
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (file.kind === 'video' || file.kind === 'audio') {
    const type = mediaType(bytes, file.kind);
    if (!type) return { state: 'refused', why: say('thisFileIsNotPlayable') };
    return { state: 'media', url: URL.createObjectURL(new Blob([bytes], { type })) };
  }
  if (file.kind === 'pdf') {
    if (!startsPdf(bytes)) return { state: 'refused', why: say('thisFileIsNamed') };
    return { state: 'pdf', url: URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })) };
  }
  const shown = bytes.subarray(0, TEXT_PREVIEW_BYTES);
  if (shown.includes(0)) return { state: 'refused', why: say('thisFileIsNotText') };
  return { state: 'text', text: new TextDecoder('utf-8').decode(shown), cut: bytes.length > TEXT_PREVIEW_BYTES };
}

export function FilePreview({
  file,
  onClose,
  finalFocus,
}: {
  file: PreviewFile;
  onClose: () => void;
  finalFocus?: RefObject<HTMLElement | null>;
}) {
  const modal = useRef<ModalHandle>(null);
  const closer = useRef<HTMLButtonElement>(null);
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (file.kind === 'image') return;
    const abort = new AbortController();
    let made: string | undefined;
    setLoaded({ state: 'loading' });
    load(file, abort.signal).then(
      (result) => {
        if (result.state === 'pdf' || result.state === 'media') made = result.url;
        if (abort.signal.aborted) {
          if (made) URL.revokeObjectURL(made);
          return;
        }
        setLoaded(result);
      },
      (error) => {
        if (!abort.signal.aborted) setLoaded({ state: 'failed', why: (error as Error).message || say('thisFileCouldNotBeRead') });
      },
    );
    /* The object URL holds the bytes until it is revoked: a closed preview lets them go. */
    return () => {
      abort.abort();
      if (made) URL.revokeObjectURL(made);
    };
  }, [file.href, file.kind, attempt]);

  const stage =
    file.kind === 'image' ? (
      <figure className="lightbox-figure">
        <img className="lightbox-image" src={file.inline ?? file.href} alt={file.name} draggable={false} />
      </figure>
    ) : loaded.state === 'loading' ? (
      <p className="file-preview-note" role="status">
        {say('opening', { name: file.name })}
      </p>
    ) : loaded.state === 'pdf' ? (
      <iframe className="file-preview-frame" src={loaded.url} title={file.name} />
    ) : loaded.state === 'media' ? (
      file.kind === 'video' ? (
        <video className="file-preview-media" src={loaded.url} controls aria-label={file.name} />
      ) : (
        <audio className="file-preview-media is-audio" src={loaded.url} controls aria-label={file.name} />
      )
    ) : loaded.state === 'text' ? (
      <div className="file-preview-text">
        <pre tabIndex={0} aria-label={file.name}>
          {loaded.text}
        </pre>
        {loaded.cut && <p className="file-preview-note">{say('showingTheFirstDownload', { size: formatBytes(TEXT_PREVIEW_BYTES) })}</p>}
      </div>
    ) : (
      <div className="file-preview-message">
        {loaded.state === 'refused' ? <Empty text={loaded.why} /> : <Problem text={loaded.why} retry={() => setAttempt((n) => n + 1)} />}
      </div>
    );
  return (
    <Modal
      className="lightbox file-preview"
      plain
      ref={modal}
      aria-label={say('previewOf', { name: file.name })}
      initialFocus={closer}
      onClose={onClose}
      {...(finalFocus ? { finalFocus } : {})}
    >
      <div className="lightbox-body">
        <div className="lightbox-bar">
          <span className="file-preview-name">{file.name}</span>
          <span className="file-preview-actions">
            <a className="lightbox-close file-preview-download" href={file.href} download={file.name}>
              {say('download')}
            </a>
            <button type="button" ref={closer} className="lightbox-close" onClick={() => modal.current?.close()}>
              {say('common.close')}
            </button>
          </span>
        </div>
        <div className={`lightbox-stage file-preview-stage is-${file.kind}`}>{stage}</div>
      </div>
    </Modal>
  );
}
