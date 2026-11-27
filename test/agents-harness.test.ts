import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AgentValidationError,
  bindAgentChannel,
  createDurableAgentWorkflow,
  createMemoryArtifactStore,
  defineAgent,
  defineAgentEval,
  defineBlock,
  defineSkill,
  defineTool,
  geminiModel,
  getAssistantProvider,
  listAssistantProviders,
  openaiCompatibleModel,
  registerAssistantProvider,
  runAgentEval,
  runAgentTurn,
  withModelFallback,
  type AgentEvent,
} from '../packages/mistri/src/server/agents.js';
import { geminiBody, readGeminiStream } from '../packages/mistri/src/server/agents/providers.js';
import { scriptedModel } from '../packages/mistri/src/server/assistant/assistantScripted.js';
import { ModelUnavailable } from '../packages/mistri/src/server/assistant/assistantModelRefusal.js';
import type { AssistantModel, ModelRequest } from '../packages/mistri/src/server/assistant/assistantModel.js';

const manager = { accountId: 'ada', roles: ['manager'], tenantId: 'acme' };
const viewer = { accountId: 'bob', roles: ['viewer'], tenantId: 'acme' };

test('defineTool, defineSkill progressive disclosure, defineBlock resolution, hooks, and artifact offloading work end to end', async () => {
  let sawBeforeTurn = false;
  let redactedCount = 0;

  const secretReportTool = defineTool({
    name: 'fetch_report',
    description: 'Fetch a long report.',
    input: { topic: { type: 'string', required: true } },
    roles: ['manager'],
    maxInlineChars: 120,
    run(input) {
      return {
        label: `Fetched ${String(input.topic)}`,
        summary: { topic: input.topic, secret: 'SSN-999-00-1111', details: 'x'.repeat(300) },
      };
    },
  });

  const blockedTool = defineTool({
    name: 'danger_op',
    description: 'Should be blocked by beforeTool hook.',
    run() {
      return { ok: true };
    },
  });

  const leaseSummaryBlock = defineBlock({
    name: 'lease_summary',
    description: 'Visual summary of a lease.',
    title: 'Lease risk summary',
    input: { leaseId: { type: 'string', required: true } },
    async resolve(input, ctx) {
      if (input.leaseId === 'hidden') return null;
      return { leaseId: input.leaseId, tenant: ctx.principal.tenantId, score: 92 };
    },
  });

  const renewalSkill = defineSkill({
    name: 'lease-renewals',
    description: 'Analyze expiring leases and render risk summaries.',
    roles: ['manager'],
    instructions: 'Always call fetch_report and render_block(lease_summary).',
    tools: [secretReportTool],
    blocks: [leaseSummaryBlock],
  });

  const agent = defineAgent({
    id: 'ops',
    instructions: 'You are an operations agent.',
    tools: [blockedTool],
    skills: [renewalSkill],
    hooks: {
      beforeTurn() {
        sawBeforeTurn = true;
        return { extraSystem: 'Follow tenant policy strictly.' };
      },
      beforeTool(call) {
        if (call.name === 'danger_op') return { allow: false, reason: 'Blocked by safety policy.' };
      },
      afterTool(_call, outcome) {
        if (outcome.result.includes('SSN-999-00-1111')) {
          redactedCount += 1;
          return { result: outcome.result.replaceAll('SSN-999-00-1111', '[REDACTED]') };
        }
      },
    },
  });

  const seenRequests: ModelRequest[] = [];
  const inner = scriptedModel({
    turns: [
      {
        when: 'renewals',
        steps: [
          { thinking: 'Loading the lease-renewals skill first.', tools: [{ name: 'load_skill', input: { name: 'lease-renewals' } }] },
          {
            tools: [
              { name: 'danger_op', input: {} },
              { name: 'fetch_report', input: { topic: 'q4-leases' } },
              { name: 'render_block', input: { name: 'lease_summary', input: { leaseId: 'L-42' } } },
              { name: 'render_block', input: { name: 'lease_summary', input: { leaseId: 'hidden' } } },
            ],
          },
          { tools: [{ name: 'read_artifact', input: { id: 'art_1', offset: 0, length: 60 } }] },
          { text: 'Renewal analysis complete.' },
        ],
      },
    ],
  });

  const recording: AssistantModel = {
    stream(req, sink, signal) {
      seenRequests.push(req);
      return inner.stream(req, sink, signal);
    },
  };

  const events: AgentEvent[] = [];
  const artifacts = createMemoryArtifactStore();
  const result = await runAgentTurn(agent, 'Check renewals', {
    model: recording,
    principal: manager,
    artifacts,
    emit: (e) => events.push(e),
  });
  assert.equal((await artifacts.list()).length, 1);

  assert.equal(sawBeforeTurn, true);
  assert.equal(result.text, 'Renewal analysis complete.');
  assert.equal(result.reasoning.length, 1);
  assert.match(result.reasoning[0].text, /lease-renewals/);
  // Step 1: before skill is loaded, fetch_report is NOT in tools yet; after load_skill it IS!
  assert.equal(
    seenRequests[0].tools.some((t) => t.name === 'fetch_report'),
    false,
  );
  assert.equal(
    seenRequests[1].tools.some((t) => t.name === 'fetch_report'),
    true,
  );
  assert.match(seenRequests[1].system, /Follow tenant policy strictly/);
  assert.match(seenRequests[1].system, /\[Skill: lease-renewals\]/);
  // danger_op was blocked by beforeTool hook.
  assert.equal(result.steps.find((s) => s.tool === 'danger_op')?.failed, true);
  // fetch_report output exceeded maxInlineChars and was offloaded to artifact art_1, with SSN redacted.
  assert.deepEqual(result.artifacts, ['art_1']);
  assert.ok(redactedCount >= 1);
  // Only the authorized lease_summary block was emitted; the 'hidden' one returned null and was suppressed.
  assert.equal(result.blocks.length, 1);
  assert.deepEqual(result.blocks[0], {
    kind: 'custom',
    name: 'lease_summary',
    title: 'Lease risk summary',
    props: { leaseId: 'L-42', tenant: 'acme', score: 92 },
  });
  assert.ok(events.some((e) => e.event === 'reasoning'));
  assert.ok(events.some((e) => e.event === 'artifact'));
  assert.ok(events.some((e) => e.event === 'block'));
});

test('subagent delegation isolates context, inherits principal authority, and blocks unauthorized roles', async () => {
  const seenChildPrincipals: string[] = [];
  const lookupTool = defineTool({
    name: 'lookup_case',
    description: 'Look up a case.',
    run(_input, ctx) {
      seenChildPrincipals.push(`${ctx.principal.accountId}:${ctx.principal.tenantId ?? ''}`);
      return { caseId: 'C-9', status: 'escalated' };
    },
  });

  const triageSubagent = defineAgent({
    id: 'triage',
    description: 'Triage escalated cases.',
    instructions: 'Look up cases and summarize.',
    tools: [lookupTool],
  });

  const parentAgent = defineAgent({
    id: 'dispatcher',
    instructions: 'Delegate case lookups to triage.',
    roles: ['manager'],
    subagents: [triageSubagent],
  });

  const model = scriptedModel({
    turns: [
      {
        when: 'help with case',
        steps: [
          { tools: [{ name: 'delegate', input: { agent: 'triage', task: 'inspect case C-9' } }] },
          { text: 'Case C-9 is escalated.' },
        ],
      },
      {
        when: 'inspect case',
        steps: [{ tools: [{ name: 'lookup_case', input: {} }] }, { text: 'Found C-9 escalated.' }],
      },
    ],
  });

  // Unauthorized viewer is rejected before any model call.
  await assert.rejects(() => runAgentTurn(parentAgent, 'help with case', { model, principal: viewer }), AgentValidationError);

  const result = await runAgentTurn(parentAgent, 'help with case', { model, principal: manager });
  assert.equal(result.text, 'Case C-9 is escalated.');
  assert.deepEqual(seenChildPrincipals, ['ada:acme']);
  assert.ok(result.steps.some((s) => s.tool === 'delegate' && !s.failed));
});

test('Gemini provider builds thinkingConfig, streams thoughts and function calls; OpenAI-compatible & fallback providers work', async () => {
  const req: ModelRequest = {
    model: 'gemini-2.5-pro',
    system: 'Be concise.',
    tools: [{ name: 'ping', description: 'Ping service', input_schema: { type: 'object', properties: {} } }],
    messages: [{ role: 'user', content: 'Check status' }],
    maxTokens: 1024,
    effort: 'high',
  };
  const body = geminiBody(req);
  assert.deepEqual((body.generationConfig as Record<string, unknown>).thinkingConfig, {
    includeThoughts: true,
    thinkingBudget: 16384,
  });

  const sse = [
    'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"Checking ping tool."}]}}]}',
    'data: {"candidates":[{"content":{"parts":[{"text":"Calling ping."},{"functionCall":{"name":"ping","args":{}}}]}}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":7}}',
  ].join('\n\n');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse));
      controller.close();
    },
  });
  const thoughts: string[] = [];
  const texts: string[] = [];
  const reply = await readGeminiStream(stream, {
    onText: (d) => texts.push(d),
    onReasoning: (ev) => {
      if (ev.delta) thoughts.push(ev.delta);
    },
  });
  assert.equal(thoughts.join(''), 'Checking ping tool.');
  assert.equal(texts.join(''), 'Calling ping.');
  assert.equal(reply.stopReason, 'tool_use');
  assert.equal(reply.content[0]?.type, 'thinking');
  assert.equal(reply.content[2]?.type, 'tool_use');
  assert.equal(reply.usage.input, 12);
  assert.equal(reply.usage.output, 7);

  // Provider registry + Gemini & OpenAI-compatible custom URL checks.
  registerAssistantProvider('local-test', () => scriptedModel({ turns: [], otherwise: 'Local ok.' }));
  assert.ok(getAssistantProvider('local-test'));
  assert.ok(listAssistantProviders().includes('google'));
  assert.ok(listAssistantProviders().includes('local-test'));

  let hitUrl = '';
  const compat = openaiCompatibleModel({
    baseUrl: 'https://llm.internal.example/v1',
    apiKey: 'secret',
    fetchImpl: (async (url: string | URL | Request) => {
      hitUrl = String(url);
      return new Response('data: {"choices":[{"delta":{"content":"Compat ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as typeof fetch,
  });
  const compatReply = await compat.stream(req, () => {}, new AbortController().signal);
  assert.equal(hitUrl, 'https://llm.internal.example/v1/chat/completions');
  assert.equal((compatReply.content[0] as Record<string, unknown>).text, 'Compat ok');

  // Gemini fetch adapter surfaces GEMINI_API_KEY on 401.
  const refusedGemini = geminiModel('bad', (async () => new Response('nope', { status: 401 })) as typeof fetch);
  await assert.rejects(() => refusedGemini.stream(req, () => {}, new AbortController().signal), /GEMINI_API_KEY/);

  // Fallback model retries automatically when primary throws ModelUnavailable.
  const failingPrimary: AssistantModel = {
    async stream() {
      throw new ModelUnavailable('Rate limited');
    },
  };
  const fallbackTarget = scriptedModel({ turns: [], otherwise: 'Recovered on fallback.' });
  const wrapped = withModelFallback(failingPrimary, [{ model: 'gpt-5', provider: fallbackTarget }]);
  const recovered = await wrapped.stream(req, () => {}, new AbortController().signal);
  assert.equal((recovered.content[0] as Record<string, unknown>).text, 'Recovered on fallback.');
});

test('durable workflow bridge, channel ingress, and defineAgentEval suite work cleanly', async () => {
  const agent = defineAgent({
    id: 'support-triage',
    instructions: 'Triage incoming support messages.',
    tools: [
      defineTool({
        name: 'classify',
        description: 'Classify ticket urgency.',
        input: { urgency: { type: 'string', enum: ['low', 'high'], required: true } },
        run(input) {
          return { summary: { urgency: input.urgency }, label: `Urgency: ${String(input.urgency)}` };
        },
      }),
    ],
  });

  const model = scriptedModel({
    turns: [
      {
        when: 'outage',
        steps: [
          { thinking: 'Production outage implies high urgency.', tools: [{ name: 'classify', input: { urgency: 'high' } }] },
          { text: 'Classified as high urgency.' },
        ],
      },
    ],
  });

  // 1. Durable workflow checkpointing + waitForEvent approval.
  const workflow = createDurableAgentWorkflow(agent, { model, principal: manager });
  const ranSteps: string[] = [];
  const wfResult = await workflow.execute(
    {
      async run(name, fn) {
        ranSteps.push(name);
        return fn();
      },
      async waitForEvent<T = unknown>(eventName: string) {
        ranSteps.push(`wait:${eventName}`);
        return { approved: true } as T;
      },
    },
    { prompt: 'Customer reports outage', approvalEvent: 'proposal.decided', approvalTimeout: '24h' },
  );
  assert.deepEqual(ranSteps, ['agent:support-triage:turn', 'wait:proposal.decided']);
  assert.deepEqual(wfResult.approval, { approved: true });
  assert.equal(wfResult.turn.text, 'Classified as high urgency.');

  // 2. Multi-channel ingress binding (email).
  let repliedTo = '';
  const emailBinding = bindAgentChannel(agent, {
    channel: 'email',
    runAs: manager,
    model,
    onReply(reply, incoming) {
      repliedTo = `${incoming.sender ?? ''}:${reply.text}`;
    },
  });
  await emailBinding.handle({ channel: 'email', sender: 'vip@acme.test', subject: 'Urgent', text: 'We have an outage!' });
  assert.equal(repliedTo, 'vip@acme.test:Classified as high urgency.');

  // 3. Agent Eval suite.
  const evalSuite = defineAgentEval({
    name: 'support-triage-regression',
    agent,
    defaultPrincipal: manager,
    cases: [
      {
        name: 'outage classified high with reasoning',
        prompt: 'Production outage on checkout',
        expect: {
          answerMatches: /high urgency/i,
          expectedTools: ['classify'],
          expectReasoning: true,
          maxSteps: 3,
          maxTokens: 5000,
        },
      },
    ],
  });
  const report = await runAgentEval(evalSuite, { model });
  assert.equal(report.total, 1);
  assert.equal(report.passed, 1);
  assert.equal(report.passRate, 1);
});
