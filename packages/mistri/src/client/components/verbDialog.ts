/**
 * The words a verb's dialog repeats when the verb is named for what the dialog already says: a verb labeled "Cancel"
 * would dismiss with "Cancel", head a subtitle with its own label and send a person to "Open Cancel …". Shared by the
 * command form and the fixed verbs' dialogs (Actions.tsx), which a lazy chunk each draw.
 */
import { shell } from '@mistriwork/kit/client/shellMode.js';
import { findTable } from '@mistriwork/kit/client/core.js';
import { recordNoun } from '@mistriwork/engine/shared/appNoun.js';
import { say } from '../copy/forms/components/verbDialog.js';
import { say as sayCommon } from '../copy/forms/components/CommandForm.js';
import { resourceOf } from '@mistriwork/kit/client/components/appRooms.js';

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** What a dialog's dismiss button says: Cancel, except where the verb is itself "Cancel", which it must not repeat. */
export function dismissLabel(verb: string): string {
  return same(verb, sayCommon('common.cancel')) ? sayCommon('common.close') : sayCommon('common.cancel');
}

/** Whether a line under the title only says the title again. */
export const repeatsTitle = (line: string, title: string): boolean => same(line, title);

/** What a resource's records are called, mid-sentence: "booking". */
export function recordNounOf(tableId: string): string {
  const table = findTable(tableId) as { id: string; name: string } | undefined;
  const app = shell().app();
  const authored = app?.resources ? resourceOf(app, tableId)?.noun : undefined;
  return recordNoun(authored, table?.name ?? tableId);
}

/** A record named by its resource's noun: "the booking". */
export const theRecord = (tableId: string): string => say('theNoun', { noun: recordNounOf(tableId) });
