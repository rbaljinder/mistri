/**
 * One piece of evidence, as the review queue and Ask show it: a record read opens as the record, a web reference
 * opens in a new tab, anything else is its label. Shared so the reader of an Ask and the reviewer of a proposal see
 * the same thing for the same read.
 */
import { go, rowView } from '@mistriwork/kit/client/core.js';
import type { ProposalEvidence } from '../commandProposals.js';
import './EvidenceList.css';

/** A reference a proposal carries as a link only where it is the web's: a `javascript:` ref is text. */
const WEB = /^(https?:\/\/|\/(?!\/))/i;

/** A record's evidence, `<table>/<key as JSON>`, opened as the record. */
function recordOf(ref: string): { table: string; key: Record<string, unknown> } | undefined {
  const cut = ref.indexOf('/');
  if (cut <= 0) return undefined;
  try {
    const key = JSON.parse(ref.slice(cut + 1)) as unknown;
    return key && typeof key === 'object' && !Array.isArray(key)
      ? { table: ref.slice(0, cut), key: key as Record<string, unknown> }
      : undefined;
  } catch {
    return undefined;
  }
}

export function EvidenceItem({ evidence, onNavigate }: { evidence: ProposalEvidence; onNavigate?: () => void }) {
  if (evidence.kind === 'text')
    return (
      <li className="proposal-evidence-item">
        <span className="proposal-evidence-label">{evidence.label}</span>
        {evidence.quote ? <blockquote className="proposal-evidence-quote">{evidence.quote}</blockquote> : null}
      </li>
    );
  if (evidence.kind === 'record') {
    const record = recordOf(evidence.ref);
    return (
      <li className="proposal-evidence-item">
        {record ? (
          <button
            type="button"
            className="proposal-evidence-link"
            onClick={() => {
              onNavigate?.();
              go(rowView(record.table, record.key, evidence.label), 'push');
            }}
          >
            {evidence.label}
          </button>
        ) : (
          <span className="proposal-evidence-label">{evidence.label}</span>
        )}
        {evidence.quote ? <blockquote className="proposal-evidence-quote">{evidence.quote}</blockquote> : null}
      </li>
    );
  }
  return (
    <li className="proposal-evidence-item">
      {WEB.test(evidence.ref) ? (
        <a className="proposal-evidence-link" href={evidence.ref} target="_blank" rel="noreferrer noopener">
          {evidence.label}
        </a>
      ) : (
        <span className="proposal-evidence-label">{evidence.label}</span>
      )}
      {evidence.quote ? <blockquote className="proposal-evidence-quote">{evidence.quote}</blockquote> : null}
    </li>
  );
}
