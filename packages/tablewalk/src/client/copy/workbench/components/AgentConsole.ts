/** What AgentConsole says, in the Workbench room (packages/kit/src/client/messages.ts says how the catalog is split). */
import { defineMessages } from '@mistriwork/kit/client/messages.js';

export const say = defineMessages({
  charsTokens: '{chars} chars · ~{tokens} tokens',
  readOnly: 'read-only',
  writes: 'writes',
  destructive: 'destructive',
  readingTheTools: 'Reading the tools…',
  agentConsole: 'Agent console',
  theMcpToolsDriven: 'The MCP tools, driven by hand. Answers are exactly what an agent receives — same code path, stats and all.',
  tools: 'Tools',
  calling: 'Calling {tool}…',
  noToolsIsTheServer: 'No tools. Is the server running?',
  isNotJson: '"{name}" is not JSON: {raw}',
  required: 'required',
  callTool: 'Call tool',
  callCost: '{ms} ms · {size} ch',
  calls: { one: '{count} call', other: '{count} calls' },
  rows: { one: '{count} row', other: '{count} rows' },
  thisSessionRead: 'This session — {calls} · {rows} read',
  openLink: 'open {link}',
});
