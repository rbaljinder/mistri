/**
 * A funnel section (`funnel()`): the rows of one table that reach each of its stages, in order. Every stage is a bar
 * against the first stage's length, its count, and its share of the stage it follows ("62% of Qualified") with the rows
 * it lost beside it ("−12"). An optional stage is a side road: marked, and a share of the last stage that is required.
 *
 * Presentational: the counts come from one statement (shared/funnel.ts, funnelText), so a later stage can never be
 * longer than the one before it. The stages' names are known before the counts arrive, so the list holds its height
 * while it loads and nothing moves when the figures land (docs/design.md, layout shift).
 */
import type { ReactNode } from 'react';
import { say as sayCopy } from '../copy/dashboards/components/Funnel.js';
import { formatPercent } from '@mistriwork/kit/client/locale.js';
import type { ViewLink } from '@mistriwork/kit/client/components/viewLink.js';
import './Funnel.css';

/** Where a figure goes: a link where the address is a list's, else a button that walks there. */
export interface FunnelDoor {
  link?: ViewLink;
  open?: () => void;
}

export interface FunnelStep {
  title: string;
  optional?: boolean;
  /** Absent while the answer is on its way. */
  count?: number;
  /** The stage this one is a share of (the last required stage before it), absent on the first. */
  basis: number | null;
  reached?: FunnelDoor;
  dropped?: FunnelDoor;
}

function Door({ door, className, title, children }: { door?: FunnelDoor; className: string; title: string; children: ReactNode }) {
  if (door?.link)
    return (
      <a className={`${className} dash-funnel-door`} href={door.link.href} title={title} onClick={door.link.onClick}>
        {children}
      </a>
    );
  if (door?.open)
    return (
      <button type="button" className={`${className} dash-funnel-door`} title={title} onClick={door.open}>
        {children}
      </button>
    );
  return <div className={className}>{children}</div>;
}

export function Funnel({
  steps,
  say,
  table,
  label,
}: {
  steps: FunnelStep[];
  /** How a count is said (the section's figure rule). */
  say: (value: unknown) => string;
  table: string;
  label?: string;
}) {
  const ready = steps.every((step) => step.count !== undefined);
  const first = steps[0]?.count || Math.max(0, ...steps.map((step) => step.count ?? 0)) || 1;
  return (
    <div className="dash-funnel-host">
      <ol
        className="dash-funnel"
        aria-busy={!ready || undefined}
        aria-label={
          label ?? sayCopy('summary', { count: steps.length, first: steps[0]?.title ?? '', last: steps[steps.length - 1]?.title ?? '' })
        }
      >
        {steps.map((step, i) => {
          const basis = step.basis === null ? undefined : steps[step.basis];
          const share = basis?.count ? (step.count ?? 0) / basis.count : undefined;
          const lost =
            basis && step.count !== undefined && basis.count !== undefined && !step.optional ? basis.count - step.count : undefined;
          const width = step.count === undefined ? 0 : Math.max(2, Math.min(100, (step.count / first) * 100));
          return (
            <li key={i} className={`dash-funnel-step${step.optional ? ' is-optional' : ''}`}>
              <Door door={step.reached} className="dash-funnel-main" title={sayCopy('openReached', { table, stage: step.title })}>
                <span className="dash-funnel-name">
                  {step.title}
                  {step.optional && <span className="dash-funnel-tag">{sayCopy('optional')}</span>}
                </span>
                <span className="dash-funnel-track" aria-hidden="true">
                  <span className="dash-funnel-fill" style={{ width: `${width}%` }} />
                </span>
                <span className="dash-funnel-value">{step.count === undefined ? ' ' : say(step.count)}</span>
                <span className="dash-funnel-share">
                  {basis && share !== undefined && step.count !== undefined
                    ? sayCopy('ofBasis', { share: formatPercent(share * 100, { maximumFractionDigits: 0 }), basis: basis.title })
                    : ' '}
                </span>
              </Door>
              <Door
                door={lost ? step.dropped : undefined}
                className="dash-funnel-drop"
                title={sayCopy('openDropped', { table, stage: step.title })}
              >
                {lost ? (
                  <span title={basis ? sayCopy('droppedTitle', { figure: say(lost), basis: basis.title, stage: step.title }) : undefined}>
                    {sayCopy('dropped', { figure: say(lost) })}
                  </span>
                ) : (
                  ' '
                )}
              </Door>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
