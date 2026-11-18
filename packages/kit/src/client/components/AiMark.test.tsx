/** The one AI mark: a glyph and the App's word for it, "AI" when the App names none; quiet keeps the word for a reader. */
import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { installShell, resetShell } from '../shellMode.js';
import { AiMark, aiWord } from './AiMark.js';

afterEach(() => {
  cleanup();
  resetShell();
});

test('with no App label the mark says AI beside its glyph', () => {
  const { container } = render(<AiMark />);
  expect(screen.getByText('AI')).toHaveClass('ai-mark-word');
  expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  expect(aiWord()).toBe('AI');
});

test("the App's own label replaces the word everywhere the mark is drawn", () => {
  installShell({ app: () => ({ ai: { label: 'Copilot' } }) as never });
  render(<AiMark className="extra" />);
  expect(screen.getByText('Copilot').closest('.ai-mark')).toHaveClass('extra');
  expect(aiWord()).toBe('Copilot');
});

test('quiet hides the word from sight and keeps it for a screen reader', () => {
  render(<AiMark quiet />);
  const word = screen.getByText('AI');
  expect(word).toHaveClass('visually-hidden');
  expect(word.closest('.ai-mark')).toHaveAttribute('data-quiet', '');
});
