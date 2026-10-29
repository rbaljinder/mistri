/**
 * The machine-readable half of a BRIEF.md (skills/mistri/references/interview.md): one fenced block in the document,
 * ```` ```json mistri-brief ````, that `mistri new --brief <file>` reads. The prose around it is for the person who
 * approves the brief; this block is what a scaffold can act on, so it says only what the scaffold needs — the App's
 * name and look, its entities (fields, references, a status column's states), its roles and the commands it names.
 *
 * JSON rather than YAML because the engine ships no YAML reader and a brief is not worth a dependency. A field is
 * one string, `"<type> [<argument>] [!] [unique] [=<default>]"`, so an entity stays a few lines:
 * `"email": "email! unique"`, `"dog": "ref dog!"`, `"status": "choice requested|confirmed|done =requested"`.
 */
import { isAppIcon } from '@mistriwork/engine/shared/appIcons.js';

const FIELD_TYPES = ['text', 'longtext', 'email', 'phone', 'int', 'number', 'money', 'bool', 'date', 'datetime', 'ref', 'choice'] as const;
type FieldType = (typeof FIELD_TYPES)[number];

interface BriefField {
  /** The column: `dog` of `"dog": "ref dog"` is the column `dog_id`. */
  column: string;
  type: FieldType;
  required: boolean;
  unique: boolean;
  /** The entity a `ref` points at, or a `choice`'s values, in the order of its life cycle. */
  to?: string;
  values?: string[];
  default?: string;
}

interface BriefEntity {
  name: string;
  fields: BriefField[];
}

interface BriefRole {
  id: string;
  label: string;
  read: true | string[];
  write?: true | string[];
  commands: string[];
}

interface BriefCommand {
  id: string;
  /** The entity it acts on. */
  on: string;
  label: string;
  /** A query-language condition on that entity: where the button shows. */
  when?: string;
  /** Columns the stub writes, as the command's one change. */
  set: Record<string, string>;
  /** Refusals the person asked for, in the reader's words; the stub lists each as a TODO for the handler. */
  refuse: string[];
}

export interface Brief {
  name: string;
  theme: 'workshop' | 'lumen' | 'mono' | 'sage' | 'ledger';
  /** An icon name for the App's mark; absent means the scaffold picks one. */
  logo?: string;
  entities: BriefEntity[];
  roles: BriefRole[];
  commands: BriefCommand[];
}

/** A brief that cannot be acted on, with the sentence that says where. */
export class BriefRefusal extends Error {}

const NAME = /^[a-z][a-z0-9_]*$/;
const THEMES = ['workshop', 'lumen', 'mono', 'sage', 'ledger'] as const;
/** The words that begin a SQL statement's name or are reserved in the three engines: a table so named needs quoting nobody wrote. */
const RESERVED = new Set(['order', 'group', 'user', 'table', 'select', 'index', 'transaction', 'check', 'default', 'column', 'references']);

const BLOCK = /```json[ \t]+mistri-brief[ \t]*\r?\n([\s\S]*?)\r?\n```/;

/** Reads the brief's machine block out of a BRIEF.md (or the bare JSON of one). Throws BriefRefusal naming the problem. */
export function parseBrief(text: string): Brief {
  const found = BLOCK.exec(text);
  const source = found ? found[1] : text.trimStart().startsWith('{') ? text : undefined;
  if (source === undefined)
    throw new BriefRefusal(
      'no ```json mistri-brief block: copy the BRIEF.md template (skills/mistri/references/interview.md) and fill its machine block.',
    );
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    throw new BriefRefusal(`the mistri-brief block is not JSON: ${(error as Error).message}`);
  }
  return readBrief(raw);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BriefRefusal(`${where} must be an object.`);
  return value as Record<string, unknown>;
}

function readBrief(raw: unknown): Brief {
  const root = record(raw, 'the brief');
  const app = record(root.app, '"app"');
  const name = typeof app.name === 'string' ? app.name.trim() : '';
  if (!name || !/[a-z]/i.test(name)) throw new BriefRefusal('"app.name" needs a name with a letter in it.');
  const theme = (app.theme ?? 'workshop') as string;
  if (!(THEMES as readonly string[]).includes(theme))
    throw new BriefRefusal(`"app.theme" is "${theme}"; the built-in looks are ${THEMES.join(', ')}.`);
  if (app.logo !== undefined && !isAppIcon(app.logo))
    throw new BriefRefusal(
      `"app.logo" is "${String(app.logo)}", which is not one of the App icons (\`mistri docs app-dsl\` lists them; "heart", "users", "calendar"…).`,
    );

  const entitiesRaw = record(root.entities, '"entities"');
  const names = Object.keys(entitiesRaw);
  if (!names.length) throw new BriefRefusal('"entities" names no entity: an App is its things.');
  const entities: BriefEntity[] = names.map((entity) => {
    if (!NAME.test(entity) || RESERVED.has(entity))
      throw new BriefRefusal(
        `entity "${entity}": a table name is lowercase letters, digits and underscores, starting with a letter, and not a SQL word.`,
      );
    const fieldsRaw = record(entitiesRaw[entity], `entity "${entity}"`);
    const fields = Object.entries(fieldsRaw).map(([column, spec]) => readField(entity, column, spec, names));
    if (!fields.length) throw new BriefRefusal(`entity "${entity}" has no fields.`);
    return { name: entity, fields };
  });

  const roles = Object.entries(root.roles === undefined ? {} : record(root.roles, '"roles"')).map(([id, value]) => {
    const role = record(value, `role "${id}"`);
    if (!NAME.test(id)) throw new BriefRefusal(`role "${id}": an id is lowercase letters, digits and underscores.`);
    const reach = (key: 'read' | 'write'): true | string[] | undefined => {
      const given = role[key];
      if (given === undefined || given === false) return undefined;
      if (given === true) return true;
      if (!Array.isArray(given) || given.some((entity) => typeof entity !== 'string' || !names.includes(entity)))
        throw new BriefRefusal(`role "${id}" ${key}: true, or a list of entities from ${names.join(', ')}.`);
      return given as string[];
    };
    return {
      id,
      label: typeof role.label === 'string' && role.label.trim() ? role.label.trim() : words(id),
      read: reach('read') ?? [],
      ...(reach('write') ? { write: reach('write') } : {}),
      commands: Array.isArray(role.commands) ? role.commands.map(String) : [],
    } satisfies BriefRole;
  });

  const commandsRaw = root.commands === undefined ? [] : root.commands;
  if (!Array.isArray(commandsRaw)) throw new BriefRefusal('"commands" is a list.');
  const commands = commandsRaw.map((value, i): BriefCommand => {
    const command = record(value, `command ${i + 1}`);
    const id = String(command.id ?? '');
    if (!/^[a-z][A-Za-z0-9]*$/.test(id)) throw new BriefRefusal(`command ${i + 1}: "id" is a camelCase name such as confirmBooking.`);
    const on = String(command.on ?? '');
    const entity = entities.find((e) => e.name === on);
    if (!entity) throw new BriefRefusal(`command "${id}": "on" is an entity from ${names.join(', ')}.`);
    const set = command.set === undefined ? {} : record(command.set, `command "${id}" set`);
    for (const column of Object.keys(set))
      if (!entity.fields.some((f) => columnOf(f) === column))
        throw new BriefRefusal(`command "${id}": set names "${column}", which ${on} has no column for.`);
    return {
      id,
      on,
      label: typeof command.label === 'string' && command.label.trim() ? command.label.trim() : words(id),
      ...(typeof command.when === 'string' ? { when: command.when } : {}),
      set: Object.fromEntries(Object.entries(set).map(([k, v]) => [k, String(v)])),
      refuse: Array.isArray(command.refuse) ? command.refuse.map(String) : [],
    };
  });
  const ids = new Set(commands.map((c) => c.id));
  if (ids.size !== commands.length) throw new BriefRefusal('two commands share an id.');
  for (const role of roles)
    for (const id of role.commands)
      if (!ids.has(id)) throw new BriefRefusal(`role "${role.id}" runs "${id}", which "commands" does not define.`);

  return { name, theme: theme as Brief['theme'], ...(typeof app.logo === 'string' ? { logo: app.logo } : {}), entities, roles, commands };
}

function readField(entity: string, column: string, spec: unknown, entities: string[]): BriefField {
  const where = `${entity}.${column}`;
  if (!NAME.test(column) || column === 'id')
    throw new BriefRefusal(`${where}: a field name is lowercase letters, digits and underscores, and not "id" (every entity has one).`);
  if (typeof spec !== 'string') throw new BriefRefusal(`${where}: a field is one string such as "text!" or "ref dog!".`);
  const tokens = spec.trim().split(/\s+/);
  const head = tokens.shift() ?? '';
  const required = head.endsWith('!');
  const type = (required ? head.slice(0, -1) : head) as FieldType;
  if (!FIELD_TYPES.includes(type)) throw new BriefRefusal(`${where}: "${head}" is not a field type (${FIELD_TYPES.join(', ')}).`);
  const field: BriefField = { column, type, required, unique: false };
  if (type === 'ref' || type === 'choice') {
    const arg = tokens.shift() ?? '';
    const bang = arg.endsWith('!');
    if (bang) field.required = true;
    const body = bang ? arg.slice(0, -1) : arg;
    if (type === 'ref') {
      if (!entities.includes(body))
        throw new BriefRefusal(`${where}: ref names "${body}", which is not an entity (${entities.join(', ')}).`);
      field.to = body;
    } else {
      const values = body.split('|').filter(Boolean);
      if (values.length < 2 || values.some((v) => !/^[a-z][a-z0-9_]*$/.test(v)))
        throw new BriefRefusal(`${where}: choice lists two or more values, lowercase, joined by |, such as "choice open|done".`);
      field.values = values;
    }
  }
  for (const token of tokens) {
    if (token === '!') field.required = true;
    else if (token === 'unique') field.unique = true;
    else if (token.startsWith('=') && token.length > 1) field.default = token.slice(1);
    else throw new BriefRefusal(`${where}: "${token}" is not a modifier (!, unique, =<default>).`);
  }
  if (field.default !== undefined && field.values && !field.values.includes(field.default))
    throw new BriefRefusal(`${where}: the default "${field.default}" is not one of ${field.values.join(', ')}.`);
  return field;
}

/** The column a field makes: a reference is `<name>_id`. */
export const columnOf = (field: BriefField): string => (field.type === 'ref' ? `${field.column}_id` : field.column);

const words = (id: string): string => {
  const spaced = id.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

const quote = (text: string): string => `'${text.replace(/'/g, "''")}'`;

function columnSql(field: BriefField): string {
  const column = columnOf(field);
  const notNull = field.required ? ' NOT NULL' : '';
  const unique = field.unique ? ' UNIQUE' : '';
  switch (field.type) {
    case 'ref':
      return `${column} INTEGER${notNull} REFERENCES ${field.to}(id)`;
    case 'choice': {
      /* A choice that starts somewhere is never empty: a status with no value is a state the life cycle does not draw. */
      const initial = field.default ?? (field.required ? field.values![0] : undefined);
      return `${column} TEXT${initial ? ' NOT NULL' : ''}${initial ? ` DEFAULT ${quote(initial)}` : ''} CHECK (${column} IN (${field.values!.map(quote).join(', ')}))`;
    }
    case 'bool':
      return `${column} BOOLEAN NOT NULL DEFAULT ${field.default === 'true' || field.default === '1' ? 1 : 0} CHECK (${column} IN (0, 1))`;
    case 'int':
      return `${column} INTEGER${notNull}${unique}${field.default !== undefined ? ` DEFAULT ${Number(field.default)}` : ''}`;
    case 'number':
      return `${column} REAL${notNull}${unique}${field.default !== undefined ? ` DEFAULT ${Number(field.default)}` : ''}`;
    case 'money':
      return `${column} NUMERIC(10, 2)${notNull}${field.default !== undefined ? ` DEFAULT ${Number(field.default)}` : ''}`;
    case 'date':
      return `${column} DATE${notNull}`;
    case 'datetime':
      return `${column} DATETIME${notNull}`;
    default:
      return `${column} TEXT${notNull}${unique}${field.default !== undefined ? ` DEFAULT ${quote(field.default)}` : ''}`;
  }
}

/** The schema the brief's entities make, in an order a reference can be created in (a table before those that point at it). */
export function schemaSql(brief: Brief): string {
  const ordered: BriefEntity[] = [];
  const placing = new Set<string>();
  const place = (entity: BriefEntity) => {
    if (ordered.includes(entity) || placing.has(entity.name)) return;
    placing.add(entity.name);
    for (const field of entity.fields) {
      const target = brief.entities.find((e) => e.name === field.to);
      if (target && target !== entity) place(target);
    }
    ordered.push(entity);
  };
  brief.entities.forEach(place);
  const tables = ordered.map(
    (entity) =>
      `CREATE TABLE ${entity.name} (\n${['  id INTEGER PRIMARY KEY', ...entity.fields.map((f) => `  ${columnSql(f)}`)].join(',\n')}\n);`,
  );
  /* A record page lists what points at it by the referencing column, and `mistri check` asks for an index there. */
  const indexes = ordered.flatMap((entity) =>
    entity.fields
      .filter((f) => f.type === 'ref')
      .map((f) => `CREATE INDEX ${entity.name}_${columnOf(f)} ON ${entity.name}(${columnOf(f)});`),
  );
  return `-- The schema this App wants, from BRIEF.md. Change it here, then write the migration that gets a database there.\n${[...tables, ...(indexes.length ? [indexes.join('\n')] : [])].join('\n\n')}\n`;
}

/** commands.ts: one stub per command the brief names, each a working change that the person's rules still have to refine. */
export function commandsModule(brief: Brief, connection: string): string {
  const stubs = brief.commands.map((command) => {
    const update = Object.entries(command.set)
      .map(([column, value]) => `${column}: ${/^-?\d+(\.\d+)?$/.test(value) ? value : quote(value)}`)
      .join(', ');
    const todo = command.refuse.map((rule) => `    // TODO refuse(${JSON.stringify(rule)}) when the rule holds.`);
    return [
      `export const ${command.id} = defineCommand({`,
      `  source: home,`,
      `  target: '${command.on}',`,
      ...(command.when ? [`  when: ${JSON.stringify(command.when)},`] : []),
      `  output: shape({ message: text({ max: 200 }) }),`,
      `  async handle({ db, record }) {`,
      ...todo,
      ...(update ? [`    await db.${command.on}.update(record, { ${update} });`] : []),
      `    return { message: ${JSON.stringify(`${command.label}: done.`)} };`,
      `  },`,
      `});`,
    ].join('\n');
  });
  const names = brief.commands.map((c) => c.id).join(', ');
  return [
    `// The business rules the brief named, as commands. Each is a working stub: it makes its one change, and its TODO`,
    `// lines are the refusals the brief asked for, to write where the rule can be read from the record. Server-only.`,
    `import { defineCommand, defineCommands, defineSource, shape, text } from '@mistriwork/mistri/commands';`,
    `import type { Rows } from './mistri-schema.d.ts';`,
    '',
    `const home = defineSource<Rows>('${connection}');`,
    '',
    stubs.join('\n\n'),
    '',
    `export default defineCommands({ ${names} });`,
    '',
  ].join('\n');
}
