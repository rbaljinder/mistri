/**
 * A dashboard's button that runs one of the App's commands (`commandButton('enableTexting', { title, description })`):
 * a switch an owner throws once, which no record carries and no form asks anything for. The command names no record
 * and needs no input (appDashSections.ts refuses any other), so the button sends it as it is; its outcome is said as a
 * page's `CommandButton` says it, and a refusal in the server's words, which the run says itself.
 */
import { useState } from 'react';
import { Button } from '@mistriwork/ui/Button.js';
import { toast } from '@mistriwork/kit/client/core.js';
import { Icon } from '@mistriwork/kit/client/components/Icon.js';
import type { AppIconName } from '@mistriwork/engine/shared/appIcons.js';
import { useCommand } from './sdk/hooks.js';
import { say } from '../copy/dashboards/components/DashboardCommand.js';

interface CommandSectionProps {
  section: { command?: string; title?: string; text?: string; label?: string; icon?: AppIconName };
}

export function DashboardCommand({ section }: CommandSectionProps) {
  const handle = useCommand(section.command ?? '');
  const [running, setRunning] = useState(false);
  const label = section.label ?? handle.label;
  const run = () => {
    setRunning(true);
    void handle
      .run({}, {}, { label })
      .then((outcome) => {
        if (outcome.status === 'applied') toast(outcome.message ?? say('commandDone', { label }), 'ok');
      })
      .finally(() => setRunning(false));
  };
  return (
    <div className="dash-command">
      {section.title ? (
        <h2 className="page-section-title">
          {section.icon ? <Icon name={section.icon} size={16} /> : null}
          {section.title}
        </h2>
      ) : null}
      {section.text ? <p className="dashboard-note-text">{section.text}</p> : null}
      <Button variant="primary" loading={running} disabled={running} onClick={run}>
        {label}
      </Button>
    </div>
  );
}
