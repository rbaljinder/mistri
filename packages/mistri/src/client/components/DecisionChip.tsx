/**
 * A decision's suggestion at a record's field (design §7): the answer in muted ink and how sure it was in a word,
 * Accept (quiet) and ⋯ — Change…, Dismiss, Why this?. In the empty mark's place on an empty field, trailing the value
 * on a filled one; the same height either way, so nothing moves when it arrives or goes.
 *
 * Accept and Change… run the answer command as the person, through the one command pipeline (sdk/commands.tsx):
 * their grants, their click. What landed is then told to the server, which reads the record to see whether it was
 * the suggestion or something else. A reader not granted the command sees the suggestion and why, and nothing to press.
 */
import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@mistriwork/ui/Button.js';
import { DropItem, DropMenu } from '@mistriwork/ui/DropMenu.js';
import { Modal } from '@mistriwork/ui/Modal.js';
import { api, findTable, toast } from '@mistriwork/kit/client/core.js';
import { formatDateTime } from '@mistriwork/kit/client/locale.js';
import { Value } from '@mistriwork/kit/client/components/Value.js';
import type { ColumnMeta, TableMeta } from '@mistriwork/engine/shared/schema.js';
import { confidenceOf, type DecisionWhy, type FieldSuggestion } from '../../shared/decisionSuggestions.js';
import { commandHandle } from './sdk/commands.js';
import { say } from '../copy/record/components/DecisionChip.js';
import './DecisionChip.css';

/* The confidence in words (design: a percent only in "Why this?"), each said by its key so the catalog knows it is. */
const sayConfidence = (probability: number): string =>
  ({ almostCertain: say('almostCertain'), veryLikely: say('veryLikely'), likely: say('likely'), possible: say('possible') })[
    confidenceOf(probability)
  ];

export default function DecisionChip({
  suggestion,
  table,
  recordKey,
  onSettled,
}: {
  suggestion: FieldSuggestion;
  table: string;
  recordKey: Readonly<Record<string, unknown>>;
  /** The suggestion moved on (accepted, corrected, dismissed): the record and its suggestions are asked again. */
  onSettled: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const handle = commandHandle(suggestion.command);
  const confidence = sayConfidence(suggestion.probability);
  const settle = async (action: 'done' | 'dismiss') => {
    try {
      await api('/api/record-decisions/settle', { id: suggestion.id, action });
    } catch {
      toast(say('couldNotSettle'), 'error');
    }
    onSettled();
  };
  const run = async (how: 'run' | 'open') => {
    setBusy(true);
    try {
      const outcome = await handle[how](recordKey, { [suggestion.field]: suggestion.answer });
      if (outcome.status === 'applied') await settle('done');
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className={`decision-chip${suggestion.filled ? ' decision-chip-trailing' : ''}`}>
      <span className="decision-chip-value" aria-label={say('suggestion', { value: suggestion.label, confidence })}>
        <span aria-hidden="true">{suggestion.label}</span>
        <span className="decision-chip-word" aria-hidden="true">
          {confidence}
        </span>
      </span>
      {handle.granted && (
        <Button intent="quiet" size="compact" className="decision-chip-accept" busy={busy} onClick={() => void run('run')}>
          {say('accept')}
        </Button>
      )}
      <DropMenu
        className="decision-chip-menu"
        triggerClassName="decision-chip-more"
        triggerLabel={say('more', { value: suggestion.label })}
        triggerTitle={say('more', { value: suggestion.label })}
        label="⋯"
        popupClassName="page-actions-popup"
        align="start"
        finalFocus={more}
      >
        {handle.granted && (
          <DropItem className="page-actions-item" disabled={busy} onClick={() => void run('open')}>
            {say('change')}
          </DropItem>
        )}
        {handle.granted && (
          <DropItem className="page-actions-item" disabled={busy} onClick={() => void settle('dismiss')}>
            {say('dismiss')}
          </DropItem>
        )}
        <DropItem className="page-actions-item" onClick={() => setWhy(true)}>
          {say('whyThis')}
        </DropItem>
      </DropMenu>
      {why && <WhyThis suggestion={suggestion} table={table} onClose={() => setWhy(false)} />}
    </span>
  );
}

/** What was asked, of whom, how surely and when: the inputs by name with what this reader may read of them now. No reasoning. */
function WhyThis({ suggestion, table, onClose }: { suggestion: FieldSuggestion; table: string; onClose: () => void }) {
  const asked = useQuery({
    queryKey: ['record-decision-why', suggestion.id],
    queryFn: async () => (await api('/api/record-decisions/why', { id: suggestion.id })) as DecisionWhy,
    staleTime: 60_000,
  });
  const meta = findTable(table) as TableMeta | undefined;
  const column = (name: string): ColumnMeta =>
    meta?.columns.find((each) => each.name === name) ?? ({ name, type: 'TEXT', nullable: true, primaryKey: false } as ColumnMeta);
  const reason = asked.data;
  return (
    <Modal className="decision-why" ariaLabel={say('whyTitle', { value: suggestion.label })} onClose={onClose} fullscreen={false}>
      <h2>{say('whyTitle', { value: suggestion.label })}</h2>
      {!reason ? (
        <p className="note">{say('reading')}</p>
      ) : (
        <dl className="decision-why-facts">
          <div>
            <dt>{say('asked')}</dt>
            <dd>{reason.question}</dd>
          </div>
          <div>
            <dt>{say('inputs')}</dt>
            <dd>
              <dl className="decision-why-inputs">
                {reason.inputs.map((input) => (
                  <div key={input.name}>
                    <dt>{input.label}</dt>
                    <dd>
                      {input.readable ? (
                        <Value col={column(input.name)} value={input.value} tableId={table} compact links={false} />
                      ) : (
                        <span className="decision-why-hidden">{say('notYours')}</span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </dd>
          </div>
          <div>
            <dt>{say('answeredBy')}</dt>
            <dd>{[reason.provider, reason.model, reason.modelVersion].filter(Boolean).join(' · ')}</dd>
          </div>
          {reason.probability !== null && (
            <div>
              <dt>{say('sure')}</dt>
              <dd>{`${Math.round(reason.probability * 100)}% · ${sayConfidence(reason.probability)}`}</dd>
            </div>
          )}
          <div>
            <dt>{say('when')}</dt>
            <dd>{formatDateTime(reason.at)}</dd>
          </div>
        </dl>
      )}
      <div className="decision-why-actions">
        <Button onClick={onClose}>{say('close')}</Button>
      </div>
    </Modal>
  );
}
