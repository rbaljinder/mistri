/**
 * The formats that draw a value their own way — stars, a swatch, a clock
 * time, a month, a year, a tree, a code to scan — and a percent's ring: each
 * dressed from the stored value, each said as words, and a value the format
 * cannot read falls back to the plain text rather than a wrong picture.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { dressFor } from './valueModel.js';
import { Dressed } from './Dressed.js';
import { mediaType } from './FilePreview.js';
import { previewKind } from './filePreviewModel.js';

afterEach(() => cleanup());

describe('own drawings', () => {
  test('a rating is stars said as words, rounded into its range, toned by its rule', () => {
    const rule = { format: 'rating' as const, tone: { '<= 2': 'bad' } };
    expect(dressFor(rule, 4)).toMatchObject({ kind: 'rating', value: 4, outOf: 5, text: '4 of 5 stars' });
    expect(dressFor({ format: 'rating', outOf: 3 }, 7)).toMatchObject({ value: 3, outOf: 3 });
    expect(dressFor(rule, 2)).toMatchObject({ tone: 'bad' });
    expect(dressFor(rule, 'many')).toBeNull();
    const { container } = render(<Dressed dress={dressFor(rule, 2)!} />);
    const stars = container.querySelector('.rating-value')!;
    expect(stars.getAttribute('role')).toBe('img');
    expect(stars.getAttribute('aria-label')).toBe('2 of 5 stars');
    expect(stars.classList.contains('rating-bad')).toBe(true);
    expect(stars.querySelectorAll('.rating-star.is-on')).toHaveLength(2);
    expect(stars.querySelectorAll('.rating-star')).toHaveLength(5);
  });

  test('a color is a swatch beside its code; a value that is no color is its text', () => {
    expect(dressFor({ format: 'color' }, '#1D4ED8')).toEqual({ kind: 'color', hex: '#1d4ed8', text: '#1D4ED8' });
    expect(dressFor({ format: 'color' }, 'blue')).toBeNull();
    const { container } = render(<Dressed dress={dressFor({ format: 'color' }, '#0e7490')!} />);
    expect((container.querySelector('.color-swatch') as HTMLElement).style.background).toBeTruthy();
    expect(container.textContent).toBe('#0e7490');
  });

  test('a clock time, a month and a year are said as a reader writes them, the stored value in the title', () => {
    expect(dressFor({ format: 'time' }, '14:30:00')).toMatchObject({ kind: 'number', title: '14:30:00' });
    expect((dressFor({ format: 'time' }, '14:30:00') as { text: string }).text).toMatch(/2:30\s?PM/);
    expect(dressFor({ format: 'time' }, '25:00')).toBeNull();
    expect((dressFor({ format: 'month' }, '2027-03') as { text: string }).text).toMatch(/Mar\w* 2027/);
    expect(dressFor({ format: 'month' }, '2027-13')).toBeNull();
    expect(dressFor({ format: 'year' }, 2026)).toMatchObject({ kind: 'number', text: '2026' });
    expect(dressFor({ format: 'year' }, 'soon')).toBeNull();
  });

  test('a JSON document is a short excerpt in a list and a tree in a record; a bare word is not a tree', async () => {
    const doc = JSON.stringify({ provider: 'CDK', sync: { inventory: true } });
    const dress = dressFor({ format: 'json' }, doc)!;
    expect(dress).toMatchObject({ kind: 'json', excerpt: doc });
    expect(dressFor({ format: 'json' }, '"word"')).toBeNull();
    expect(dressFor({ format: 'json' }, '{broken')).toBeNull();
    const compact = render(<Dressed dress={dress} compact />);
    expect(compact.container.querySelector('.json-preview-text')?.textContent).toBe(doc);
    compact.unmount();
    const { container } = render(<Dressed dress={dress} />);
    await waitFor(() => expect(container.textContent).toContain('provider'));
    expect(container.textContent).toContain('CDK');
  });

  test('a QR value is its text in a list and, in a record, a code fetched on demand with the text under it', async () => {
    const dress = dressFor({ format: 'qr' }, 'STK-0042')!;
    expect(dress).toEqual({ kind: 'qr', text: 'STK-0042' });
    expect(dressFor({ format: 'qr' }, '  ')).toBeNull();
    const compact = render(<Dressed dress={dress} compact />);
    expect(compact.container.querySelector('svg')).toBeNull();
    expect(compact.container.textContent).toBe('STK-0042');
    compact.unmount();
    const { container } = render(<Dressed dress={dress} />);
    await waitFor(() => expect(container.querySelector('svg.qr-value-code')).not.toBeNull());
    expect(container.querySelector('svg')!.getAttribute('aria-label')).toBe('QR code: STK-0042');
    expect(container.querySelector('.qr-value-ink')!.getAttribute('d')).toMatch(/^M4 4h/);
    expect(container.querySelector('figcaption')!.textContent).toBe('STK-0042');
  });

  test("a percent's ring fills to its figure, held inside 0 to 100", () => {
    expect(dressFor({ format: 'percent', ring: true }, 72)).toMatchObject({ kind: 'percent', ring: 72 });
    expect(dressFor({ format: 'percent', ring: true }, 140)).toMatchObject({ ring: 100 });
    const { container } = render(<Dressed dress={dressFor({ format: 'percent', ring: true }, 50)!} />);
    const fill = container.querySelector('.pct-ring-fill')!;
    const [dash, whole] = fill.getAttribute('stroke-dasharray')!.split(' ').map(Number);
    expect(dash! / whole!).toBeCloseTo(0.5);
    expect(container.querySelector('.pct-ring')!.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('file previews: video and audio', () => {
  const bytes = (...parts: (string | number[])[]) =>
    new Uint8Array(
      parts.flatMap((part) => (typeof part === 'string' ? [...part].map((c) => c.charCodeAt(0)) : part)).concat(Array(16).fill(0)),
    );

  test('a name or a type claims a player; the bytes say which one, and a renamed file is refused', () => {
    expect(previewKind('walkaround.mp4')).toBe('video');
    expect(previewKind('voicemail.mp3')).toBe('audio');
    expect(previewKind('clip', 'video/webm')).toBe('video');
    expect(mediaType(bytes([0, 0, 0, 24], 'ftyp'), 'video')).toBe('video/mp4');
    expect(mediaType(bytes([0x1a, 0x45, 0xdf, 0xa3]), 'video')).toBe('video/webm');
    expect(mediaType(bytes('OggS'), 'audio')).toBe('audio/ogg');
    expect(mediaType(bytes('RIFF', [0, 0, 0, 0], 'WAVE'), 'audio')).toBe('audio/wav');
    expect(mediaType(bytes('ID3'), 'audio')).toBe('audio/mpeg');
    expect(mediaType(bytes('ID3'), 'video')).toBeUndefined();
    expect(mediaType(bytes('%PDF-1.7'), 'video')).toBeUndefined();
    expect(mediaType(new Uint8Array(4), 'audio')).toBeUndefined();
  });
});
