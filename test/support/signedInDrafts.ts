/**
 * A real server over a row-policy App with one signed-in saved form (`owner`): the fixture the draft cases that need
 * the whole runtime share — a person's draft under a row policy that can narrow between two steps.
 *
 * The policy reads each person's region from a `scope` table, so a case narrows a member's rows by updating that row
 * in the served database, as an operator would, between two requests.
 */
import type { TestContext } from 'node:test';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { policyServer, sourceUrl } from './policyServer.js';

const IDS = ['startOnboarding', 'savePlan', 'saveContact', 'submitOnboarding'];

export const DRAFT_POLICY_SQL = `CREATE TABLE person(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL);
  CREATE TABLE scope(email TEXT PRIMARY KEY, region INTEGER NOT NULL);
  CREATE TABLE onboarding(id INTEGER PRIMARY KEY, status TEXT NOT NULL, person_id INTEGER NOT NULL REFERENCES person(id), region INTEGER NOT NULL,
    full_name TEXT, plan TEXT, reference TEXT, resume_token_hash TEXT, resume_expires_at TEXT, resume_progress TEXT);
  CREATE TABLE contact(id INTEGER PRIMARY KEY, onboarding_id INTEGER NOT NULL REFERENCES onboarding(id), label TEXT NOT NULL);
  INSERT INTO person VALUES (1, 'ann@example.org'), (2, 'bob@example.org');
  INSERT INTO scope VALUES ('ann@example.org', 1), ('bob@example.org', 1);`;

export const DRAFT_POLICY = `export default { appId: 'people',
  resultReferences: { startOnboarding: () => [], savePlan: () => [], saveContact: () => [], submitOnboarding: () => [] },
  async resolveRows(principal, { db }) {
    const found = principal.email ? await db.scope.where({ email: principal.email.toLowerCase() }).limit(1) : [];
    if (!found.length) return { person: false, scope: false, onboarding: false, contact: false };
    return { person: true, scope: true, contact: true, onboarding: { groups: [[{ column: 'region', op: '=', value: found[0].region }]] } };
  } };`;

/* Each step writes the draft's own rows; the first lands the root in region 1, which the member's scope must admit. */
export const DRAFT_COMMANDS = `import { defineCommand, defineCommands } from ${sourceUrl('packages/mistri/src/server/commands/businessCommands.ts')};
const base = { targets: 'none', source: 'main', target: 'onboarding', read: ['onboarding', 'contact', 'person'], write: ['onboarding', 'contact'], output: { parse: (value) => value } };
export default defineCommands({
  startOnboarding: defineCommand({ ...base, input: { full_name: { type: 'text', max: 60 } },
    async handle({ db, draft }, input) {
      if (draft.root) await db.onboarding.update(await db.onboarding.get(draft.root), input);
      else await db.onboarding.insert({ ...input, ...draft.start, region: 1 });
      return {};
    } }),
  savePlan: defineCommand({ ...base, input: { plan: { type: 'text', max: 20 } },
    async handle({ db, draft }, input) { await db.onboarding.update(await db.onboarding.get(draft.root), input); return {}; } }),
  saveContact: defineCommand({ ...base, input: { contact_label: { type: 'text', max: 60 } },
    async handle({ db, draft }, input) {
      for (const row of await db.contact.where({})) await db.contact.remove(row);
      await db.contact.insert({ label: input.contact_label, onboarding_id: draft.root.id });
      return {};
    } }),
  submitOnboarding: defineCommand({ ...base, input: { consent: { type: 'boolean' } },
    async handle({ db, draft }) {
      const root = await db.onboarding.get(draft.root);
      await db.onboarding.update(root, { status: 'submitted', reference: 'ONB-' + root.id });
      return { reference: 'ONB-' + root.id };
    } }),
});`;

export const DRAFT_FORM = {
  kind: 'form',
  label: 'Onboarding',
  command: 'submitOnboarding',
  steps: [
    { label: 'You', command: 'startOnboarding' },
    { label: 'Plan', command: 'savePlan' },
    { label: 'Contact', command: 'saveContact' },
  ],
  resume: { token: 'resume_token_hash', expires: 'resume_expires_at', progress: 'resume_progress', after: '14 days' },
  draft: { status: 'in_progress' },
  owner: 'person_id',
};

export const draftApp = (form: Record<string, unknown> = DRAFT_FORM) => ({
  id: 'people',
  name: 'People',
  auth: {
    signUp: 'open',
    store: 'accounts.db',
    defaultRole: 'member',
    rows: 'policy',
    me: { from: 'person', column: 'email' },
    roles: { member: { read: true, commands: IDS } },
  },
  resources: { person: {}, scope: {}, onboarding: { access: 'write' }, contact: { access: 'write' } },
  views: { onboardings: { kind: 'list', from: 'onboarding' }, onboard: form },
  home: 'onboardings',
  nav: ['onboardings', 'onboard'],
});

/* With `files`, a file table beneath the draft's root that the policy lets every member read: what a draft's file
   must still hide from anyone but its owner until submit (forms/draftFiles.ts). */
const DRAFT_FILE_SQL = `CREATE TABLE document(id INTEGER PRIMARY KEY, onboarding_id INTEGER NOT NULL REFERENCES onboarding(id),
  file_name TEXT NOT NULL, data BLOB);`;

/** The server, and a person's calls on the form. */
export async function draftPolicyServer(t: TestContext, options: { files?: boolean } = {}) {
  const base = draftApp() as { resources: Record<string, unknown> };
  const app = options.files
    ? { ...base, resources: { ...base.resources, document: { file: { content: 'data', name: 'file_name' } } } }
    : base;
  const sql = options.files ? `${DRAFT_POLICY_SQL}\n  ${DRAFT_FILE_SQL}` : DRAFT_POLICY_SQL;
  const policy = options.files
    ? DRAFT_POLICY.replaceAll('contact: false', 'contact: false, document: false').replace(
        'contact: true,',
        'contact: true, document: true,',
      )
    : DRAFT_POLICY;
  const server = await policyServer(t, { app, sql, commands: DRAFT_COMMANDS, policy });
  let n = 0;
  const key = (tag: string) => `${tag}-${String(++n).padStart(6, '0')}-draft-key`;
  const commandOf: Record<string, string> = { you: 'startOnboarding', plan: 'savePlan', contact: 'saveContact' };
  const inputOf: Record<string, unknown> = {
    you: { full_name: 'Ann Lee' },
    plan: { plan: 'team' },
    contact: { contact_label: 'ann@work.test' },
  };
  const envelope = (command: string, input: unknown) => ({
    command,
    commandVersion: 1,
    key: {},
    expectedVersion: 0,
    idempotencyKey: key(command),
    input,
  });
  const database = () => new DatabaseSync(server.url);
  const rows = <T>(sql: string): T[] => {
    const db = database();
    try {
      return db.prepare(sql).all() as T[];
    } finally {
      db.close();
    }
  };
  /* Open sign-up leaves an address unproven, and `me` is nobody's until it is proven (appMe.ts): the fixture proves the
     address as following a mailed link would, in the store the App names. */
  const prove = (email: string) => {
    const store = new DatabaseSync(join(dirname(server.url), 'app', 'accounts.db'));
    try {
      store.prepare('UPDATE user SET emailVerified = 1 WHERE email = ?').run(email);
    } finally {
      store.close();
    }
  };
  const signUp = async (name: string) => {
    const cookie = await server.signUp(name);
    prove(`${name}@example.org`);
    return cookie;
  };
  return {
    server,
    signUp,
    step: (cookie: string, step: string, draft?: number) =>
      server.api(
        'commands/draft',
        { form: 'onboard', op: 'step', step, ...(draft === undefined ? {} : { draft }), request: envelope(commandOf[step], inputOf[step]) },
        cookie,
      ),
    op: (cookie: string, op: 'resume' | 'review' | 'discard') => server.api('commands/draft', { form: 'onboard', op }, cookie),
    submit: (cookie: string, version: string) =>
      server.api(
        'commands/draft',
        { form: 'onboard', op: 'submit', version, request: envelope('submitOnboarding', { consent: true }) },
        cookie,
      ),
    /** Narrow (or widen) a member's rows, as an operator editing the policy's data would. */
    setRegion: (email: string, region: number) => {
      const db = database();
      try {
        db.prepare('UPDATE scope SET region = ? WHERE email = ?').run(region, email);
      } finally {
        db.close();
      }
    },
    onboardings: () => rows<Record<string, unknown>>('SELECT * FROM onboarding ORDER BY id'),
    contacts: () => rows<Record<string, unknown>>('SELECT * FROM contact ORDER BY id'),
    /** A file beneath a draft's root, written as a step's upload would leave it (`files` only). */
    attach: (onboarding: number, name: string) => {
      const db = database();
      try {
        return Number(
          db
            .prepare('INSERT INTO document(onboarding_id, file_name, data) VALUES (?, ?, ?)')
            .run(onboarding, name, new Uint8Array([1, 2, 3])).lastInsertRowid,
        );
      } finally {
        db.close();
      }
    },
    /** The file route's status for one document, as `cookie` reads it. */
    readFile: async (cookie: string, id: number) =>
      (await server.api(`file?table=document&key=${encodeURIComponent(JSON.stringify({ id }))}`, undefined, cookie)).status,
  };
}
