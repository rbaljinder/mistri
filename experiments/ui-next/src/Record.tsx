import { breakable } from './breaks';
import { EditableText, type EditableTextProps } from './EditableText';
import { CaretRight, Check } from '@phosphor-icons/react';
import { Skeleton } from './Skeleton';
import { Meter, MeterIndicator, MeterTrack } from '@ui-sdk/react/meter';
import { Timeline, TimelineConnector, TimelineItem, TimelineMarker, TimelineTitle } from '@ui-sdk/react/timeline';
import type { ReactNode } from 'react';
import type { Tone } from './Status';
import { words } from './words';

/* A record page's parts. Each is layout and type over a slot name; what goes in them is the caller's. */

export type Crumb = { label: string; href?: string };

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav data-slot="breadcrumbs" aria-label={words.breadcrumb}>
      <ol>
        {items.map((item, index) => (
          <li key={item.label}>
            {index > 0 && <CaretRight aria-hidden="true" />}
            {item.href ? <a href={item.href}>{item.label}</a> : <span aria-current="page">{item.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function RecordHeader({
  kind,
  title,
  status,
  actions,
  heading: Heading = 'h1',
  children,
}: {
  kind: string;
  title: string;
  status?: ReactNode;
  actions?: ReactNode;
  /* The record's name is the page's heading unless the page it stands on already has one. */
  heading?: 'h1' | 'h2';
  children?: ReactNode;
}) {
  return (
    <header data-slot="record-head">
      <div data-slot="record-title-row">
        <div data-slot="record-title">
          <p data-slot="record-kind">{kind}</p>
          <Heading>
            {title}
            {status}
          </Heading>
        </div>
        {actions && <div data-slot="record-actions">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

export type Fact = { label: string; value: ReactNode };

/* The few values a reader checks before anything else: label over value, in a row. */
export function Facts({ items }: { items: Fact[] }) {
  return (
    <dl data-slot="facts">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* A workflow's stages, as a horizontal timeline: done, current, still to come. */
export function Stages({ label, stages, current }: { label: string; stages: string[]; current: string }) {
  const at = stages.indexOf(current);
  return (
    <Timeline aria-label={label} orientation="horizontal" data-kind="stages">
      {stages.map((stage, index) => (
        <TimelineItem key={stage} status={index < at ? 'complete' : index === at ? 'current' : 'upcoming'}>
          <TimelineMarker>{index < at ? <Check aria-hidden="true" weight="bold" /> : index + 1}</TimelineMarker>
          <TimelineConnector />
          <TimelineTitle>{stage}</TimelineTitle>
        </TimelineItem>
      ))}
    </Timeline>
  );
}

export type StatItem = {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: Tone;
  /* A share of a whole, from 0 to 1, drawn as a bar under the figure: how full, how far, how much collected. */
  share?: number;
};

/* Figures side by side in one ruled strip, so three numbers read as one statement and not as three cards. */
export function Stats({ items, loading }: { items: StatItem[]; /* The figures are still being read. */ loading?: boolean }) {
  return (
    <dl data-slot="stats" aria-busy={loading || undefined}>
      {items.map((item) => (
        <div key={item.label} data-tone={loading ? undefined : item.tone}>
          <dt>{item.label}</dt>
          <dd>{loading ? <Skeleton width="4.5rem" height="1.5rem" /> : item.value}</dd>
          {loading && (
            <dd data-slot="stat-note">
              <Skeleton width="8rem" />
            </dd>
          )}
          {!loading && item.share !== undefined && (
            <dd data-slot="stat-share">
              <Meter value={Math.round(Math.min(Math.max(item.share, 0), 1) * 100)} aria-label={item.label}>
                <MeterTrack>
                  <MeterIndicator />
                </MeterTrack>
              </Meter>
            </dd>
          )}
          {!loading && item.note && <dd data-slot="stat-note">{item.note}</dd>}
        </div>
      ))}
    </dl>
  );
}

export function RecordSection({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section data-slot="record-section" aria-label={title}>
      <header>
        <h2>
          {title}
          {count !== undefined && <span data-slot="list-count">{count}</span>}
        </h2>
        {action}
      </header>
      {children}
    </section>
  );
}

export type Property = {
  label: string;
  value: ReactNode;
  /* The value can be changed where it stands: its text, and what keeps it. `value` is then not drawn. */
  edit?: Pick<EditableTextProps, 'value' | 'onSave' | 'check' | 'inputMode' | 'placeholder' | 'display'>;
};

/* A related thing, beside the record: its name, then label and value on one line each. */
export function Properties({
  title,
  name,
  avatar,
  items,
  link,
}: {
  title: string;
  name?: string;
  avatar?: ReactNode;
  items: Property[];
  link?: ReactNode;
}) {
  return (
    <section data-slot="properties" aria-label={title}>
      <h2>{title}</h2>
      {name && (
        <p data-slot="properties-name">
          {avatar}
          {name}
        </p>
      )}
      <dl>
        {items.map((item) => (
          <div key={item.label}>
            <dt>{item.label}</dt>
            <dd>
              {item.edit ? (
                <EditableText label={item.label} {...item.edit} />
              ) : typeof item.value === 'string' ? (
                breakable(item.value)
              ) : (
                item.value
              )}
            </dd>
          </div>
        ))}
      </dl>
      {link}
    </section>
  );
}

export function RecordLayout({ children, aside }: { children: ReactNode; aside: ReactNode }) {
  return (
    <div data-slot="record-layout">
      <div data-slot="record-main">{children}</div>
      <aside data-slot="record-aside">{aside}</aside>
    </div>
  );
}
