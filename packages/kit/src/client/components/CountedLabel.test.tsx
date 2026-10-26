import { cleanup, render } from '@testing-library/react';
import IntlMessageFormat from 'intl-messageformat';
import { afterEach, expect, test } from 'vitest';
import { CountedLabel, type CountedMessage } from './CountedLabel.js';

afterEach(cleanup);

/* What the server sends: the message parsed in the reader's locale (server appMessages.ts countedLabels). */
const parsed = (text: string, locale: string) => new IntlMessageFormat(text, locale).getAst() as unknown as CountedMessage;

test("an App's counting label is said for the selection, by the reader's language's plural rules", () => {
  const message = parsed('Aprobar {count, plural, one {# hoja} other {# hojas}}', 'es');
  const { container, rerender } = render(<CountedLabel message={message} count={1} locale="es" />);
  expect(container.textContent).toBe('Aprobar 1 hoja');
  rerender(<CountedLabel message={message} count={3} locale="es" />);
  expect(container.textContent).toBe('Aprobar 3 hojas');
});
