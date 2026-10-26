/**
 * Which files open in a preview (FilePreview.tsx), and what a preview is
 * handed. Apart from the preview itself, which is loaded the first time a
 * file is opened: a list of attachments needs only to know which names are
 * worth a button.
 */
type PreviewKind = 'image' | 'pdf' | 'text' | 'video' | 'audio';

const IMAGE = /^(png|jpe?g|gif|webp|avif|bmp)$/;
const VIDEO = /^(mp4|m4v|mov|webm|ogv)$/;
const AUDIO = /^(mp3|m4a|wav|ogg|oga|opus|flac)$/;
const TEXT = /^(txt|text|md|markdown|csv|tsv|json|log|xml|ya?ml|ini|toml|sql|ts|js|css|html?)$/;

/** Which viewer a file opens in, read from its name and its stored type; undefined is download-only. */
export function previewKind(name: string, type?: string): PreviewKind | undefined {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const claimed = (type ?? '').toLowerCase();
  if (IMAGE.test(ext) || /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(claimed)) return 'image';
  if (ext === 'pdf' || claimed === 'application/pdf') return 'pdf';
  if (VIDEO.test(ext) || claimed.startsWith('video/')) return 'video';
  if (AUDIO.test(ext) || claimed.startsWith('audio/')) return 'audio';
  if (TEXT.test(ext) || claimed.startsWith('text/') || claimed === 'application/json') return 'text';
  return undefined;
}

export interface PreviewFile {
  name: string;
  kind: PreviewKind;
  /** The download address: the bytes a PDF or a text is read from. */
  href: string;
  /** A picture's address in the file route's inline mode. */
  inline?: string;
}
