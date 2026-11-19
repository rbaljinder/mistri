/**
 * The assistant's door in the App bar: one icon button, beside the
 * account's, drawn where the App payload says this person is offered an
 * assistant (`assistant` on /api/app). It is the whole of the assistant in
 * the first page — the panel, its stylesheet and everything it draws with
 * are a chunk of their own (AssistantPanel.tsx), fetched when the button is
 * first pressed, or pointed at, since a pointer on its way to it is the
 * moment to start (docs/assistant.md, "Panel").
 *
 * Its look is the bell's (InboxBell.css), which is already in the first
 * paint, so it brings no stylesheet of its own.
 *
 * Ask is the same panel opened on a question (docs/assistant.md, "Ask"):
 * from the palette's "Ask" and from a list's verbs, which this door draws
 * there, since it is the one part that is mounted wherever the App's
 * assistant is on and nowhere else.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@mistriwork/kit/client/components/Icon.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { useCrumbSlots, verbsAt } from '@mistriwork/kit/client/components/crumbSlot.js';
import { useWalk } from '@mistriwork/kit/client/components/walk.js';
import { addPaletteSource } from '@mistriwork/kit/client/palette.js';
import { say } from '../copy/shell/components/AssistantTrigger.js';
import { shellQuery } from '@mistriwork/kit/client/shellHost.js';
import { activeApp } from '../appState.js';

const AssistantPanel = onDemand(() => import('./AssistantPanel.js'), 'AssistantPanel', { quiet: true });

/* Who opens Ask: the door that is mounted. One at a time, as the door is. */
const askers = new Set<() => void>();

/** Open the assistant's panel on a fresh Ask. Nothing happens where the App's assistant is off: no door is mounted. */
function askAssistant(): void {
  for (const ask of askers) ask();
}

let registered = false;
/** The palette's "Ask", offered only while an App with its assistant on is open. Registered once, by the chrome. */
export function registerAskInPalette(): void {
  if (registered) return;
  registered = true;
  addPaletteSource('places', () =>
    askers.size && (activeApp() as { assistant?: unknown } | null)?.assistant
      ? [{ kind: 'action', label: say('ask'), search: `${say('ask')} ${say('askDetail')}`, detail: say('askDetail'), run: askAssistant }]
      : [],
  );
}

export function AssistantTrigger({ app, record }: { app: string; record: boolean }) {
  const [open, setOpen] = useState(false);
  // Counts the Asks: each one is a fresh panel (AssistantPanel's key).
  const [ask, setAsk] = useState(0);
  useEffect(() => {
    const opened = () => {
      void AssistantPanel.ready();
      setAsk((was) => was + 1);
      setOpen(true);
    };
    askers.add(opened);
    return () => {
      askers.delete(opened);
    };
  }, []);
  const walk = useWalk();
  const top = walk[walk.length - 1];
  const verbs = verbsAt(useCrumbSlots());
  return (
    <>
      {top?.kind === 'table' &&
        verbs &&
        createPortal(
          <button
            type="button"
            className="ghost assistant-ask-list"
            onPointerEnter={() => void AssistantPanel.ready()}
            onClick={askAssistant}
          >
            <Icon name="chat-circle" />
            {say('ask')}
          </button>,
          verbs,
        )}
      <button
        type="button"
        className="icon-button inbox-trigger assistant-trigger"
        aria-expanded={open}
        aria-controls={open ? 'assistant-panel' : undefined}
        title={say('assistant')}
        aria-label={say('assistant')}
        onPointerEnter={() => void AssistantPanel.ready()}
        onFocus={() => void AssistantPanel.ready()}
        onClick={() => {
          setAsk(0);
          setOpen((was) => !was);
        }}
      >
        <Icon name="chat-circle" />
      </button>
      {open && (
        <AssistantPanel
          app={app}
          record={record}
          {...(ask ? { ask } : {})}
          onClose={() => {
            setOpen(false);
            setAsk(0);
            shellQuery<HTMLElement>('.assistant-trigger')?.focus();
          }}
        />
      )}
    </>
  );
}
