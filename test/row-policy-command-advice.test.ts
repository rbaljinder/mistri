/**
 * Field report R9: under a row policy, the advice a startup refusal gave led
 * to a second refusal. Started without --commands, the App was told to give
 * its commands; with --commands, the policy was told to declare
 * resultReferences, "one function per command"; and a policy that did so for
 * every command, its public one too, was refused as "Scoped commands require
 * explicit journal support and complete result authorization declarations",
 * blamed on the App and its connections rather than the policy that missed.
 * Each refusal now names what to write, and writing it starts the App.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { policyServer, refusedStart, sourceUrl } from './support/policyServer.js';

const APP = {
  id: 'spoke',
  name: 'Spoke',
  track: 'receipts',
  auth: {
    signUp: 'open',
    defaultRole: 'mechanic',
    rows: 'policy',
    roles: { mechanic: { read: true, commands: ['assign', 'close'] } },
  },
  resources: {
    job: {
      access: 'write',
      actions: { assign: { label: 'Assign', command: 'assign' }, close: { label: 'Close', command: 'close' } },
    },
  },
  views: { jobs: { kind: 'list', from: 'job' } },
  home: 'jobs',
  nav: ['jobs'],
};
const COMMANDS = `import { defineCommand, defineCommands } from ${sourceUrl('packages/mistri/src/server/commands/businessCommands.ts')};
export default defineCommands({
  assign: defineCommand({ source: 'main', target: 'job', read: ['job'], write: ['job'], async handle() { return {}; } }),
  close: defineCommand({ source: 'main', target: 'job', read: ['job'], write: ['job'], async handle() { return {}; } }),
  // A public form's command: it runs on no row-policy App, so the policy says nothing of its result.
  ping: defineCommand({ public: true, source: 'main', target: 'job', write: ['job'], async handle() { return {}; } }),
});`;
const SQL = 'CREATE TABLE job(id INTEGER PRIMARY KEY, title TEXT NOT NULL);';
const policy = (references: string[] | undefined) =>
  `export default { appId: 'spoke', ${references ? `resultReferences: { ${references.map((id) => `${id}: () => []`).join(', ')} },` : ''}
    resolveRows() { return { job: true }; } };`;
const cause = (said: string) => said.split('\n').find((line) => line.startsWith('Policy startup error:')) ?? said;

test(
  'each row-policy startup refusal about commands names what to write, and writing it starts the App',
  { timeout: 120_000 },
  async (t) => {
    const bare = await refusedStart(t, { app: APP, policy: policy(undefined), sql: SQL });
    assert.match(bare, /no commands module is loaded\. Give the App its commands module with --commands <file>/);

    // The advice names the commands the policy covers, and only those: the public one is left out.
    const undeclared = cause(await refusedStart(t, { app: APP, policy: policy(undefined), sql: SQL, commands: COMMANDS }));
    assert.match(undeclared, /The App row policy definition could not be loaded or is invalid\./);
    assert.match(undeclared, /resultReferences: one function for each of "assign", "close"/);
    assert.match(undeclared, /"ping" is public: true and needs none/);

    // One function per command, the public one too, as the old advice read: refused by name, and on the policy.
    const everyOne = cause(await refusedStart(t, { app: APP, policy: policy(['assign', 'close', 'ping']), sql: SQL, commands: COMMANDS }));
    assert.match(everyOne, /The App row policy definition could not be loaded or is invalid\./);
    assert.match(everyOne, /leave out "ping", which is public: true/);
    assert.doesNotMatch(everyOne, /Scoped commands require|not the policy module/);

    const short = cause(await refusedStart(t, { app: APP, policy: policy(['assign', 'other']), sql: SQL, commands: COMMANDS }));
    assert.match(short, /add "close"/);
    assert.match(short, /leave out "other", which the commands module does not register/);

    // What the advice said to write starts the App.
    const server = await policyServer(t, { app: APP, policy: policy(['assign', 'close']), sql: SQL, commands: COMMANDS });
    assert.equal((await server.api('app')).status, 401);
  },
);
