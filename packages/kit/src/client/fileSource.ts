/**
 * Where a file of a file resource is drawn from, and how it is saved.
 *
 * In an App on its own server a file is an address — the file route, under
 * the reader's grants (`/api/file?table=…&key=…`) — so a picture is an
 * `<img src>` and a download is a link. A tenant App has no such address: its
 * every read is a request on the tab's lease, which names the tenant and is
 * answered only for it (tenantTransport.ts). There a file is read on the
 * lease as base64 (`/api/file/read`), made a blob here, and drawn or saved
 * from the blob's own address, which no other page and no other tenant can
 * open. A picture read once is kept for the page's life, a few hundred at
 * most, so a list that scrolls back does not read it again.
 */
import { useEffect, useState } from 'react';
import { api } from './core.js';
import { served } from './addressMount.js';
import { ownedBy } from './requestIdentity.js';
import { captureSessionIdentity } from './sessionIdentity.js';
import { say } from './copy/record/fileSource.js';
import { portalRoot } from './shellHost.js';

/** Whether files here travel on a tenant lease rather than by address. */
export const filesOnLease = (): boolean => captureSessionIdentity().tenantRequired === true;

/** One file's address in the file route, for an App on its own server. */
function fileAddress(
  table: string,
  key: Record<string, unknown>,
  connection: string | null | undefined,
  options: { inline?: boolean; variant?: 'thumb' } = {},
): string {
  return served(
    `/api/file?${new URLSearchParams({
      ...ownedBy(connection ?? null),
      table,
      key: JSON.stringify(key),
      ...(options.inline ? { inline: '1' } : {}),
      ...(options.variant ? { variant: options.variant } : {}),
    })}`,
  );
}

function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/** One file read on the lease, as a blob: a picture typed as its bytes say when asked for in place, anything else a download. */
async function fileOnLease(
  table: string,
  key: Record<string, unknown>,
  options: { inline?: boolean; variant?: 'thumb' } = {},
): Promise<{ blob: Blob; name: string }> {
  const reply = (await api('/api/file/read', {
    table,
    key,
    ...(options.inline ? { inline: true } : {}),
    ...(options.variant ? { variant: options.variant } : {}),
  })) as { name?: unknown; type?: unknown; data?: unknown; error?: unknown };
  if (typeof reply.error === 'string') throw new Error(reply.error);
  if (typeof reply.data !== 'string' || typeof reply.name !== 'string') throw new Error(say('unreadable'));
  const type =
    typeof reply.type === 'string' && /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(reply.type) ? reply.type : 'application/octet-stream';
  return { blob: new Blob([bytesOf(reply.data)], { type }), name: reply.name };
}

/* Pictures read on the lease, by what they were read as; the oldest is let go past the most kept. */
const KEPT = 300;
const pictures = new Map<string, Promise<string>>();
/* The lease a picture was read on: another account or tenant reads its own. */
let keptFor: unknown;

function pictureOnLease(table: string, key: Record<string, unknown>, variant?: 'thumb'): Promise<string> {
  const identity = captureSessionIdentity();
  if (keptFor !== identity) {
    for (const kept of pictures.values()) void kept.then(URL.revokeObjectURL, () => {});
    pictures.clear();
    keptFor = identity;
  }
  const name = JSON.stringify([table, key, variant ?? '']);
  const kept = pictures.get(name);
  if (kept) return kept;
  const read = fileOnLease(table, key, { inline: true, ...(variant ? { variant } : {}) }).then(({ blob }) => URL.createObjectURL(blob));
  read.catch(() => pictures.delete(name));
  pictures.set(name, read);
  if (pictures.size > KEPT) {
    const [oldest, gone] = pictures.entries().next().value!;
    pictures.delete(oldest);
    void gone.then(URL.revokeObjectURL, () => {});
  }
  return read;
}

/**
 * A picture's address, to draw in place: the file route's inline mode, or on
 * a lease the blob it was read into — undefined until it has been, and when
 * it could not be (the picture then draws as its words).
 */
export function usePictureAddress(
  table: string | undefined,
  key: Record<string, unknown> | undefined,
  connection: string | null | undefined,
  variant?: 'thumb',
): string | undefined {
  const lease = filesOnLease();
  const direct =
    table && key && !lease ? fileAddress(table, key, connection, { inline: true, ...(variant ? { variant } : {}) }) : undefined;
  const [drawn, setDrawn] = useState<{ name: string; src: string }>();
  const name = table && key ? JSON.stringify([table, key, variant ?? '']) : '';
  useEffect(() => {
    if (!lease || !table || !key) return;
    let current = true;
    pictureOnLease(table, key, variant).then(
      (src) => current && setDrawn({ name, src }),
      () => current && setDrawn(undefined),
    );
    return () => {
      current = false;
    };
  }, [lease, name]);
  return direct ?? (drawn?.name === name ? drawn.src : undefined);
}

/** Save one file as the reader's own: on a lease, read and handed to the browser as a download. */
export async function saveFileOnLease(table: string, key: Record<string, unknown>): Promise<void> {
  const { blob, name } = await fileOnLease(table, key);
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  link.rel = 'noopener';
  portalRoot().append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}
