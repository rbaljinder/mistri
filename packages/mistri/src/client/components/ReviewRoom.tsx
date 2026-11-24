/**
 * The For review room (`/{app}/review`): what AI proposed that a person may decide, grouped by command, and what a
 * non-person maker wrote that no person has confirmed yet. Shown when the App has such work for this reader (`review`
 * in its payload); the list is the server's, scoped to the commands the reader is granted
 * (server/commands/proposals.ts), so a row here is one they may decide.
 *
 * A row says the mark, the record, why, and how long it has waited, with Approve (as it stands), Change… (the
 * proposal's panel, ProposalPanel.tsx) and Dismiss. Approve all and Dismiss all are offered only for a command whose
 * action says `bulk`: one that does not asks to be decided one record at a time.
 *
 * Loaded the first time the room opens (appnav.js, onDemand): no first page carries it.
 */
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@mistriwork/ui/Button.js';
import { findTable, go, rowView, state, toast } from '@mistriwork/kit/client/core.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { AiBadge, aiWord } from '@mistriwork/kit/client/components/AiMark.js';
import { Empty } from '@mistriwork/kit/client/components/Notes.js';
import { useCrumbSlots } from '@mistriwork/kit/client/components/crumbSlot.js';
import { formatDateTime } from '@mistriwork/kit/client/locale.js';
import { approveProposal, confirmProvenance, dismissProposal } from '../proposalDecisions.js';
import { PROPOSALS_KEY, useReview, type CommandProposal, type UnconfirmedMark } from '../commandProposals.js';
import { activeApp } from '../appState.js';
import { actionOf } from './sdk/commands.js';
import { commandResource, commandRevision } from './sdk/proposalCommands.js';
import { openProposal, proposalKey } from './ProposalPanel.js';
import { proposalStateWord } from '../proposalWords.js';
import { relativeTime } from '../relativeTime.js';
import { say } from '../copy/review/components/ReviewRoom.js';
import './ReviewRoom.css';
import './ProposalPanel.css';

const keyText = (key: Readonly<Record<string, unknown>>) => Object.values(key).map(String).join(' · ');

/** A row's record, as a link to it; a create's proposal names no record yet. */
function RecordLink({ table, keyJson }: { table: string | undefined; keyJson: string | null }) {
  const key = proposalKey({ target: keyJson });
  if (!table || !keyJson || !Object.keys(key).length) return <span className="review-record">{say('newRecord')}</span>;
  const noun = findTable(table)?.name ?? table;
  const label = keyText(key);
  return (
    <button type="button" className="review-record review-record-link" onClick={() => go(rowView(table, key, label), 'push')}>
      <span className="review-record-noun">{humanName(noun)}</span> {label}
    </button>
  );
}

function Age({ at }: { at: number }) {
  return (
    <time className="review-age" dateTime={new Date(at).toISOString()} title={formatDateTime(new Date(at).toISOString())}>
      {relativeTime(at)}
    </time>
  );
}

export function ReviewRoom() {
  const connection = state.activeConnection ?? null;
  const offered = Boolean(activeApp()?.review);
  const list = useReview(connection, offered);
  const client = useQueryClient();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const crumbs = useCrumbSlots();

  const hold = (ids: readonly string[], on: boolean) =>
    setBusy((now) => {
      const next = new Set(now);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  /* Every decision reads the list again; an approval also wrote a record, so what shows it is read again too. */
  const settled = (wrote: boolean) => void (wrote ? client.invalidateQueries() : client.invalidateQueries({ queryKey: [PROPOSALS_KEY] }));

  const approveOne = async (proposal: CommandProposal) => {
    const key = proposalKey(proposal);
    const expectedVersion = proposal.target ? ((await commandRevision(proposal.command, key)) ?? 0) : 0;
    await approveProposal(connection, { id: proposal.id, command: proposal.command, expectedVersion });
  };
  const decide = async (proposals: readonly CommandProposal[], how: 'approve' | 'dismiss') => {
    const ids = proposals.map((each) => each.id);
    hold(ids, true);
    let done = 0;
    try {
      for (const proposal of proposals) {
        if (how === 'approve') await approveOne(proposal);
        else await dismissProposal(connection, { id: proposal.id, command: proposal.command });
        done += 1;
      }
      toast(how === 'approve' ? say('approved') : say('dismissed'));
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      hold(ids, false);
      settled(how === 'approve' && done > 0);
    }
  };
  const change = (proposal: CommandProposal) => {
    void openProposal(proposal, connection)?.then((outcome) => {
      if (outcome.status === 'applied') settled(true);
    });
  };
  const confirm = async (mark: UnconfirmedMark) => {
    hold([mark.id], true);
    try {
      await confirmProvenance(connection, {
        command: mark.command,
        resource: mark.resource,
        key: proposalKey({ target: mark.rowKey }),
        ...(mark.field ? { field: mark.field } : {}),
      });
      toast(say('confirmed'));
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      hold([mark.id], false);
      settled(false);
    }
  };

  const proposals = (list?.proposals ?? []).filter((each) => each.state === 'proposed');
  const unconfirmed = list?.unconfirmed ?? [];
  const waiting = proposals.length + unconfirmed.length;
  const groups = new Map<string, CommandProposal[]>();
  for (const proposal of proposals) groups.set(proposal.command, [...(groups.get(proposal.command) ?? []), proposal]);

  const title = (
    <>
      <h1 className="applist-title" id="review-room-title">
        {say('title')}
      </h1>
      {waiting > 0 && <span className="applist-count">{say('count', { count: waiting })}</span>}
    </>
  );
  let body: ReactNode;
  if (!list) body = <p className="loading">{say('loading')}</p>;
  else if (!waiting) body = <Empty text={say('nothing')} detail={say('nothingDetail', { ai: aiWord() })} room />;
  else
    body = (
      <>
        {[...groups].map(([command, rows]) => {
          const action = actionOf(command);
          const label = action?.label ?? humanName(command);
          const table = commandResource(command);
          const ids = rows.map((each) => each.id);
          const anyBusy = ids.some((id) => busy.has(id));
          return (
            <section key={command} className="review-group" aria-labelledby={`review-${command}`}>
              <div className="review-group-head">
                <h2 id={`review-${command}`} className="review-group-title">
                  {label}
                </h2>
                <span className="review-group-count">{rows.length}</span>
                {action?.bulk === true && rows.length > 1 && (
                  <span className="review-group-tools">
                    <Button variant="secondary" size="sm" disabled={anyBusy} onClick={() => void decide(rows, 'approve')}>
                      {say('approveAll')}
                    </Button>
                    <Button variant="ghost" size="sm" disabled={anyBusy} onClick={() => void decide(rows, 'dismiss')}>
                      {say('dismissAll')}
                    </Button>
                  </span>
                )}
              </div>
              <ul className="review-list">
                {rows.map((proposal) => (
                  <li key={proposal.id} className="review-row" data-proposal={proposal.id}>
                    <AiBadge quiet className="review-mark" />
                    <div className="review-text">
                      <RecordLink table={table} keyJson={proposal.target} />
                      {proposal.reason ? <span className="review-reason">{proposal.reason}</span> : null}
                      <span className="review-meta">
                        {proposalStateWord(proposal.state, label)} · <Age at={proposal.createdAt} />
                      </span>
                    </div>
                    <span className="review-tools">
                      <Button
                        variant="primary"
                        size="sm"
                        loading={busy.has(proposal.id)}
                        onClick={() => void decide([proposal], 'approve')}
                      >
                        {say('approve')}
                      </Button>
                      {action && (
                        <Button variant="ghost" size="sm" disabled={busy.has(proposal.id)} onClick={() => change(proposal)}>
                          {say('change')}
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" disabled={busy.has(proposal.id)} onClick={() => void decide([proposal], 'dismiss')}>
                        {say('dismiss')}
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        {unconfirmed.length > 0 && (
          <section className="review-group" aria-labelledby="review-unconfirmed">
            <div className="review-group-head">
              <h2 id="review-unconfirmed" className="review-group-title">
                {say('unconfirmed')}
              </h2>
              <span className="review-group-count">{unconfirmed.length}</span>
            </div>
            <p className="review-group-note">{say('unconfirmedDetail')}</p>
            <ul className="review-list">
              {unconfirmed.map((mark) => {
                const column = mark.field
                  ? (findTable(mark.resource)?.columns.find((each: { name: string }) => each.name === mark.field)?.name ?? mark.field)
                  : undefined;
                return (
                  <li key={mark.id} className="review-row" data-unconfirmed={mark.id}>
                    {mark.actorKind === 'job' ? (
                      <span className="review-maker">{say('byJob', { job: mark.actor })}</span>
                    ) : (
                      <AiBadge quiet className="review-mark" />
                    )}
                    <div className="review-text">
                      <RecordLink table={mark.resource} keyJson={mark.rowKey} />
                      <span className="review-reason">{column ? humanName(column) : say('wholeRecord')}</span>
                      <span className="review-meta">
                        <Age at={mark.createdAt} />
                      </span>
                    </div>
                    <span className="review-tools">
                      <Button variant="secondary" size="sm" loading={busy.has(mark.id)} onClick={() => void confirm(mark)}>
                        {say('confirm')}
                      </Button>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </>
    );
  return (
    <section className="review-room" aria-labelledby="review-room-title">
      {crumbs.note ? createPortal(title, crumbs.note) : <div className="review-room-head">{title}</div>}
      {body}
    </section>
  );
}
