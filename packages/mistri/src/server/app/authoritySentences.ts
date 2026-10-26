/**
 * authority.lock in plain English, for the Console's Governance room: each
 * fact of a report (shared/appAuthority.ts) as a sentence, and a change
 * between two reports as what a role can now do, or can no longer do.
 *
 * The lock's grammar is the source; this only reads it. A fact this file has
 * no sentence for is shown as it is written, never dropped, so a new kind of
 * fact is visible before anyone writes its sentence. Contributors are kept
 * beside the sentence: who grants a thing is part of the answer.
 */

const SEPARATOR = ' — ';
const code = (name: string) => `\`${name}\``;
/** A quoted JSON string in the lock (`"Approve"`), read back for a sentence. */
const unquote = (text: string) => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'string' ? value : text;
  } catch {
    return text;
  }
};

/** Which part of the App a fact belongs to: a role's name, or one of the App-wide groups. */
export type AuthorityGroup = 'sign-in' | 'data' | 'public' | 'api' | 'flags' | 'environment' | `role:${string}`;

interface AuthoritySentence {
  readonly fact: string;
  readonly group: AuthorityGroup;
  /** The present-tense sentence: "Role `agent` can update `incident.state`." */
  readonly text: string;
  readonly by: readonly string[];
}

interface AuthorityChange {
  readonly change: 'added' | 'removed' | 'changed';
  readonly group: AuthorityGroup;
  /** "Role `agent` can now update `incident.state`." / "… can no longer …" / the new sentence of a changed setting. */
  readonly text: string;
  /** A changed setting's sentence before. */
  readonly was?: string;
  readonly fact: string;
}

interface Read {
  group: AuthorityGroup;
  /** Who the sentence is about and what follows "can", when it is a capability: the change says "can now"/"can no longer". */
  can?: { who: string; does: string };
  text?: string;
  /** A setting with one value at a time: a removed and an added line under one key are one change. */
  setting?: string;
}

const RULES: ReadonlyArray<[RegExp, (...parts: string[]) => Read]> = [
  [/^auth none$/, () => ({ group: 'sign-in', text: 'Nobody signs in: the App has no accounts.', setting: 'auth' })],
  [/^auth providers (.+)$/, (list) => ({ group: 'sign-in', text: `People sign in with ${list}.`, setting: 'auth providers' })],
  [
    /^auth sign-up just-in-time provider (.+)$/,
    (provider) => ({ group: 'sign-in', can: { who: `A first sign-in through ${provider}`, does: 'make an account' } }),
  ],
  [
    /^auth sign-up just-in-time domain (.+)$/,
    (domain) => ({ group: 'sign-in', can: { who: `A first sign-in from ${domain}`, does: 'make an account' } }),
  ],
  [/^auth sign-up just-in-time$/, () => ({ group: 'sign-in', text: 'An account is made at a first sign-in.', setting: 'auth sign-up' })],
  [/^auth sign-up (.+)$/, (mode) => ({ group: 'sign-in', text: `Sign-up is ${mode}.`, setting: 'auth sign-up' })],
  [
    /^auth default-role (.+)$/,
    (role) => ({ group: 'sign-in', text: `A new account gets role ${code(role)}.`, setting: 'auth default-role' }),
  ],
  [/^auth rows (.+)$/, (rows) => ({ group: 'sign-in', text: `Rows are scoped ${rows}.`, setting: 'auth rows' })],
  [/^auth platform realm enabled$/, () => ({ group: 'sign-in', text: 'The platform realm is on.' })],
  [
    /^auth tenant profile (.+)$/,
    (profile) => ({ group: 'sign-in', text: `Each tenant's profile is ${code(profile)}.`, setting: 'auth tenant profile' }),
  ],
  [
    /^source (\S+) connection (.+)$/,
    (name, connection) => ({
      group: 'data',
      text: `Source ${code(name)} uses connection ${unquote(connection)}.`,
      setting: `source ${name} connection`,
    }),
  ],
  [/^source (\S+) default$/, (name) => ({ group: 'data', text: `Source ${code(name)} is the default.` })],
  [
    /^source (\S+) schema (.+)$/,
    (name, schema) => ({ group: 'data', text: `Source ${code(name)} reads schema ${unquote(schema)}.`, setting: `source ${name} schema` }),
  ],
  [
    /^source (\S+) resources (.+)$/,
    (name, list) => ({
      group: 'data',
      text: list === 'all' ? `Source ${code(name)} reaches every table.` : `Source ${code(name)} reaches ${list}.`,
      setting: `source ${name} resources`,
    }),
  ],
  [/^source (\S+) realm platform read-only$/, (name) => ({ group: 'data', text: `Source ${code(name)} is the platform's, read-only.` })],
  [
    /^connection (.+)$/,
    (connection) => ({ group: 'data', text: `The App uses connection ${unquote(connection)}.`, setting: 'connection' }),
  ],
  [/^scope roles: .+$/, () => ({ group: 'data', text: 'Every read and write is granted by role, within the ceilings.', setting: 'scope' })],
  [
    /^scope ceilings: .+$/,
    () => ({ group: 'data', text: 'Declared resources are read; only those with write access are written.', setting: 'scope' }),
  ],
  [/^resource (\S+) reads$/, (name) => ({ group: 'data', text: `${code(name)} is served.` })],
  [
    /^resource (\S+) physical (.+)$/,
    (name, table) => ({ group: 'data', text: `${code(name)} is the table ${table}.`, setting: `resource ${name} physical` }),
  ],
  [
    /^resource (\S+) access (.+)$/,
    (name, access) => ({ group: 'data', text: `${code(name)} allows ${access} access at most.`, setting: `resource ${name} access` }),
  ],
  [/^resource (\S+) delete$/, (name) => ({ group: 'data', text: `Rows of ${code(name)} can be deleted.` })],
  [
    /^resource (\S+) owner (.+)$/,
    (name, owner) => ({
      group: 'data',
      text: `${code(name)} rows belong to whoever ${code(owner)} names.`,
      setting: `resource ${name} owner`,
    }),
  ],
  [/^resource (\S+) fields read (\S+)$/, (name, column) => ({ group: 'data', text: `${code(`${name}.${column}`)} can be read.` })],
  [/^resource (\S+) fields write (\S+)$/, (name, column) => ({ group: 'data', text: `${code(`${name}.${column}`)} can be written.` })],
  [
    /^flag (\S+) owner (\S+) tenant-managed (true|false)$/,
    (id, owner, tenant) => ({
      group: 'flags',
      text: `Flag ${code(id)} belongs to ${owner}${tenant === 'true' ? ', and tenants manage it' : ''}.`,
      setting: `flag ${id}`,
    }),
  ],
  [
    /^experiment (\S+) declared unit (\S+)$/,
    (id, unit) => ({ group: 'flags', text: `Experiment ${code(id)} assigns by ${unit}.`, setting: `experiment ${id} unit` }),
  ],
  [
    /^experiment (\S+) primary conversion (\S+)$/,
    (id, conversion) => ({
      group: 'flags',
      text: `Experiment ${code(id)} is judged by ${code(conversion)}.`,
      setting: `experiment ${id} primary`,
    }),
  ],
  [
    /^experiment (\S+) guardrail conversion (\S+)$/,
    (id, conversion) => ({ group: 'flags', text: `Experiment ${code(id)} watches ${code(conversion)}.` }),
  ],
  [
    /^role (\S+) realm (\S+)$/,
    (role, realm) => ({ group: `role:${role}`, text: `Role ${code(role)} is in the ${realm} realm.`, setting: `role ${role} realm` }),
  ],
  [
    /^role (\S+) extends (\S+)$/,
    (role, parent) => ({
      group: `role:${role}`,
      text: `Role ${code(role)} holds every grant of role ${code(parent)}, and those below.`,
      setting: `role ${role} extends`,
    }),
  ],
  [
    /^role (\S+) from claim (\S+) (.+)$/,
    (role, claim, value) => ({
      group: `role:${role}`,
      text: `Anyone whose ${code(claim)} claim is "${unquote(value)}" holds role ${code(role)}.`,
    }),
  ],
  [
    /^role (\S+) read (\S+)$/,
    (role, resource) => ({ group: `role:${role}`, can: { who: `Role ${code(role)}`, does: `read ${code(resource)}` } }),
  ],
  [
    /^role (\S+) write (\S+)$/,
    (role, resource) => ({ group: `role:${role}`, can: { who: `Role ${code(role)}`, does: `write ${code(resource)}` } }),
  ],
  [
    /^role (\S+) command (\S+)$/,
    (role, command) => ({ group: `role:${role}`, can: { who: `Role ${code(role)}`, does: `run ${code(command)}` } }),
  ],
  [
    /^role (\S+) action (\S+) (.+)$/,
    (role, resource, label) => ({
      group: `role:${role}`,
      can: { who: `Role ${code(role)}`, does: `use "${unquote(label)}" on ${code(resource)}` },
    }),
  ],
  [
    /^role (\S+) operation (\S+)$/,
    (role, operation) => ({ group: `role:${role}`, can: { who: `Role ${code(role)}`, does: `operate ${operation}` } }),
  ],
  [
    /^role (\S+) (flags|experiments) (.+)$/,
    (role, kind, entry) => ({ group: `role:${role}`, can: { who: `Role ${code(role)}`, does: `manage ${kind} ${capability(entry)}` } }),
  ],
  [
    /^role (\S+) fields (\S+) read (\S+)$/,
    (role, resource, column) => ({
      group: `role:${role}`,
      can: { who: `Role ${code(role)}`, does: `read ${code(`${resource}.${column}`)}` },
    }),
  ],
  [
    /^role (\S+) fields (\S+) write (\S+)$/,
    (role, resource, column) => ({
      group: `role:${role}`,
      can: { who: `Role ${code(role)}`, does: `update ${code(`${resource}.${column}`)}` },
    }),
  ],
  [/^role (\S+) grants nothing$/, (role) => ({ group: `role:${role}`, text: `Role ${code(role)} grants nothing.` })],
  [/^public read (\S+)$/, (resource) => ({ group: 'public', can: { who: 'Anyone, signed in or not,', does: `read ${code(resource)}` } })],
  [
    /^public fields (\S+) read (\S+)$/,
    (resource, column) => ({ group: 'public', can: { who: 'Anyone, signed in or not,', does: `read ${code(`${resource}.${column}`)}` } }),
  ],
  [
    /^public form (\S+) runs command (\S+) version (\d+)$/,
    (form, command, version) => ({
      group: 'public',
      can: { who: 'Anyone', does: `run ${code(command)} (version ${version}) through the form ${code(form)}` },
    }),
  ],
  [/^page (\S+) reads (\S+)$/, (page, resource) => ({ group: 'data', can: { who: `Page ${code(page)}`, does: `read ${code(resource)}` } })],
  [/^page (\S+) runs (\S+)$/, (page, command) => ({ group: 'data', can: { who: `Page ${code(page)}`, does: `run ${code(command)}` } })],
  [/^page (\S+) loads (\S+)$/, (page, loader) => ({ group: 'data', can: { who: `Page ${code(page)}`, does: `load ${code(loader)}` } })],
  [/^page (\S+) public$/, (page) => ({ group: 'public', can: { who: 'Anyone', does: `open the page ${code(page)}` } })],
  [/^egress connect (\S+)$/, (origin) => ({ group: 'environment', can: { who: "The App's pages", does: `connect to ${origin}` } })],
  [/^egress images (\S+)$/, (origin) => ({ group: 'environment', can: { who: "The App's pages", does: `load images from ${origin}` } })],
  [/^env (\S+) secret$/, (name) => ({ group: 'environment', can: { who: 'The definition', does: `read the secret ${code(name)}` } })],
  [/^env (\S+)$/, (name) => ({ group: 'environment', can: { who: 'The definition', does: `read ${code(name)}` } })],
  [/^api version (\S+)$/, (version) => ({ group: 'api', text: `The API is version ${version}.`, setting: 'api version' })],
  [
    /^api public-spec (\S+)$/,
    (spec) => ({
      group: 'api',
      text: spec === 'true' ? 'The API spec is public.' : 'The API spec is private.',
      setting: 'api public-spec',
    }),
  ],
  [/^api role (\S+)$/, (role) => ({ group: 'api', can: { who: `API tokens with role ${code(role)}`, does: 'call the API' } })],
  [
    /^api resource (\S+) (create|update|delete)$/,
    (name, verb) => ({ group: 'api', can: { who: 'The API', does: `${verb} ${code(name)}` } }),
  ],
  [
    /^api resource (\S+) (\S+) (\S+)$/,
    (name, kind, value) => ({ group: 'api', can: { who: 'The API', does: `use ${kind} ${code(value)} of ${code(name)}` } }),
  ],
  [
    /^api view (\S+) definition .+$/,
    (name) => ({ group: 'api', text: `The API view ${code(name)} has its definition pinned.`, setting: `api view ${name} definition` }),
  ],
  [/^api view (\S+)$/, (name) => ({ group: 'api', can: { who: 'The API', does: `list ${code(name)}` } })],
  [/^api command (\S+) target .+$/, (command) => ({ group: 'api', can: { who: 'The API', does: `run ${code(command)}` } })],
  [/^api event (\S+)$/, (name) => ({ group: 'api', can: { who: 'The API', does: `stream ${code(name)}` } })],
];

/** A flag or experiment grant's JSON key, as words: "toggle, edit in production for growth". */
function capability(entry: string): string {
  try {
    const value = JSON.parse(entry) as { actions?: string[]; environments?: string[]; owners?: string[]; ids?: string[] };
    const list = (items: readonly string[] | undefined) => (items?.length ? items.join(', ') : 'any');
    return `(${list(value.actions)}) in ${list(value.environments)} for ${list(value.owners)}${value.ids ? `: ${value.ids.map(code).join(', ')}` : ''}`;
  } catch {
    return entry;
  }
}

function read(fact: string): Read {
  for (const [pattern, sentence] of RULES) {
    const match = pattern.exec(fact);
    if (match) return sentence(...match.slice(1));
  }
  return { group: fact.startsWith('role ') ? `role:${fact.split(' ')[1]}` : 'data', text: fact };
}

const present = (reading: Read) => reading.text ?? `${reading.can!.who} can ${reading.can!.does}.`;

/** One fact line of a report, its sentence and who contributes it. */
const split = (line: string) => {
  const at = line.lastIndexOf(SEPARATOR);
  return at < 0
    ? { fact: line, by: [] as string[] }
    : {
        fact: line.slice(0, at),
        by: line
          .slice(at + SEPARATOR.length)
          .split(', ')
          .filter(Boolean),
      };
};
const facts = (report: string) =>
  report
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('contract ') && !line.startsWith('workflow '));

/** Every fact of a report (or lock), as a sentence. */
export function authoritySentences(report: string): AuthoritySentence[] {
  return facts(report).map((line) => {
    const { fact, by } = split(line),
      reading = read(fact);
    return Object.freeze({ fact, group: reading.group, text: present(reading), by: Object.freeze(by) });
  });
}

/**
 * What changed from one report to the next, by fact (who contributes is not a
 * change of authority). A setting that holds one value at a time is one
 * `changed` entry, not a removal and an addition.
 */
export function authorityChanges(before: string, after: string): AuthorityChange[] {
  const was = new Set(facts(before).map((line) => split(line).fact)),
    now = new Set(facts(after).map((line) => split(line).fact));
  const removed = [...was].filter((fact) => !now.has(fact)),
    added = [...now].filter((fact) => !was.has(fact));
  const changes: AuthorityChange[] = [];
  const paired = new Set<string>();
  for (const fact of added) {
    const reading = read(fact);
    const previous = reading.setting && removed.find((old) => !paired.has(old) && read(old).setting === reading.setting);
    if (previous) {
      paired.add(previous);
      changes.push(Object.freeze({ change: 'changed', group: reading.group, text: present(reading), was: present(read(previous)), fact }));
      continue;
    }
    changes.push(
      Object.freeze({
        change: 'added',
        group: reading.group,
        text: reading.can ? `${reading.can.who} can now ${reading.can.does}.` : `Now: ${present(reading)}`,
        fact,
      }),
    );
  }
  for (const fact of removed) {
    if (paired.has(fact)) continue;
    const reading = read(fact);
    changes.push(
      Object.freeze({
        change: 'removed',
        group: reading.group,
        text: reading.can ? `${reading.can.who} can no longer ${reading.can.does}.` : `No longer: ${present(reading)}`,
        fact,
      }),
    );
  }
  return changes;
}
