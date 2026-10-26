/**
 * A new App's first steps. A home over empty tables draws charts of nothing
 * and counts of zero, which say the App is broken when it is only new; this
 * says what to do instead — add the first record here, then there — each
 * step a link to its list with the New form open.
 *
 * A step is done when its table has a row the reader can see, read as one
 * bounded row per step. `useFirstRun` says where the dashboard stands:
 * `fresh` (no step done) draws the welcome alone, `started` draws it above
 * the dashboard, `done` (or no steps this reader can take) draws nothing.
 */
import { useQueries } from '@tanstack/react-query';
import { findTable, state } from '@mistriwork/kit/client/core.js';
import { batchedRun } from '@mistriwork/kit/client/breakdownBatch.js';
import { canInsert } from '@mistriwork/kit/client/insert.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { buttonClass } from '@mistriwork/ui/Button.js';
import { Icon } from '@mistriwork/kit/client/components/Icon.js';
import { viewLink } from '@mistriwork/kit/client/components/viewLink.js';
import type { Section } from '@mistriwork/kit/client/components/dashboardModel.js';
import './FirstRun.css';
import { say } from '../copy/shell/components/FirstRun.js';

type FirstRunStage = 'unknown' | 'fresh' | 'started' | 'done';

/** Which steps are done, and so what the dashboard draws. */
export function useFirstRun(section: Section | undefined): { stage: FirstRunStage; done: boolean[] } {
  const steps = section?.steps ?? [];
  const reads = useQueries({
    queries: steps.map((step) => ({
      queryKey: ['first-run', state.activeConnection ?? '', step.table],
      queryFn: async () => {
        // Asked with the dashboard's other reads, in one request, and not counted (breakdownBatch.ts).
        const data = await batchedRun<{ rows?: unknown[] }>({ q: step.table ?? '', limit: 1, offset: 0, count: 'none' });
        return Boolean(data.rows?.length);
      },
      // Read again whenever the home is drawn: the reader has just come back from adding the first record.
      staleTime: 0,
    })),
  });
  if (!section || !steps.length) return { stage: 'done', done: [] };
  /* A step that cannot be read is not a reason to hide the dashboard: it counts as done. */
  const done = reads.map((read) => read.isError || read.data === true);
  if (reads.some((read) => read.isPending)) return { stage: 'unknown', done };
  return { stage: done.every(Boolean) ? 'done' : done.some(Boolean) ? 'started' : 'fresh', done };
}

export function FirstRun({ section, done, fresh }: { section: Section; done: boolean[]; fresh: boolean }) {
  const steps = section.steps ?? [];
  const next = done.indexOf(false);
  return (
    <section className={`page-section width-full dash-first-run${fresh ? ' is-fresh' : ''}`} aria-labelledby="first-run-title">
      <h2 className="page-section-title" id="first-run-title">
        {section.title ?? say('getStarted')}
      </h2>
      {section.text && <p className="first-run-text">{section.text}</p>}
      <ol className="first-run-steps">
        {steps.map((step, i) => {
          const table = findTable(step.table ?? '') as TableMeta | undefined;
          /* The New form where the reader may add; the list itself where they may only read. */
          const adding = !done[i] && Boolean(table && canInsert(table, true));
          const link = viewLink(step.view, 'push', adding);
          return (
            <li key={step.view} className={`first-run-step${done[i] ? ' is-done' : ''}`}>
              <span className="first-run-mark" aria-hidden="true">
                {done[i] ? <Icon name="check-circle" size={20} weight="bold" /> : <span className="first-run-number">{i + 1}</span>}
              </span>
              <span className="first-run-words">
                <span className="first-run-label">
                  {step.label}
                  {done[i] ? <span className="visually-hidden"> {say('done')}</span> : null}
                </span>
                {step.detail && <span className="first-run-detail">{step.detail}</span>}
              </span>
              {link &&
                (done[i] ? (
                  <a className={buttonClass({ intent: 'quiet', size: 'compact' })} {...link}>
                    {say('open')}
                  </a>
                ) : (
                  <a className={buttonClass({ intent: i === next ? 'primary' : 'secondary', size: 'compact' })} {...link}>
                    {adding ? say('common.add') : say('open')}
                  </a>
                ))}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
