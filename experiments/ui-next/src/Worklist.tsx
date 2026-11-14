import { CaretRight } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { Skeleton } from './Skeleton';
import type { Tone } from './Status';
import { words } from './words';

export type WorkItem = {
  id: string;
  title: ReactNode;
  /* What the reader needs to decide whether to open it: where, since when. */
  detail?: ReactNode;
  /* The figure or the date the row is about, at its end. */
  value?: ReactNode;
  tone?: Tone;
  icon?: ReactNode;
  href: string;
  /* Hears a plain press, so the host can move in place; a modified press is the browser's (a new tab). */
  onOpen?: () => void;
};

/* Things to do, each one row and one press: what it is, where, and the figure it is about. A list of links, since
   every row goes somewhere, with the whole row the target. */
export function Worklist({
  label,
  items,
  empty,
  loading,
}: {
  label: string;
  items: WorkItem[];
  empty?: ReactNode;
  /* The rows are still being read: a few wait in their place. */
  loading?: boolean;
}) {
  if (loading)
    return (
      <ul data-slot="worklist" aria-label={label} aria-busy="true">
        {['64%', '48%', '72%', '55%'].map((width) => (
          <li key={width}>
            <span data-slot="worklist-item" data-waiting="">
              <span data-slot="worklist-icon" aria-hidden="true" />
              <span data-slot="worklist-words">
                <Skeleton width={width} />
                <Skeleton width="38%" />
              </span>
            </span>
          </li>
        ))}
      </ul>
    );
  if (items.length === 0) return <p data-slot="worklist-empty">{empty ?? words.nothingToDo}</p>;
  return (
    <ul data-slot="worklist" aria-label={label}>
      {items.map((item) => (
        <li key={item.id}>
          <a
            href={item.href}
            data-slot="worklist-item"
            data-tone={item.tone}
            onClick={(event) => {
              if (!item.onOpen || event.metaKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              item.onOpen();
            }}
          >
            {item.icon && (
              <span data-slot="worklist-icon" aria-hidden="true">
                {item.icon}
              </span>
            )}
            <span data-slot="worklist-words">
              <span data-slot="worklist-title">{item.title}</span>
              {item.detail && <span data-slot="worklist-detail">{item.detail}</span>}
            </span>
            {item.value && <span data-slot="worklist-value">{item.value}</span>}
            <CaretRight aria-hidden="true" data-slot="worklist-go" />
          </a>
        </li>
      ))}
    </ul>
  );
}
