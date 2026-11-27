/** An App's assistant, as declared: who is offered it, which of the fixed
 * tools and blocks it may use, which of the App's verbs it may never propose,
 * and what it may spend. The declaration only narrows: every read and every
 * proposal is still the person's own, under their grants (docs/assistant.md). */

import { isAppIcon, type AppIconName } from '@mistriwork/engine/shared/appIcons.js';
import { parseComponentDecl, parsePropDecls, type ComponentDecl, type ComponentPropDecl } from '@mistriwork/engine/shared/appComponents.js';

/** The tool core, the same for every App: discovery is a tool, not a preamble. */
export const ASSISTANT_TOOLS = ['find', 'describe', 'query', 'show', 'run'] as const;
type AssistantTool = (typeof ASSISTANT_TOOLS)[number];
/** The blocks the model may compose: the App's own components, never markup. */
export const ASSISTANT_BLOCKS = [
  'table',
  'metric',
  'metrics',
  'chart',
  'breakdown',
  'funnel',
  'board',
  'timeline',
  'record',
  'callout',
  'tabs',
] as const;
type AssistantBlockKind = (typeof ASSISTANT_BLOCKS)[number];
/** Where it is offered: a panel beside every room, with a record as its context, and a room of its own (`/{app}/assistant`). */
export const ASSISTANT_PLACEMENTS = ['panel', 'record', 'page'] as const;
/** Presentation surface modes the panel can switch between. */
const ASSISTANT_PRESENTATIONS = ['sidebar', 'floating', 'fullscreen'] as const;
type AssistantPresentation = (typeof ASSISTANT_PRESENTATIONS)[number];
/** How model reasoning / thinking traces are surfaced in the assistant UI. */
const ASSISTANT_REASONING = ['collapsed', 'expanded', 'hidden'] as const;
type AssistantReasoningVisibility = (typeof ASSISTANT_REASONING)[number];
export const ASSISTANT_EFFORTS = ['low', 'medium', 'high'] as const;
/** The model an App gets unless it names one; the operator's key decides whether any is reachable. */
const DEFAULT_ASSISTANT_MODEL = 'claude-sonnet-5-5';
const TOKEN_LIMIT_KEYS = ['tokensPerTurn', 'tokensPerPersonPerDay', 'tokensPerDay'] as const;
const LIMIT_KEYS = [...TOKEN_LIMIT_KEYS, 'steps'] as const;
/** The rounds of tool calls one answer takes before it must be written, when the App names no figure. */
export const DEFAULT_ASSISTANT_STEPS = 8;
/** The most an App may ask for: every round resends the turn so far, so a long one is paid for many times over. */
const MAX_ASSISTANT_STEPS = 32;
/** What one person may spend in a UTC day when the App names no figure: an assistant is a bill the operator pays,
 * so an open sign-up is not an open tab. A modest day's use fits; an App that expects more names its own
 * `limits.tokensPerPersonPerDay`. */
export const DEFAULT_TOKENS_PER_PERSON_PER_DAY = 200_000;
/** How long a conversation untouched is kept, in days, when nothing says otherwise: every App's, and a tenant App's
 * unless its policy names `assistant.retentionDays`. */
export const ASSISTANT_RETENTION_DAYS = 90;
const KEYS = [
  'instructions',
  'starters',
  'model',
  'effort',
  'effortPicker',
  'reasoning',
  'presentations',
  'defaultPresentation',
  'roles',
  'tools',
  'exclude',
  'blocks',
  'placement',
  'limits',
  'agents',
  'defaultAgent',
  'customBlocks',
] as const;
const AGENT_ID = /^[a-z][a-z0-9_-]{0,39}$/;
const MAX_AGENTS = 16;
const AGENT_KEYS = [
  'name',
  'description',
  'icon',
  'instructions',
  'model',
  'effort',
  'starters',
  'roles',
  'tools',
  'exclude',
  'blocks',
  'customBlocks',
  'subagents',
  'limits',
] as const;
const CUSTOM_BLOCK_NAME = /^[a-z][a-z0-9_-]{0,47}$/;
const MAX_CUSTOM_BLOCKS = 32;
const CUSTOM_BLOCK_KEYS = ['description', 'title', 'component', 'props'] as const;
/** An empty conversation offers a few of the App's own questions, each a line the person sends with one press: at
    most six in any one place, however many the App declares for its different places. */
const MAX_STARTERS = 6;
const MAX_STARTER = 120;
const STARTER_KEYS = ['text', 'views', 'records', 'roles'] as const;

/**
 * A starter offered in some places only: in the named views (their own rooms, a list or a dashboard), on a record of
 * the named tables, or both; and to some people only, by `roles`. A starter that is a bare line is offered everywhere,
 * to everyone.
 *
 *   starters: ['Find stale deals', { text: 'Summarize this ticket', records: ['incident'] }, { text: 'Who is behind?', roles: ['manager'] }]
 */
export interface AssistantStarter {
  text: string;
  /** View keys: offered while one of these views is the room. */
  views?: string[];
  /** Table names: offered while a record of one of these tables is open. */
  records?: string[];
  /** Role names: offered to a person who holds one of them. The server leaves the rest out; a served starter carries none. */
  roles?: string[];
}

interface AssistantLimits {
  /** Input and output tokens one turn may spend, every model call in it counted; a call's cached input (the turn so far,
   * read again) counts at a tenth, as it is billed. */
  tokensPerTurn?: number;
  /** One person's tokens in a UTC day, across their conversations; `DEFAULT_TOKENS_PER_PERSON_PER_DAY` when not named. */
  tokensPerPersonPerDay?: number;
  /** Every person's tokens in the App in a UTC day. */
  tokensPerDay?: number;
  /** The rounds of tool calls one answer may take before it is written, 1 to `MAX_ASSISTANT_STEPS`; a round whose
   * every call was refused is not counted, and the answer after the last round is always words. */
  steps?: number;
}

/** An author-declared custom block the assistant may compose via `show({ kind: 'custom', name, props })`. */
interface AppAssistantCustomBlock {
  /** Short description shown to the model in the system prompt so it knows when and how to draw this block. */
  description: string;
  /** Optional default heading for the block when the model omits `title`. */
  title?: string;
  /** Optional custom React component compiled and served through Mistri's component pipeline. */
  component?: ComponentDecl;
  /** Validated JSON-safe props schema the model may pass when drawing this block. */
  props?: Record<string, ComponentPropDecl>;
}

/** A named, role-scoped agent inside a multi-agent Mistri App. Always narrows the top-level assistant's authority. */
export interface AppAssistantAgent {
  id: string;
  name: string;
  description?: string;
  icon?: AppIconName;
  instructions?: string;
  model?: string;
  effort?: (typeof ASSISTANT_EFFORTS)[number];
  starters?: Array<string | AssistantStarter>;
  roles?: string[];
  tools?: AssistantTool[];
  exclude?: string[];
  blocks?: AssistantBlockKind[];
  customBlocks?: string[];
  /** Named sibling agents this agent may delegate bounded read/analysis sub-tasks to. */
  subagents?: string[];
  limits?: AssistantLimits;
}

/** Viewer-safe agent summary served in `/api/app` (never leaks `roles` or internal instructions). */
export interface ServedAssistantAgent {
  id: string;
  name: string;
  description?: string;
  icon?: AppIconName;
  effort?: (typeof ASSISTANT_EFFORTS)[number];
  starters?: Array<string | AssistantStarter>;
  subagents?: string[];
}

export interface AppAssistant {
  /** What the App's assistant is for and how it should answer: the author's words, prefixed by the platform's own rules. */
  instructions?: string;
  /** Questions an empty conversation offers, in the App's words: each sent as the person's own when pressed. A bare
      line is offered everywhere, a starter with `views` or `records` only there. */
  starters: Array<string | AssistantStarter>;
  model: string;
  effort?: (typeof ASSISTANT_EFFORTS)[number];
  /** Offer a per-turn reasoning effort selector in the assistant composer. */
  effortPicker?: boolean;
  /** How model reasoning / thinking traces appear in the UI: `'collapsed'` (default), `'expanded'`, or `'hidden'`. */
  reasoning: AssistantReasoningVisibility;
  /** Presentation modes offered by the assistant panel: `'sidebar'`, `'floating'`, `'fullscreen'`. */
  presentations: AssistantPresentation[];
  /** Default presentation mode when opening the panel before a reader chooses one. */
  defaultPresentation: AssistantPresentation;
  /** The roles offered the assistant; absent, everyone who may open the App. */
  roles?: string[];
  tools: AssistantTool[];
  /** Verbs it may never propose, as `resource.action` (an action's key, or `new` for the New form). */
  exclude: string[];
  blocks: AssistantBlockKind[];
  placement: Array<(typeof ASSISTANT_PLACEMENTS)[number]>;
  limits: AssistantLimits;
  /** Optional named agents for multi-agent Apps, each narrowing tools, blocks, starters, instructions, and roles. */
  agents?: Record<string, AppAssistantAgent>;
  /** Default agent key when `agents` is declared. */
  defaultAgent?: string;
  /** Optional author-declared interactive custom blocks the assistant may compose via `show({ kind: 'custom', name, props })`. */
  customBlocks?: Record<string, AppAssistantCustomBlock>;
}

interface AssistantContext {
  roles: readonly string[] | undefined;
  /** Each resource's action keys, so an exclusion names a verb that exists. */
  actions: Readonly<Record<string, readonly string[]>>;
  /** Each view's key and the table it shows, so a starter names a view that exists. */
  views?: Readonly<Record<string, string | undefined>>;
  /** The tables a record can be opened from: a list view's or a page's. */
  recordTables?: readonly string[];
}

function subset<T extends string>(raw: unknown, allowed: readonly T[], where: string): T[] {
  if (!Array.isArray(raw) || !raw.length) throw new Error(`${where} is a non-empty list of ${allowed.map((x) => `"${x}"`).join(', ')}.`);
  for (const value of raw) {
    if (!allowed.includes(value as T))
      throw new Error(`${where} names "${String(value)}"; it is one of ${allowed.map((x) => `"${x}"`).join(', ')}.`);
  }
  return [...new Set(raw as T[])];
}

function parseExclude(raw: unknown, context: AssistantContext, where: string): string[] {
  if (!Array.isArray(raw)) throw new Error(`${where} is a list of "resource.action".`);
  const exclude: string[] = [];
  for (const entry of raw) {
    const [resource, action, rest] = typeof entry === 'string' ? entry.split('.') : [];
    if (!resource || !action || rest !== undefined)
      throw new Error(`${where} has "${String(entry)}"; each is "resource.action", or "resource.new" for its New form.`);
    const actions = context.actions[resource];
    if (!actions) throw new Error(`${where} names "${resource}", which is not one of the App's resources.`);
    if (action !== 'new' && !actions.includes(action)) {
      throw new Error(
        `${where} names "${entry}"; resources.${resource} has no action "${action}"${actions.length ? ` (it has ${actions.join(', ')})` : ''}.`,
      );
    }
    exclude.push(entry);
  }
  return exclude;
}

function parseLimits(raw: unknown, where: string, defaults: AssistantLimits = {}): AssistantLimits {
  const limits: AssistantLimits = { ...defaults };
  if (raw === undefined) return limits;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where} is an object.`);
  for (const [key, value] of Object.entries(raw)) {
    if (!(LIMIT_KEYS as readonly string[]).includes(key))
      throw new Error(`${where} has an unknown key "${key}"; it takes ${LIMIT_KEYS.join(', ')}.`);
    if (key === 'steps') {
      if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_ASSISTANT_STEPS)
        throw new Error(`${where}.steps is a whole number of tool rounds, 1 to ${MAX_ASSISTANT_STEPS}.`);
    } else if (!Number.isSafeInteger(value) || (value as number) < 1000)
      throw new Error(`${where}.${key} is a whole number of tokens, at least 1000.`);
    limits[key as keyof AssistantLimits] = value as number;
  }
  return limits;
}

function parseCustomBlocks(raw: unknown, where: string): Record<string, AppAssistantCustomBlock> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length)
    throw new Error(`${where} is a non-empty object of custom block declarations.`);
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_CUSTOM_BLOCKS)
    throw new Error(`${where} declares ${entries.length} blocks; at most ${MAX_CUSTOM_BLOCKS} are allowed.`);
  const out: Record<string, AppAssistantCustomBlock> = {};
  for (const [name, entry] of entries) {
    const at = `${where}.${name}`;
    if (!CUSTOM_BLOCK_NAME.test(name))
      throw new Error(`${at}: a custom block name is lowercase letters, digits, hyphens or underscores, starting with a letter.`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error(`${at} is an object: { description, component?, props? }.`);
    const b = entry as Record<string, unknown>;
    for (const key of Object.keys(b)) {
      if (!(CUSTOM_BLOCK_KEYS as readonly string[]).includes(key))
        throw new Error(`${at} has an unknown key "${key}"; it takes ${CUSTOM_BLOCK_KEYS.join(', ')}.`);
    }
    if (typeof b.description !== 'string' || !b.description.trim() || b.description.trim().length > 240)
      throw new Error(`${at}.description is a non-empty string of at most 240 characters.`);
    if (b.title !== undefined && (typeof b.title !== 'string' || !b.title.trim() || b.title.trim().length > 120))
      throw new Error(`${at}.title is a non-empty string of at most 120 characters.`);
    const component = b.component === undefined ? undefined : parseComponentDecl(b.component, `${at}.component`, 'section');
    const props = b.props !== undefined ? parsePropDecls(b.props, at) : component?.props;
    out[name] = {
      description: b.description.trim(),
      ...(b.title !== undefined ? { title: (b.title as string).trim() } : {}),
      ...(component ? { component } : {}),
      ...(props ? { props } : {}),
    };
  }
  return out;
}

function parseAgents(
  raw: unknown,
  placement: AppAssistant['placement'],
  customBlocks: Record<string, AppAssistantCustomBlock> | undefined,
  context: AssistantContext,
  where: string,
): Record<string, AppAssistantAgent> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length)
    throw new Error(`${where} is a non-empty object of agent declarations.`);
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_AGENTS) throw new Error(`${where} declares ${entries.length} agents; at most ${MAX_AGENTS} are allowed.`);
  const ids = new Set(entries.map(([id]) => id));
  const blockNames = Object.keys(customBlocks ?? {});
  const out: Record<string, AppAssistantAgent> = {};
  for (const [id, entry] of entries) {
    const at = `${where}.${id}`;
    if (!AGENT_ID.test(id))
      throw new Error(`${at}: an agent id is lowercase letters, digits, hyphens or underscores, starting with a letter.`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${at} is an object: { name, instructions, ... }.`);
    const a = entry as Record<string, unknown>;
    for (const key of Object.keys(a)) {
      if (!(AGENT_KEYS as readonly string[]).includes(key))
        throw new Error(`${at} has an unknown key "${key}"; it takes ${AGENT_KEYS.join(', ')}.`);
    }
    if (typeof a.name !== 'string' || !a.name.trim() || a.name.trim().length > 48)
      throw new Error(`${at}.name is a non-empty string of at most 48 characters.`);
    if (a.description !== undefined && (typeof a.description !== 'string' || !a.description.trim() || a.description.trim().length > 240))
      throw new Error(`${at}.description is a non-empty string of at most 240 characters.`);
    if (a.icon !== undefined && !isAppIcon(a.icon)) throw new Error(`${at}.icon names "${String(a.icon)}", which is not a known App icon.`);
    if (a.instructions !== undefined && (typeof a.instructions !== 'string' || !a.instructions.trim()))
      throw new Error(`${at}.instructions is a non-empty string.`);
    if (a.model !== undefined && (typeof a.model !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(a.model)))
      throw new Error(`${at}.model is a model id, such as "${DEFAULT_ASSISTANT_MODEL}".`);
    if (a.effort !== undefined && !(ASSISTANT_EFFORTS as readonly unknown[]).includes(a.effort))
      throw new Error(`${at}.effort is "low", "medium" or "high".`);
    let roles: string[] | undefined;
    if (a.roles !== undefined) {
      if (!context.roles) throw new Error(`${at}.roles names roles, and the App declares no "auth" with roles.`);
      roles = subset(a.roles, context.roles as string[], `${at}.roles`);
    }
    const tools = a.tools === undefined ? undefined : subset(a.tools, ASSISTANT_TOOLS, `${at}.tools`);
    const blocks = a.blocks === undefined ? undefined : subset(a.blocks, ASSISTANT_BLOCKS, `${at}.blocks`);
    const exclude = a.exclude === undefined ? undefined : parseExclude(a.exclude, context, `${at}.exclude`);
    const starters = a.starters === undefined ? undefined : parseStarters(a.starters, placement, context, `${at}.starters`);
    let agentCustomBlocks: string[] | undefined;
    if (a.customBlocks !== undefined) {
      if (!blockNames.length) throw new Error(`${at}.customBlocks names custom blocks, and the assistant declares no "customBlocks".`);
      agentCustomBlocks = subset(a.customBlocks, blockNames, `${at}.customBlocks`);
    }
    let subagents: string[] | undefined;
    if (a.subagents !== undefined) {
      subagents = nameList(a.subagents, (name) => ids.has(name), `${at}.subagents`, 'agent ids', 'is not one of the declared agents');
      if (subagents.includes(id)) throw new Error(`${at}.subagents cannot name "${id}" itself.`);
    }
    const limits = a.limits === undefined ? undefined : parseLimits(a.limits, `${at}.limits`);
    out[id] = {
      id,
      name: a.name.trim(),
      ...(a.description !== undefined ? { description: (a.description as string).trim() } : {}),
      ...(a.icon !== undefined ? { icon: a.icon as AppIconName } : {}),
      ...(a.instructions !== undefined ? { instructions: (a.instructions as string).trim() } : {}),
      ...(a.model !== undefined ? { model: a.model as string } : {}),
      ...(a.effort !== undefined ? { effort: a.effort as AppAssistant['effort'] } : {}),
      ...(starters ? { starters } : {}),
      ...(roles ? { roles } : {}),
      ...(tools ? { tools } : {}),
      ...(exclude ? { exclude } : {}),
      ...(blocks ? { blocks } : {}),
      ...(agentCustomBlocks ? { customBlocks: agentCustomBlocks } : {}),
      ...(subagents ? { subagents } : {}),
      ...(limits ? { limits } : {}),
    };
  }
  return out;
}

export function parseAppAssistant(raw: unknown, context: AssistantContext, where = 'assistant'): AppAssistant | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where} is an object: assistant({ instructions, ... }).`);
  const a = raw as Record<string, unknown>;
  /* Writes wait for the person, and an author cannot turn that off: the record text the model reads is not theirs.
     A key that could only restate it was dropped before 1.0, so it is refused with the reason, not as a stranger. */
  if (Object.hasOwn(a, 'confirm'))
    throw new Error(`${where}.confirm is gone: every write the assistant proposes waits for the person to confirm it. Delete it.`);
  for (const key of Object.keys(a)) {
    if (!(KEYS as readonly string[]).includes(key)) throw new Error(`${where} has an unknown key "${key}"; it takes ${KEYS.join(', ')}.`);
  }
  if (a.instructions !== undefined && (typeof a.instructions !== 'string' || !a.instructions.trim())) {
    throw new Error(`${where}.instructions is a non-empty string.`);
  }
  if (a.model !== undefined && (typeof a.model !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(a.model))) {
    throw new Error(`${where}.model is a model id, such as "${DEFAULT_ASSISTANT_MODEL}".`);
  }
  if (a.effort !== undefined && !(ASSISTANT_EFFORTS as readonly unknown[]).includes(a.effort)) {
    throw new Error(`${where}.effort is "low", "medium" or "high".`);
  }
  if (a.effortPicker !== undefined && typeof a.effortPicker !== 'boolean') {
    throw new Error(`${where}.effortPicker is true or false.`);
  }
  if (a.reasoning !== undefined && !(ASSISTANT_REASONING as readonly unknown[]).includes(a.reasoning)) {
    throw new Error(`${where}.reasoning is "collapsed", "expanded" or "hidden".`);
  }
  const reasoning: AssistantReasoningVisibility = (a.reasoning as AssistantReasoningVisibility | undefined) ?? 'collapsed';
  const presentations =
    a.presentations === undefined
      ? [...ASSISTANT_PRESENTATIONS]
      : subset(a.presentations, ASSISTANT_PRESENTATIONS, `${where}.presentations`);
  if (a.defaultPresentation !== undefined && !(ASSISTANT_PRESENTATIONS as readonly unknown[]).includes(a.defaultPresentation)) {
    throw new Error(`${where}.defaultPresentation is "sidebar", "floating" or "fullscreen".`);
  }
  const defaultPresentation: AssistantPresentation =
    (a.defaultPresentation as AssistantPresentation | undefined) ?? (presentations.includes('sidebar') ? 'sidebar' : presentations[0]!);
  if (!presentations.includes(defaultPresentation)) {
    throw new Error(`${where}.defaultPresentation names "${defaultPresentation}", which is not in ${where}.presentations.`);
  }
  let roles: string[] | undefined;
  if (a.roles !== undefined) {
    if (!context.roles) throw new Error(`${where}.roles names roles, and the App declares no "auth" with roles.`);
    roles = subset(a.roles as unknown, context.roles as string[], `${where}.roles`);
  }
  const tools = a.tools === undefined ? [...ASSISTANT_TOOLS] : subset(a.tools, ASSISTANT_TOOLS, `${where}.tools`);
  const blocks = a.blocks === undefined ? [...ASSISTANT_BLOCKS] : subset(a.blocks, ASSISTANT_BLOCKS, `${where}.blocks`);
  // A page of its own is a room in the App's menu: the author's to add, so absent it is the panel and the record.
  const placement =
    a.placement === undefined
      ? (['panel', 'record'] as AppAssistant['placement'])
      : subset(a.placement, ASSISTANT_PLACEMENTS, `${where}.placement`);
  if (!placement.includes('panel'))
    throw new Error(`${where}.placement includes "panel": the record placement and the page open the same conversation.`);
  const starters = a.starters === undefined ? [] : parseStarters(a.starters, placement, context, `${where}.starters`);
  const exclude = a.exclude === undefined ? [] : parseExclude(a.exclude, context, `${where}.exclude`);
  const limits = parseLimits(a.limits, `${where}.limits`, { tokensPerPersonPerDay: DEFAULT_TOKENS_PER_PERSON_PER_DAY });
  const customBlocks = parseCustomBlocks(a.customBlocks, `${where}.customBlocks`);
  const agents = parseAgents(a.agents, placement, customBlocks, context, `${where}.agents`);
  let defaultAgent: string | undefined;
  if (a.defaultAgent !== undefined) {
    if (!agents) throw new Error(`${where}.defaultAgent names an agent, and ${where} declares no "agents".`);
    if (typeof a.defaultAgent !== 'string' || !Object.hasOwn(agents, a.defaultAgent))
      throw new Error(`${where}.defaultAgent names "${String(a.defaultAgent)}", which is not one of ${where}.agents.`);
    defaultAgent = a.defaultAgent;
  } else if (agents) {
    defaultAgent = Object.keys(agents)[0];
  }
  return {
    ...(a.instructions === undefined ? {} : { instructions: (a.instructions as string).trim() }),
    starters,
    model: (a.model as string | undefined) ?? DEFAULT_ASSISTANT_MODEL,
    ...(a.effort === undefined ? {} : { effort: a.effort as AppAssistant['effort'] }),
    ...(a.effortPicker === true ? { effortPicker: true } : {}),
    reasoning,
    presentations,
    defaultPresentation,
    ...(roles ? { roles } : {}),
    tools,
    exclude,
    blocks,
    placement,
    limits,
    ...(agents ? { agents } : {}),
    ...(defaultAgent ? { defaultAgent } : {}),
    ...(customBlocks ? { customBlocks } : {}),
  };
}

function nameList(raw: unknown, known: (name: string) => boolean, where: string, what: string, unknown: string): string[] {
  if (!Array.isArray(raw) || !raw.length || raw.some((name) => typeof name !== 'string' || !name))
    throw new Error(`${where} is a non-empty list of ${what}.`);
  for (const name of raw as string[]) if (!known(name)) throw new Error(`${where} names "${name}", which ${unknown}.`);
  return [...new Set(raw as string[])];
}

function parseStarters(
  raw: unknown,
  placement: AppAssistant['placement'],
  context: AssistantContext,
  where: string,
): AppAssistant['starters'] {
  if (!Array.isArray(raw) || !raw.length)
    throw new Error(`${where} is a list of questions an empty conversation offers: a line, or { text, views, records, roles }.`);
  const views = context.views ?? {};
  const tables = new Set(context.recordTables ?? Object.values(views).filter((table) => table !== undefined));
  const seen = new Set<string>();
  const starters = raw.map((entry, i): string | AssistantStarter => {
    const at = `${where}[${i}]`;
    const scoped = Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry);
    const text = scoped ? (entry as Record<string, unknown>).text : entry;
    if (typeof text !== 'string' || !text.trim() || text.trim().length > MAX_STARTER || /[\p{Cc}\p{Cs}]/u.test(text))
      throw new Error(`${where} has ${JSON.stringify(text)}; each is one line of at most ${MAX_STARTER} characters.`);
    const line = text.trim();
    if (seen.has(line)) throw new Error(`${where} names "${line}" twice.`);
    seen.add(line);
    if (!scoped) return line;
    const starter = entry as Record<string, unknown>;
    for (const key of Object.keys(starter))
      if (!(STARTER_KEYS as readonly string[]).includes(key))
        throw new Error(`${at} has an unknown key "${key}"; a starter takes ${STARTER_KEYS.join(', ')}.`);
    if (starter.views === undefined && starter.records === undefined && starter.roles === undefined)
      throw new Error(`${at} names no place and no role: give it views, records or roles, or write the line alone to offer it everywhere.`);
    const out: AssistantStarter = { text: line };
    if (starter.roles !== undefined) {
      if (!context.roles) throw new Error(`${at}.roles names roles, and the App declares no "auth" with roles.`);
      out.roles = nameList(
        starter.roles,
        (role) => (context.roles as readonly string[]).includes(role),
        `${at}.roles`,
        'role names',
        `is not one of the App's roles (${(context.roles as readonly string[]).join(', ')})`,
      );
    }
    if (starter.views !== undefined)
      out.views = nameList(starter.views, (key) => Object.hasOwn(views, key), `${at}.views`, 'view keys', "is not one of this App's views");
    if (starter.records !== undefined) {
      // A record's starter speaks of the open record ("Summarize this ticket"), so the assistant must be handed it.
      if (!placement.includes('record'))
        throw new Error(
          `${at}.records offers it on an open record, and the assistant does not take the record as context: add "record" to placement.`,
        );
      out.records = nameList(
        starter.records,
        (table) => tables.has(table),
        `${at}.records`,
        'table names',
        'no list view or page of this App opens a record of',
      );
    }
    return out;
  });
  /* At most six in any one place: everywhere's, with a view's own or a record's own, as one person is offered them
     (a starter for one role is not counted against another's). */
  const scoped = starters.some((s) => typeof s !== 'string' && s.roles);
  for (const role of scoped ? (context.roles as readonly string[]) : [undefined]) {
    const theirs = starters.filter((s) => typeof s === 'string' || !s.roles || (role !== undefined && s.roles.includes(role)));
    const placed = (s: string | AssistantStarter): s is AssistantStarter => typeof s !== 'string' && Boolean(s.views || s.records);
    const everywhere = theirs.filter((s) => !placed(s)).length;
    const places = [
      ['everywhere', everywhere] as const,
      ...Object.keys(views).map(
        (key) => [`in view "${key}"`, everywhere + theirs.filter((s) => placed(s) && s.views?.includes(key)).length] as const,
      ),
      ...[...tables].map(
        (table) => [`on a ${table} record`, everywhere + theirs.filter((s) => placed(s) && s.records?.includes(table)).length] as const,
      ),
    ];
    const crowded = places.find(([, count]) => count > MAX_STARTERS);
    if (crowded)
      throw new Error(
        `${where} offers ${crowded[1]} starters ${crowded[0]}${role === undefined ? '' : ` to role "${role}"`}; at most ${MAX_STARTERS} are offered in one place.`,
      );
  }
  return starters;
}

/**
 * The starters a person holding `roles` is offered, as they are served: one for other roles is left out, and the
 * rest carry no role list (which roles an App has is not the browser's to know). One that named only roles is a bare
 * line again, offered everywhere.
 */
export function startersFor(
  starters: readonly (string | AssistantStarter)[] | undefined,
  roles: readonly string[],
): Array<string | AssistantStarter> {
  return (starters ?? []).flatMap((starter): Array<string | AssistantStarter> => {
    if (typeof starter === 'string' || !starter.roles) return [starter];
    if (!starter.roles.some((role) => roles.includes(role))) return [];
    const { roles: _roles, ...rest } = starter;
    return [rest.views || rest.records ? rest : rest.text];
  });
}

/** Where the person is, as the starters read it: the view that is the room, the table of the record that is open. */
interface StarterPlace {
  view?: string;
  record?: string;
}

/** The starters offered here, in the App's order: every bare line, and a scoped one where its view or record is. */
export function startersHere(starters: readonly (string | AssistantStarter)[] | undefined, here: StarterPlace): string[] {
  return (starters ?? []).flatMap((starter) => {
    if (typeof starter === 'string') return [starter];
    const offered =
      (here.view !== undefined && starter.views?.includes(here.view)) ||
      (here.record !== undefined && starter.records?.includes(here.record));
    return offered ? [starter.text] : [];
  });
}

/** Whether a person holding `roles` may use `agent`: an agent without `roles` is offered to everyone who may open the assistant. */
function agentAllowedFor(agent: Pick<AppAssistantAgent, 'roles'>, roles: readonly string[]): boolean {
  return !agent.roles || agent.roles.some((role) => roles.includes(role));
}

/**
 * The agents a person holding `roles` is offered, as they are served: agents for other roles are left out, each agent's
 * `starters` are filtered for `roles`, `subagents` only name accessible sibling agents, and `roles` itself is never sent.
 */
export function agentsFor(
  agents: ReadonlyArray<ServedAssistantAgent & { roles?: readonly string[] }> | undefined,
  roles: readonly string[],
): ServedAssistantAgent[] {
  if (!agents?.length) return [];
  const accessible = agents.filter((agent) => !agent.roles || agent.roles.some((role) => roles.includes(role)));
  const ids = new Set(accessible.map((agent) => agent.id));
  return accessible.map(({ roles: _roles, starters, subagents, ...rest }) => {
    const theirs = startersFor(starters, roles);
    const allowedSubs = subagents?.filter((id) => ids.has(id));
    return {
      ...rest,
      ...(theirs.length ? { starters: theirs } : {}),
      ...(allowedSubs?.length ? { subagents: allowedSubs } : {}),
    };
  });
}

const minDefined = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.min(a, b);

/**
 * Resolve an active named agent onto the App's base assistant definition, strictly narrowing authority and budgets.
 * Returns `{ assistant: base }` unchanged when the App declares no `agents`. Throws an error if `agentId` is explicitly
 * requested and does not exist or is not permitted for `viewerRoles`.
 */
export function resolveAgentAssistant(
  base: AppAssistant,
  agentId: string | undefined,
  viewerRoles?: readonly string[],
): { assistant: AppAssistant; agent?: AppAssistantAgent } {
  if (!base.agents || !Object.keys(base.agents).length) {
    if (agentId !== undefined) throw new Error('This assistant does not declare named agents.');
    return { assistant: base };
  }
  const roles = viewerRoles ?? [];
  const allowedEntries = Object.values(base.agents).filter((each) => (viewerRoles ? agentAllowedFor(each, roles) : true));
  let agent: AppAssistantAgent | undefined;
  if (agentId !== undefined) {
    const candidate = base.agents[agentId];
    if (!candidate || (viewerRoles && !agentAllowedFor(candidate, roles))) {
      throw new Error(`Agent "${agentId}" is not available to you here.`);
    }
    agent = candidate;
  } else {
    const fallback = base.defaultAgent ? base.agents[base.defaultAgent] : undefined;
    agent = fallback && (!viewerRoles || agentAllowedFor(fallback, roles)) ? fallback : allowedEntries[0];
  }
  if (!agent) return { assistant: base };
  const tools = agent.tools ? base.tools.filter((tool) => agent.tools!.includes(tool)) : base.tools;
  const blocks = agent.blocks ? base.blocks.filter((block) => agent.blocks!.includes(block)) : base.blocks;
  const exclude = [...new Set([...base.exclude, ...(agent.exclude ?? [])])];
  const customBlocks =
    base.customBlocks && agent.customBlocks
      ? Object.fromEntries(Object.entries(base.customBlocks).filter(([name]) => agent.customBlocks!.includes(name)))
      : base.customBlocks;
  const instructions = [base.instructions, agent.instructions].filter(Boolean).join('\n\n') || undefined;
  const limits: AssistantLimits = {
    ...(minDefined(base.limits.tokensPerTurn, agent.limits?.tokensPerTurn) !== undefined
      ? { tokensPerTurn: minDefined(base.limits.tokensPerTurn, agent.limits?.tokensPerTurn) }
      : {}),
    ...(minDefined(base.limits.tokensPerPersonPerDay, agent.limits?.tokensPerPersonPerDay) !== undefined
      ? { tokensPerPersonPerDay: minDefined(base.limits.tokensPerPersonPerDay, agent.limits?.tokensPerPersonPerDay) }
      : {}),
    ...(minDefined(base.limits.tokensPerDay, agent.limits?.tokensPerDay) !== undefined
      ? { tokensPerDay: minDefined(base.limits.tokensPerDay, agent.limits?.tokensPerDay) }
      : {}),
    ...(minDefined(base.limits.steps, agent.limits?.steps) !== undefined
      ? { steps: minDefined(base.limits.steps, agent.limits?.steps) }
      : {}),
  };
  const accessibleSubagents = agent.subagents?.filter((id) => {
    const target = base.agents?.[id];
    return Boolean(target && (!viewerRoles || agentAllowedFor(target, roles)));
  });
  const resolvedAgent: AppAssistantAgent = {
    ...agent,
    ...(accessibleSubagents?.length ? { subagents: accessibleSubagents } : { subagents: undefined }),
  };
  return {
    agent: resolvedAgent,
    assistant: {
      ...base,
      ...(instructions ? { instructions } : {}),
      model: agent.model ?? base.model,
      ...((agent.effort ?? base.effort) ? { effort: agent.effort ?? base.effort } : {}),
      starters: agent.starters ?? base.starters,
      tools,
      blocks,
      exclude,
      limits,
      ...(customBlocks && Object.keys(customBlocks).length ? { customBlocks } : { customBlocks: undefined }),
    },
  };
}
