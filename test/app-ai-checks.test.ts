/**
 * `mistri check`'s three advisories about AI: the word AI said as text where the App's one word belongs
 * (`ai-text-bare`), an AI's commands that run without a person's word (`ai-command-unreviewed`), and a free-form page
 * that is only one command form (`page-single-form`). Each has a case that says it and a case that stays quiet.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { aiApprovalWarnings, aiTextWarnings } from '../packages/mistri/src/server/app/appAiChecks.js';
import { lintComponents } from '../packages/mistri/src/server/app/componentLint.js';

const run = (id: string) => ({ id, label: id, command: id });

test("ai-text-bare: a label or title that says AI as a word is advised; the App's own ai.label and a longer word are not", () => {
  const app = {
    ai: { label: 'AI' },
    assistant: { tools: ['run'], exclude: [], instructions: 'You are an AI.', label: 'Ask AI' },
    resources: { lead: { actions: [{ id: 'draft', label: 'Draft with AI', command: 'draft' }] } },
    views: { board: { kind: 'list', title: 'AI inbox' } },
  };
  const said = aiTextWarnings(app as never, { summarize: { label: 'Summarize with AI' } } as never);
  assert.equal(said.length, 3, said.join('\n'));
  assert.ok(said.every((line) => line.includes('[ai-text-bare]')));
  assert.match(said.join('\n'), /resources\.lead\.actions\[0\]\.label/);
  assert.match(said.join('\n'), /views\.board\.title/);
  assert.match(said.join('\n'), /command "summarize"/);
  const quiet = {
    ai: { label: 'Copilot' },
    resources: { lead: { actions: [{ id: 'a', label: 'Mail the lead', command: 'a' }] } },
    views: { board: { kind: 'list', title: 'Said, again; PAIR and AIM and ai' } },
  };
  assert.deepEqual(aiTextWarnings(quiet as never, { a: { label: 'Mail the lead' } } as never), []);
});

test('ai-text-bare: markup that says AI outside <AiBadge> is advised, in text, braces and a label', async (t: TestContext) => {
  const lint = async (source: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'mistri-ai-text-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'widgets'));
    writeFileSync(join(dir, 'widgets', 'Note.tsx'), source);
    const warnings = (await lintComponents(dir, { entries: { note: { sources: ['widgets/Note.tsx'] } } } as never)).warnings;
    return warnings.filter((warning) => warning.text.includes('[ai-text-bare]'));
  };
  const bare = await lint('export default () => <div><p>Written by AI</p><span>{\'AI draft\'}</span><Chip label="AI" /></div>;\n');
  assert.equal(bare.length, 3, JSON.stringify(bare));
  assert.equal(bare[0].file, 'widgets/Note.tsx');
  assert.deepEqual(
    await lint(
      'import { AiBadge } from \'@mistriwork/mistri/ui\';\nexport default () => <div><AiBadge>AI</AiBadge><p>A said, a PAIR, an aim</p><Chip label="Draft" /></div>;\n',
    ),
    [],
  );
});

test("ai-command-unreviewed: a command the assistant may run, or a suggest-only decision answers through, needs approval: 'ai'", () => {
  const app = {
    assistant: { tools: ['find', 'run'], exclude: ['lead.archive'] },
    resources: {
      lead: {
        actions: [
          run('qualify'),
          { id: 'archive', label: 'Archive', command: 'archive' },
          { id: 'nudge', label: 'Nudge', command: 'nudge' },
        ],
      },
    },
  };
  const commands = {
    qualify: { approval: 'ai' },
    archive: {},
    nudge: {},
    classify: {},
    applied: {},
  };
  const decisions = new Map([
    ['triage', { name: 'triage', answer: { command: { id: 'classify' }, field: 'kind' } }],
    ['auto', { name: 'auto', apply: 0.95, answer: { command: { id: 'applied' }, field: 'kind' } }],
  ]);
  const said = aiApprovalWarnings(app as never, commands as never, decisions as never);
  assert.equal(said.length, 2, said.join('\n'));
  assert.match(said[0], /command "nudge" is made by AI \(the assistant can run it from lead\.nudge\).*\[ai-command-unreviewed\]/);
  assert.match(said[1], /command "classify" .* decision "triage" only suggests/);
  // Marked, excluded, applying, or the assistant has no run tool: nothing to say.
  assert.deepEqual(
    aiApprovalWarnings(
      { ...app, assistant: { tools: ['find'], exclude: [] } } as never,
      { qualify: { approval: 'ai' }, classify: { approval: 'ai' }, applied: {} } as never,
      decisions as never,
    ),
    [],
  );
  assert.deepEqual(aiApprovalWarnings(app as never, undefined, decisions as never), []);
});

test('page-single-form: a page that is one command form is advised; a page with more on it is not', async (t: TestContext) => {
  const lint = async (source: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'mistri-single-form-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'pages'));
    writeFileSync(join(dir, 'pages', 'intake.page.tsx'), source);
    const manifest = { key: 'intake', reads: [], commands: ['addLead'], actions: [], loaders: [] };
    const { warnings } = await lintComponents(
      dir,
      { entries: { 'page-intake': { sources: ['pages/intake.page.tsx'] } } } as never,
      new Map([['page-intake', manifest]]) as never,
    );
    return warnings.filter((warning) => warning.text.includes('[page-single-form]'));
  };
  const head = "import { CommandForm, Stack, definePage } from '@mistriwork/mistri/page';\n";
  const alone = await lint(
    `${head}export default definePage({ label: 'Add a lead', reads: [], commands: ['addLead'], component: () => <Stack><CommandForm command="addLead" /></Stack> });\n`,
  );
  assert.equal(alone.length, 1, JSON.stringify(alone));
  assert.match(alone[0].text, /one command form \(addLead\).*started from the record or list.*drawer/);
  const more = await lint(
    `${head}import { Heading } from '@mistriwork/mistri/page';\nexport default definePage({ label: 'Add a lead', reads: [], commands: ['addLead'], component: () => <Stack><Heading>New lead</Heading><CommandForm command="addLead" /></Stack> });\n`,
  );
  assert.deepEqual(more, []);
});
