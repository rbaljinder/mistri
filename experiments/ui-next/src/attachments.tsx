import { CaretLeft, CaretRight, DownloadSimple, File as FileIcon, FileImage, FilePdf, FileText, Trash, X } from '@phosphor-icons/react';
import { Dialog, DialogBackdrop, DialogClose, DialogContent, DialogTitle } from '@ui-sdk/react/dialog';
import { type ReactNode, useEffect, useState } from 'react';
import { Button, ButtonLink } from './Button';
import { words } from './words';

/* The files on a record, and one of them read without leaving it. A file is opened where it stands: a picture
   as a picture, a PDF in the browser's own reader, a text file as its words, and anything else with what it is
   and the way to keep it. The arrow keys go from one file to the next, as they do through pictures. */

export type Attachment = {
  id: string;
  name: string;
  /* Where the file is fetched from. */
  href: string;
  /* Its kind, as a media type: `image/png`, `application/pdf`. Left out, it is read off the name. */
  type?: string;
  /* In bytes. */
  size?: number;
  /* When it was added and by whom, as they are to be read. */
  when?: string;
  by?: string;
};

type Kind = 'image' | 'pdf' | 'text' | 'other';
const kindOf = (file: Attachment): Kind => {
  const type = file.type ?? '';
  const name = file.name.toLowerCase();
  if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|svg)$/.test(name)) return 'image';
  if (type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (type.startsWith('text/') || /\.(txt|csv|md|json|log)$/.test(name)) return 'text';
  return 'other';
};
const ICON: Record<Kind, ReactNode> = { image: <FileImage />, pdf: <FilePdf />, text: <FileText />, other: <FileIcon /> };
const sizeOf = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};
/* How much of a text file is read into the page. */
const MOST = 200_000;

function Words({ file }: { file: Attachment }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setText(null);
    setFailed(false);
    fetch(file.href)
      .then((answer) => (answer.ok ? answer.text() : Promise.reject(new Error(String(answer.status)))))
      .then((body) => live && setText(body.length > MOST ? `${body.slice(0, MOST)}\n…` : body))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [file.href]);
  if (failed) return <p data-slot="file-preview-none">{words.fileUnread}</p>;
  return (
    <pre data-slot="file-preview-words" aria-busy={text === null || undefined} tabIndex={0}>
      {text ?? ''}
    </pre>
  );
}

export function Attachments({
  label,
  files,
  onRemove,
  empty,
}: {
  label: string;
  files: Attachment[];
  /* Asked to take a file off the record. Without it the list is only read. */
  onRemove?: (file: Attachment) => void;
  empty?: ReactNode;
}) {
  const [at, setAt] = useState<number | null>(null);
  const shown = at === null ? undefined : files[at];
  const go = (to: number) => setAt(Math.min(Math.max(to, 0), files.length - 1));
  const kind = shown ? kindOf(shown) : 'other';
  if (files.length === 0) return <p data-slot="attachments-empty">{empty ?? words.noFiles}</p>;
  return (
    <>
      <ul data-slot="attachments" aria-label={label}>
        {files.map((file, index) => {
          const about = [file.size === undefined ? undefined : sizeOf(file.size), file.when, file.by].filter(Boolean).join(' · ');
          return (
            <li key={file.id}>
              <span data-slot="attachment-icon" aria-hidden="true">
                {kindOf(file) === 'image' ? <img src={file.href} alt="" loading="lazy" decoding="async" /> : ICON[kindOf(file)]}
              </span>
              <span data-slot="attachment-words">
                <button type="button" data-slot="attachment-name" onClick={() => setAt(index)}>
                  {file.name}
                </button>
                {about && <span>{about}</span>}
              </span>
              <ButtonLink intent="quiet" size="sm" href={file.href} download={file.name} aria-label={words.downloadFile(file.name)}>
                <DownloadSimple aria-hidden="true" />
              </ButtonLink>
              {onRemove && (
                <Button intent="quiet" size="sm" aria-label={words.removeFile(file.name)} onClick={() => onRemove(file)}>
                  <Trash aria-hidden="true" />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <Dialog open={at !== null} onOpenChange={(open) => !open && setAt(null)}>
        <DialogBackdrop />
        <DialogContent
          data-kind="lightbox"
          data-file={kind}
          onKeyDown={(event) => {
            if (at === null || (event.target as HTMLElement).closest('pre')) return;
            const to = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: files.length - 1 }[event.key];
            if (to === undefined) return;
            event.preventDefault();
            go(to);
          }}
        >
          <header>
            <DialogTitle>{shown?.name}</DialogTitle>
            {files.length > 1 && at !== null && (
              <span data-slot="lightbox-count" aria-live="polite">
                {words.countOf(at + 1, files.length)}
              </span>
            )}
            {shown && (
              <ButtonLink intent="quiet" size="sm" href={shown.href} download={shown.name}>
                <DownloadSimple aria-hidden="true" />
                {words.download}
              </ButtonLink>
            )}
            <DialogClose aria-label={words.close} data-variant="quiet">
              <X aria-hidden="true" />
            </DialogClose>
          </header>
          <div data-slot="file-preview">
            {shown && kind === 'image' && <img src={shown.href} alt={shown.name} />}
            {shown && kind === 'pdf' && <object data={shown.href} type="application/pdf" aria-label={shown.name} />}
            {shown && kind === 'text' && <Words file={shown} />}
            {shown && kind === 'other' && (
              <p data-slot="file-preview-none">
                <FileIcon aria-hidden="true" />
                {words.noPreview}
              </p>
            )}
          </div>
          {files.length > 1 && at !== null && (
            <>
              <button
                type="button"
                data-slot="lightbox-step"
                data-side="before"
                aria-label={words.previousFile}
                disabled={at === 0}
                onClick={() => go(at - 1)}
              >
                <CaretLeft aria-hidden="true" weight="bold" />
              </button>
              <button
                type="button"
                data-slot="lightbox-step"
                data-side="after"
                aria-label={words.nextFile}
                disabled={at === files.length - 1}
                onClick={() => go(at + 1)}
              >
                <CaretRight aria-hidden="true" weight="bold" />
              </button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
