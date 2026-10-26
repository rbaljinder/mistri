/**
 * A value as a QR code to scan — an asset tag, a link to a portal — with the
 * value under it, so a reader without a camera reads the same thing.
 *
 * A part on demand (Dressed.tsx): the encoder is a library of its own, and
 * only a record or a card that shows a `format: 'qr'` value fetches it. The
 * code is drawn as one SVG path of its dark modules, near-black on white
 * with the quiet zone the standard asks for, in every look and mode: an
 * inverted code on a dark ground is one many scanners refuse.
 */
import { memo } from 'react';
import qrcode from 'qrcode-generator';
import { say } from '../copy/record/components/QrCode.js';
import './QrCode.css';

/* The quiet zone, in modules: four, as the standard says. */
const QUIET = 4;

/** The value's UTF-8 bytes as the encoder's byte string: its own conversion keeps only each code unit's low byte. */
function utf8(text: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(text)) out += String.fromCharCode(byte);
  return out;
}

/** The dark modules as one path, a run of them in a row a rectangle. */
function pathOf(text: string): { size: number; d: string } | null {
  const code = qrcode(0, 'M');
  try {
    code.addData(utf8(text), 'Byte');
    code.make();
  } catch {
    return null;
  }
  const count = code.getModuleCount();
  let d = '';
  for (let row = 0; row < count; row += 1) {
    let col = 0;
    while (col < count) {
      if (!code.isDark(row, col)) {
        col += 1;
        continue;
      }
      const start = col;
      while (col < count && code.isDark(row, col)) col += 1;
      d += `M${start + QUIET} ${row + QUIET}h${col - start}v1h${start - col}z`;
    }
  }
  return { size: count + QUIET * 2, d };
}

export const QrCode = memo(function QrCode({ text }: { text: string }) {
  const drawn = pathOf(text);
  if (!drawn) return <span className="qr-value-text">{text}</span>;
  return (
    <figure className="qr-value">
      <svg
        className="qr-value-code"
        viewBox={`0 0 ${drawn.size} ${drawn.size}`}
        role="img"
        aria-label={say('qrOf', { text })}
        shapeRendering="crispEdges"
      >
        <rect width={drawn.size} height={drawn.size} className="qr-value-ground" />
        <path d={drawn.d} className="qr-value-ink" />
      </svg>
      <figcaption className="qr-value-text">{text}</figcaption>
    </figure>
  );
});
