/**
 * A notice's words (`{words.code}` in a notify title, given by the write:
 * `db.t.insert(row, { words: { code } })`), sealed while they wait to be
 * sent. A one-time code or a link's token is said to its person by mail or
 * on a channel and nowhere else: the inbox keeps the title with each word
 * masked, and the queued mail or message keeps the said title sealed with
 * AES-256-GCM under a key derived from `MISTRI_SECRETS_KEY` for this purpose
 * alone (integrationSecrets.ts), bound to the row it waits in. The sealed
 * value is cleared once it is sent, fails or expires, so a database read
 * holds the words only while they are on their way, and only as ciphertext.
 *
 * An App whose notices say words does not start without the key, as an App
 * with integrations does not.
 */
import { openUnder, purposeKey, SecretsKeyMissing, sealUnder } from '../integrations/integrationSecrets.js';

const missing = () =>
  new SecretsKeyMissing(
    "The App's notifications say a write's words ({words.…} in a notify title), which wait to be sent sealed",
    'makes the words of any notice still waiting unreadable; it is then not sent',
  );
const keyOf = (appId: string) => () => purposeKey(appId, 'mistri.notice-words', 'notice-words', missing);
const placeOf = (place: readonly string[]) => Buffer.from(JSON.stringify(['mistri.notice-words.v1', ...place]));

/** Whether the deployment can seal a notice's words: asked as the App starts, before any write could need it. */
export function assertNoticeWordsKey(appId: string): void {
  keyOf(appId)();
}

/** A notice rule's sealer: the said title, bound to where it waits (the inbox's App and the notice id, or the
    channel message's App, tenant and key). */
export const noticeWordsSeal =
  (appId: string) =>
  (text: string, place: readonly string[]): string =>
    sealUnder(keyOf(appId), placeOf(place), text);

/** Why a notice whose words did not open is not sent: they cannot be said, and a masked code tells nobody anything. */
export const NOTICE_WORDS_UNOPENED = "the notice's sealed words do not open with this deployment's MISTRI_SECRETS_KEY";

/** The said title, or undefined where it does not open here: another key, another row, a damaged value. */
export const openNoticeWords = (appId: string, place: readonly string[], sealed: string): string | undefined =>
  openUnder(keyOf(appId), placeOf(place), sealed);

/** What is kept and logged in place of a provider's reason for a send that said a write's words: the reason may
    quote the text it refused, and the words must not outlive the sealed value in a column or a log line. */
const NOTICE_WORDS_REASON = "the provider's reason is not kept: the message said a write's words";

/** A failed send's reason as it may be kept: the provider's own, unless the message said a write's words. */
export const keptReason = (reason: string, words: string | null | undefined): string => (words ? NOTICE_WORDS_REASON : reason);
