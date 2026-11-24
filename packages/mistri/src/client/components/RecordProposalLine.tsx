/**
 * What waits on one record from a maker that is not a person, said on the record itself: the line under its head
 * ("✦ AI 1 proposal: Send appeal · Review", the mark carrying the word) and the mark at a field an AI or a job wrote
 * that no person has confirmed, with Confirm in place. Both read the shell's one review list (commandProposals.ts `useReview`), which the record's
 * adornment (decisionAdornment.tsx) hands over whole: opening a record asks nothing more.
 *
 * Loaded the first time a record's table has something waiting (decisionAdornment.tsx), and it is here, not in the
 * adornment, that the list is narrowed to the record: no first page carries that, nor the proposal panel it opens.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { go, state, toast } from '@mistriwork/kit/client/core.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { AiBadge, aiWord } from '@mistriwork/kit/client/components/AiMark.js';
import { PROPOSALS_KEY, type CommandProposal, type ReviewList, type UnconfirmedMark } from '../commandProposals.js';
import { pendingOn, unconfirmedOn } from '../proposalTargets.js';
import { confirmProvenance } from '../proposalDecisions.js';
import { reviewEntry } from '../publicAddress.js';
import { actionOf } from './sdk/commands.js';
import { commandResource } from './sdk/proposalCommands.js';
import { openProposal } from './ProposalPanel.js';
import { say } from '../copy/record/components/RecordProposalLine.js';
import './RecordProposalLine.css';

const makerOf = (mark: Pick<UnconfirmedMark, 'actorKind' | 'actor'>) =>
  mark.actorKind === 'job' ? say('madeByJob', { job: mark.actor }) : aiWord();

/** Confirm one field's mark, or every mark on the row when `field` is absent; the list is read again either way. */
function useConfirm(mark: UnconfirmedMark, key: Readonly<Record<string, unknown>>, field?: string) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await confirmProvenance(state.activeConnection ?? null, {
        command: mark.command,
        resource: mark.resource,
        key,
        ...(field ? { field } : {}),
      });
      toast(say('confirmed'));
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(false);
      void client.invalidateQueries({ queryKey: [PROPOSALS_KEY] });
    }
  };
  return { busy, run };
}

export function RecordProposalLine({
  proposals,
  rowMark,
  recordKey,
  onLanded,
}: {
  proposals: readonly CommandProposal[];
  /** A mark on the row as a whole (a record an AI or a job created), when no person has confirmed it. */
  rowMark?: UnconfirmedMark;
  recordKey: Readonly<Record<string, unknown>>;
  onLanded: () => void;
}) {
  const client = useQueryClient();
  const confirm = useConfirm(rowMark ?? ({} as UnconfirmedMark), recordKey);
  const labels = [...new Set(proposals.map((each) => actionOf(each.command)?.label ?? humanName(each.command)))].join(', ');
  /* One proposal opens its panel here; several go to the room, where each is decided in its group. */
  const review = () => {
    if (proposals.length !== 1) return go(reviewEntry(), 'push');
    void openProposal(proposals[0]!, state.activeConnection ?? null)?.then((outcome) => {
      if (outcome.status !== 'applied') return;
      void client.invalidateQueries();
      onLanded();
    });
  };
  return (
    <div className="record-ai-line" role="status">
      {proposals.length > 0 && (
        <p className="record-ai-item">
          <AiBadge />
          <span>{say('proposals', { count: proposals.length, labels })}</span>
          <span aria-hidden="true">·</span>
          <button type="button" className="record-ai-act" onClick={review}>
            {say('review')}
          </button>
        </p>
      )}
      {rowMark && (
        <p className="record-ai-item">
          <AiBadge quiet />
          <span>{say('madeUnconfirmed', { maker: makerOf(rowMark) })}</span>
          <span aria-hidden="true">·</span>
          <button type="button" className="record-ai-act" disabled={confirm.busy} onClick={() => void confirm.run()}>
            {say('confirm')}
          </button>
        </p>
      )}
    </div>
  );
}

/** The mark beside a field a non-person maker wrote, with Confirm in place. */
export function UnconfirmedFieldMark({ mark, recordKey }: { mark: UnconfirmedMark; recordKey: Readonly<Record<string, unknown>> }) {
  const field = humanName(mark.field ?? '');
  const confirm = useConfirm(mark, recordKey, mark.field ?? undefined);
  return (
    <span className="unconfirmed-mark" title={say('unconfirmedField', { field, maker: makerOf(mark) })}>
      <AiBadge quiet />
      <button
        type="button"
        className="record-ai-act"
        disabled={confirm.busy}
        aria-label={say('confirmField', { field })}
        onClick={() => void confirm.run()}
      >
        {say('confirm')}
      </button>
    </span>
  );
}

/** The record's line, from the whole review list: its pending proposals on this table, and a mark on the row itself. */
export function RecordReview({
  review,
  table,
  recordKey,
  onLanded,
}: {
  review: ReviewList;
  table: string;
  recordKey: Readonly<Record<string, unknown>>;
  onLanded: () => void;
}) {
  const proposals = pendingOn(review.proposals, recordKey).filter((each) => commandResource(each.command) === table);
  const rowMark = unconfirmedOn(review.unconfirmed, table, recordKey).find((mark) => mark.field === null);
  if (!proposals.length && !rowMark) return null;
  return <RecordProposalLine proposals={proposals} rowMark={rowMark} recordKey={recordKey} onLanded={onLanded} />;
}

/** One field's mark, from the whole review list, where a non-person maker wrote it and no person has confirmed it. */
export function FieldReview({
  marks,
  table,
  column,
  recordKey,
}: {
  marks: readonly UnconfirmedMark[];
  table: string;
  column: string;
  recordKey: Readonly<Record<string, unknown>>;
}) {
  const mark = unconfirmedOn(marks, table, recordKey).find((each) => each.field === column);
  return mark ? <UnconfirmedFieldMark mark={mark} recordKey={recordKey} /> : null;
}
