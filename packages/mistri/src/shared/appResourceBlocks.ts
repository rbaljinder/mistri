/**
 * The data half of the root: `connection`, `sources` and one block per
 * logical resource (`resources.<name>`). Every resource-indexed fact — the
 * physical binding, the ceiling, the column ceiling, display, validation —
 * lives in the block, beside the facts that
 * used to hide in navigation: the New form, the actions, the captions and
 * the default page. The block is keyed by the logical name: bare for the
 * default source (or the single connection), `source.name` for a secondary
 * source. That dot is the only meaning a dot has in a resource slot.
 *
 * Normalised, not lowered: `AppDef.resources` keeps one ResourceDef per
 * block under the authored key (physical binding, source, ceiling and
 * column ceiling, display, validation, labels, New form, actions, page),
 * and `sources` carries its default. appAuthGrants.ts grants within the
 * ceilings; the views that show the resource read its captions and narrow
 * its actions by label (appViews.ts).
 *
 * A view shows the App's declared resources: every table a list or a
 * dashboard section names has a block here (checkDeclaredResource). A
 * record page's related lists are the access ceiling's to govern, not this.
 */
import { authoredValue } from '@mistriwork/engine/shared/autoValues.js';
import { SET_EXPRESSION, setExpression } from './appStamps.js';
import { isComponentDecl, parseComponentDecl, parseInputs, commandInputAt } from '@mistriwork/engine/shared/appComponents.js';
import {
  DISPLAY_FORMATS,
  FILE_MAX_BYTES_CEILING,
  LATER,
  type AppAction,
  type AppAuditDef,
  type AppComputed,
  type AppConsumes,
  type AppRollup,
  type AppSegment,
  type AppDisplayRule,
  type SeriesColor,
  type AppFileBucket,
  type AppFileDef,
  type AppForm,
  type AppTagsDef,
  type AppSourceBinding,
  type ResourceDef,
  type AppAvatarPhoto,
  homeSourceOf,
  qualifyResource,
  RESOURCE_CLONES,
} from './appModel.js';
import {
  DISPLAY_TONES,
  RESERVED_NAMES,
  allowKeys,
  isRecord,
  plainRecord,
  humanName,
  type AppNoun,
} from '@mistriwork/engine/shared/model.js';
import { parseIcon, type AppIconName } from '@mistriwork/engine/shared/appIcons.js';
import { isRegisteredCommand, parseCommandReference, registeredCommand } from './command.js';
import { machineActions, parseMachine } from './appMachine.js';
import { parseResourceAt } from './appAt.js';
import { ROLLUP_FNS, type RollupFn } from '@mistriwork/engine/shared/rollups.js';
import { COMPUTED_TYPES } from '@mistriwork/engine/shared/computed.js';
import { pluralOf } from '@mistriwork/engine/shared/appNoun.js';
import { mentionLabelColumns } from '@mistriwork/engine/shared/mentionLabel.js';
import { AppProblems, problemsOf } from './appProblems.js';
import { AUTHORED_FORM_KEYS, parseAppForm, parseFormRules } from './formRules.js';
import { parseFieldAccess } from './appAuthGrants.js';
import { unknownKey } from '@mistriwork/engine/shared/suggest.js';
import { parseImportDef } from './appImport.js';
import { parseNotify } from './appNotify.js';
import { parseTextRules } from '@mistriwork/engine/shared/textRules.js';
import { parseDefined } from '@mistriwork/engine/shared/definedFields.js';
import { parseFlows } from './appFlows.js';
import { andQuery, splitClauseTail } from '@mistriwork/engine/shared/query.js';
import { segmentBookFromRaw, type SegmentBook } from './appSegments.js';
import { parseCaption } from '@mistriwork/engine/shared/appMessages.js';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const RESOURCE_BLOCK_KEYS = [
  'physical',
  'access',
  'delete',
  'favorite',
  'fields',
  'hidden',
  'references',
  'display',
  'types',
  'inputs',
  'validation',
  'text',
  'defined',
  'flows',
  'labels',
  'recordLabel',
  'form',
  'actions',
  'machine',
  'at',
  'file',
  'tags',
  'search',
  'page',
  'view',
  'address',
  'slug',
  'noun',
  'rollups',
  'computed',
  'audit',
  'settings',
  'import',
  'notify',
  'segments',
  'consumes',
  'restocks',
] as const;

/** What a resource slot needs to know to judge a dotted name, and what a page over a resource is called when it says nothing. */
export interface SourceScope {
  secondary: ReadonlySet<string>;
  defaultSource?: string;
  /** What the sources' own `resources` bring in: named tables as logical
      names, and the sources that bring in every table (judged at load). */
  implicit?: { named: readonly string[]; all: ReadonlySet<string> };
  /** Each resource's word for one record, by logical name, read leniently: parseDataBlocks judges it. */
  nouns?: Readonly<Record<string, string>>;
  /** Each resource's segments' labels, read leniently: a page names segments apart from the resources it is parsed beside. */
  segments?: SegmentBook;
}

/** The data half as parsed: the connection or the sources, and every resource under its logical name. */
export interface ParsedData extends SourceScope {
  connection?: string;
  sources?: Record<string, AppSourceBinding>;
  resources?: Record<string, ResourceDef>;
  unions?: import('./appUnions.js').AppUnion[];
}

/**
 * A view's table must be a declared resource. A block may be empty
 * (`{}`): declaring the name is what brings the table into the App.
 */
export function checkDeclaredResource(name: string, at: string, data: ParsedData): void {
  if (data.resources && Object.hasOwn(data.resources, name)) return;
  if (data.unions?.some((union) => union.name === name)) return;
  /* A source that says `resources: 'all'` declares every table it has: which
     ones exist is the catalog's to say, so a view naming one it lacks is
     reported where views resolve, not here. */
  const dot = name.indexOf('.');
  const source = dot < 0 ? data.defaultSource : name.slice(0, dot);
  if (
    source !== undefined &&
    data.implicit?.all.has(source) &&
    (dot < 0 || !name.slice(dot + 1).includes('.')) &&
    IDENTIFIER.test(dot < 0 ? name : name.slice(dot + 1))
  ) {
    // Named, it is declared: the implicit `{}` block every reader of a view's resource finds.
    (data.resources ??= {})[name] = { source };
    return;
  }
  const key = IDENTIFIER.test(name) ? name : `'${name}'`;
  throw new Error(
    `${at} names "${name}", which no resource block declares; a view shows the App's declared resources. ` +
      `Add resources: { ${key}: {} }, with a "physical" table id if the database names it differently` +
      (data.sources ? ', or list the table in its source\'s "resources".' : '.'),
  );
}

/**
 * A resource slot takes a logical name: bare, or `source.name` for a
 * declared, non-default source. Any other dot — an engine schema like
 * `public.work_order` — is refused with the binding that says it.
 */
export function checkResourceSlot(name: string, at: string, scope: SourceScope): void {
  const dot = name.indexOf('.');
  if (dot < 0) return;
  const prefix = name.slice(0, dot);
  const rest = name.slice(dot + 1);
  if (scope.secondary.has(prefix) && rest && !rest.includes('.')) return;
  const which = prefix === scope.defaultSource ? 'the default source, whose resources stay bare' : 'not a declared, non-default source';
  throw new Error(
    `${at} names "${name}": a dot in a resource name always qualifies it by source, and "${prefix}" is ${which}. ` +
      `Name the resource ("${rest}"), and bind it if needed: resources: { ${rest}: { physical: '${name}' } }.`,
  );
}

/** The declared sources and the resources' nouns, read leniently for a location that only needs the slot rule and a page's default label. */
export function sourceScopeOf(raw: unknown): SourceScope {
  const blocks = isRecord(raw) && isRecord(raw.resources) ? raw.resources : {};
  const said = Object.entries(blocks).flatMap(([name, block]): Array<[string, string]> => {
    const noun = isRecord(block) ? block.noun : undefined;
    const one = typeof noun === 'string' ? noun : isRecord(noun) && typeof noun.one === 'string' ? noun.one : undefined;
    return one?.trim() ? [[name, one.trim()]] : [];
  });
  const nouns = { ...(said.length ? { nouns: Object.fromEntries(said) } : {}), segments: segmentBookFromRaw(raw) };
  const sources = isRecord(raw) && isRecord(raw.sources) ? raw.sources : undefined;
  if (!sources) return { secondary: new Set(), ...nouns };
  const names = Object.keys(sources);
  const flag = (name: string) => (isRecord(sources[name]) ? (sources[name] as Record<string, unknown>).default : undefined);
  const defaultSource = names.length === 1 ? (flag(names[0]) === false ? undefined : names[0]) : names.find((name) => flag(name) === true);
  return { secondary: new Set(names.filter((name) => name !== defaultSource)), ...(defaultSource ? { defaultSource } : {}), ...nouns };
}

export function parseDataBlocks(a: Record<string, unknown>, where: string): ParsedData {
  if (a.connection !== undefined && typeof a.connection !== 'string') throw new Error(`${where} has a "connection" that is not a string.`);
  /* A root `connection` is the App's one source, named for it: `connection: 'tick'` is read as `sources: { tick:
     { connection: 'tick' } }`, so commands, their journal and event store, and the API's generic writes run on an
     App bound by `connection` as they do on one bound by `sources`. A connection whose name is not an identifier
     ('loaner-desk') has no source name to give; that App names its source in `sources` to run commands. */
  const named = typeof a.connection === 'string' && a.sources === undefined ? a.connection.trim() : undefined;
  const scope = parseSources(
    named !== undefined && IDENTIFIER.test(named) && !RESERVED_NAMES.has(named)
      ? { ...a, connection: undefined, sources: { [named]: { connection: named } } }
      : a,
    where,
  );
  const data: ParsedData = {
    ...scope.scope,
    ...(a.connection === undefined ? {} : { connection: a.connection as string }),
    ...(scope.sources ? { sources: scope.sources, connection: scope.sources[homeSourceOf(scope)!].connection } : {}),
  };
  if (a.resources === undefined) return withImplicitResources(data);
  const blocks = plainRecord(a.resources, `${where}: "resources"`, 'an object of resource blocks keyed by logical name');
  const resources: Record<string, ResourceDef> = {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(blocks)) {
    try {
      const at = `${where}: resources "${key}"`;
      const dot = key.indexOf('.');
      const bare = dot < 0 ? key : key.slice(dot + 1);
      if (dot >= 0) checkResourceSlot(key, at, data);
      if (!IDENTIFIER.test(bare) || RESERVED_NAMES.has(bare)) {
        throw new Error(`${at} needs a logical name: an identifier, bare for the default source or "source.name" for a secondary one.`);
      }
      const raw = plainRecord(
        value,
        at,
        'an object. A resource block is { physical?, access?, delete?, favorite?, fields?, hidden?, references?, display?, types?, validation?, text?, defined?, labels?, recordLabel?, form?, actions?, machine?, file?, tags?, search?, page?, view?, address?, slug?, noun?, rollups?, computed?, segments?, consumes?, restocks?, audit?, settings?, import?, notify? }',
      );
      allowKeys(raw, [...RESOURCE_BLOCK_KEYS, 'owner', 'clone', 'live'], at);
      if (dot < 0 && data.sources && !data.defaultSource) {
        throw new Error(
          `${at} is a bare name, and no source says "default: true", so every resource is named "source.${key}". ` +
            `Name its source (${Object.keys(data.sources)
              .map((name) => `'${name}.${key}'`)
              .join(', ')}).`,
        );
      }
      const source = dot < 0 ? data.defaultSource : key.slice(0, dot);
      const resource: ResourceDef = source ? { source } : {};
      // Checked against `auth.rows` and the platform realm once the App is whole (appTenancy.ts).
      if (raw.owner !== undefined) {
        if (raw.owner !== 'tenant' && raw.owner !== 'global' && raw.owner !== 'platform') {
          throw new Error(`${at} has an "owner" of "${String(raw.owner)}". Use "tenant", "global" or "platform".`);
        }
        resource.owner = raw.owner;
      }
      // Checked against the owner once the App is whole (appTenancy.ts); the catalog at startup (tenantClone.ts).
      if (raw.clone !== undefined) {
        if (!(RESOURCE_CLONES as readonly unknown[]).includes(raw.clone)) {
          throw new Error(
            `${at} has a "clone" of "${String(raw.clone)}". Use "config" (a clone always copies its rows) or "sample" (only when it asks for samples).`,
          );
        }
        resource.clone = raw.clone as ResourceDef['clone'];
      }
      /* One way per thing: the App opts in to live sync with its own `live: true`, and a resource opts out. */
      if (raw.live !== undefined) {
        if (raw.live !== false)
          throw new Error(
            `${at} has a "live" of ${JSON.stringify(raw.live)}. A resource only leaves live sync, with live: false; the App joins it with live: true at its top.`,
          );
        resource.live = false;
      }
      if (raw.physical !== undefined) {
        if (typeof raw.physical !== 'string' || !raw.physical.trim()) throw new Error(`${at} has a "physical" that is not a table id.`);
        resource.physical = raw.physical.trim();
      }
      /* A resource reads unless it says it writes: there is no 'read' to write. */
      if (raw.access !== undefined) {
        if (raw.access !== 'write')
          throw new Error(
            `${at} has an "access" of "${String(raw.access)}". A resource reads by default; say "write" for one the App writes, or leave it out.`,
          );
        resource.access = raw.access;
      }
      /* Opt-in: true, or false, which is the same as leaving it out. */
      for (const flag of ['delete', 'favorite'] as const) {
        if (raw[flag] === undefined) continue;
        if (typeof raw[flag] !== 'boolean') throw new Error(`${at} has a "${flag}" that is not true or false.`);
        if (raw[flag]) resource[flag] = true;
      }
      /* A settings record: the resource holds one row (a company profile, the
         payroll settings), opened from the reader's settings — the account menu
         — under these words, not from a list. */
      if (raw.settings !== undefined) {
        if (typeof raw.settings !== 'string' || !raw.settings.trim() || raw.settings.trim().length > 60) {
          throw new Error(
            `${at} has a "settings" that is not the words the settings menu says for it, like 'Company profile' (1 to 60 characters).`,
          );
        }
        resource.settings = raw.settings.trim();
      }
      if (raw.search !== undefined) {
        const declared = plainRecord(raw.search, `${at}, "search"`, 'an object { connection, fields }');
        allowKeys(declared, ['connection', 'fields'], `${at}, "search"`);
        if (typeof declared.connection !== 'string' || !declared.connection.trim()) {
          throw new Error(`${at}, "search" needs a "connection": the name of the search provider's connection.`);
        }
        const fields = declared.fields;
        if (
          !Array.isArray(fields) ||
          !fields.length ||
          fields.some(
            (field) =>
              typeof field !== 'string' ||
              !field.trim() ||
              field
                .trim()
                .split('.')
                .some((part) => !part),
          )
        ) {
          throw new Error(
            `${at}, "search" needs "fields": the columns the index holds, at least one, each a column of this resource ` +
              "or one a reference of it points at ('requester.name').",
          );
        }
        const named = fields.map((field) => (field as string).trim());
        if (new Set(named).size !== named.length) throw new Error(`${at}, "search" names a field twice.`);
        resource.search = { connection: declared.connection.trim(), fields: named };
      }
      if (resource.delete && resource.access !== 'write') {
        throw new Error(`${at} has "delete: true" and no access 'write'; deleting a record needs the resource's access 'write'.`);
      }
      if (raw.fields !== undefined) {
        /* The column ceiling is read exactly as a role's field grant is:
           data properties only, dense lists of names, write within read. */
        const fields = parseFieldAccess({ [key]: raw.fields }, `${at}, "fields"`)[key];
        if (resource.access !== 'write' && fields.write?.length) {
          throw new Error(`${at} has "fields.write" and no access 'write'; a column written needs the resource's access 'write'.`);
        }
        resource.fields = fields;
      }
      if (raw.hidden !== undefined) {
        const hidden = raw.hidden;
        if (
          !Array.isArray(hidden) ||
          !hidden.length ||
          hidden.some((column) => typeof column !== 'string' || !IDENTIFIER.test(column.trim()))
        ) {
          throw new Error(`${at} has a "hidden" that is not a list of the resource's own column names, like hidden: ['password_hash'].`);
        }
        const named = hidden.map((column) => (column as string).trim());
        if (new Set(named).size !== named.length) throw new Error(`${at}, "hidden" names a column twice.`);
        /* The search index holds its own copy of what it is given, beyond
           any catalog the server cuts. */
        const indexed = resource.search?.fields.find((field) => named.includes(field));
        if (indexed)
          throw new Error(
            `${at}, "search" indexes "${indexed}", which "hidden" keeps from every reader: the index would hold its values. Drop it from search.fields.`,
          );
        resource.hidden = named;
      }
      if (raw.references !== undefined) resource.references = parseReferences(raw.references, at, data);
      if (raw.display !== undefined) {
        if (!isRecord(raw.display)) throw new Error(`${at} has a "display" that is not an object of column rules.`);
        resource.display = Object.fromEntries(
          Object.entries(raw.display).map(([column, rule]) => {
            const here = `${at}, display "${column}"`;
            if (!column.trim() || column.includes('.')) {
              throw new Error(`${here}: display is keyed by the resource's own column inside its block, never by a dotted table.column.`);
            }
            return [column, parseDisplayRule(rule, here)];
          }),
        );
      }
      if (raw.types !== undefined) {
        const shape = `${at} has a "types" that is not an object of the resource's own TEXT column → 'date' or 'datetime', like types: { due_on: 'date' }.`;
        if (!isRecord(raw.types) || !Object.keys(raw.types).length) throw new Error(shape);
        for (const [column, kind] of Object.entries(raw.types)) {
          if (!IDENTIFIER.test(column) || (kind !== 'date' && kind !== 'datetime')) throw new Error(shape);
        }
        resource.types = { ...raw.types } as Record<string, 'date' | 'datetime'>;
      }
      /* A component standing in a column's control, in the resource's edit and New forms. */
      const inputs = parseInputs(raw.inputs, at);
      if (inputs) {
        const dotted = Object.keys(inputs).find((column) => column.includes('.'));
        if (dotted) throw new Error(`${at}, inputs "${dotted}": an input is keyed by the resource's own column.`);
        resource.inputs = inputs;
      }
      if (raw.validation !== undefined) resource.validation = parseFormRules(raw.validation, `${at}, validation`);
      if (raw.text !== undefined) resource.text = parseTextRules(raw.text, at);
      if (raw.defined !== undefined) resource.defined = parseDefined(raw.defined, at);
      if (raw.flows !== undefined) resource.flows = parseFlows(raw.flows, at);
      if (raw.labels !== undefined) Object.assign(resource, parseLabels(raw.labels, `${at}, "labels"`));
      if (raw.recordLabel !== undefined) {
        if (typeof raw.recordLabel !== 'string' || !raw.recordLabel.trim()) {
          throw new Error(`${at} has a "recordLabel" that is not a non-empty label path.`);
        }
        resource.recordLabel = raw.recordLabel.trim();
      }
      if (raw.form !== undefined) resource.form = parseForm(raw.form, at);
      if (raw.actions !== undefined) {
        const actions = parseActions(raw.actions, at);
        const seen = new Set<string>();
        for (const action of actions) {
          if (seen.has(action.label))
            throw new Error(
              `${at} has two actions labelled "${action.label}" ("${actions.find((other) => other.label === action.label)!.id}" and "${action.id}"): two buttons with one word on a record read as one.`,
            );
          seen.add(action.label);
        }
        /* An empty object declares no actions, as an absent one does. */
        if (actions.length) resource.actions = actions;
      }
      /* Timers at an instant the record keeps: the resource's, whatever moves the record (appAt.ts). */
      if (raw.at !== undefined) resource.at = parseResourceAt(raw.at, at, isRegisteredCommand);
      if (raw.machine !== undefined) {
        if (resource.access !== 'write')
          throw new Error(`${at} has a "machine" and no access 'write'; a record that moves needs the resource's access 'write'.`);
        const machine = parseMachine(raw.machine, at, isRegisteredCommand);
        /* The machine's verbs are the record's actions for its column, in the
           graph's order and before the others; the others may not move it. */
        for (const action of resource.actions ?? []) {
          if (action.set && Object.hasOwn(action.set, machine.column)) {
            throw new Error(
              `${at}: action "${action.label}" sets "${machine.column}", which the machine moves. Make it a verb of the state it leaves.`,
            );
          }
          if (action.command && machine.edges.some((edge) => edge.command === action.command!.id)) {
            throw new Error(`${at}: action "${action.label}" runs "${action.command.id}", a verb of the machine, which offers it already.`);
          }
        }
        /* A verb that is another record's command — receiving a purchase
           order's line moves the order — or a form's — submitting the
           application moves its draft on — is an edge of this graph that the
           other record's button or the form walks, so it is not a button here. */
        const columnDisplay = isRecord(raw.display) ? (raw.display as Record<string, unknown>)[machine.column] : undefined;
        const words = isRecord(columnDisplay) && isRecord(columnDisplay.values) ? columnDisplay.values : {};
        const buttons = machineActions(machine, words).filter((verb) => {
          const entry = verb.command === undefined ? undefined : registeredCommand(verb.command);
          return !entry || (entry.targets !== 'none' && entry.target === key);
        });
        const derived = parseActions(Object.fromEntries(buttons.map(({ id, ...action }) => [id, action])), `${at}, "machine"`, true);
        const merged = [...derived, ...(resource.actions ?? [])];
        const labels = new Set<string>();
        const ids = new Set<string>();
        for (const action of merged) {
          if (labels.has(action.label))
            throw new Error(
              `${at} has two actions labelled "${action.label}" (a verb of the machine among them). Give one a label of its own.`,
            );
          if (ids.has(action.id))
            throw new Error(`${at} has two actions named "${action.id}" (a verb of the machine among them). Give one a name of its own.`);
          ids.add(action.id);
          labels.add(action.label);
        }
        resource.machine = machine;
        resource.actions = merged;
      }
      if (raw.file !== undefined) {
        const declared = plainRecord(
          raw.file,
          `${at}, "file"`,
          'an object { content, name, type?, size?, thumbnail?, maxBytes?, object?, hash?, storage?, bucket? }',
        );
        allowKeys(
          declared,
          ['content', 'name', 'type', 'size', 'thumbnail', 'maxBytes', 'object', 'hash', 'storage', 'bucket'],
          `${at}, "file"`,
        );
        const column = (key: 'content' | 'name' | 'type' | 'size' | 'thumbnail' | 'object' | 'hash', required: boolean) => {
          const value = declared[key];
          if (value === undefined && !required) return undefined;
          if (typeof value !== 'string' || !value.trim() || value.includes('.'))
            throw new Error(`${at}, "file" "${key}" must name a column of the resource.`);
          return value.trim();
        };
        const file: AppFileDef = { content: column('content', true)!, name: column('name', true)! };
        const type = column('type', false);
        const size = column('size', false);
        if (type) file.type = type;
        if (size) file.size = size;
        const thumbnail = column('thumbnail', false);
        if (thumbnail) file.thumbnail = thumbnail;
        if (declared.maxBytes !== undefined) {
          if (
            typeof declared.maxBytes !== 'number' ||
            !Number.isInteger(declared.maxBytes) ||
            declared.maxBytes < 1 ||
            declared.maxBytes > FILE_MAX_BYTES_CEILING
          ) {
            throw new Error(`${at}, "file" "maxBytes" must be a whole number of bytes from 1 to ${FILE_MAX_BYTES_CEILING} (25 MB).`);
          }
          file.maxBytes = declared.maxBytes;
        }
        const object = column('object', false);
        if (object) file.object = object;
        const hash = column('hash', false);
        if (hash) file.hash = hash;
        Object.assign(file, parseFileStorage(declared, at));
        const named = [file.content, file.name, file.type, file.size, file.thumbnail, file.object, file.hash].filter(Boolean);
        if (new Set(named).size !== named.length)
          throw new Error(
            `${at}, "file" names one column for two things; the bytes, the name, the type, the size, the thumbnail, the object and the hash are separate columns.`,
          );
        resource.file = file;
      }
      if (raw.tags !== undefined) {
        const declared = plainRecord(raw.tags, `${at}, "tags"`, 'an object { through, to, toneOf?, add?, remove? }');
        allowKeys(declared, ['through', 'to', 'toneOf', 'add', 'remove'], `${at}, "tags"`, {
          tone: 'is now "toneOf": the column of the tags table holding each tag\'s tone',
        });
        const named = (key: 'through' | 'to' | 'toneOf', what: string) => {
          const value = declared[key];
          if (value === undefined && key === 'toneOf') return undefined;
          if (typeof value !== 'string' || !value.trim() || (key === 'toneOf' && value.includes('.')))
            throw new Error(`${at}, "tags" "${key}" must name ${what}.`);
          return value.trim();
        };
        const tags: AppTagsDef = { through: named('through', 'the link table')!, to: named('to', 'the table of tags')! };
        const toneOf = named('toneOf', 'a column of the tags table');
        if (toneOf) tags.toneOf = toneOf;
        if (tags.through === tags.to) throw new Error(`${at}, "tags": the link table and the table of tags are two tables.`);
        /* Tagging through the App's own commands (G58): each runs on the record, told the tag's key. */
        if ((declared.add === undefined) !== (declared.remove === undefined))
          throw new Error(
            `${at}, "tags" names ${declared.add === undefined ? 'remove' : 'add'} alone; a picker that puts tags on takes them off.`,
          );
        for (const verb of ['add', 'remove'] as const) {
          if (declared[verb] === undefined) continue;
          const command = parseCommandReference(declared[verb], `${at}, "tags" "${verb}"`);
          if (command.target !== key || command.targets === 'many')
            throw new Error(
              `${at}, "tags" "${verb}" names "${command.id}", which acts on ${command.target}; it must act on one ${key} record.`,
            );
          if (!command.input.some((field) => field.name === 'tag'))
            throw new Error(`${at}, "tags" "${verb}" names "${command.id}", which takes no "tag" input: it is told the tag's key.`);
          tags[verb] = command;
        }
        resource.tags = tags;
      }
      if (raw.page !== undefined) {
        if (typeof raw.page !== 'string' || !raw.page.trim()) throw new Error(`${at} has a "page" that is not a page id.`);
        resource.page = raw.page.trim();
      }
      /* How its records are addressed (appAddress.ts): judged against the views
         and the catalog once the App is whole — a view the resource names must
         list it, a natural key must be NOT NULL and unique in the database. */
      if (raw.view !== undefined) {
        if (typeof raw.view !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(raw.view))
          throw new Error(`${at} has a "view" that is not a view key.`);
        resource.view = raw.view;
      }
      if (raw.address !== undefined) {
        if (typeof raw.address !== 'string' || !raw.address.trim())
          throw new Error(`${at} has an "address" that is not a column: the natural key its records are addressed by.`);
        resource.address = raw.address.trim();
        if (resource.hidden?.includes(resource.address)) {
          throw new Error(
            `${at} has an "address" of "${resource.address}", which "hidden" keeps from every reader; a record's address is in every link to it.`,
          );
        }
      }
      if (raw.slug !== undefined) {
        if (typeof raw.slug !== 'boolean')
          throw new Error(`${at}: "slug" must be true (the record's name after its id on public pages) or false.`);
        if (raw.slug) resource.slug = true;
      }
      if (raw.noun !== undefined) resource.noun = parseNoun(raw.noun, `${at}, "noun"`);
      if (raw.rollups !== undefined) {
        const rollups = parseRollups(raw.rollups, `${at}, "rollups"`);
        if (Object.keys(rollups).length) resource.rollups = rollups;
      }
      if (raw.computed !== undefined) {
        const computed = parseComputedColumns(raw.computed, `${at}, "computed"`);
        if (Object.keys(computed).length) resource.computed = computed;
      }
      /* What the support write trail keeps of these rows. A marked column is
         recorded as a keyed hash instead of its value, so a session's changes
         are still auditable without the audit becoming a second copy of the
         data. Declared here, next to the ceiling, because it is a fact about
         the resource, not about one writer. */
      if (raw.audit !== undefined) {
        const here = `${at}, "audit"`;
        const declared = plainRecord(raw.audit, here, 'an object { redact }');
        allowKeys(declared, ['redact'], here);
        resource.audit = parseAudit(declared.redact, here);
      }
      /* Rows from a CSV file (appImport.ts): opt-in, and a plain import writes
         records, so it needs the ceiling that allows it. */
      if (raw.import !== undefined) {
        const def = parseImportDef(raw.import, at);
        if (def && !def.command && resource.access !== 'write') {
          throw new Error(
            `${at} has "import" and no access 'write'; importing creates records, which needs the resource's access 'write'.`,
          );
        }
        if (def) resource.import = def;
      }
      /* Named queries: their conditions and names are judged against the catalog once the App is whole
         (appSegments.ts), beside the columns, rollups and machine groups a name must not take. */
      if (raw.segments !== undefined) {
        const segments = parseSegments(raw.segments, `${at}, "segments"`);
        if (Object.keys(segments).length) resource.segments = segments;
      }
      /* The balances a row uses up (appConsumes.ts): shape here, the columns against the catalog. */
      if (raw.consumes !== undefined) resource.consumes = parseConsumes(raw.consumes, `${at}, "consumes"`);
      if (raw.restocks !== undefined) resource.restocks = parseConsumes(raw.restocks, `${at}, "restocks"`);
      /* Who a write tells: judged against the catalog once the App is whole (appNotifyRules). */
      if (raw.notify !== undefined) {
        const notify = parseNotify(raw.notify, `${at}, "notify"`);
        if (notify.length) resource.notify = notify;
      }
      resources[key] = resource;
    } catch (err) {
      // Each block is judged on its own, so one run names every block's refusal (appProblems.ts).
      problems.push(...problemsOf(err));
    }
  }
  withImplicitResources(data, resources);
  /* A reference names a declared resource, as a view does: the block is what brings the table into the App. */
  for (const [key, resource] of Object.entries(resources)) {
    for (const [column, reference] of Object.entries(resource.references ?? {})) {
      try {
        checkDeclaredResource(reference.to, `${where}: resources "${key}", references "${column}"`, { ...data, resources });
      } catch (err) {
        problems.push(...problemsOf(err));
      }
    }
  }
  if (problems.length) throw new AppProblems(problems);
  data.resources = resources;
  return data;
}

/**
 * What a refused resource still says about the names it serves — its rollups, computed columns and segments —
 * each read on its own and left out where it does not parse. Only the schema types read it (app.ts dataHalfOf), so
 * a refusal elsewhere in the resource does not type its pages against a table that has lost those names.
 */
export function declaredNamesOf(raw: unknown): {
  rollups?: Record<string, AppRollup>;
  computed?: Record<string, AppComputed>;
  segments?: Record<string, AppSegment>;
} {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const block = raw as Record<string, unknown>;
  const read = <T>(key: string, parse: (value: unknown, here: string) => T): T | undefined => {
    if (block[key] === undefined) return undefined;
    try {
      return parse(block[key], key);
    } catch {
      return undefined;
    }
  };
  const rollups = read('rollups', parseRollups);
  const computed = read('computed', parseComputedColumns);
  const segments = read('segments', parseSegments);
  return { ...(rollups ? { rollups } : {}), ...(computed ? { computed } : {}), ...(segments ? { segments } : {}) };
}

/**
 * A resource's computed columns, by name: shape only. Whether the expression
 * parses, what its columns are and what it comes to are the catalog's to
 * judge (appComputedRules), like a rollup's names.
 */
function parseComputedColumns(raw: unknown, here: string): Record<string, AppComputed> {
  const declared = plainRecord(
    raw,
    here,
    "an object of name to computed column, such as { is_overdue: computed.boolean('due_on < today and not completed') }",
  );
  const out: Record<string, AppComputed> = {};
  for (const [name, value] of Object.entries(declared)) {
    const at = `${here} "${name}"`;
    if (!IDENTIFIER.test(name) || RESERVED_NAMES.has(name)) {
      throw new Error(`${at}: a computed column's name is read like a column's, so it is an identifier (letters, digits, underscores).`);
    }
    const column = plainRecord(value, at, "a computed column: computed.boolean('…'), computed.number('…') or computed.date('…')");
    allowKeys(column, ['type', 'value'], at);
    if (!(COMPUTED_TYPES as readonly unknown[]).includes(column.type)) {
      throw new Error(`${at} has a "type" of "${String(column.type)}". Use ${COMPUTED_TYPES.map((type) => `"${type}"`).join(', ')}.`);
    }
    if (typeof column.value !== 'string' || !column.value.trim() || column.value.length > 500) {
      throw new Error(`${at} needs a "value": its expression, at most 500 characters, like 'due_on < today and not completed'.`);
    }
    out[name] = { type: column.type as AppComputed['type'], value: column.value.trim() };
  }
  return out;
}

/**
 * A resource's segments, by name: shape only. A string is the short form of
 * `{ query }`; the label is the key said as words unless it says its own.
 * Whether the conditions read, and whether a name is taken, is the catalog's
 * to judge (appSegments.ts).
 */
function parseSegments(raw: unknown, here: string): Record<string, AppSegment> {
  const declared = plainRecord(
    raw,
    here,
    "an object of name to segment, such as { open: 'status is open', overdue: { query: 'due_on < today', label: 'Overdue' } }",
  );
  const out: Record<string, AppSegment> = {};
  for (const [name, value] of Object.entries(declared)) {
    const at = `${here} "${name}"`;
    if (!IDENTIFIER.test(name) || RESERVED_NAMES.has(name)) {
      throw new Error(`${at}: a segment's name is a word of the query language, so it is an identifier (letters, digits, underscores).`);
    }
    const segment =
      typeof value === 'string'
        ? { query: value }
        : plainRecord(value, at, "a segment: its conditions ('status is open'), or { query, label }");
    allowKeys(segment, ['query', 'label'], at);
    if (typeof segment.query !== 'string' || !segment.query.trim() || segment.query.length > 500) {
      throw new Error(`${at} needs a "query": its conditions, at most 500 characters, like 'due_on < today and status is open'.`);
    }
    /* Conditions only: a tab over it says its own order (`{ segment, sort }`), and a segment is written inline. */
    if (splitClauseTail(segment.query).tail)
      throw new Error(
        `${at} has a "query" with a clause ("${splitClauseTail(segment.query).tail}"). A segment holds conditions only; a tab over it says its "sort".`,
      );
    out[name] = {
      query: segment.query.trim(),
      label: segment.label === undefined ? humanName(name) : parseCaption(segment.label, `${at}, "label"`),
    };
  }
  return out;
}

/**
 * A resource's `consumes` or `restocks`: one rule or a list of them, shape only. Its path
 * is one reference and the parent's column (`part_id.on_hand`); whether those
 * are a reference and a number, and whether `by` is one, is the catalog's to
 * judge (appConsumes.ts).
 */
function parseConsumes(raw: unknown, here: string): AppConsumes[] {
  const list = Array.isArray(raw) ? raw : [raw];
  if (!list.length)
    throw new Error(`${here} is an empty list: name one rule, { column: 'part_id.on_hand', by: 'quantity' }, or leave it out.`);
  return list.map((entry, i) => {
    const at = Array.isArray(raw) ? `${here}, rule ${i + 1}` : here;
    const rule = plainRecord(entry, at, "a rule: { column: 'part_id.on_hand', by?: 'quantity', message?: '…', floor?: false }");
    allowKeys(rule, ['column', 'by', 'message', 'floor'], at, { refuse: 'is now "message", as a form rule\'s is' });
    const column = typeof rule.column === 'string' ? rule.column.trim() : '';
    const hops = column.split('.');
    if (hops.length !== 2 || hops.some((hop) => !IDENTIFIER.test(hop))) {
      throw new Error(
        `${at} has a "column" of ${JSON.stringify(rule.column ?? null)}: it is one reference of this resource and a number column of the record it names, like "part_id.on_hand".`,
      );
    }
    if (rule.by !== undefined && (typeof rule.by !== 'string' || !IDENTIFIER.test(rule.by.trim())))
      throw new Error(`${at} has a "by" that is not one of this resource's own number columns, like "quantity".`);
    if (rule.message !== undefined && (typeof rule.message !== 'string' || !rule.message.trim()))
      throw new Error(`${at} has a "message" that is not text: the message a refused write says, like 'Only {part_id.on_hand} left'.`);
    if (rule.floor !== undefined && rule.floor !== false)
      throw new Error(`${at} has a "floor" of ${JSON.stringify(rule.floor)}: it is false, to let the balance go below zero, or left out.`);
    return {
      reference: hops[0],
      balance: hops[1],
      ...(typeof rule.by === 'string' ? { by: rule.by.trim() } : {}),
      ...(typeof rule.message === 'string' ? { message: rule.message.trim() } : {}),
      ...(rule.floor === false ? { floor: false as const } : {}),
    };
  });
}

/**
 * A resource's rollups, by name: shape only. Whether `from` points here,
 * whether the column exists and sums, and whether the query parses are
 * the catalog's to judge (appRollupRules), like every other name a block says.
 */
function parseRollups(raw: unknown, here: string): Record<string, AppRollup> {
  const declared = plainRecord(
    raw,
    here,
    "an object of name to rollup, such as { lines: count('order_line'), total: sum('order_line', 'amount') }",
  );
  const rollups: Record<string, AppRollup> = {};
  for (const [name, value] of Object.entries(declared)) {
    const at = `${here} "${name}"`;
    if (!IDENTIFIER.test(name) || RESERVED_NAMES.has(name)) {
      throw new Error(`${at}: a rollup's name is read like a column's, so it is an identifier (letters, digits, underscores).`);
    }
    const rollup = plainRecord(
      value,
      at,
      'a rollup: count(from, opts?), sum(from, column, opts?), min(from, column, opts?), max(from, column, opts?) or latest(from, column, opts?)',
    );
    allowKeys(rollup, ['fn', 'from', 'column', 'whose', 'query', 'segment', 'sort'], at, {
      by: 'is now "sort": the column whose greatest value is the newest row',
    });
    if (!(ROLLUP_FNS as readonly unknown[]).includes(rollup.fn)) {
      throw new Error(`${at} has a "fn" of "${String(rollup.fn)}". Use ${ROLLUP_FNS.map((fn) => `"${fn}"`).join(', ')}.`);
    }
    const fn = rollup.fn as RollupFn;
    if (typeof rollup.from !== 'string' || !rollup.from.trim())
      throw new Error(`${at} needs a "from": the resource whose rows point at this one.`);
    if (fn === 'count' && rollup.column !== undefined) {
      throw new Error(`${at} counts rows and names a "column"; a count reads none. Drop it, or use sum, min or max.`);
    }
    if (fn !== 'count' && (typeof rollup.column !== 'string' || !rollup.column.trim() || rollup.column.includes('.'))) {
      throw new Error(`${at} is a ${fn} and needs a "column": one of ${String(rollup.from)}'s own columns.`);
    }
    /* Which row is the latest is a latest's alone to say; every other rollup reads all of them. */
    if (rollup.sort !== undefined && fn !== 'latest')
      throw new Error(`${at} is a ${fn} and names a "sort"; only a latest orders its rows.`);
    if (rollup.sort !== undefined && (typeof rollup.sort !== 'string' || !rollup.sort.trim() || rollup.sort.includes('.'))) {
      throw new Error(`${at} has a "sort" that is not one of ${String(rollup.from)}'s own columns.`);
    }
    for (const key of ['whose', 'query', 'segment'] as const) {
      if (rollup[key] !== undefined && (typeof rollup[key] !== 'string' || !(rollup[key] as string).trim())) {
        throw new Error(`${at} has a "${key}" that is not a non-empty string.`);
      }
    }
    /* One reference, or two: `task_id.project_id` reads a project's hours
       through its tasks, as a metric's `whose` does. A third hop is a
       report, and a rollup is a number in a row. */
    if (typeof rollup.whose === 'string' && rollup.whose.trim().split('.').length > 2) {
      throw new Error(
        `${at} has a "whose" of "${rollup.whose}": a rollup reads through one or two references — a column of ${String(rollup.from)} that points here, or one that points at a record that does, like "task_id.project_id".`,
      );
    }
    rollups[name] = {
      fn,
      from: rollup.from.trim(),
      ...(typeof rollup.column === 'string' ? { column: rollup.column.trim() } : {}),
      ...(typeof rollup.whose === 'string' ? { whose: rollup.whose.trim() } : {}),
      /* A segment is its word in the rows' query: the catalog reads it as `from`'s, and refuses one it lacks. */
      ...(typeof rollup.query === 'string' || typeof rollup.segment === 'string'
        ? { query: andQuery(rollup.segment as string | undefined, rollup.query as string | undefined) }
        : {}),
      ...(typeof rollup.sort === 'string' ? { by: rollup.sort.trim() } : {}),
    };
  }
  return rollups;
}

/** Which of a resource's columns the support write trail keeps as a keyed hash
 * rather than as their value: every one (`'values'`), or the named ones. */
function parseAudit(redact: unknown, here: string): AppAuditDef {
  if (redact === 'values') return { redact: 'values' };
  if (
    !Array.isArray(redact) ||
    !redact.length ||
    redact.some((column) => typeof column !== 'string' || !column.trim() || column.includes('.'))
  ) {
    throw new Error(
      `${here} needs a "redact": 'values' for every column, or a list of this resource's own columns to keep as a keyed hash.`,
    );
  }
  const named = redact.map((column) => (column as string).trim());
  if (new Set(named).size !== named.length) throw new Error(`${here} names a redacted column twice.`);
  return { redact: named };
}

function parseSources(a: Record<string, unknown>, where: string): { scope: SourceScope; sources?: Record<string, AppSourceBinding> } {
  if (a.sources === undefined) return { scope: { secondary: new Set() } };
  if (a.connection !== undefined) {
    throw new Error(`${where}: "sources" cannot be combined with root "connection". Name each connection inside "sources".`);
  }
  if (!isRecord(a.sources) || !Object.keys(a.sources).length) {
    throw new Error(`${where}: "sources" must be a non-empty map of names to connection bindings.`);
  }
  /* Connection → the schema each of its sources is scoped to ('' for none).
     One connection backs several sources only when each sees a schema of its
     own: a source that saw the whole connection would see its neighbors'
     tables, and a table two sources both hold has no one owner to attribute
     a write, a journal entry or a history line to. */
  const scopes = new Map<string, string[]>();
  const defaults: string[] = [];
  const sources: Record<string, AppSourceBinding> = {};
  for (const [name, raw] of Object.entries(a.sources)) {
    const at = `${where}: source "${name}"`;
    if (!IDENTIFIER.test(name) || RESERVED_NAMES.has(name)) {
      throw new Error(`${at} needs a non-reserved identifier containing only letters, digits and underscores.`);
    }
    if (!isRecord(raw)) throw new Error(`${at} must be a connection binding object.`);
    allowKeys(raw, ['connection', 'default', 'realm', 'schema', 'resources'], at);
    if (typeof raw.connection !== 'string' || !raw.connection.trim()) throw new Error(`${at} needs a non-empty "connection" reference.`);
    const connection = raw.connection.trim();
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(connection)) {
      throw new Error(`${at}: "connection" must reference server configuration, not contain a connection URL.`);
    }
    if (raw.schema !== undefined && (typeof raw.schema !== 'string' || !raw.schema.trim() || raw.schema.includes('.'))) {
      throw new Error(`${at} has a "schema" that is not a schema name, such as 'catalog'.`);
    }
    const schema = typeof raw.schema === 'string' ? raw.schema.trim() : undefined;
    const beside = scopes.get(connection) ?? [];
    if (beside.includes(schema ?? '')) {
      throw new Error(
        schema
          ? `${at} repeats connection "${connection}" and schema "${schema}", which another source already sees.`
          : `${at} repeats connection "${connection}", which another source already uses. Give each source on one connection its own "schema".`,
      );
    }
    if (beside.length && (!schema || beside.includes(''))) {
      throw new Error(
        `${at} shares connection "${connection}" with another source, so each of them needs a "schema" of its own: ` +
          "a source without one sees every schema of the connection, its neighbors' tables too.",
      );
    }
    scopes.set(connection, [...beside, schema ?? '']);
    if (raw.default !== undefined) {
      if (typeof raw.default !== 'boolean') throw new Error(`${at} has a "default" that is not true or false.`);
      if (raw.default) defaults.push(name);
    }
    // Whether the App may have one is judged once the App is whole (appTenancy.ts).
    if (raw.realm !== undefined && raw.realm !== 'platform') {
      throw new Error(
        `${at} has a "realm" of "${String(raw.realm)}". A source says only "realm": "platform": a source the platform realm alone reads.`,
      );
    }
    if (raw.resources !== undefined && raw.realm === 'platform') {
      throw new Error(
        `${at} is "realm": "platform", so each of its resources is a block of its own ({ owner: 'platform' }); it takes no "resources".`,
      );
    }
    sources[name] = {
      connection,
      default: raw.default === true,
      ...(raw.realm === 'platform' ? { realm: 'platform' as const } : {}),
      ...(schema ? { schema } : {}),
      ...(raw.resources !== undefined ? { resources: parseSourceResources(raw.resources, at) } : {}),
    };
  }
  if (defaults.length > 1) {
    throw new Error(
      `${where}: at most one source says "default: true" — the source whose resources stay bare. ${defaults.join(' and ')} both do.`,
    );
  }
  /* A source that stands alone is the default unless it says `default: false`:
     an App keeps its `source.name` names through the removal of every other
     source by saying so, and beside others no source is made the default. */
  const names = Object.keys(sources);
  const alone =
    names.length === 1 &&
    (a.sources as Record<string, Record<string, unknown>>)[names[0]].default !== false &&
    sources[names[0]].realm !== 'platform';
  if (alone) sources[names[0]].default = true;
  // Bare names are the App's own source's; a platform-only source's are always qualified.
  const defaultSource = alone ? names[0] : defaults[0];
  if (defaultSource && sources[defaultSource].realm === 'platform') {
    throw new Error(
      `${where}: source "${defaultSource}" is "realm": "platform", so it is never the default. ` +
        'Declare the App\'s own source beside it with "default": true, or leave every source\'s resources named "source.table".',
    );
  }
  /* The tenant separation doctrine keeps the platform realm's data in a
     location of its own, never a schema beside the App's (tenantPlatformSource.ts). */
  for (const [name, source] of Object.entries(sources)) {
    if (source.realm !== 'platform') continue;
    const neighbor = Object.keys(sources).find((other) => other !== name && sources[other].connection === source.connection);
    if (neighbor)
      throw new Error(
        `${where}: source "${name}" is "realm": "platform" and shares connection "${source.connection}" with source "${neighbor}". ` +
          'A platform-only source is a database of its own; give it its own connection.',
      );
  }
  if (!names.some((name) => sources[name].realm !== 'platform')) {
    throw new Error(`${where}: every source is "realm": "platform". Declare the App's own source beside them.`);
  }
  return {
    scope: {
      secondary: new Set(names.filter((name) => name !== defaultSource)),
      ...(defaultSource ? { defaultSource } : {}),
      implicit: implicitSourceResources(sources, defaultSource),
    },
    sources,
  };
}

/** The empty blocks a source's `resources` list stands for, where the App wrote none: `{}` exactly, so they grant nothing. */
function withImplicitResources(data: ParsedData, resources: Record<string, ResourceDef> = {}): ParsedData {
  for (const name of data.implicit?.named ?? []) {
    if (Object.hasOwn(resources, name)) continue;
    const dot = name.indexOf('.');
    resources[name] = { source: dot < 0 ? data.defaultSource! : name.slice(0, dot) };
  }
  if (Object.keys(resources).length) data.resources = resources;
  return data;
}

/** `resources` on a source: 'all', or the local names of the tables it brings in without a block each. */
function parseSourceResources(raw: unknown, at: string): 'all' | string[] {
  if (raw === 'all') return 'all';
  if (
    !Array.isArray(raw) ||
    !raw.length ||
    raw.some((name) => typeof name !== 'string' || !IDENTIFIER.test(name.trim()) || RESERVED_NAMES.has(name.trim()))
  ) {
    throw new Error(`${at} has a "resources" that is neither 'all' nor a list of its tables' names, such as ['product', 'bin'].`);
  }
  const names = raw.map((name) => (name as string).trim());
  if (new Set(names).size !== names.length) throw new Error(`${at} names a table twice in "resources".`);
  return names;
}

/** What a source's `resources` brings in: the logical names a list declares, and the sources that bring in every table. */
function implicitSourceResources(sources: Record<string, AppSourceBinding>, defaultSource: string | undefined): SourceScope['implicit'] {
  const named: string[] = [];
  const all = new Set<string>();
  for (const [name, source] of Object.entries(sources)) {
    if (source.resources === 'all') all.add(name);
    else for (const local of source.resources ?? []) named.push(qualifyResource(defaultSource, name, local));
  }
  return { named, all };
}

/**
 * What one record is called, as it reads mid-sentence — "issue", "work order",
 * "API key" — its plural made by rule; or `{ one, many }` for a plural no rule
 * makes ("person", "people"). Said once, here, for every place that names a
 * record: New, a split's detail, a page and a list that name nothing else.
 */
function parseNoun(raw: unknown, at: string): AppNoun {
  const word = (value: unknown, key: string): string => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 60) {
      throw new Error(`${at}${key} is not a word of at most 60 characters, as it reads mid-sentence: "issue", "work order".`);
    }
    return value.trim();
  };
  if (typeof raw === 'string') {
    const one = word(raw, '');
    return { one, many: pluralOf(one) };
  }
  const declared = plainRecord(raw, at, 'a word, or { one, many } for a plural no rule makes');
  allowKeys(declared, ['one', 'many'], at);
  return { one: word(declared.one, ' "one"'), many: word(declared.many, ' "many"') };
}

function parseLabels(raw: unknown, at: string): Pick<ResourceDef, 'labels'> {
  if (!isRecord(raw)) throw new Error(`${at} must be an object of column (or label path) → caption.`);
  const labels: Record<string, string> = {};
  for (const [path, label] of Object.entries(raw)) {
    if (!path.trim() || path !== path.trim()) throw new Error(`${at} has a key that is not a column or a label path.`);
    if (typeof label !== 'string' || !label.trim() || label.trim().length > 120) {
      throw new Error(`${at} gives "${path}" a caption that is not text of at most 120 characters.`);
    }
    Object.defineProperty(labels, path, { value: label.trim(), enumerable: true, configurable: true, writable: true });
  }
  return { labels };
}

/** The faces a value may be set in: the look's data face, the interface face, the code face (a theme's words for them). */
const DISPLAY_FACES = ['data', 'ui', 'code'];
/** How one column's values dress. */
function parseDisplayRule(value: unknown, at: string): AppDisplayRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${at} is not an object.`);
  }
  /* A value renderer stands where a rule does: `display: { hours: hoursBar }`
     is `{ component: hoursBar }`, drawn by the author's module in an App. */
  if (isComponentDecl(value)) return { component: parseComponentDecl(value, at, 'value') };
  const r = value as Record<string, unknown>;
  /* One object per column, one key per concern: the figure's `format`
     (with its `currency` and `unit`), the words (`values`), the colour
     (`tone`), the mark (`icons`), a `bar`, a disc (`avatar`), a mask. */
  const takes = [
    'format',
    'currency',
    'minor',
    'unit',
    'tone',
    'bar',
    'avatar',
    'icons',
    'values',
    'subtitle',
    'component',
    'masked',
    'mentions',
    'images',
    'colors',
    'icon',
    'outOf',
    'ring',
    'slider',
    'scan',
    'signature',
    'face',
  ];
  for (const k of Object.keys(r)) {
    if (!takes.includes(k)) throw new Error(`${at} ${unknownKey(k, takes)}.`);
  }
  if (r.format !== undefined && !DISPLAY_FORMATS.includes(r.format as never)) {
    throw new Error(`${at} has a "format" of "${String(r.format)}". Use ${DISPLAY_FORMATS.join(', ')}.`);
  }
  const masked = r.masked === undefined ? undefined : parseMasked(r.masked, at);
  /* A value masked whole is a placeholder and nothing else: there is no figure, word or mark to dress. */
  if (masked === true) {
    const dressing = Object.keys(r).filter((key) => key !== 'masked' && key !== 'subtitle');
    if (dressing.length)
      throw new Error(
        `${at} has "masked: true", which draws a placeholder instead of the value; it takes no ${dressing.map((key) => `"${key}"`).join(', ')}.`,
      );
  }
  /* A unit is said after a figure, so it belongs to the formats that make one. */
  if (r.unit !== undefined) {
    if (typeof r.unit !== 'string' || !r.unit.trim() || r.unit.trim().length > 12 || /[\n<>]/.test(r.unit)) {
      throw new Error(`${at} has a "unit" that is not a short word of at most 12 characters, like "mi" or "/mo".`);
    }
    // With no format the column's number is the figure (a text value stays itself); another format makes no figure to follow.
    if (r.format !== undefined && r.format !== 'number' && r.format !== 'money')
      throw new Error(`${at} has "unit", which a number says after the figure: format "number", "money", or none on a numeric column.`);
  }
  /* A list of items is a text of lines: nothing about it is a number, a tone or a bar. */
  if (r.format === 'items' && ['currency', 'tone', 'bar', 'avatar', 'icons'].some((key) => r[key] !== undefined)) {
    throw new Error(`${at} has format "items", a text of one item per line; it takes no currency, tone, bar, avatar or icons.`);
  }
  /* A list of people is drawn as their discs: no figure, word, colour or mark of its own. */
  if (
    r.format === 'avatars' &&
    ['currency', 'unit', 'tone', 'bar', 'avatar', 'icons', 'values', 'colors', 'icon'].some((key) => r[key] !== undefined)
  ) {
    throw new Error(
      `${at} has format "avatars", a list of people drawn as their discs; it takes no currency, unit, tone, bar, avatar, icons, values, colors or icon.`,
    );
  }
  // Renamed before 1.0: the interface face is `ui`, as the theme says it (`fonts.ui`, a type role's `face: 'ui'`).
  if (r.face === 'sans') throw new Error(`${at} has a "face" of "sans", which is now "ui": the interface's reading face.`);
  if (r.face !== undefined && !DISPLAY_FACES.includes(r.face as never))
    throw new Error(`${at} has a "face" of "${String(r.face)}". Use ${DISPLAY_FACES.join(', ')}.`);
  /* A component draws the value in its own markup and face, and the platform's drawing it falls back on is not wrapped
     in one: a face beside it would apply to the fallback alone, so it is refused rather than half obeyed. */
  if (r.face !== undefined && r.component !== undefined)
    throw new Error(`${at} has "face", which a component sets itself; set the face in the component, or drop "component".`);
  const own = parseOwnDrawing(r, at);
  const colors = r.colors === undefined ? undefined : parseSeriesColors(r.colors, at);
  if (
    colors &&
    (r.bar !== undefined || ['money', 'percent', 'number', 'duration', 'relative', 'items', 'richText'].includes(r.format as string))
  )
    throw new Error(`${at} has "colors", which give a category's words their colors; a figure, a date or a text takes none.`);
  const icon = r.icon === undefined ? undefined : parseLeadIcon(r.icon, at);
  /* Formatted text is its own drawing: no figure, word, colour or mark dresses it. */
  if (
    r.format === 'richText' &&
    ['currency', 'unit', 'tone', 'bar', 'avatar', 'icons', 'values', 'masked'].some((key) => r[key] !== undefined)
  ) {
    throw new Error(`${at} has format "richText", formatted text; it takes no currency, unit, tone, bar, avatar, icons, values or mask.`);
  }
  if ((r.mentions !== undefined || r.images !== undefined) && r.format !== 'richText')
    throw new Error(`${at} has "${r.mentions !== undefined ? 'mentions' : 'images'}", which only format "richText" carries.`);
  let mentions: AppDisplayRule['mentions'];
  if (r.mentions !== undefined) {
    const m = r.mentions as Record<string, unknown>;
    const ident = (v: unknown) => typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_.]{0,127}$/.test(v);
    const shaped = (v: unknown, keys: string[]): v is Record<string, unknown> =>
      Boolean(v) &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      Object.keys(v as object).every((k) => keys.includes(k)) &&
      ident((v as Record<string, unknown>).from) &&
      ident((v as Record<string, unknown>).by) &&
      ((v as Record<string, unknown>).through === undefined || ident((v as Record<string, unknown>).through)) &&
      ((v as Record<string, unknown>).labelColumn === undefined || typeof (v as Record<string, unknown>).labelColumn === 'string');
    for (const said of [m, m?.groups as Record<string, unknown> | undefined])
      if (said && typeof said === 'object' && Object.hasOwn(said, 'label'))
        throw new Error(`${at} has "mentions" with "label", which is now "labelColumn": the column a person is shown by.`);
    if (!shaped(m, ['from', 'by', 'labelColumn', 'groups']))
      throw new Error(
        `${at} has "mentions" that is not { from, by, labelColumn?, groups? }: the resource of people, its handle column, ` +
          `the column shown or a template of them ('{first_name} {last_name}').`,
      );
    /* The label is a column or a record label template of the people's own columns (mentionLabel.ts). */
    for (const [where, label] of [
      ['mentions.labelColumn', m.labelColumn],
      ['mentions.groups.labelColumn', (m.groups as Record<string, unknown> | undefined)?.labelColumn],
    ] as const) {
      if (typeof label !== 'string') continue;
      const read = mentionLabelColumns(label);
      if ('problem' in read) throw new Error(`${at} has "${where}": ${read.problem}`);
      const bad = read.columns.find((column) => !ident(column));
      if (bad !== undefined) throw new Error(`${at} has "${where}" "${label}", and "${bad}" is not a column name.`);
    }
    if (m.groups !== undefined && !shaped(m.groups, ['from', 'by', 'labelColumn', 'through']))
      throw new Error(
        `${at} has "mentions.groups" that is not { from, by, labelColumn?, through? }: the resource of teams, its handle column, the column shown, ` +
          'and the resource of link rows that puts a person in a team (absent: the people resource references the team).',
      );
    const g = m.groups as Record<string, string> | undefined;
    mentions = {
      from: m.from as string,
      by: m.by as string,
      ...(m.labelColumn === undefined ? {} : { labelColumn: m.labelColumn as string }),
      ...(g
        ? {
            groups: {
              from: g.from,
              by: g.by,
              ...(g.labelColumn === undefined ? {} : { labelColumn: g.labelColumn }),
              ...(g.through === undefined ? {} : { through: g.through }),
            },
          }
        : {}),
    };
  }
  if (r.images !== undefined && (typeof r.images !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.]{0,127}$/.test(r.images)))
    throw new Error(`${at} has "images" that is not the name of a resource whose rows are files.`);
  /* A currency is a code, or the column each row keeps its own in: `currency: { column: 'currency_code' }`. */
  let currencyColumn: string | undefined;
  if (r.currency !== undefined) {
    const c = r.currency as Record<string, unknown>;
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      if (Object.keys(c).some((key) => key !== 'column') || typeof c.column !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.column))
        throw new Error(`${at} has a "currency" object that is not { column: '<a column of this resource holding the code>' }.`);
      currencyColumn = c.column;
    } else if (typeof r.currency !== 'string' || !/^[A-Za-z]{3}$/.test(r.currency)) {
      throw new Error(`${at} has a "currency" that is not a three-letter code like "USD", or { column: 'currency_code' }.`);
    }
    if (r.format !== 'money') throw new Error(`${at} has "currency", which only format "money" carries.`);
  }
  /* Minor units are money's: a count of cents is a figure only once it is said in its currency. */
  if (r.minor !== undefined) {
    if (r.minor !== true) throw new Error(`${at} has a "minor" that is not true; a money column of whole minor units says minor: true.`);
    if (r.format !== 'money')
      throw new Error(`${at} has "minor", which only format "money" carries: minor units are { format: 'money', minor: true }.`);
  }
  /* The bar's scale is its value: `bar: true` for a percent, which fills
     against 100, and `bar: 5` for any other number, filled against 5. */
  let max: number | undefined;
  if (r.bar !== undefined) {
    if (r.bar !== true && (typeof r.bar !== 'number' || !Number.isFinite(r.bar) || r.bar <= 0)) {
      throw new Error(`${at} has a "bar" that is not true (a percent, against 100) or the number that fills it, like bar: 5.`);
    }
    if (r.format === 'relative') throw new Error(`${at} has "bar" beside format "relative"; a date has no bar.`);
    if (r.bar === true && r.format !== 'percent')
      throw new Error(
        `${at} has "bar: true" with no scale: format "percent" draws against 100; for any other number, say the value that fills it — bar: 5.`,
      );
    if (typeof r.bar === 'number') {
      if (r.format === 'percent')
        throw new Error(`${at} has "bar: ${r.bar}" beside format "percent", which draws against 100; say bar: true.`);
      max = r.bar;
    }
  }
  const avatar =
    r.avatar === undefined || typeof r.avatar === 'boolean' ? (r.avatar as boolean | undefined) : parseAvatarPhoto(r.avatar, at);
  const icons = r.icons === undefined ? undefined : parseValueIcons(r.icons, at);
  /* A mark and a disc both lead the value; one value is not a person and a status at once. */
  if (icons && avatar) throw new Error(`${at} has "avatar" and "icons": a value leads with a person's disc or a mark, not both.`);
  if (icons && (r.bar !== undefined || r.format === 'money' || r.format === 'percent' || r.format === 'duration')) {
    throw new Error(`${at} has "icons", which mark a vocabulary's words; a figure (a bar, money, a percent, a duration) takes none.`);
  }
  /* Words for stored values: a figure is said by its format, so a word
     belongs to a vocabulary. A `tone` says every value of one as words; a
     `values` map says these in the author's words and every other one as
     words too, so a vocabulary never reads half in words and half in codes. */
  if (r.values !== undefined) {
    if (!r.values || typeof r.values !== 'object' || Array.isArray(r.values) || !Object.keys(r.values).length) {
      throw new Error(`${at} has "values" that are not an object of stored value → word, like { PUB: 'Published' }.`);
    }
    for (const [v, word] of Object.entries(r.values)) {
      if (typeof word !== 'string' || !word.trim() || word.trim().length > 80)
        throw new Error(`${at} gives "${v}" a word in "values" that is not text of at most 80 characters.`);
    }
  }
  if (
    r.values !== undefined &&
    (r.bar !== undefined || ['money', 'percent', 'number', 'duration', 'relative', 'items'].includes(r.format as string))
  ) {
    throw new Error(`${at} has "values", which say a vocabulary's words; a figure, a date or a list of items takes none.`);
  }
  if (r.subtitle !== undefined && (typeof r.subtitle !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.subtitle))) {
    throw new Error(`${at} has a "subtitle" that is not one of the resource's own columns.`);
  }
  if (r.tone !== undefined) {
    if (!r.tone || typeof r.tone !== 'object' || Array.isArray(r.tone)) {
      throw new Error(`${at} has a "tone" that is not an object of value → tone.`);
    }
    for (const [v, t] of Object.entries(r.tone)) {
      if (!DISPLAY_TONES.includes(t as never)) {
        throw new Error(`${at} gives "${v}" the tone "${String(t)}". Use ${DISPLAY_TONES.join(', ')}.`);
      }
      /* A key that starts like a comparison must BE one: ">= 90" is a
         threshold, ">= high" is a typo pretending to be a value. */
      if (/^[<>]/.test(v) && !/^(>=|<=|>|<)\s*-?\d+(\.\d+)?$/.test(v)) {
        throw new Error(`${at} has a tone key "${v}" that is not a comparison like ">= 90".`);
      }
    }
  }
  return {
    ...(r.format === undefined ? {} : { format: r.format as AppDisplayRule['format'] }),
    ...(r.currency === undefined || currencyColumn ? {} : { currency: (r.currency as string).toUpperCase() }),
    ...(currencyColumn ? { currencyColumn } : {}),
    ...(r.minor === true ? { minor: true as const } : {}),
    ...(r.unit === undefined ? {} : { unit: (r.unit as string).trim() }),
    ...(r.tone === undefined ? {} : { tone: r.tone as AppDisplayRule['tone'] }),
    ...(r.bar === undefined ? {} : { bar: true }),
    ...(max === undefined ? {} : { max }),
    ...(avatar === true ? { avatar: true as const } : avatar && typeof avatar === 'object' ? { avatar } : {}),
    ...(icons ? { icons } : {}),
    ...(r.values === undefined
      ? {}
      : { values: Object.fromEntries(Object.entries(r.values as Record<string, string>).map(([v, word]) => [v, word.trim()])) }),
    /* A tone keyed by stored values is a vocabulary: said as words without a
       second declaration. A threshold tone (">= 90") colours a figure, and a
       figure is said by its format. */
    ...(r.values !== undefined ||
    (r.tone !== undefined &&
      r.format === undefined &&
      r.bar === undefined &&
      !Object.keys(r.tone as object).some((key) => /^[<>]/.test(key)))
      ? { humanize: true as const }
      : {}),
    ...(r.subtitle === undefined ? {} : { subtitle: r.subtitle as string }),
    ...(colors ? { colors } : {}),
    ...(icon ? { icon } : {}),
    ...(r.component === undefined ? {} : { component: parseComponentDecl(r.component, `${at}, "component"`, 'value') }),
    ...(masked ? { masked } : {}),
    ...(mentions ? { mentions } : {}),
    ...(r.images === undefined ? {} : { images: r.images as string }),
    ...(r.face === undefined ? {} : { face: r.face as AppDisplayRule['face'] }),
    ...own,
  };
}

/* The formats that draw a value as a thing of its own — stars, a swatch, a clock time, a month, a year, a tree, a
   code — and the two figures' extras, a ring and a slider. Each is its own drawing: nothing else dresses it. */
const OWN_DRAWINGS = ['rating', 'color', 'time', 'month', 'year', 'json', 'qr'];
const DRESSINGS = ['currency', 'unit', 'tone', 'bar', 'avatar', 'icons', 'values', 'colors', 'icon'];
function parseOwnDrawing(r: Record<string, unknown>, at: string): Pick<AppDisplayRule, 'outOf' | 'ring' | 'slider' | 'scan' | 'signature'> {
  const format = r.format as string | undefined;
  if (format && OWN_DRAWINGS.includes(format)) {
    const extra = DRESSINGS.filter((key) => r[key] !== undefined && !(format === 'rating' && key === 'tone'));
    if (extra.length)
      throw new Error(
        `${at} has format "${format}", which draws the value its own way; it takes no ${extra.map((key) => `"${key}"`).join(', ')}.`,
      );
  }
  const out: Pick<AppDisplayRule, 'outOf' | 'ring' | 'slider' | 'scan' | 'signature'> = {};
  /* Two inputs of their own for a plain column: a code read by the camera into a text, and a signature drawn and
     kept as a picture in a file resource the column points at. Each is the whole of how the value is entered, so
     neither takes a format or a dressing. */
  for (const key of ['scan', 'signature'] as const) {
    if (r[key] === undefined) continue;
    if (r[key] !== true) throw new Error(`${at} has a "${key}" that is not true.`);
    const dressed = ['format', ...DRESSINGS, 'slider'].filter((other) => r[other] !== undefined);
    if (dressed.length)
      throw new Error(
        `${at} has "${key}", ${key === 'scan' ? "a text's camera input" : 'a signature pad'}; it takes no ${dressed.map((other) => `"${other}"`).join(', ')}.`,
      );
    out[key] = true;
  }
  if (out.scan && out.signature) throw new Error(`${at} has "scan" and "signature": a column is entered one way.`);
  if (r.outOf !== undefined) {
    if (format !== 'rating') throw new Error(`${at} has "outOf", the stars of a rating: add format: 'rating'.`);
    if (typeof r.outOf !== 'number' || !Number.isInteger(r.outOf) || r.outOf < 3 || r.outOf > 10)
      throw new Error(`${at} has an "outOf" that is not a whole number of stars from 3 to 10.`);
    out.outOf = r.outOf;
  }
  if (r.ring !== undefined) {
    if (r.ring !== true) throw new Error(`${at} has a "ring" that is not true.`);
    if (format !== 'percent') throw new Error(`${at} has "ring", a percent's circle: add format: 'percent'.`);
    if (r.bar !== undefined) throw new Error(`${at} has "ring" and "bar": a percent is drawn as one or the other.`);
    out.ring = true;
  }
  if (r.slider !== undefined) {
    const s = r.slider as Record<string, unknown>;
    const shape = `${at} has a "slider" that is not { min, max, step? }: the numbers its range runs between, like { min: 0, max: 10 }.`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(shape);
    for (const k of Object.keys(s))
      if (!['min', 'max', 'step'].includes(k)) throw new Error(`${at}, "slider" ${unknownKey(k, ['min', 'max', 'step'])}.`);
    const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
    if (!finite(s.min) || !finite(s.max) || (s.max as number) <= (s.min as number)) throw new Error(shape);
    if (s.step !== undefined && (!finite(s.step) || (s.step as number) <= 0 || (s.step as number) > (s.max as number) - (s.min as number)))
      throw new Error(`${at} has a "slider" "step" that is not a positive number inside its range.`);
    if (format !== undefined && format !== 'number' && format !== 'percent' && format !== 'money')
      throw new Error(`${at} has "slider", which moves a number: its format is "number", "percent", "money" or none.`);
    out.slider = { min: s.min as number, max: s.max as number, ...(s.step === undefined ? {} : { step: s.step as number }) };
  }
  return out;
}

/* The prefix is compared in the statement that names a record (viewLabels.ts)
   as well as in the browser, so it is held to what a quoted literal carries
   alike on every engine — printable, no backslash — and written into a served
   record-name template, whose braces and bar it cannot hold. */
function parseMasked(raw: unknown, at: string): true | { prefix: string } {
  if (raw === true) return true;
  const shape = `${at} has a "masked" that is not true (every value) or { prefix }, a short text the masked values start with, like { prefix: 'ENC:' }.`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(shape);
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== 'prefix') throw new Error(`${at}, "masked" ${unknownKey(k, ['prefix'])}.`);
  if (
    typeof o.prefix !== 'string' ||
    !o.prefix ||
    o.prefix.length > 16 ||
    /[\\{}|]/.test(o.prefix) ||
    [...o.prefix].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)
  )
    throw new Error(shape);
  return { prefix: o.prefix };
}

/** An avatar's photo: `{ from: 'member_avatar', whose: 'member_id', sort? }`, checked against the catalog at startup (app.ts). */
function parseAvatarPhoto(raw: unknown, at: string): AppAvatarPhoto {
  const here = `${at}, "avatar"`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${at} has an "avatar" that is not true, false or { from, whose } naming a file resource of photos.`);
  }
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (!['from', 'whose', 'sort'].includes(k)) throw new Error(`${here} ${unknownKey(k, ['from', 'whose', 'sort'])}.`);
  if (typeof o.from !== 'string' || !o.from.trim())
    throw new Error(`${here} needs "from": a resource whose rows are files, like "member_avatar".`);
  if (typeof o.whose !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(o.whose.trim())) {
    throw new Error(`${here} needs "whose": the column of "${o.from}" that names the record, like "member_id".`);
  }
  if (o.sort !== undefined && (typeof o.sort !== 'string' || !/^\s*[A-Za-z_][A-Za-z0-9_]*(\s+(asc|desc))?\s*$/i.test(o.sort))) {
    throw new Error(`${here}: "sort" is one column and an optional direction, like "position" or "added_at desc".`);
  }
  return {
    from: o.from.trim(),
    whose: o.whose.trim(),
    ...(typeof o.sort === 'string' ? { sort: o.sort.trim().replace(/\s+/g, ' ') } : {}),
  };
}

/** Value → App icon: `{ rush: 'fire', high: 'cell-signal-high' }`. */
/** A category's colors: value → one of the theme's eight chart colors, by place. */
function parseSeriesColors(raw: unknown, at: string): Record<string, SeriesColor> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length)
    throw new Error(`${at} has "colors" that are not an object of value → chart color 1 to 8, like { design: 1, research: 3 }.`);
  const out: Record<string, SeriesColor> = {};
  for (const [value, color] of Object.entries(raw as Record<string, unknown>)) {
    if (!value.trim()) throw new Error(`${at} has "colors" with a blank value.`);
    if (typeof color !== 'number' || !Number.isInteger(color) || color < 1 || color > 8)
      throw new Error(`${at} gives "${value}" the color ${JSON.stringify(color)}: a color is one of the theme's chart colors, 1 to 8.`);
    out[value] = color as SeriesColor;
  }
  return out;
}

/** The mark in a tinted square before a value: an App icon, or `{ mark, toneOf }` tinted by another column's tone. */
function parseLeadIcon(raw: unknown, at: string): { mark: AppIconName; toneOf?: string } {
  if (typeof raw === 'string') return { mark: parseIcon(raw, `${at}, "icon"`) };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error(`${at} has an "icon" that is not an App icon or { mark, toneOf }, like { mark: 'robot', toneOf: 'status' }.`);
  const o = raw as Record<string, unknown>;
  /* `toneOf` names a column; `tone` is a display rule's value → tone map everywhere else. */
  if (o.tone !== undefined) throw new Error(`${at}, "icon" has "tone", which is now "toneOf": the column whose tone tints the mark.`);
  for (const k of Object.keys(o))
    if (k !== 'mark' && k !== 'toneOf') throw new Error(`${at}, "icon" ${unknownKey(k, ['mark', 'toneOf'])}.`);
  if (o.toneOf !== undefined && (typeof o.toneOf !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(o.toneOf)))
    throw new Error(`${at} has an "icon" whose "toneOf" is not one of the resource's own columns.`);
  return { mark: parseIcon(o.mark, `${at}, "icon", "mark"`), ...(o.toneOf === undefined ? {} : { toneOf: o.toneOf as string }) };
}

function parseValueIcons(raw: unknown, at: string): Record<string, AppIconName> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length) {
    throw new Error(`${at} has "icons" that are not an object of value → App icon, like { high: 'cell-signal-high' }.`);
  }
  const out: Record<string, AppIconName> = {};
  for (const [value, icon] of Object.entries(raw as Record<string, unknown>)) {
    if (!value.trim()) throw new Error(`${at} has "icons" with a blank value.`);
    out[value] = parseIcon(icon, `${at}, "icons", "${value}"`);
  }
  return out;
}

/* A set expression as authored, `computed.date('today + 14 days')`: parsed
   here, its kind matching its constructor's; its column is judged with the
   catalog (appStamps.ts). */
function setExpressionValue(v: Record<string, unknown>, at: string): string {
  const keys = Object.keys(v);
  if (keys.length !== 2 || typeof v.value !== 'string' || !v.value.trim() || !(COMPUTED_TYPES as readonly unknown[]).includes(v.type)) {
    throw new Error(`${at} an object that is not computed.date('…'), computed.number('…') or computed.boolean('…').`);
  }
  const judged = setExpression(v.value.trim());
  if ('problem' in judged) throw new Error(`${at} ${judged.problem}`);
  if (judged.kind !== v.type)
    throw new Error(
      `${at} computed.${v.type}('${v.value.trim()}'), which comes to a ${judged.kind === 'boolean' ? 'yes-or-no' : judged.kind}: write computed.${judged.kind}('…').`,
    );
  return `${SET_EXPRESSION}${v.value.trim()}`;
}

const scalar = (v: unknown): v is string | number | boolean | null => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/* An action's id is what a header, a queue and a role name it by: a word a JS key needs no quotes for. */
const ACTION_ID = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * A resource's actions, keyed by id in the order they are drawn. The id is
 * the action's name everywhere else — a header's `primary`, a queue's
 * selector, a role's grant — so renaming a button's words renames nothing.
 */
function parseActions(raw: unknown, at: string, derived = false): AppAction[] {
  const declared = plainRecord(
    raw,
    `${at}, "actions"`,
    "an object of action id to action, like { complete: action('Complete', { set: { completed: true } }) }",
  );
  return Object.entries(declared).map(([id, entry]) => {
    const here = `${at}, action "${id}"`;
    if (!ACTION_ID.test(id) || RESERVED_NAMES.has(id)) {
      throw new Error(`${here}: an action's id is a word of letters, digits and underscores that starts with a letter, like "markLost".`);
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${here} is not an object.`);
    const a = entry as Record<string, unknown>;
    /* A command's button carries the command's own `when` (its registration says it once), so only a fixed update has one to write. */
    allowKeys(
      a,
      a.command !== undefined && !derived
        ? ['label', 'command', 'bulk', 'header', 'inputs', 'set', 'confirm', 'reason']
        : ['label', 'command', 'set', 'when', 'confirm', 'bulk', 'header', 'reason', 'inputs', ...(derived ? ['labels', 'move'] : [])],
      here,
      { enter: LATER.T8 },
    );
    if (typeof a.label !== 'string' || !a.label.trim()) throw new Error(`${here} has no "label".`);
    if (a.header !== undefined && typeof a.header !== 'boolean') throw new Error(`${here} has a "header" that is not true or false.`);
    /* Only the drawing reads it, so only `false` is carried: `true` is what every action already is. */
    const header = a.header === false ? { header: false } : {};
    if (a.command !== undefined) {
      if (Object.hasOwn(a, 'set')) throw new Error(`${here} cannot combine a command with set.`);
      if (Object.hasOwn(a, 'reason')) throw new Error(`${here} asks a reason, which a command collects through its own input.`);
      const command = parseCommandReference(a.command, here);
      /* A command that asks nothing runs on one click; `confirm` asks first. One with inputs asks them in its form,
         which is already the question, so a confirmation there would be asked twice. */
      if (a.confirm !== undefined && typeof a.confirm !== 'boolean') throw new Error(`${here} has a "confirm" that is not true or false.`);
      if (a.confirm === true && command.input.length)
        throw new Error(
          `${here} confirms, but its command "${command.id}" asks for input in its form, which is already the confirmation; leave "confirm" out.`,
        );
      if (a.bulk !== undefined && typeof a.bulk !== 'boolean') throw new Error(`${here} has a "bulk" that is not true or false.`);
      // A selection is one request only for a command built to name several
      // records in its envelope, receipt and audit; any other names one.
      if (a.bulk === true && command.targets !== 'many') {
        throw new Error(`${here} can offer "${command.id}" in bulk only when the command declares targets: 'many'.`);
      }
      /* A component standing in one of the command's own inputs, in its form. */
      const inputs = parseInputs(a.inputs, here, { paths: true });
      const unknown = inputs && Object.keys(inputs).find((name) => !commandInputAt(command.input, name));
      if (unknown) {
        throw new Error(
          `${here} names an input component for "${unknown}", which is not one of the command's inputs (${command.input.map((field) => field.name).join(', ') || 'it has none'}).`,
        );
      }
      /* A machine's verb is offered from the states that leave (the machine wrote that condition); any other button is offered where the command is. */
      if (derived && a.when !== undefined && (typeof a.when !== 'string' || !a.when.trim()))
        throw new Error(`${here} has a "when" that is not a condition.`);
      const when = derived && a.when !== undefined ? (a.when as string).trim() : registeredCommand(command.id)?.when;
      // A machine's verb said differently from different states (machineActions): carried as the machine wrote it.
      const labels = derived && Array.isArray(a.labels) ? (a.labels as Array<{ when: string; label: string }>) : undefined;
      const move = derived && isRecord(a.move) ? (a.move as { column: string; edges: Array<{ from: string; to: string }> }) : undefined;
      return {
        id,
        label: a.label.trim(),
        command,
        ...(when === undefined ? {} : { when }),
        ...(labels ? { labels } : {}),
        ...(move ? { move } : {}),
        ...(a.bulk === undefined ? {} : { bulk: a.bulk as boolean }),
        ...(a.confirm === true ? { confirm: true } : {}),
        ...header,
        ...(inputs ? { inputs } : {}),
      };
    }
    if (a.inputs !== undefined) throw new Error(`${here} names "inputs", which only a command's form draws; a fixed update asks nothing.`);
    if (!a.set || typeof a.set !== 'object' || Array.isArray(a.set) || !Object.keys(a.set).length) {
      throw new Error(
        `${here} has no "set" — the column → value it writes, like { "status": "working" } — and no "command": write it with action(label, { set }) or action(label, { command }).`,
      );
    }
    /* `now`, `today`, `me` and a constant expression are filled in as the
       server writes (appStamps.ts); the model carries an expression as its
       text after `=`, so a literal that starts with one is refused. */
    const set = Object.fromEntries(
      Object.entries(a.set as Record<string, unknown>).map(([k, v]) => {
        if (typeof v === 'string' && v.startsWith(SET_EXPRESSION)) {
          throw new Error(
            `${here} sets "${k}" to the text '${v}', which reads as an expression: write computed.date('…') ` +
              '(or .number, .boolean) for one, or another literal.',
          );
        }
        if (isRecord(v) && Object.hasOwn(v, 'value') && Object.hasOwn(v, 'type'))
          return [k, setExpressionValue(v, `${here} sets "${k}" to`)];
        return [k, authoredValue(v, `${here} sets "${k}", which`, ['now', 'today', 'me'])];
      }),
    );
    for (const [k, v] of Object.entries(set)) {
      if (!scalar(v))
        throw new Error(
          `${here} sets "${k}" to something that is not a string, number, boolean, null, now, today, me or computed.date('…').`,
        );
    }
    if (a.when !== undefined && (typeof a.when !== 'string' || !a.when.trim())) {
      throw new Error(`${here} has a "when" that is not a condition like "status = new".`);
    }
    if (a.confirm !== undefined && typeof a.confirm !== 'boolean') throw new Error(`${here} has a "confirm" that is not true or false.`);
    if (a.bulk !== undefined && typeof a.bulk !== 'boolean') throw new Error(`${here} has a "bulk" that is not true or false.`);
    if (a.reason !== undefined && (typeof a.reason !== 'string' || !a.reason.trim() || a.reason.includes('.'))) {
      throw new Error(`${here} has a "reason" that is not a column of the resource.`);
    }
    if (a.reason !== undefined && a.bulk === true)
      throw new Error(`${here} asks a reason and is offered in bulk; a reason belongs to one record, so drop one.`);
    return {
      id,
      label: a.label.trim(),
      set: set as NonNullable<AppAction['set']>,
      ...(a.when === undefined ? {} : { when: (a.when as string).trim() }),
      ...(a.confirm === undefined ? {} : { confirm: a.confirm as boolean }),
      ...(a.bulk === undefined ? {} : { bulk: a.bulk as boolean }),
      ...header,
      ...(a.reason === undefined ? {} : { reason: (a.reason as string).trim() }),
    };
  });
}

function parseForm(raw: unknown, at: string): AppForm {
  // Keep the manifest's established error for an unknown form key while the
  // shared parser owns strict capture and the richer semantic fields.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${at} has a "form" that is not an object.`);
  }
  /* Repeatable children are parsed and unit-tested behind the shared
     parser, and are not part of the public surface: named here so the key
     gets the reason rather than the "no such key" list. */
  allowKeys(raw as Record<string, unknown>, AUTHORED_FORM_KEYS, `${at}, "form"`, {
    children: 'is not part of an authored form',
    derived: "is said in defaults, as { from: 'reference.column' }",
  });
  /* The values filled in as the form opens are constants as written, and
     their words once read (autoValues.ts); the shared parser reads the words.
     A value from a referenced record (`{ from }`) is kept apart, as `derived`. */
  const form = raw as Record<string, unknown>;
  if (!isRecord(form.defaults)) return parseAppForm(form, `${at}, "form"`);
  const entries = Object.entries(form.defaults);
  const from = (value: unknown) => isRecord(value) && Object.hasOwn(value, 'from');
  const defaults = Object.fromEntries(
    entries
      .filter(([, value]) => !from(value))
      .map(([column, value]) => [column, authoredValue(value, `${at}, "form": defaults "${column}"`)]),
  );
  const derived = entries.filter(([, value]) => from(value));
  for (const [column, value] of derived)
    if (Object.keys(value as object).length !== 1)
      throw new Error(`${at}, "form": defaults "${column}" takes { from: 'reference.column' } and nothing beside it.`);
  return parseAppForm(
    {
      ...form,
      defaults,
      ...(derived.length
        ? { derived: Object.fromEntries(derived.map(([column, value]) => [column, (value as { from: unknown }).from])) }
        : {}),
    },
    `${at}, "form"`,
  );
}

/**
 * Declared references (soft keys): column → `{ to, column? }`, the resource
 * it names and the column that is looked up by. Judged against the catalog
 * when the App loads (declaredReferences.ts); here, only its shape. A target
 * in another source is read in two steps rather than joined (stitched), and
 * what that cannot carry is judged there and in checkTenancy.
 */
function parseReferences(raw: unknown, at: string, scope: SourceScope): Record<string, { to: string; column?: string }> {
  const here = `${at}, "references"`;
  const declared = plainRecord(
    raw,
    here,
    "an object of column → { to, column? }, like references: { product_sku: { to: 'product', column: 'sku' } }",
  );
  const out: Record<string, { to: string; column?: string }> = {};
  for (const [column, value] of Object.entries(declared)) {
    const one = `${here} "${column}"`;
    if (!IDENTIFIER.test(column)) throw new Error(`${one}: a reference is keyed by the resource's own column.`);
    const rule = plainRecord(
      value,
      one,
      "{ to, column? }: the resource it names, and the column it is looked up by (absent, that resource's primary key)",
    );
    allowKeys(rule, ['to', 'column'], one);
    if (typeof rule.to !== 'string' || !rule.to.trim()) throw new Error(`${one} needs "to": the resource it names.`);
    const to = rule.to.trim();
    checkResourceSlot(to, `${one}, "to"`, scope);
    if (rule.column !== undefined && (typeof rule.column !== 'string' || !IDENTIFIER.test(rule.column.trim()))) {
      throw new Error(`${one} has a "column" that is not a column name of "${to}".`);
    }
    out[column] = { to, ...(typeof rule.column === 'string' ? { column: rule.column.trim() } : {}) };
  }
  return out;
}

/**
 * A file resource's `storage` and `bucket`: where new uploads go, and the
 * S3-compatible bucket they go to. Only the bucket's address is the App's;
 * its credentials are the server's environment (MISTRI_S3_*), so App
 * source — which every browser receives — never holds one. The bucket stays
 * named after uploads return to the database, because a row still names
 * its object until `mistri migrate files up` brings it back.
 */
function parseFileStorage(declared: Record<string, unknown>, at: string): Pick<AppFileDef, 'storage' | 'bucket'> {
  const out: Pick<AppFileDef, 'storage' | 'bucket'> = {};
  if (declared.storage !== undefined) {
    if (declared.storage !== 'database' && declared.storage !== 'bucket')
      throw new Error(`${at}, "file" "storage" is 'database' or 'bucket'.`);
    out.storage = declared.storage;
  }
  if (declared.bucket !== undefined) {
    const raw = plainRecord(
      declared.bucket,
      `${at}, "file" "bucket"`,
      'an object { name, region?, endpoint?, pathStyle?, prefix?, presign? }',
    );
    allowKeys(raw, ['name', 'region', 'endpoint', 'pathStyle', 'prefix', 'presign'], `${at}, "file" "bucket"`);
    // S3's own rule for a bucket's name; R2, MinIO, B2 and Tigris keep to it.
    if (typeof raw.name !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(raw.name))
      throw new Error(`${at}, "file" "bucket" "name" must be a bucket name: 3 to 63 lowercase letters, digits, dots and hyphens.`);
    const bucket: AppFileBucket = { name: raw.name };
    if (raw.region !== undefined) {
      if (typeof raw.region !== 'string' || !/^[a-z0-9-]{1,32}$/.test(raw.region))
        throw new Error(`${at}, "file" "bucket" "region" must be a region name: us-east-1, auto.`);
      bucket.region = raw.region;
    }
    if (raw.endpoint !== undefined) {
      let endpoint: URL | undefined;
      try {
        endpoint = typeof raw.endpoint === 'string' ? new URL(raw.endpoint) : undefined;
      } catch {
        endpoint = undefined;
      }
      if (!endpoint || !/^https?:$/.test(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
        throw new Error(`${at}, "file" "bucket" "endpoint" must be the provider's https:// address, with no credentials or query in it.`);
      bucket.endpoint = (raw.endpoint as string).replace(/\/+$/, '');
    }
    for (const flag of ['pathStyle', 'presign'] as const) {
      if (raw[flag] === undefined) continue;
      if (typeof raw[flag] !== 'boolean') throw new Error(`${at}, "file" "bucket" "${flag}" is true or false.`);
      bucket[flag] = raw[flag];
    }
    if (raw.prefix !== undefined) {
      if (
        typeof raw.prefix !== 'string' ||
        raw.prefix.length > 200 ||
        raw.prefix.startsWith('/') ||
        raw.prefix.includes('//') ||
        /[\p{Cc}\\]/u.test(raw.prefix)
      )
        throw new Error(
          `${at}, "file" "bucket" "prefix" must be a key prefix such as "files/", at most 200 characters, not starting with "/".`,
        );
      bucket.prefix = raw.prefix && !raw.prefix.endsWith('/') ? `${raw.prefix}/` : raw.prefix;
    }
    out.bucket = bucket;
  }
  if (out.storage === 'bucket' && !out.bucket) throw new Error(`${at}, "file" "storage: 'bucket'" needs the "bucket" it names.`);
  if (out.bucket && declared.object === undefined)
    throw new Error(`${at}, "file" "bucket" needs "object": the text column that holds each file's key in it.`);
  return out;
}
