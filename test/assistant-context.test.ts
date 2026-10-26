import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { catalogFromApp, estimateTokens, systemPrompt, toolSpecs } from '../packages/mistri/src/server/assistant/assistantCatalog.js';
import { appDirectory, walkedApps } from './support/exampleApps.js';

/**
 * What the assistant is told before anyone asks anything — the system prompt
 * and the five tools — is the prefix every turn pays for (cached, but paid
 * once a conversation and counted against the caps). It must not grow with
 * the App: fields, inputs and choices come from `describe` when a step needs
 * them. Measured over every example App, and the fixtures that were examples, at its widest (every role's verbs at
 * once, catalogFromApp), with the conservative count assistantCatalog.ts
 * keeps; a sample that outgrows the budget says the catalog has started to
 * carry what `describe` is for.
 */
const BUDGET = 2500;

for (const name of walkedApps()) {
  test(`${name}: the starting context stays under ${BUDGET} tokens`, async () => {
    const { app } = await loadApp(appDirectory(name));
    const system = estimateTokens(systemPrompt(catalogFromApp(app)));
    const tools = estimateTokens(JSON.stringify(toolSpecs(app.assistant)));
    assert.ok(system + tools <= BUDGET, `${name}: ${system} (system) + ${tools} (tools) = ${system + tools} tokens`);
    // The tool core is the same size for every App: it carries no App's names.
    assert.ok(tools < 1000, `${name}: the tools alone are ${tools} tokens`);
  });
}
