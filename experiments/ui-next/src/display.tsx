import { Check, Question } from '@phosphor-icons/react';
import { Avatar as Disc, AvatarFallback, AvatarImage } from '@ui-sdk/react/avatar';
import { Popover as Pop, PopoverContent, PopoverTrigger } from '@ui-sdk/react/popover';
import { Progress, ProgressIndicator, ProgressLabel, ProgressTrack, ProgressValue } from '@ui-sdk/react/progress';
import { Tabs as TabsRoot, TabsIndicator, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs';
import { type CSSProperties, type ReactNode, useEffect, useRef } from 'react';
import type { Tone } from './Status';
import { words } from './words';

/* The small things a page is furnished with: a person's disc, tabs, a badge, the marks and bars a form says its
   progress with, and the blocks a landing page is laid out in. Each is layout and words over UI SDK's part where
   there is one, and plain markup where there is not. */

export const initialsOf = (name: string): string =>
  name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');

/* A person or a thing as a disc: its picture where there is one, else its initials. Beside the name it is
   decoration and says nothing; on its own (`alone`) it is the name, for a screen reader too. */
export function Avatar({ name, src, size = 'md', alone }: { name: string; src?: string; size?: 'sm' | 'md' | 'lg'; alone?: boolean }) {
  return (
    <Disc
      data-size={size === 'md' ? undefined : size}
      role={alone ? 'img' : undefined}
      aria-label={alone ? name : undefined}
      title={alone ? name : undefined}
    >
      {src && <AvatarImage src={src} alt="" />}
      <AvatarFallback aria-hidden="true">{initialsOf(name)}</AvatarFallback>
    </Disc>
  );
}

export type TabItem = { value: string; label: ReactNode; count?: number; content: ReactNode; disabled?: boolean };

/* Tabs as data: what each is called, how many it holds, and what it shows. The panel of a tab is drawn when the
   tab is first opened and kept, so going back to one finds it as it was left. */
export function Tabs({
  label,
  items,
  value,
  defaultValue,
  onValueChange,
}: {
  label: string;
  items: TabItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}) {
  return (
    <TabsRoot
      value={value}
      defaultValue={value === undefined ? (defaultValue ?? items[0]?.value) : undefined}
      onValueChange={(next) => next !== null && onValueChange?.(String(next))}
    >
      <TabsList aria-label={label}>
        {items.map((item) => (
          <TabsTab key={item.value} value={item.value} disabled={item.disabled}>
            {item.label}
            {item.count !== undefined && <span data-slot="tab-count">{item.count}</span>}
          </TabsTab>
        ))}
        <TabsIndicator />
      </TabsList>
      {items.map((item) => (
        <TabsPanel key={item.value} value={item.value}>
          {item.content}
        </TabsPanel>
      ))}
    </TabsRoot>
  );
}

/* A word set apart: a count, a state, "New". Quieter than a status, which is a fact about a record. */
export function Badge({ children, icon, tone }: { children: ReactNode; icon?: ReactNode; tone?: Tone }) {
  return (
    <span data-slot="badge" data-tone={tone}>
      {icon}
      {children}
    </span>
  );
}

/* A field's value is whole and well formed: a tick at the field's end, said to a screen reader in words. */
export function ValidMark({ label = words.complete }: { label?: string }) {
  return (
    <span data-slot="valid-mark" role="img" aria-label={label}>
      <Check aria-hidden="true" weight="bold" />
    </span>
  );
}

/* How far along, as a bar with its words over it. */
export function ProgressBar({
  value,
  max = 100,
  label,
  showValue = true,
}: {
  value: number;
  max?: number;
  label: string;
  showValue?: boolean;
}) {
  return (
    <Progress value={value} max={max}>
      <ProgressLabel>{label}</ProgressLabel>
      {showValue && <ProgressValue />}
      <ProgressTrack>
        <ProgressIndicator />
      </ProgressTrack>
    </Progress>
  );
}

/* More about a field, behind a small question mark. It opens on a press and stays until it is closed, so it works
   under a finger and can hold a sentence or a link; a hint that only appears on hover does neither. */
export function HelpTip({ children, label = words.moreAboutThis }: { children: ReactNode; label?: string }) {
  return (
    <Pop>
      <PopoverTrigger data-kind="help-tip" aria-label={label}>
        <Question aria-hidden="true" weight="bold" />
      </PopoverTrigger>
      <PopoverContent data-kind="help-tip">{children}</PopoverContent>
    </Pop>
  );
}

/* The head of one step of a longer form: where the reader is, what this step is, and a line on why it is asked. */
export function StepHeader({
  title,
  lead,
  step,
  of,
  level = 2,
  arrive,
}: {
  title: string;
  lead?: ReactNode;
  step?: number;
  of?: number;
  level?: 1 | 2 | 3;
  /* Puts the keyboard on the step's name when the step changes, so a reader who pressed Continue hears where they
     have arrived instead of being left on a button that is no longer there. */
  arrive?: boolean;
}) {
  const Heading = `h${level}` as 'h1' | 'h2' | 'h3';
  const name = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  useEffect(() => {
    // Not on the first draw: a page that opens on a step has not moved the reader anywhere.
    if (arrive && !first.current) name.current?.focus();
    first.current = false;
  }, [arrive, step, title]);
  return (
    <header data-slot="step-header">
      {step !== undefined && of !== undefined && (
        <>
          <p data-slot="step-count">{words.stepOf(step, of)}</p>
          <span data-slot="step-track" aria-hidden="true" style={{ '--done': step / of } as CSSProperties} />
        </>
      )}
      <Heading ref={name} tabIndex={-1}>
        {title}
      </Heading>
      {lead && <p data-slot="step-lead">{lead}</p>}
    </header>
  );
}

/* Things side by side where there is room and stacked where there is not: columns at least this wide each. */
export function Columns({ min = '16rem', children }: { min?: string; children: ReactNode }) {
  return (
    <div data-slot="columns" style={{ '--min': min } as CSSProperties}>
      {children}
    </div>
  );
}

export type ReviewItem = { label: string; value: ReactNode; onChange?: () => void };

/* What the reader has said so far, before they send it: each answer with the way back to change it. */
export function ReviewList({ label, items }: { label: string; items: ReviewItem[] }) {
  return (
    <dl data-slot="review-list" aria-label={label}>
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
          {item.onChange && (
            <dd data-slot="review-change">
              <button type="button" data-slot="more-link" onClick={item.onChange}>
                {words.change}
                <span data-slot="visually-hidden"> {item.label.toLowerCase()}</span>
              </button>
            </dd>
          )}
        </div>
      ))}
    </dl>
  );
}

/* A landing page's points: an icon, a few words, a sentence under them. */
export function IconRows({ rows }: { rows: { icon: ReactNode; title: string; text?: ReactNode }[] }) {
  return (
    <ul data-slot="icon-rows">
      {rows.map((row) => (
        <li key={row.title}>
          <span data-slot="icon-rows-icon" aria-hidden="true">
            {row.icon}
          </span>
          <div>
            <strong>{row.title}</strong>
            {row.text && <p>{row.text}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}

export type PhotoTile = { src: string; alt: string; caption?: string; srcSet?: string; sizes?: string };

/* Two to four pictures laid as tiles: the first leads, the rest fill beside it. */
export function PhotoTiles({ tiles }: { tiles: PhotoTile[] }) {
  return (
    <div data-slot="photo-tiles" data-count={Math.min(tiles.length, 4)}>
      {tiles.slice(0, 4).map((tile, at) => (
        <figure key={tile.src}>
          {/* The first picture is what the page is waiting for; the rest wait their turn. */}
          <img
            src={tile.src}
            srcSet={tile.srcSet}
            sizes={tile.sizes}
            alt={tile.alt}
            loading={at === 0 ? 'eager' : 'lazy'}
            fetchPriority={at === 0 ? 'high' : 'auto'}
          />
          {tile.caption && <figcaption>{tile.caption}</figcaption>}
        </figure>
      ))}
    </div>
  );
}
