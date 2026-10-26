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
 */
import { useState } from 'react';
import { Icon } from '@mistriwork/kit/client/components/Icon.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { say } from '../copy/shell/components/AssistantTrigger.js';
import { shellQuery } from '@mistriwork/kit/client/shellHost.js';

const AssistantPanel = onDemand(() => import('./AssistantPanel.js'), 'AssistantPanel', { quiet: true });

export function AssistantTrigger({ app, record }: { app: string; record: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="icon-button inbox-trigger assistant-trigger"
        aria-expanded={open}
        aria-controls={open ? 'assistant-panel' : undefined}
        title={say('assistant')}
        aria-label={say('assistant')}
        onPointerEnter={() => void AssistantPanel.ready()}
        onFocus={() => void AssistantPanel.ready()}
        onClick={() => setOpen((was) => !was)}
      >
        <Icon name="chat-circle" />
      </button>
      {open && (
        <AssistantPanel
          app={app}
          record={record}
          onClose={() => {
            setOpen(false);
            shellQuery<HTMLElement>('.assistant-trigger')?.focus();
          }}
        />
      )}
    </>
  );
}
