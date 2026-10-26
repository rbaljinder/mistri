/**
 * The workflow strip: where a record stands in its status vocabulary. Only
 * the current state is known. Where the author says the steps are an order
 * (`ordered`), the steps before it are drawn as passed — the order written
 * down, not a history of the record — and a state outside the steps passes
 * none. A step one of the record's own edits can move it to now is marked
 * as reachable; the strip still moves nothing, the record's actions do.
 *
 * An ordered strip reads as a way travelled: a passed step's mark is filled
 * in the ink, the current one in the accent, the steps ahead hollow, and a
 * hairline joins each step to the next — in the ink where it has been walked.
 */
import { useLayoutEffect, useRef } from 'react';
import { workflowLabel, type ResolvedWorkflowStatus as WorkflowDefinition } from '@mistriwork/engine/shared/pageModel.js';
import { say } from '../copy/record/components/WorkflowStatus.js';

export function WorkflowStatus({
  definition,
  value,
  reachable,
}: {
  definition: WorkflowDefinition;
  value: unknown;
  reachable?: ReadonlySet<string>;
}) {
  const current = definition.steps.findIndex((step) => step.value === value);
  const known = current !== -1;
  /* On a narrow screen the strip is one line that scrolls sideways (page.css); the current step is brought into
     view by moving the strip alone, never the page, so a record opened at "Negotiation" shows Negotiation. */
  const strip = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    const ol = strip.current;
    const step = ol?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!ol || !step || ol.scrollWidth <= ol.clientWidth) return;
    /* The strip starts at the step before the current one, whole, so the way in reads "Proposal — Negotiation"
       rather than from the middle of a word. */
    const from = (step.previousElementSibling as HTMLElement | null) ?? step;
    ol.scrollLeft = Math.max(0, from.offsetLeft - ol.offsetLeft);
    edges(ol);
  }, [current]);
  return (
    <div className="workflow-status">
      <ol
        ref={strip}
        onScroll={(event) => edges(event.currentTarget)}
        aria-label={say('workflowStatus')}
        className="workflow-steps"
        data-scrolls=""
        data-ordered={definition.ordered === true || undefined}
      >
        {definition.steps.map((step, index) => {
          const passed = definition.ordered === true && known && index < current;
          const next = index !== current && reachable?.has(String(step.value)) === true;
          return (
            <li
              key={step.value}
              aria-current={index === current ? 'step' : undefined}
              data-passed={passed || undefined}
              data-reachable={next || undefined}
            >
              <span className="workflow-marker" aria-hidden="true" />
              {step.label}
              {passed && <span className="visually-hidden"> {say('passed')}</span>}
              {next && <span className="visually-hidden"> {say('availableFromHere')}</span>}
            </li>
          );
        })}
      </ol>
      {!known && (
        <p className="workflow-unmapped" role="status">
          {say('currentState')} {value === null || value === undefined || value === '' ? say('notSet') : workflowLabel(String(value))}
        </p>
      )}
    </div>
  );
}

/* Which ends of a scrolling strip have more beyond them, for its fade (page.css). */
function edges(ol: HTMLOListElement) {
  ol.toggleAttribute('data-more-before', ol.scrollLeft > 1);
  ol.toggleAttribute('data-more-after', ol.scrollLeft + ol.clientWidth < ol.scrollWidth - 1);
}
