/**
 * One vocabulary for a proposal's state, wherever it is shown (the For review room, a record's head line, the
 * assistant's card, a decision's chip): drafted, then approved, then what the command did — its label's verb in the
 * past tense, "Sent" for Send appeal — or dismissed. Approved alone is a proposal approved whose run has not settled.
 *
 * The verb is read off the command's own label rather than declared: a command already says what it does, and a
 * second word for the same thing is a knob nobody keeps in step. A label whose first word is not an English verb, or
 * an App in another language, says Done.
 */
import { messageLanguage, servedLanguage } from '@mistriwork/kit/client/messages.js';
import { say } from './copy/record/proposalWords.js';
import type { ProposalState } from './commandProposals.js';

/* The irregular and doubled-consonant verbs a command's label starts with; the rest take -ed by the regular rules. */
const IRREGULAR: Readonly<Record<string, string>> = {
  send: 'sent',
  pay: 'paid',
  write: 'written',
  stop: 'stopped',
  ship: 'shipped',
  submit: 'submitted',
  set: 'set',
  put: 'put',
  cut: 'cut',
  run: 'ran',
  begin: 'begun',
  hold: 'held',
  make: 'made',
  take: 'taken',
  give: 'given',
  get: 'got',
  sell: 'sold',
  buy: 'bought',
  bring: 'brought',
  lead: 'led',
  plan: 'planned',
  drop: 'dropped',
  flag: 'flagged',
  tag: 'tagged',
  pin: 'pinned',
  admit: 'admitted',
  refer: 'referred',
  commit: 'committed',
  transfer: 'transferred',
  forward: 'forwarded',
  bill: 'billed',
  file: 'filed',
};

/** The past tense of a command's label's first word, or undefined when it cannot be read as an English verb. */
export function pastTense(label: string): string | undefined {
  // The label is the App's words: read as English only where both the platform and the App speak it.
  if (messageLanguage() !== 'en' || !/^en\b/i.test(servedLanguage() ?? 'en')) return undefined;
  const word = /^[A-Za-z]+/.exec(label.trim())?.[0];
  if (!word || word.length < 2) return undefined;
  const verb = word.toLowerCase();
  let past = IRREGULAR[verb];
  if (!past) {
    if (verb.endsWith('ed')) return undefined;
    if (verb.endsWith('e')) past = `${verb}d`;
    else if (/[^aeiou]y$/.test(verb)) past = `${verb.slice(0, -1)}ied`;
    else past = `${verb}ed`;
  }
  return past.charAt(0).toUpperCase() + past.slice(1);
}

/**
 * The word for a proposal's state. `ran` says whether an approval's run settled (a receipt), so approved-and-done says
 * the command's past tense and approved-and-waiting says Approved.
 */
export function proposalStateWord(state: ProposalState | 'done', label: string | undefined, ran = true): string {
  if (state === 'proposed') return say('drafted');
  if (state === 'dismissed' || state === 'expired') return say('dismissed');
  if (state === 'failed') return say('failed');
  if (state === 'approved' && !ran) return say('approved');
  return (label && pastTense(label)) || say('done');
}
