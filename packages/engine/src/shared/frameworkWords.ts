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
  'mistri.form.timeHint': 'HH:MM',
  'mistri.form.review': 'Review',
  'mistri.form.reviewTitle': 'Review your answers',
  'mistri.form.reviewLead': 'Check each section. Change anything that is not right.',
  'mistri.form.change': 'Change',
  'mistri.form.changeNamed': 'Change {label}',
  'mistri.form.submit': 'Submit',
  'mistri.form.checkBox': 'Check this box to continue.',
  'mistri.form.notAccepted': 'This answer was not accepted. Check it and try again.',
  'mistri.receipt.received': 'Received',
  'mistri.receipt.keepReference': 'Keep this reference.',
  'mistri.receipt.another': 'Fill in another',
  'mistri.receipt.backTo': 'Back to {name}',
  'mistri.refusal.unreachable': 'The form could not be sent. Check your connection and try again.',
  'mistri.refusal.failed': 'The form could not be submitted ({status}).',
  'mistri.refusal.tooMany': 'Too many submissions from this address. Try again in {retryAfter} seconds.',
  'mistri.refusal.invalidInput': 'Some answers need another look.',
  'mistri.refusal.version': 'This form has changed since the page was opened. Reload the page to continue.',
  'mistri.refusal.notFound': 'What this form was about is no longer here. Reload the page to continue.',
  'mistri.refusal.ineligible': 'This can’t be sent as it stands. Check your answers and try again.',
  'mistri.refusal.forbidden': 'This form can’t be sent from this page. Reload it and try again.',
  'mistri.refusal.keyReused': 'This was already sent with different answers. Reload the page to start again.',
  'mistri.refusal.duplicate': 'Something with these details already exists.',
  'mistri.refusal.stale': 'Something changed while you were filling this in. Reload the page and try again.',
  'mistri.refusal.cancelled': 'It was not sent.',
  'mistri.refusal.unavailable': 'It could not be sent just now. Try again in a moment; it will not be sent twice.',
  'mistri.refusal.locked': 'Someone else is changing this record right now. Nothing was sent; try again in a moment.',
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
