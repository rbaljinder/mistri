/**
 * The fixed words the platform says on an App's command and public forms, which the App's own catalog may say instead
 * (`messages/<locale>.ts`, a `mistri.*` key). Without them an App translated into Spanish still said "Step 2 of 3",
 * "Back" and "(optional)" in English around its own words. Each key's English is what the platform says when the
 * App's catalog has no word for it in the reader's language, so a key is opt-in and an App without one changes
 * nothing. The server checks an App's `mistri.*` keys against this table (server/app/appMessages.ts readCatalogs)
 * and serves the ones it has, in the reader's words, as plain `{name}` templates (`words`); the client says them in
 * place of its own (`appWord`, kit client/messages.ts).
 */
export const FRAMEWORK_WORDS = {
  'mistri.form.step': 'Step {step} of {count}',
  'mistri.form.stepNamed': 'Step {step} of {count}: {label}',
  'mistri.form.back': 'Back',
  'mistri.form.optional': '(optional)',
  'mistri.form.required': '(required)',
  'mistri.form.reference': 'Your reference',
  'mistri.form.signAgain': 'Sign again',
  'mistri.form.yes': 'Yes',
  'mistri.form.no': 'No',
  'mistri.form.monthHint': 'MM/YYYY',
  'mistri.form.dateTimeHint': 'YYYY-MM-DD HH:MM',
  'mistri.status.offerEmail': 'We can email a code to the address on this application. It opens its details once, for 10 minutes.',
  'mistri.status.offerText': 'We can send a code to the phone number on this application. It opens its details once, for 10 minutes.',
  'mistri.status.askEmail': 'Email me a code',
  'mistri.status.askText': 'Send me a code',
  'mistri.status.sentEmail': 'We sent a code to your email.',
  'mistri.status.sentText': 'We sent a code by text message.',
  'mistri.status.codeEmail': 'Code from the email',
  'mistri.status.codeText': 'Code from the message',
} as const;

export type FrameworkWordKey = keyof typeof FRAMEWORK_WORDS;

/** A catalog key the platform reserves: an App's catalog may say it only as one of FRAMEWORK_WORDS. */
export const isFrameworkWordKey = (key: string): boolean => key.startsWith('mistri.');

/** The `{name}` arguments a built-in word's English reads: all an App's word for it may read. */
export function frameworkWordArgs(key: FrameworkWordKey): Set<string> {
  return new Set([...FRAMEWORK_WORDS[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]!));
}
