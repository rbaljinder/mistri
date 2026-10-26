/**
 * Collapsible sections: each a heading holding a real disclosure button
 * (`aria-expanded`, `aria-controls`) over the region it opens. Specs,
 * features, questions — the things a reader opens one at a time.
 *
 * Opening and closing are instant: the content is there or it is not, and
 * only the chevron turns (docs/design.md, motion doctrine — nothing that
 * reflows). A run of items inside `Accordion` is one ruled group, and the
 * arrow keys, Home and End move between its buttons, as the ARIA pattern
 * describes; an item on its own is still a working disclosure.
 */
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';

const TRIGGER = '.accordion-trigger';
const STEPS: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 };

/** Arrow keys between the group's own buttons — not a nested group's. */
function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
  const target = event.target as HTMLElement;
  if (!target.matches(TRIGGER) || target.closest('.accordion') !== event.currentTarget) return;
  const triggers = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(TRIGGER)].filter(
    (button) => button.closest('.accordion') === event.currentTarget,
  );
  const at = triggers.indexOf(target as HTMLButtonElement);
  const step = STEPS[event.key];
  const to = step
    ? (at + step + triggers.length) % triggers.length
    : event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? triggers.length - 1
        : -1;
  if (to < 0 || at < 0) return;
  event.preventDefault();
  triggers[to].focus();
}

export function Accordion({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="accordion" role={label ? 'group' : undefined} aria-label={label} onKeyDown={moveFocus}>
      {children}
    </div>
  );
}

interface AccordionItemProps {
  title: ReactNode;
  children: ReactNode;
  /** Open when first drawn; the reader's choice after that. */
  defaultOpen?: boolean;
  /** The heading level the button sits in, so the outline never skips one. */
  level?: 2 | 3 | 4;
}

export function AccordionItem({ title, children, defaultOpen = false, level = 3 }: AccordionItemProps) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const Heading = `h${level}` as 'h2' | 'h3' | 'h4';
  return (
    <div className={`accordion-item${open ? ' is-open' : ''}`}>
      <Heading className="accordion-heading">
        <button
          type="button"
          className="accordion-trigger"
          id={`${id}-button`}
          aria-expanded={open}
          aria-controls={`${id}-panel`}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="accordion-title">{title}</span>
          <svg className="accordion-chevron" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </Heading>
      <div className="accordion-panel" id={`${id}-panel`} role="region" aria-labelledby={`${id}-button`} hidden={!open}>
        {children}
      </div>
    </div>
  );
}
