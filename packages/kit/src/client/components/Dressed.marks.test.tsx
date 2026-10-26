/**
 * A value's mark (a display rule's `icons`) and a person's photo, as drawn:
 * the mark stands where a tone's dot would and the word stays the value for
 * assistive technology; a photo stands in the initials' place and gives way
 * to them where it will not load.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { dressFor } from './valueModel.js';
import { AvatarText, Dressed } from './Dressed.js';

afterEach(() => cleanup());

describe('value marks', () => {
  const rule = { tone: { rush: 'bad', '*': 'neutral' }, icons: { rush: 'fire', low: 'cell-signal-low' } };

  test('a toned value takes its mark in the tone, an untoned one in the caption ink, and the word is said', () => {
    expect(dressFor(rule, 'rush')).toMatchObject({ kind: 'tone', tone: 'bad', icon: 'fire', label: 'Rush' });
    expect(dressFor(rule, 'normal')).toEqual({ kind: 'tone', tone: 'neutral', text: 'normal', label: 'Normal' });
    expect(dressFor({ icons: { low: 'cell-signal-low' } }, 'low')).toEqual({
      kind: 'mark',
      icon: 'cell-signal-low',
      text: 'low',
      label: 'Low',
    });
    // A mark names a word of the vocabulary: a prototype key is not one.
    expect(dressFor({ icons: { low: 'cell-signal-low' } }, 'constructor')).toBeNull();
    const { container } = render(<Dressed dress={dressFor(rule, 'rush')!} />);
    const chip = container.querySelector('.tone.tone-marked')!;
    expect(chip.textContent).toBe('Rush');
    expect(chip.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  test("a photo stands in the initials' place, and the initials come back when it will not load", () => {
    const { container } = render(<AvatarText text="Rosa Delgado" photo="/api/file?table=photo" />);
    const img = container.querySelector('img.avatar-photo')!;
    expect(img.getAttribute('alt')).toBe('');
    expect(container.textContent).toBe('Rosa Delgado');
    fireEvent.error(img);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.avatar')?.textContent).toBe('RD');
  });
});

describe('a stack of people', () => {
  const rule = { format: 'avatars' } as never;
  const four = ['Ada Lovelace', 'Bo Chen', 'Cy Young', 'Di Prince'];

  test.each([
    ['an array', four],
    ['a JSON array as text', JSON.stringify(four)],
    ['a comma list', four.join(', ')],
  ])('%s is three discs and a count of the rest, naming everyone', (_, value) => {
    const { container } = render(<Dressed dress={dressFor(rule, value)!} />);
    const stack = container.querySelector('.avatar-stack')!;
    expect(stack.querySelectorAll('.avatar:not(.avatar-more)')).toHaveLength(3);
    expect([...stack.querySelectorAll('.avatar:not(.avatar-more)')].map((n) => n.textContent)).toEqual(['AL', 'BC', 'CY']);
    expect(stack.querySelector('.avatar-more')?.textContent).toBe('+1');
    for (const name of four) {
      expect(stack.getAttribute('title')).toContain(name);
      expect(stack.getAttribute('aria-label')).toContain(name);
    }
  });

  test('a few people have no count, and nobody is no dress', () => {
    const { container } = render(<Dressed dress={dressFor(rule, ['Ada Lovelace', 'Bo Chen'])!} />);
    expect(container.querySelectorAll('.avatar')).toHaveLength(2);
    expect(container.querySelector('.avatar-more')).toBeNull();
    expect(dressFor(rule, '[]')).toBeNull();
  });
});
