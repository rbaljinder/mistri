/**
 * The agent console: the MCP tools, driven by hand.
 *
 * MCP is invisible by design — newline-delimited JSON between two programs —
 * which leaves nowhere to *watch* it. This is that place: the tool list an
 * agent's client would receive, a form for each tool's arguments, and the
 * answer exactly as an agent gets it, stats and all. The claim is structural
 * rather than aspirational: the endpoint underneath calls the same runTool
 * the stdio loop calls.
 *
 * What it is for: tuning tool descriptions by reading them the way a model
 * would, checking what a call costs before an agent pays it on every step,
 * and debugging "why did the agent do that" by replaying its calls.
 */
import { createElement } from 'react';
import { el } from '@mistriwork/kit/client/core.js';
import { mount, unmount } from '@mistriwork/kit/client/components/mount.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { say } from './copy/workbench/agent.js';
import { portalRoot } from '@mistriwork/kit/client/shellHost.js';

/* Loaded the first time the console opens. */
const AgentConsole = onDemand(() => import('./components/AgentConsole.js'), 'AgentConsole');

let panel = null;

/** The console is `components/AgentConsole.tsx`; this is its one host on the body. */
export async function openAgentConsole() {
  /* The console arrives with its frame, so the modal panel never stands
     empty, without its focus trap. */
  await AgentConsole.ready();
  if (panel) return;
  panel = el('div', {
    class: 'conn-manager agent-console',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': say('common.agentConsole'),
  });
  portalRoot().append(panel);
  mount(panel, createElement(AgentConsole, { onClose: close }));
}

function close() {
  if (!panel) return;
  unmount(panel);
  panel.remove();
  panel = null;
}
