/**
 * One input of a command drawn by a component's own control (`useField`), and
 * the money reading the platform's own form uses (`parseMoney`): a typed
 * amount is read in the locale and the currency's digits, a negative only
 * where the field allows one, and a figure past 2^53 is kept as text.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { parseMoney, useField, type UiField } from './fields.js';
import { renderSection } from './testing.js';

afterEach(cleanup);

describe('parseMoney', () => {
  test('reads the locale’s marks and the currency’s digits', () => {
    expect(parseMoney('$1,234.50', { currency: 'USD', locale: 'en-US' })).toEqual({ minor: '123450', major: '1234.50' });
    expect(parseMoney('1.234,5 €', { currency: 'EUR', locale: 'de-DE' })).toEqual({ minor: '123450', major: '1234.50' });
    expect(parseMoney('1,200', { currency: 'JPY', locale: 'ja-JP' })).toEqual({ minor: '1200', major: '1200' });
  });

  test('says what is wrong instead of guessing', () => {
    expect(parseMoney('', { currency: 'USD', locale: 'en-US' })).toEqual({ problem: 'Enter an amount.' });
    expect(parseMoney('12a', { currency: 'USD', locale: 'en-US' })).toEqual({ problem: 'Enter an amount.' });
    expect(parseMoney('1.234', { currency: 'USD', locale: 'en-US' })).toEqual({
      problem: 'Enter an amount with at most 2 decimal places.',
    });
    expect(parseMoney('1.5', { currency: 'JPY', locale: 'en-US' })).toEqual({ problem: 'Enter a whole amount.' });
  });

  test('takes a negative only where the field allows one', () => {
    expect(parseMoney('-5.00', { currency: 'USD', locale: 'en-US' })).toEqual({ problem: 'Enter an amount of zero or more.' });
    expect(parseMoney('−5.00', { currency: 'USD', locale: 'en-US', negative: true })).toEqual({ minor: '-500', major: '-5.00' });
  });

  test('keeps a figure past 2^53 exact, as text', () => {
    expect(parseMoney('123456789012345678.91', { currency: 'USD', locale: 'en-US' })).toEqual({
      minor: '12345678901234567891',
      major: '123456789012345678.91',
    });
  });
});

describe('useField', () => {
  const held: { field?: UiField } = {};
  function Amount() {
    const field = useField('transfer', 'amount');
    held.field = field;
    return (
      <label>
        {field.inputProps.label}
        <input
          id={field.inputProps.id}
          disabled={field.inputProps.disabled}
          aria-invalid={field.inputProps.invalid}
          value={field.text}
          onChange={(event) => field.inputProps.onChange(event.target.value)}
        />
        {field.error ? <span id={field.inputProps.describedBy}>{field.error}</span> : null}
      </label>
    );
  }
  const served = {
    transfer: { label: 'Transfer', input: { amount: { type: 'money' as const, minor: true, required: true, currency: 'USD' } } },
  };

  test('binds the declared input: its label, its value as sent, and its problem once judged', () => {
    renderSection(Amount, { component: { id: 'amount' } }, { viewer: { signedIn: true, account: 'a' }, commands: served, locale: 'en-US' });
    expect(screen.getByLabelText('Amount')).not.toBeDisabled();
    expect(held.field).toMatchObject({ text: '', value: null, touched: false, dirty: false, error: undefined });
    let valid = true;
    act(() => {
      valid = held.field!.validate();
    });
    expect(valid).toBe(false);
    expect(held.field!.error).toBeTruthy();
    expect(held.field!.inputProps).toMatchObject({ invalid: true, required: true, context: 'command', field: { name: 'amount' } });
    act(() => held.field!.inputProps.onChange('1,234.50'));
    expect(held.field).toMatchObject({ text: '1,234.50', value: '1234.50', touched: true, dirty: true, error: undefined });
    act(() => held.field!.inputProps.onChange('1.234'));
    expect(held.field!.error).toBe('Enter an amount with at most 2 decimal places.');
    expect(held.field!.value).toBeNull();
  });

  test('a reader not granted the command is drawn the field, disabled and never judged', () => {
    renderSection(Amount, { component: { id: 'amount' } }, { commands: served });
    expect(screen.getByRole('textbox')).toBeDisabled();
    act(() => {
      expect(held.field!.validate()).toBe(true);
    });
  });

  test('a name the command does not declare is a mistake, said plainly', () => {
    function Wrong() {
      useField('transfer', 'amout');
      return null;
    }
    expect(() => render(<Wrong />)).toThrow();
    expect(() =>
      renderSection(Wrong, { component: { id: 'wrong' } }, { viewer: { signedIn: true, account: 'a' }, commands: served }),
    ).toThrow('transfer has no input "amout" to bind');
  });
});
