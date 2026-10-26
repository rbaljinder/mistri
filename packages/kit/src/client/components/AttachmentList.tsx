/**
 * A related list over a resource whose rows are files, drawn as attachments:
 * each file by name with its size and when it came, a Download beside it,
 * and — for a picture, a PDF or text — a preview in place (FilePreview.tsx).
 * Where the resource lets this reader, a file is renamed in its row and
 * removed from its More menu. Where the list may add, an Attach button sits
 * in a drop area drawn as one. A file past the resource's cap is refused
 * here with the reason, before any of it is read.
 */
import { useRef, useState, type ReactNode } from 'react';
import { formatBytes } from '../locale.js';
import { toast } from '../core.js';
import { Empty } from './Notes.js';
import { Button, buttonClass } from '@mistriwork/ui/Button.js';
import { Field } from '@mistriwork/ui/Field.js';
import { Modal, type ModalHandle } from '@mistriwork/ui/Modal.js';
import { DropItem, DropMenu } from '@mistriwork/ui/DropMenu.js';
import { previewKind, type PreviewFile } from './filePreviewModel.js';
import { onDemand } from './onDemand.js';
import { say } from '../copy/record/components/AttachmentList.js';

/* The preview draws its own dialog, fetched the first time a file is opened. */
const FilePreview = onDemand(() => import('./FilePreview.js'), 'FilePreview', { quiet: true });

/** What a row may do answers null when it was done, or why it was not. */
type Outcome = Promise<string | null>;

interface AttachmentItem {
  id: string;
  name: string;
  /** The download address. */
  href: string;
  /** In a tenant App, where a file has no address (fileSource.ts): saving reads it on the lease instead of following `href`. */
  save?: () => Promise<void>;
  meta: string[];
  /** The stored media type, where the resource keeps one: which viewer to try, never trusted for the bytes. */
  type?: string;
  /** A picture's address in the file route's inline mode, for its preview. */
  inline?: string;
  onOpen?: () => void;
  /** Present where this reader may change the file's name. */
  rename?: (name: string) => Outcome;
  /** Present where this reader may delete the file. */
  remove?: () => Outcome;
}

interface AttachmentListProps {
  items: AttachmentItem[];
  emptyText: string;
  empty?: ReactNode;
  /** Present where the list may add: `send` answers null, or why nothing was attached. */
  upload?: { label: string; maxBytes: number; send: (file: File) => Promise<string | null> };
}

/** A file's bytes as base64, in slices, so a large file does not overflow the argument list. */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/* A link that is saved from the lease rather than followed, where the file has no address of its own. */
const saveOnLease = (item: AttachmentItem) =>
  item.save
    ? (event: { preventDefault(): void }) => {
        event.preventDefault();
        void item.save!().catch((error: Error) => toast(error.message, 'error'));
      }
    : undefined;

/* The extension, as a file manager shows it: a short word, not an icon set. */
const badge = (name: string) => {
  const dot = name.lastIndexOf('.');
  const ext =
    dot > 0
      ? name
          .slice(dot + 1)
          .slice(0, 4)
          .toUpperCase()
      : '';
  return ext || 'FILE';
};

export function AttachmentList({ items, emptyText, empty, upload }: AttachmentListProps) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; error: boolean }>();
  const input = useRef<HTMLInputElement>(null);
  const [previewing, setPreviewing] = useState<PreviewFile>();
  const [renaming, setRenaming] = useState<string>();
  const [removing, setRemoving] = useState<AttachmentItem>();
  /* Where focus goes back to once a preview closes: the name that opened it. */
  const back = useRef<HTMLElement | null>(null);

  const take = async (files: File[]) => {
    if (!upload || busy || !files.length) return;
    setBusy(true);
    setSaid(undefined);
    const attached: string[] = [];
    const refused: string[] = [];
    for (const file of files) {
      if (file.size > upload.maxBytes) {
        refused.push(say('isOverTheLimit', { name: file.name, maxBytes: formatBytes(upload.maxBytes) }));
        continue;
      }
      const why = await upload.send(file);
      if (why) refused.push(why);
      else attached.push(file.name);
    }
    setBusy(false);
    if (refused.length) setSaid({ text: refused.join(' '), error: true });
    else
      setSaid({
        text: attached.length === 1 ? say('attached', { attached: attached[0] }) : say('attachedFiles', { count: attached.length }),
        error: false,
      });
  };

  const carriesFiles = (types: readonly string[]) => types.includes('Files');
  const previewOf = (item: AttachmentItem): PreviewFile | undefined => {
    /* A viewer reads its file by address; a file on a lease has none, so it is saved instead. */
    if (item.save) return undefined;
    const kind = previewKind(item.name, item.type);
    return kind ? { name: item.name, kind, href: item.href, ...(item.inline ? { inline: item.inline } : {}) } : undefined;
  };
  return (
    <div
      className={`attachments${over ? ' is-over' : ''}`}
      onDragOver={
        upload
          ? (event) => {
              if (carriesFiles([...event.dataTransfer.types])) {
                event.preventDefault();
                setOver(true);
              }
            }
          : undefined
      }
      onDragLeave={
        upload
          ? (event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
            }
          : undefined
      }
      onDrop={
        upload
          ? (event) => {
              event.preventDefault();
              setOver(false);
              void take([...event.dataTransfer.files]);
            }
          : undefined
      }
    >
      {upload && (
        /* The drop area is drawn, not only promised: an edge a file can be
           aimed at, with the button inside it for everyone else. */
        <div className="attachments-add">
          <Button
            intent="secondary"
            size="compact"
            busy={busy}
            busyLabel={say('attaching')}
            onClick={() => input.current?.click()}
          >{`+ ${upload.label}`}</Button>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            aria-label={upload.label}
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = '';
              void take(files);
            }}
          />
          <span className="attachments-hint">{say('orDropFilesHere')}</span>
          {said && (
            <span role={said.error ? 'alert' : 'status'} className={said.error ? 'attachments-error' : 'attachments-said'}>
              {said.text}
            </span>
          )}
        </div>
      )}
      {items.length ? (
        <ul className="attachments-list">
          {items.map((item) => {
            const preview = previewOf(item);
            return (
              <li key={item.id} className="attachments-item">
                <span className="attachments-badge" aria-hidden="true">
                  {badge(item.name)}
                </span>
                {renaming === item.id && item.rename ? (
                  <RenameRow item={item} onDone={() => setRenaming(undefined)} />
                ) : (
                  <>
                    <span className="attachments-text">
                      {/* A file with a viewer opens in it; any other is its download. */}
                      {preview ? (
                        <button
                          type="button"
                          className="attachments-name"
                          title={say('preview', { name: item.name })}
                          onClick={(event) => {
                            back.current = event.currentTarget;
                            setPreviewing(preview);
                          }}
                        >
                          {item.name}
                        </button>
                      ) : (
                        <a className="attachments-name" href={item.href} download={item.name} onClick={saveOnLease(item)}>
                          {item.name}
                        </a>
                      )}
                      {item.meta.length > 0 && <span className="attachments-meta">{item.meta.join(' · ')}</span>}
                    </span>
                    <span className="attachments-actions">
                      <a
                        className={buttonClass({ intent: 'quiet', size: 'compact', className: 'attachments-download' })}
                        href={item.href}
                        download={item.name}
                        onClick={saveOnLease(item)}
                        aria-label={say('downloadName', { name: item.name })}
                      >
                        {say('download')}
                      </a>
                      {(item.onOpen || item.rename || item.remove) && (
                        <DropMenu
                          className="row-actions-menu"
                          triggerClassName="ghost row-actions-trigger"
                          triggerTitle={say('more', { name: item.name })}
                          triggerLabel={say('more', { name: item.name })}
                          label="⋯"
                          popupClassName="page-actions-popup"
                          align="end"
                        >
                          {item.onOpen && (
                            <DropItem className="page-actions-item" onClick={item.onOpen}>
                              {say('detailsItem')}
                            </DropItem>
                          )}
                          {item.rename && (
                            <DropItem className="page-actions-item" onClick={() => setRenaming(item.id)}>
                              {say('common.rename')}
                            </DropItem>
                          )}
                          {/* Remove is last, in the danger colour, ruled off from the rest (docs/design.md). */}
                          {item.remove && (
                            <DropItem className="page-actions-item is-danger" onClick={() => setRemoving(item)}>
                              {say('removeMore')}
                            </DropItem>
                          )}
                        </DropMenu>
                      )}
                    </span>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        (empty ?? <Empty className="attachments-empty" text={emptyText} />)
      )}
      {previewing && <FilePreview file={previewing} onClose={() => setPreviewing(undefined)} finalFocus={back} />}
      {removing && <RemoveConfirm item={removing} onClose={() => setRemoving(undefined)} />}
    </div>
  );
}

/** The name, edited where it stood: Enter saves, Escape puts it back. */
function RenameRow({ item, onDone }: { item: AttachmentItem; onDone: () => void }) {
  const [name, setName] = useState(item.name);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const save = async () => {
    const next = name.trim();
    if (!next) {
      setProblem(say('aFileNeedsAName'));
      return;
    }
    if (next === item.name) {
      onDone();
      return;
    }
    setBusy(true);
    const why = await item.rename!(next);
    setBusy(false);
    if (why) setProblem(why);
    else onDone();
  };
  return (
    <form
      className="attachments-rename"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onDone();
        }
      }}
    >
      <Field label={say('fileName')} size="compact" problem={problem}>
        {/* The reader just asked to type here, so the box takes the focus. */}
        {/* oxlint-disable-next-line jsx-a11y/no-autofocus */}
        <input
          type="text"
          value={name}
          autoFocus
          onChange={(event) => {
            setName(event.target.value);
            setProblem('');
          }}
        />
      </Field>
      <span className="attachments-rename-actions">
        <Button intent="primary" size="compact" type="submit" busy={busy} busyLabel={say('common.saving')}>
          {say('common.save')}
        </Button>
        <Button intent="secondary" size="compact" onClick={onDone}>
          {say('common.cancel')}
        </Button>
      </span>
    </form>
  );
}

/* A removed file is not in Undo, so it is asked about first, and said so. */
function RemoveConfirm({ item, onClose }: { item: AttachmentItem; onClose: () => void }) {
  const dialog = useRef<ModalHandle>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const remove = async () => {
    setBusy(true);
    const why = await item.remove!();
    setBusy(false);
    if (why) setProblem(why);
    else dialog.current?.close();
  };
  return (
    <Modal
      className="confirm attachments-confirm"
      ref={dialog}
      fullscreen={false}
      initialFocus={keep}
      closeDisabled={busy}
      aria-label={say('removeName', { name: item.name })}
      onClose={onClose}
    >
      <h2>{say('removeQuotedNameQuestion', { name: item.name })}</h2>
      <p>{say('theFileIsDeleted')}</p>
      {problem && (
        <p className="attachments-error" role="alert">
          {problem}
        </p>
      )}
      <div className="confirm-actions">
        <Button ref={keep} intent="secondary" disabled={busy} onClick={() => dialog.current?.close()}>
          {say('keep')}
        </Button>
        <Button intent="danger" busy={busy} busyLabel={say('removing')} onClick={() => void remove()}>
          {say('common.remove')}
        </Button>
      </div>
    </Modal>
  );
}
