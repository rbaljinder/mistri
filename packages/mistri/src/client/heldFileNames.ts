/**
 * What this page knows of the files it has held for a command (components/
 * HeldFiles.tsx): an id is all a form's value carries, so a review, or the
 * field drawn again on the step it left, says the file by the name it was
 * sent with. Kept apart from the drop area, so a review knows the names
 * without loading it. A held id this page did not send has no entry.
 */
export interface HeldFileInfo {
  name: string;
  type: string;
  size: number;
  /** The bytes as sent, for a preview and a kept signature's picture. */
  url?: string;
}

const held = new Map<string, HeldFileInfo>();

export const heldFileInfo = (id: string): HeldFileInfo | undefined => held.get(id);

export function rememberHeldFile(id: string, info: HeldFileInfo): void {
  held.set(id, info);
}

/** A file taken off the form: its bytes let go. */
export function forgetHeldFile(id: string): void {
  const info = held.get(id);
  if (info?.url) URL.revokeObjectURL(info.url);
  held.delete(id);
}
