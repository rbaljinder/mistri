/**
 * The one view of how a command ended (outcomeModel.ts): a title in the
 * state's status colour, the App's words, and the way on — the record it
 * changed, the next step after a refusal, a check that reads the receipt of a
 * lost answer. A command's form and a public form draw it in their status
 * line; the host says how loudly (a polite status, an alert) through the
 * element's own attributes.
 */
import { useState, type HTMLAttributes } from 'react';
import { Button } from '@mistriwork/ui/Button.js';
import { outcomeTitle, type Outcome } from './outcomeModel.js';
import { say } from '../copy/forms/components/CommandOutcome.js';
import { copyLink } from './commandResult.js';
import './CommandOutcome.css';

/** An address the command handed back, drawn to be read and copied: selectable text beside a Copy that says it worked. */
function ResultLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <p className="command-outcome-link">
      <input data-slot="input" readOnly value={url} aria-label={say('copyLink')} onFocus={(event) => event.target.select()} />
      <Button
        intent="secondary"
        size="compact"
        onClick={() => {
          void copyLink(url).then(setCopied);
        }}
      >
        {copied ? say('copied') : say('copy')}
      </Button>
    </p>
  );
}

export function CommandOutcome({
  outcome,
  onOpen,
  onCheck,
  className,
  ...rest
}: {
  outcome: Outcome;
  /** Open the record a done command changed. Without it the record is named, not linked. */
  onOpen?: () => void;
  /** Read the receipt again, for an unknown outcome. Without it the host draws its own check. */
  onCheck?: () => void;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={`command-outcome${className ? ` ${className}` : ''}`}
      data-state={outcome.state}
      {...(outcome.state === 'pending' ? { 'data-waiting': outcome.waiting } : {})}
    >
      <p className="command-outcome-title">{outcomeTitle(outcome)}</p>
      {outcome.said && <p className="command-outcome-body">{outcome.said}</p>}
      {outcome.state === 'done' && outcome.links?.map((url) => <ResultLink key={url} url={url} />)}
      {outcome.state === 'done' && outcome.changed && onOpen && (
        <p className="command-outcome-next">
          <Button intent="quiet" size="compact" onClick={onOpen}>
            {say('openRecord', { label: outcome.changed.label })}
          </Button>
        </p>
      )}
      {(outcome.state === 'refused' || outcome.state === 'unknown') && <p className="command-outcome-next">{outcome.next}</p>}
      {outcome.state === 'unknown' && onCheck && (
        <p className="command-outcome-check">
          <Button intent="secondary" onClick={onCheck}>
            {say('checkAgain')}
          </Button>
        </p>
      )}
    </div>
  );
}
