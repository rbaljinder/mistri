/**
 * A public form's review, read from the page's own memory: what each answer
 * says in words. Shared by the one-submit form (FormSurface.tsx) and the form
 * saved on every step (SavedFormSurface.tsx); neither ever asks the server
 * for what was typed.
 */
import type { AppCommandField } from '../../shared/command.js';
import { formatLocale } from '@mistriwork/kit/client/locale.js';
import { say } from '../copy/record/components/reviewValues.js';
import { amountIn, maskShown } from './fieldShown.js';

/** Whether a field keeps only part of what is typed (`sensitive`): it is never said in full where it is read back. */
export function sensitiveText(
  field: AppCommandField,
): field is Extract<AppCommandField, { type: 'text' | 'textarea' }> & { mask?: string } {
  return (field.type === 'text' || field.type === 'textarea') && 'sensitive' in field && !!field.sensitive;
}

/**
 * A sensitive answer as it is read back: a dot for every character but the last four, a mask's own punctuation
 * kept where it stands (`•••-••-6789` for `123456789` under `000-00-0000`). An answer of four or fewer is all dots.
 */
export function maskedLast4(value: string, mask?: string): string {
  const shown = new Set<number>();
  const chars = [...value];
  for (let i = Math.max(chars.length - 4, chars.length > 4 ? 0 : chars.length); i < chars.length; i++) shown.add(i);
  const dotted = chars.map((char, index) => (shown.has(index) ? char : '•'));
  if (!mask) return dotted.join('');
  // Walk the mask: a place takes the next character, anything else is drawn as written until the value runs out.
  let used = 0;
  let out = '';
  for (const part of mask) {
    if (used >= dotted.length) break;
    if (part === '0' || part === 'a' || part === '*') out += dotted[used++];
    else out += part;
  }
  return out + dotted.slice(used).join('');
}

/**
 * A value as the review reads it, as its field drew it: the choice's label, yes or no, a day in words, an amount in
 * the App's currency (`$450`), a masked text through its mask (`(303) 555-0142`), a group's rows.
 */
export function sayInput(field: AppCommandField, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  const mask = 'mask' in field && typeof field.mask === 'string' ? field.mask : undefined;
  if (sensitiveText(field)) return maskedLast4(String(value), field.mask);
  if (field.type === 'boolean') return value ? say('common.yes') : say('common.no');
  // A day is a calendar date, not a moment: read in UTC so no zone moves it, and said as the person's locale says it.
  if (field.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(value)))
    return new Date(`${String(value)}T00:00:00Z`).toLocaleDateString(formatLocale(), { timeZone: 'UTC', dateStyle: 'medium' });
  if (field.type === 'money' && Number.isFinite(Number(value))) return amountIn(Number(value), undefined, field.step);
  if (mask && typeof value === 'string') return maskShown(mask, value);
  if (field.type === 'choice') return field.options.find((option) => option.value === value)?.label ?? String(value);
  if (field.type === 'choices') {
    const picked = Array.isArray(value) ? value : [value];
    if (!picked.length) return '—';
    return picked.map((each) => field.options.find((option) => option.value === each)?.label ?? String(each)).join(', ');
  }
  if (field.type === 'group') {
    const lines = reviewLines(field, value);
    return lines.length ? lines.join('; ') : '—';
  }
  return String(value);
}

/** Whether an answer was given: not empty, not an empty list. */
export const answered = (value: unknown) =>
  value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && !value.length);

/**
 * What a step said, in a line, for the steps beside a page's form (MultiStepForm's `summarize`): each answer given, as
 * the review says it, after one another. A yes-or-no question says its label when yes and nothing when no — a bare
 * "Yes" names nothing — and a sensitive answer keeps to its last four. Undefined when the step said nothing.
 */
export function stepSaid(fields: readonly AppCommandField[], values: Readonly<Record<string, unknown>>): string | undefined {
  const said = fields.flatMap((field) => {
    const value = values[field.name];
    if (!answered(value)) return [];
    if (field.type === 'boolean') return value ? [field.label] : [];
    return [sayInput(field, value)];
  });
  return said.length ? said.join(', ') : undefined;
}

/**
 * A group's answers as the review lists them, a line each: every member by its label ("Urgent: Yes"), so a run of
 * yes-or-no questions never reads "Yes, Yes, No, No" with nothing to say which is which. A member left empty is
 * left out, and a group of one member says its answer alone. A repeating group is a line per row, its members after
 * one another. Empty for a group with no answer.
 */
export function reviewLines(field: Extract<AppCommandField, { type: 'group' }>, value: unknown): string[] {
  const said = (row: unknown) =>
    field.fields.flatMap((member) => {
      const held = (row as Record<string, unknown> | undefined)?.[member.name];
      if (!answered(held)) return [];
      // A group of one asks one thing, which its own label (the review's term) already names.
      return [field.fields.length > 1 ? `${member.label}: ${sayInput(member, held)}` : sayInput(member, held)];
    });
  if (field.repeat) return (Array.isArray(value) ? value : []).map((row) => said(row).join(', ')).filter(Boolean);
  return said(value);
}
