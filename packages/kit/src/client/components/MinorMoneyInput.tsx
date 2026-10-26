/**
 * A money box over a column kept in minor units (`format: 'money', minor:
 * true`): a person types the figure they mean, "19.99", and the form holds
 * what is stored, "1999" — so every check, live value and save reads one
 * unit. The box keeps its own text while it is typed ("19.", "19.9") and
 * hands back the stored amount once the text is one; text that is not (more
 * decimals than the currency has, a letter) is handed back as typed, which
 * an integer column then refuses, and `minorProblem` says why first.
 *
 * Fetched with the forms that draw it (NewRecord, GridCellEditor, FormLines),
 * never with a list.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { currencyDigits, minorToMajor } from '@mistriwork/engine/shared/money.js';
import { majorToMinor } from '@mistriwork/engine/shared/moneyEntry.js';
import { say } from '../copy/forms/components/MinorMoneyInput.js';

/** The major figure a stored amount is typed as; the text itself when it is no amount. */
export function majorText(stored: string | null | undefined, currency: string): string {
  if (stored === null || stored === undefined || stored === '') return '';
  return minorToMajor(stored, currency) ?? stored;
}

/** What a box's text hands the form: the stored amount where it is one, '' for none, else the text as typed. */
function handed(text: string, currency: string): string {
  if (text.trim() === '') return '';
  const stored = majorToMinor(text, currency);
  return stored === undefined ? text : String(stored);
}

/** Why a held value is not an amount of this currency, or '' when it is one (or empty). */
export function minorProblem(stored: string | null | undefined, currency: string): string {
  if (stored === null || stored === undefined || stored === '' || /^-?\d+$/.test(stored)) return '';
  const digits = currencyDigits(currency);
  return digits ? say('enterAnAmount', { digits }) : say('enterAWholeAmount');
}

export function MinorMoneyInput({
  value,
  currency,
  onChange,
  children,
}: {
  /** The stored amount, as text: "1999". */
  value: string;
  currency: string;
  /** The stored amount where the text is one, else the text as typed. */
  onChange: (stored: string) => void;
  /** The box itself, drawn by the caller in its own dress, over the text a person sees. */
  children: (text: string, change: (text: string) => void) => ReactNode;
}) {
  const [text, setText] = useState(() => majorText(value, currency));
  /* A value set from outside (a reset, another currency) redraws the box, unless the box already says it. */
  useEffect(() => {
    if (handed(text, currency) !== value) setText(majorText(value, currency));
  }, [value, currency]); // eslint-disable-line react-hooks/exhaustive-deps
  const change = (next: string) => {
    setText(next);
    onChange(handed(next, currency));
  };
  return <>{children(text, change)}</>;
}
