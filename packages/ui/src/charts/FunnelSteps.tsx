/**
 * Presentational stage-conversion funnel (`FunnelSteps`): renders ordered stages against the first
 * stage's length, optional side-road stages (`optional`), basis share readouts, and interactive
 * drill-through doors (`reached` / `dropped`) while holding layout height steady while counts load.
 */
import type { MouseEvent, ReactNode, Ref } from 'react';
import { cx } from '../internal/cx.js';
import { resolveLocale } from '../internal/locale.js';
import { useSurfaceSeam } from '../internal/surfaceSeam.js';

interface FunnelDoorLink {
  href: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}

/** Interactive stage drill-through action or link on a `FunnelSteps` row. */
export interface FunnelDoor {
  link?: FunnelDoorLink;
  open?: () => void;
}

/** Single ordered stage in a `FunnelSteps` conversion funnel. */
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

interface FunnelWords {
  summary?: (args: { count: number; first: string; last: string }) => string;
  openReached?: (args: { table: string; stage: string }) => string;
  openDropped?: (args: { table: string; stage: string }) => string;
  optional?: string;
  ofBasis?: (args: { share: string; basis: string }) => string;
  dropped?: (args: { figure: string }) => string;
  droppedTitle?: (args: { figure: string; basis: string; stage: string }) => string;
}

const defaultPercent = (pctValue: number, locale?: string) =>
  new Intl.NumberFormat(resolveLocale(locale), { maximumFractionDigits: 0 }).format(pctValue) + '%';

function Door({ door, className, title, children }: { door?: FunnelDoor; className: string; title: string; children: ReactNode }) {
  const seam = useSurfaceSeam();
  const linkProps = seam?.useLinkProps
    ? seam.useLinkProps(door?.link?.href, door?.link?.onClick as ((event: MouseEvent<HTMLElement>) => void) | undefined)
    : { href: door?.link?.href, onClick: door?.link?.onClick };
  if (door?.link) {
    return (
      <a
        className={`${className} dash-funnel-door`}
        href={linkProps.href ?? door.link.href}
        title={title}
        onClick={linkProps.onClick as ((event: MouseEvent<HTMLAnchorElement>) => void) | undefined}
      >
        {children}
      </a>
    );
  }
  if (door?.open) {
    return (
      <button type="button" className={`${className} dash-funnel-door nx-funnel-door`} title={title} onClick={door.open}>
        {children}
      </button>
    );
  }
  return <div className={className}>{children}</div>;
}

/** Props for the `FunnelSteps` component. */
export interface FunnelStepsProps {
  steps: ReadonlyArray<FunnelStep>;
  /** Formatter for stage and drop counts. */
  formatValue?: (value: number) => string;
  locale?: string;
  formatShare?: (percentValue: number) => string;
  table?: string;
  label?: string;
  ariaLabel?: string;
  words?: FunnelWords;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

/** Stage-conversion funnel with basis share readouts, optional stages, and drill-through doors. */
export function FunnelSteps(props: FunnelStepsProps) {
  const {
    steps,
    formatValue: explicitFormatValue,
    locale,
    formatShare: explicitFormatShare,
    table = 'records',
    label,
    ariaLabel,
    words,
    className,
    ref,
  } = props;
  const legacySay = (props as unknown as { say?: (value: unknown) => string }).say;
  const sayCount = explicitFormatValue ?? (legacySay ? (v: number) => legacySay(v) : String);
  const formatShare = explicitFormatShare ?? ((pctValue: number) => defaultPercent(pctValue, locale));
  const ready = steps.every((step) => step.count !== undefined);
  const rawFirst = steps[0]?.count ?? Math.max(0, ...steps.map((step) => step.count ?? 0));
  const first = Number.isFinite(rawFirst) && rawFirst > 0 ? rawFirst : 0;
  const summaryLabel =
    ariaLabel ??
    label ??
    (words?.summary
      ? words.summary({ count: steps.length, first: steps[0]?.title ?? '', last: steps[steps.length - 1]?.title ?? '' })
      : `Funnel, ${steps.length} stages from ${steps[0]?.title ?? ''} to ${steps[steps.length - 1]?.title ?? ''}`);

  return (
    <div ref={ref} className={cx('dash-funnel-host', className)}>
      <ol className="dash-funnel" aria-busy={!ready || undefined} aria-label={summaryLabel}>
        {steps.map((step, i) => {
          const basis = step.basis === null ? undefined : steps[step.basis];
          const share = basis?.count && basis.count > 0 ? Math.max(0, step.count ?? 0) / basis.count : undefined;
          const lost =
            basis && step.count !== undefined && basis.count !== undefined && !step.optional
              ? Math.max(0, basis.count - step.count)
              : undefined;
          const width =
            step.count === undefined || !Number.isFinite(step.count) || step.count <= 0 || first <= 0
              ? 0
              : Math.max(2, Math.min(100, (step.count / first) * 100));
          const reachedTitle = words?.openReached
            ? words.openReached({ table, stage: step.title })
            : `Open ${table} that reached ${step.title}`;
          const droppedDoorTitle = words?.openDropped
            ? words.openDropped({ table, stage: step.title })
            : `Open ${table} dropped before ${step.title}`;
          return (
            <li key={i} className={`dash-funnel-step${step.optional ? ' is-optional' : ''}`}>
              <Door door={step.reached} className="dash-funnel-main" title={reachedTitle}>
                <span className="dash-funnel-name">
                  {step.title}
                  {step.optional && <span className="dash-funnel-tag">{words?.optional ?? 'optional'}</span>}
                </span>
                <span className="pct-bar dash-funnel-track" aria-hidden="true">
                  <span data-slot="funnel-fill" className="pct-fill dash-funnel-fill" style={{ width: `${width}%` }} />
                </span>
                <span className="dash-funnel-value">{step.count === undefined ? '\u00a0' : sayCount(step.count)}</span>
                <span className="dash-funnel-share">
                  {basis && share !== undefined && step.count !== undefined
                    ? words?.ofBasis
                      ? words.ofBasis({ share: formatShare(share * 100), basis: basis.title })
                      : `${formatShare(share * 100)} of ${basis.title}`
                    : '\u00a0'}
                </span>
              </Door>
              <Door door={lost ? step.dropped : undefined} className="dash-funnel-drop" title={droppedDoorTitle}>
                {lost ? (
                  <span
                    title={
                      basis
                        ? words?.droppedTitle
                          ? words.droppedTitle({ figure: sayCount(lost), basis: basis.title, stage: step.title })
                          : `${sayCount(lost)} from ${basis.title} did not reach ${step.title}`
                        : undefined
                    }
                  >
                    {words?.dropped ? words.dropped({ figure: sayCount(lost) }) : `\u2212${sayCount(lost)}`}
                  </span>
                ) : (
                  '\u00a0'
                )}
              </Door>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
