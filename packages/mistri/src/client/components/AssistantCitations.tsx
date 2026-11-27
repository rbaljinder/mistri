/**
 * Grounded knowledge citations and quiet memory trace chips for the assistant
 * thread (AssistantPanel.tsx):
 *
 * - `CitationPill`: borderless inline `[1]` superscript pill rendered inside
 *   prose when a turn retrieved matching citations.
 * - `CitationsCard`: airy hairline Sources shelf showing numbered record items
 *   with metadata/excerpts and one-click navigation to verifiable Mistri addresses.
 * - `MemoryEventChip`: quiet inline whisper whenever the assistant remembers,
 *   updates, or forgets a durable memory, with a direct shortcut to Manage.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@mistriwork/ui/Button.js';
import type { Citation, CitationsItem, MemoryEventItem } from './assistantStream.js';
import { say } from '../copy/shell/components/AssistantCitations.js';
import './AssistantCitations.css';

/** Inline clickable `[1]` citation pill embedded directly inside assistant prose. */
export function CitationPill({
  citation,
  onFollow,
  onFocusSource,
}: {
  citation: Citation;
  onFollow: (address: string) => void;
  onFocusSource?: (ref: number) => void;
}) {
  const label = citation.address ? say('openSource', { title: citation.title }) : `${citation.title} — ${citation.sourceLabel}`;
  return (
    <button
      type="button"
      className="assistant-cite-pill"
      title={`${citation.title} (${citation.sourceLabel})`}
      aria-label={label}
      onClick={() => {
        if (citation.address) onFollow(citation.address);
        else onFocusSource?.(citation.ref);
      }}
    >
      {citation.ref}
    </button>
  );
}

/** Airy hairline Sources shelf displaying verifiable knowledge citations retrieved during the turn. */
export function CitationsCard({
  item,
  highlightedRef,
  onFollow,
}: {
  item: CitationsItem;
  highlightedRef?: number | null;
  onFollow: (address: string) => void;
}) {
  const [expanded, setExpanded] = useState(item.items.length <= 4);
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (highlightedRef == null) return;
    if (!item.items.some((c) => c.ref === highlightedRef)) return;
    if (!expanded) setExpanded(true);
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-cite-ref="${highlightedRef}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [highlightedRef, expanded, item.items]);
  const shown = expanded ? item.items : item.items.slice(0, 3);
  return (
    <section ref={rootRef} className="assistant-citations" aria-label={say('sourcesRegion')}>
      <div className="assistant-citations-head">
        <span className="assistant-citations-title">{say('sources', { count: item.items.length })}</span>
        {item.items.length > 3 && (
          <Button size="xs" variant="ghost" onClick={() => setExpanded((was) => !was)}>
            {expanded ? '−' : `+${item.items.length - 3}`}
          </Button>
        )}
      </div>
      <div className="assistant-citations-list">
        {shown.map((citation) => {
          const highlighted = highlightedRef === citation.ref;
          const distinctSnippet =
            citation.snippet && citation.snippet.trim().toLowerCase() !== citation.title.trim().toLowerCase()
              ? citation.snippet.trim()
              : undefined;
          const body = (
            <>
              <span className="assistant-citation-ref" aria-hidden="true">
                {citation.ref}
              </span>
              <span className="assistant-citation-copy">
                <span className="assistant-citation-top">
                  <span className="assistant-citation-title">{citation.title}</span>
                  {citation.address && (
                    <span className="assistant-citation-arrow" aria-hidden="true">
                      ↗
                    </span>
                  )}
                </span>
                <span className="assistant-citation-meta">
                  {citation.sourceLabel}
                  {distinctSnippet ? ` · ${distinctSnippet}` : ''}
                </span>
              </span>
            </>
          );
          if (citation.address) {
            return (
              <button
                key={`${citation.ref}-${citation.source}`}
                type="button"
                data-cite-ref={citation.ref}
                className={`assistant-citation-item assistant-citation-clickable${highlighted ? ' assistant-citation-highlighted' : ''}`}
                onClick={() => onFollow(citation.address!)}
              >
                {body}
              </button>
            );
          }
          return (
            <div
              key={`${citation.ref}-${citation.source}`}
              data-cite-ref={citation.ref}
              className={`assistant-citation-item${highlighted ? ' assistant-citation-highlighted' : ''}`}
            >
              {body}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Quiet inline whisper emitted when the assistant saves, updates, or forgets a durable memory. */
export function MemoryEventChip({ item, onManage }: { item: MemoryEventItem; onManage?: () => void }) {
  const verb = item.action === 'updated' ? say('memoryUpdated') : item.action === 'forgot' ? say('memoryForgot') : say('memoryRemembered');
  const scopeLabel = item.scope === 'app' ? say('memoryScopeApp') : say('memoryScopePerson');
  return (
    <div className="assistant-memory-chip" role="status">
      <span className="assistant-memory-chip-dot" aria-hidden="true" />
      <span className="assistant-memory-chip-verb">{verb}</span>
      <span className="assistant-memory-chip-sep" aria-hidden="true">
        ·
      </span>
      <span className="assistant-memory-chip-scope">{scopeLabel}</span>
      {item.content && <span className="assistant-memory-chip-text">“{item.content}”</span>}
      {onManage && (
        <Button size="xs" variant="ghost" className="assistant-memory-chip-manage" onClick={onManage}>
          {say('memoryManage')}
        </Button>
      )}
    </div>
  );
}
