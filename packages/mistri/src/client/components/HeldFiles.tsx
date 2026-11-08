/**
 * A command form's files (`field.files`) and its signature (`field.signature`):
 * each file is sent as it is picked, dropped or pasted, and held by the
 * server for the command (server commands/stagedFiles.ts); the form keeps the
 * ids it is answered, and the command takes the files when it runs. A file
 * is shown with its progress while it goes, then by name with a preview and a
 * Remove before the form is sent. The drop area is the attachments list's
 * (AttachmentList.tsx), drawn the same quiet way; the signature is the pad a
 * column's signature uses (builtInInputs.tsx), kept by holding its PNG.
 *
 * Loaded the first time a form asks one, with its stylesheet: no first page
 * carries a drop area or a pad.
 */
import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { formatBytes } from '@mistriwork/kit/client/locale.js';
import { served } from '@mistriwork/kit/client/addressMount.js';
import { api, state } from '@mistriwork/kit/client/core.js';
import { ownedBy, scopeApiRequest } from '@mistriwork/kit/client/requestIdentity.js';
import { captureSessionIdentity } from '@mistriwork/kit/client/sessionIdentity.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { previewKind, type PreviewFile } from '@mistriwork/kit/client/components/filePreviewModel.js';
import { Button } from '@mistriwork/ui/Button.js';
import { ProgressBar } from '@mistriwork/ui/FormParts.js';
import { COMMAND_ROUTES } from '../../shared/commandRoutes.js';
import type { AppCommandField } from '../../shared/command.js';
import { forgetHeldFile, heldFileInfo, rememberHeldFile, type HeldFileInfo } from '../heldFileNames.js';
import { base64Of, SignaturePad } from './builtInInputs.js';
import { say } from '../copy/forms/components/HeldFiles.js';
import './HeldFiles.css';

const FilePreview = onDemand(() => import('@mistriwork/kit/client/components/FilePreview.js'), 'FilePreview', { quiet: true });

/** Where a form's files are held: a signed-in reader's command, on its connection; or a public form's, by its key. */
export type HeldTarget = { command: string; connection?: string } | { form: string; via?: string };

interface Held extends HeldFileInfo {
  id: string;
}

/** A refusal in the server's own sentence, or the transport's. */
class NotHeld extends Error {}

/**
 * Sends one file to be held for `field`. A request of its own rather than the shell's `api`: the bytes go as they are
 * read, and the upload's progress is what the reader watches. The same owner and account the shell's requests carry.
 */
function holdFile(target: HeldTarget, field: string, file: File, progress: (fraction: number) => void) {
  const xhr = new XMLHttpRequest();
  const done = (async (): Promise<Held> => {
    const sent = { field, file: { name: file.name || 'file', type: file.type, data: await base64Of(file) } };
    /* A tenant's signed-in reader sends through the tenant transport, which carries the lease the server holds the file
       under; its request has no byte-by-byte progress to watch. */
    if ('command' in target && captureSessionIdentity().tenantRequired) {
      try {
        const data = (await api(COMMAND_ROUTES.files, { command: target.command, ...sent })) as Record<string, unknown>;
        progress(1);
        if (typeof data.id !== 'string') throw new NotHeld(say('couldNotSend'));
        return {
          id: data.id,
          name: typeof data.name === 'string' ? data.name : file.name,
          type: typeof data.type === 'string' ? data.type : file.type,
          size: typeof data.size === 'number' ? data.size : file.size,
          url: URL.createObjectURL(file),
        };
      } catch (error) {
        throw error instanceof NotHeld ? error : new NotHeld(error instanceof Error && error.message ? error.message : say('couldNotSend'));
      }
    }
    let url: string;
    let body: Record<string, unknown>;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if ('form' in target) {
      url = `/api/forms/${encodeURIComponent(target.form)}/files${target.via ? `?via=${encodeURIComponent(target.via)}` : ''}`;
      body = sent;
    } else {
      const scoped = scopeApiRequest(
        COMMAND_ROUTES.files,
        { command: target.command, ...sent, ...ownedBy(target.connection) },
        state.activeConnection,
      );
      url = scoped.url;
      body = scoped.payload ?? {};
      const identity = captureSessionIdentity();
      if (identity.mode === 'authenticated' && identity.accountId) headers['x-mistri-account'] = identity.accountId;
    }
    return await new Promise<Held>((resolve, reject) => {
      xhr.open('POST', served(url));
      xhr.withCredentials = true;
      for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) progress(event.loaded / event.total);
      };
      xhr.onerror = () => reject(new NotHeld(say('couldNotSend')));
      xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
      xhr.onload = () => {
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(xhr.responseText) as Record<string, unknown>;
        } catch {
          /* the status is the answer */
        }
        if (xhr.status === 200 && typeof data.id === 'string')
          return resolve({
            id: data.id,
            name: typeof data.name === 'string' ? data.name : file.name,
            type: typeof data.type === 'string' ? data.type : file.type,
            size: typeof data.size === 'number' ? data.size : file.size,
            url: URL.createObjectURL(file),
          });
        const said = typeof data.error === 'string' ? data.error : typeof data.message === 'string' ? data.message : undefined;
        reject(new NotHeld(said ?? (xhr.status === 413 ? say('tooLarge') : say('couldNotSend'))));
      };
      xhr.send(JSON.stringify(body));
    });
  })();
  return { done, abort: () => xhr.abort() };
}

interface FieldProps {
  id: string;
  describedBy?: string;
  /** The field's caption, which names the group of controls. */
  labelledBy?: string;
  invalid: boolean;
  disabled: boolean;
  label: string;
  /** The input's name, the field the server holds the files for. */
  name: string;
  target: HeldTarget | undefined;
}

/* The extension, as a file manager shows it (AttachmentList's badge). */
const badge = (name: string) => {
  const dot = name.lastIndexOf('.');
  return (
    (dot > 0
      ? name
          .slice(dot + 1)
          .slice(0, 4)
          .toUpperCase()
      : '') || 'FILE'
  );
};

interface Sending {
  key: number;
  name: string;
  fraction: number;
  abort: () => void;
}

let sendings = 0;

/** A `field.files` input: the ids of the files held for it, in the order they were sent. */
export function HeldFilesInput({
  id,
  describedBy,
  labelledBy,
  invalid,
  disabled,
  label,
  name,
  target,
  value,
  max,
  accept,
  onChange,
}: FieldProps & { value: readonly string[]; max: number; accept?: readonly string[]; onChange: (ids: string[]) => void }) {
  const [over, setOver] = useState(false);
  const [sending, setSending] = useState<Sending[]>([]);
  const [said, setSaid] = useState<string>();
  const [previewing, setPreviewing] = useState<PreviewFile>();
  const picker = useRef<HTMLInputElement>(null);
  /* The ids as last changed: files sent one after another each add to what the one before left, before the form has
     drawn again with it. */
  const latest = useRef(value);
  latest.current = value;
  const change = (ids: string[]) => {
    latest.current = ids;
    onChange(ids);
  };
  const room = max - value.length - sending.length;
  const off = disabled || !target;

  const take = async (files: File[]) => {
    if (off || !files.length || !target) return;
    setSaid(undefined);
    const refused: string[] = [];
    if (files.length > room) refused.push(say('takesAtMost', { label, count: max }));
    for (const file of files.slice(0, Math.max(0, room))) {
      const key = ++sendings;
      const out = holdFile(target, name, file, (fraction) =>
        setSending((all) => all.map((each) => (each.key === key ? { ...each, fraction } : each))),
      );
      setSending((all) => [...all, { key, name: file.name || 'file', fraction: 0, abort: out.abort }]);
      try {
        const held = await out.done;
        rememberHeldFile(held.id, held);
        change([...latest.current, held.id]);
      } catch (error) {
        if (error instanceof NotHeld) refused.push(say('notSent', { name: file.name || 'file', reason: error.message }));
      } finally {
        setSending((all) => all.filter((each) => each.key !== key));
      }
    }
    if (refused.length) setSaid(refused.join(' '));
  };

  const carriesFiles = (event: DragEvent) => [...event.dataTransfer.types].includes('Files');
  const one = max === 1;
  return (
    <div
      className={`held-files${over ? ' is-over' : ''}`}
      role="group"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onDragOver={(event) => {
        if (off || !carriesFiles(event)) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(event) => {
        if (off) return;
        event.preventDefault();
        setOver(false);
        void take([...event.dataTransfer.files]);
      }}
      /* A picture copied from elsewhere is pasted while the focus is in the field: on its button, or a file's. */
      onPaste={(event: ClipboardEvent) => {
        const files = [...event.clipboardData.files];
        if (off || !files.length) return;
        event.preventDefault();
        void take(files);
      }}
    >
      {target ? (
        <div className="held-files-add">
          <Button
            id={id}
            intent="secondary"
            size="compact"
            disabled={off || room <= 0}
            aria-invalid={invalid || undefined}
            onClick={() => picker.current?.click()}
          >{`+ ${say(one ? 'chooseFile' : 'chooseFiles')}`}</Button>
          <input
            ref={picker}
            type="file"
            multiple={!one}
            hidden
            tabIndex={-1}
            aria-label={label}
            {...(accept?.length ? { accept: accept.join(',') } : {})}
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = '';
              void take(files);
            }}
          />
          <span className="held-files-hint">{say(one ? 'orDropOrPasteOne' : 'orDropOrPaste')}</span>
        </div>
      ) : (
        <p className="held-files-hint">{say('noHolding')}</p>
      )}
      {said && (
        <p className="held-files-error" role="alert">
          {said}
        </p>
      )}
      {(value.length > 0 || sending.length > 0) && (
        <ul className="held-files-list">
          {value.map((held) => {
            const info = heldFileInfo(held);
            const shown = info?.name ?? say('aFile');
            const kind = info?.url ? previewKind(shown, info.type) : undefined;
            return (
              <li key={held} className="held-files-item">
                <span className="held-files-badge" aria-hidden="true">
                  {badge(shown)}
                </span>
                <span className="held-files-text">
                  {kind && info?.url ? (
                    <button
                      type="button"
                      className="held-files-name"
                      aria-label={say('preview', { name: shown })}
                      onClick={() => setPreviewing({ name: shown, kind, href: info.url! })}
                    >
                      {shown}
                    </button>
                  ) : (
                    <span className="held-files-name is-plain">{shown}</span>
                  )}
                  {info && <span className="held-files-meta">{formatBytes(info.size)}</span>}
                </span>
                <Button
                  intent="quiet"
                  size="compact"
                  disabled={disabled}
                  aria-label={say('removeFile', { name: shown })}
                  onClick={() => {
                    forgetHeldFile(held);
                    change(latest.current.filter((each) => each !== held));
                  }}
                >
                  {say('remove')}
                </Button>
              </li>
            );
          })}
          {sending.map((each) => {
            const percent = Math.round(each.fraction * 100);
            return (
              <li key={`sending-${each.key}`} className="held-files-item is-sending">
                <span className="held-files-badge" aria-hidden="true">
                  {badge(each.name)}
                </span>
                <span className="held-files-text">
                  <span className="held-files-name is-plain">{each.name}</span>
                  <ProgressBar value={percent} max={100} label={say('sending', { name: each.name, percent })} />
                </span>
                <Button intent="quiet" size="compact" onClick={each.abort}>
                  {say('cancel')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {previewing && <FilePreview file={previewing} onClose={() => setPreviewing(undefined)} />}
    </div>
  );
}

/** A `field.signature` input: the pad, its drawing kept by holding it as a PNG; the value is the held file's id. */
export function HeldSignatureInput({
  id,
  describedBy,
  invalid,
  disabled,
  label,
  name,
  target,
  value,
  onChange,
}: FieldProps & { value: string | undefined; onChange: (id: string | null) => void }) {
  if (!target) return <p className="held-files-hint">{say('noHolding')}</p>;
  return (
    <SignaturePad
      id={id}
      {...(describedBy ? { describedBy } : {})}
      invalid={invalid}
      disabled={disabled}
      label={label}
      value={value ?? null}
      onChange={(next) => {
        if (value && next !== value) forgetHeldFile(value);
        onChange(typeof next === 'string' ? next : null);
      }}
      keeper={{
        keep: async (png) => {
          try {
            const held = await holdFile(target, name, new File([png], 'signature.png', { type: 'image/png' }), () => {}).done;
            rememberHeldFile(held.id, held);
            return held.id;
          } catch (error) {
            throw error instanceof NotHeld ? error : new Error(say('couldNotSend'));
          }
        },
        picture: (held) => heldFileInfo(String(held))?.url,
      }}
    />
  );
}

/** A files or signature field as a command form draws it (CommandFields.tsx): the one entry the form loads. */
export function HeldInput({
  field,
  value,
  onChange,
  ...props
}: Omit<FieldProps, 'label' | 'name'> & {
  field: Extract<AppCommandField, { type: 'files' | 'signature' }>;
  value: unknown;
  onChange: (value: string[] | string | undefined) => void;
}) {
  const named = { ...props, label: field.label, name: field.name };
  return field.type === 'files' ? (
    <HeldFilesInput
      {...named}
      value={Array.isArray(value) ? (value as string[]) : []}
      max={field.max}
      {...(field.accept ? { accept: field.accept } : {})}
      onChange={(ids) => onChange(ids.length ? ids : undefined)}
    />
  ) : (
    <HeldSignatureInput {...named} value={typeof value === 'string' ? value : undefined} onChange={(held) => onChange(held ?? undefined)} />
  );
}
