/** An App's assistant, as declared: who is offered it, which of the fixed
 * tools and blocks it may use, which of the App's verbs it may never propose,
 * and what it may spend. The declaration only narrows: every read and every
 * proposal is still the person's own, under their grants (docs/assistant.md). */

import { isAppIcon, type AppIconName } from '@mistriwork/engine/shared/appIcons.js';
import { parseComponentDecl, parsePropDecls, type ComponentDecl, type ComponentPropDecl } from '@mistriwork/engine/shared/appComponents.js';
import {
  parseAssistantWebhooks,
  parseExternalTools,
  parseMcpServers,
  type AppAssistantExternalTool,
  type AppAssistantMcpServer,
  type AppAssistantWebhook,
} from './appAssistantExternal.js';
import { parseAssistantSkills, type AppAssistantSkill } from './appAssistantSkills.js';
import { parseAssistantProvider, parseFallbackModels, type AssistantProvider } from './appAssistantRouting.js';

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
  'gallery',
  'calendar',
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
/** Scopes for durable assistant memory: per-person private notes, or shared app/tenant knowledge. */
const ASSISTANT_MEMORY_SCOPES = ['person', 'app'] as const;
type AssistantMemoryScope = (typeof ASSISTANT_MEMORY_SCOPES)[number];
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
  'roleInstructions',
  'starters',
  'model',
  'provider',
  'fallbackModels',
  'effort',
  'effortPicker',
  'reasoning',
  'presentations',
  'defaultPresentation',
  'roles',
  'tools',
  'exclude',
  'autoApproveCommands',
  'blocks',
  'placement',
  'limits',
  'agents',
  'defaultAgent',
  'customBlocks',
  'memory',
  'knowledge',
  'backgroundRuns',
  'evals',
  'externalTools',
  'mcpServers',
  'skills',
  'webhooks',
] as const;
const MAX_EVALS = 24;
const EVAL_KEYS = ['id', 'label', 'description', 'prompt', 'agent', 'roles', 'expect'] as const;
const EVAL_EXPECT_KEYS = [
  'answerMatches',
  'expectedTools',
  'forbiddenTools',
  'expectedBlocks',
  'expectCitations',
  'expectReasoning',
  'maxTokens',
  'maxSteps',
] as const;
const AGENT_ID = /^[a-z][a-z0-9_-]{0,39}$/;
const MAX_AGENTS = 16;
const AGENT_KEYS = [
  'name',
  'description',
  'icon',
  'instructions',
  'model',
  'provider',
  'fallbackModels',
  'effort',
  'starters',
  'roles',
  'tools',
  'exclude',
  'blocks',
  'customBlocks',
  'subagents',
  'limits',
  'memory',
  'knowledge',
  'skills',
] as const;
const CUSTOM_BLOCK_NAME = /^[a-z][a-z0-9_-]{0,47}$/;
const MAX_CUSTOM_BLOCKS = 32;
const CUSTOM_BLOCK_KEYS = ['description', 'title', 'component', 'props'] as const;
const MEMORY_KEYS = ['scopes', 'maxItems', 'sharedRoles'] as const;
const DEFAULT_MEMORY_ITEMS = 50;
const MAX_MEMORY_ITEMS = 200;
const KNOWLEDGE_NAME = /^[a-z][a-z0-9_-]{0,47}$/;
const MAX_KNOWLEDGE_SOURCES = 16;
const KNOWLEDGE_KEYS = ['resource', 'fields', 'title', 'description', 'where', 'roles', 'limit'] as const;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_KNOWLEDGE_LIMIT = 6;
const MAX_KNOWLEDGE_LIMIT = 12;
const BACKGROUND_RUNS_KEYS = ['maxConcurrent', 'maxSteps', 'presets', 'schedules', 'triggers'] as const;
const DEFAULT_RUN_CONCURRENT = 2;
const MAX_RUN_CONCURRENT = 5;
const DEFAULT_RUN_STEPS = 16;
const RUN_PRESET_ID = /^[a-z][a-z0-9_-]{0,47}$/;
const MAX_RUN_PRESETS = 12;
const RUN_PRESET_KEYS = ['id', 'label', 'description', 'prompt', 'agent', 'roles'] as const;
const MAX_RUN_SCHEDULES = 12;
const RUN_SCHEDULE_KEYS = ['id', 'label', 'description', 'every', 'timezone', 'prompt', 'agent', 'roles', 'enabled'] as const;
const MAX_RUN_TRIGGERS = 16;
const RUN_TRIGGER_KEYS = [
  'id',
  'label',
  'description',
  'resource',
  'on',
  'fields',
  'prompt',
  'agent',
  'roles',
  'enabled',
  'cooldownSeconds',
] as const;
const RUN_TRIGGER_EVENTS = ['create', 'update'] as const;
const DEFAULT_TRIGGER_COOLDOWN = 60;
const MAX_TRIGGER_COOLDOWN = 86_400;
const CRON_WORDS: Readonly<Record<string, string>> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
};
const CRON_BOUNDS: readonly [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
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

/** Durable scoped memory settings for an App's assistant. */
interface AppAssistantMemory {
  /** Which memory scopes are enabled: `'person'` (private per signed-in user) and/or `'app'` (shared across the App/tenant). */
  scopes: AssistantMemoryScope[];
  /** Maximum retained memories per scope/owner (1–200, default 50). */
  maxItems: number;
  /** Roles allowed to write or delete `'app'`-scoped shared memories. Absent, everyone who may open the assistant. */
  sharedRoles?: string[];
}

/** Viewer-safe memory summary served in `/api/app` (never leaks `sharedRoles`). */
export interface ServedAssistantMemory {
  scopes: AssistantMemoryScope[];
  maxItems: number;
  canWriteShared?: boolean;
}

/** A declarative, authority-scoped knowledge source backed by an App resource/table. */
interface AppAssistantKnowledgeSource {
  id: string;
  /** Resource/table name in the App; searches run strictly through the viewer's own grants and row policies. */
  resource: string;
  /** Text columns searched and excerpted for grounded citations. */
  fields: string[];
  /** Optional column naming the record/document title; defaults to the first field or record label. */
  title?: string;
  /** Short description shown to the model so it knows when to search this source. */
  description?: string;
  /** Optional static filter expression applied to every search of this source (e.g. `"status = 'published'"`). */
  where?: string;
  /** Optional roles permitted to query this source; stripped before serving to the browser. */
  roles?: string[];
  /** Maximum citations returned per search (1–12, default 6). */
  limit: number;
}

/** Viewer-safe knowledge source summary served in `/api/app`. */
export interface ServedAssistantKnowledge {
  id: string;
  resource: string;
  description?: string;
}

/** A named, role-scoped agent inside a multi-agent Mistri App. Always narrows the top-level assistant's authority. */
export interface AppAssistantAgent {
  id: string;
  name: string;
  description?: string;
  icon?: AppIconName;
  instructions?: string;
  model?: string;
  provider?: AssistantProvider;
  fallbackModels?: string[];
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
  /** `false` disables memory for this agent even when the top-level assistant enables it. */
  memory?: boolean;
  /** Subset of `assistant.knowledge` keys this agent may search. */
  knowledge?: string[];
  /** Subset of `assistant.skills` keys this agent may load on demand. */
  skills?: string[];
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
  /** Optional role-specific guidance keyed by declared role name (server-only; appended when viewer holds that role). */
  roleInstructions?: Record<string, string>;
  /** Questions an empty conversation offers, in the App's words: each sent as the person's own when pressed. A bare
      line is offered everywhere, a starter with `views` or `records` only there. */
  starters: Array<string | AssistantStarter>;
  model: string;
  /** Optional explicit provider; inferred from `model` when absent. */
  provider?: AssistantProvider;
  /** Optional ordered fallback models tried automatically on provider unavailability. */
  fallbackModels?: string[];
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
  /** Named low-risk business commands allowed to execute directly under the viewer's own grants & row policy. */
  autoApproveCommands?: string[];
  blocks: AssistantBlockKind[];
  placement: Array<(typeof ASSISTANT_PLACEMENTS)[number]>;
  limits: AssistantLimits;
  /** Optional named agents for multi-agent Apps, each narrowing tools, blocks, starters, instructions, and roles. */
  agents?: Record<string, AppAssistantAgent>;
  /** Default agent key when `agents` is declared. */
  defaultAgent?: string;
  /** Optional author-declared interactive custom blocks the assistant may compose via `show({ kind: 'custom', name, props })`. */
  customBlocks?: Record<string, AppAssistantCustomBlock>;
  /** Optional scoped persistent memory (`person` and/or shared `app` notes). */
  memory?: AppAssistantMemory;
  /** Optional authority-scoped knowledge sources searchable with inline record citations. */
  knowledge?: Record<string, AppAssistantKnowledgeSource>;
  /** Optional durable background agent runs configuration and one-click run presets. */
  backgroundRuns?: AppAssistantBackgroundRuns;
  /** Optional declarative evaluation cases run on demand from the Trace & Eval console. */
  evals?: AppAssistantEvalCase[];
  /** Optional declarative outbound HTTP & MCP tool bridges. */
  externalTools?: Record<string, AppAssistantExternalTool>;
  /** Optional declarative MCP servers supporting live `tools/list` discovery. */
  mcpServers?: Record<string, AppAssistantMcpServer>;
  /** Optional progressive-disclosure skills loaded on demand via `load_skill`. */
  skills?: Record<string, AppAssistantSkill>;
  /** Optional signed inbound webhooks that launch durable background runs. */
  webhooks?: AppAssistantWebhook[];
}

/** Declarative expectations graded against an assistant eval run. */
interface AppAssistantEvalExpect {
  answerMatches?: string;
  expectedTools?: string[];
  forbiddenTools?: string[];
  expectedBlocks?: string[];
  expectCitations?: boolean;
  expectReasoning?: boolean;
  maxTokens?: number;
  maxSteps?: number;
}

/** A declarative assistant evaluation case. */
interface AppAssistantEvalCase {
  id: string;
  label: string;
  description?: string;
  prompt: string;
  agent?: string;
  roles?: string[];
  expect: AppAssistantEvalExpect;
}

/** Viewer-safe evaluation case summary served in `/api/app` (never leaks `roles`). */
export interface ServedAssistantEvalCase {
  id: string;
  label: string;
  description?: string;
  prompt: string;
  agent?: string;
  expect: AppAssistantEvalExpect;
}

/** A declarative one-click background run preset shown in the Run Monitor. */
interface AppAssistantRunPreset {
  id: string;
  label: string;
  description?: string;
  prompt: string;
  agent?: string;
  roles?: string[];
}

/** A declarative cron-scheduled background run. */
interface AppAssistantRunSchedule {
  id: string;
  label: string;
  description?: string;
  /** Five cron fields or @hourly, @daily, @weekly, @monthly. */
  every: string;
  /** Optional IANA timezone (defaults to App ui.timezone or UTC). */
  timezone?: string;
  prompt: string;
  agent?: string;
  roles?: string[];
  /** Whether enabled by default before a person toggles it (default true). */
  enabled: boolean;
}

/** A declarative record-change triggered background run. */
interface AppAssistantRunTrigger {
  id: string;
  label: string;
  description?: string;
  resource: string;
  on: Array<'create' | 'update'>;
  fields?: string[];
  prompt: string;
  agent?: string;
  roles?: string[];
  /** Whether enabled by default before a person toggles it (default true). */
  enabled: boolean;
  /** Minimum seconds between automatic fires for the same record (default 60). */
  cooldownSeconds: number;
}

/** Durable background agent run settings for an App's assistant. */
interface AppAssistantBackgroundRuns {
  /** Maximum active concurrent background runs per person (1–5, default 2). */
  maxConcurrent: number;
  /** Maximum tool rounds per background run (1–32, default 16). */
  maxSteps: number;
  /** Optional one-click background run playbooks/presets. */
  presets: AppAssistantRunPreset[];
  /** Optional cron-scheduled background runs. */
  schedules: AppAssistantRunSchedule[];
  /** Optional record-change event-triggered background runs. */
  triggers: AppAssistantRunTrigger[];
}

/** Viewer-safe background runs capability served in `/api/app` (never leaks `roles`). */
export interface ServedAssistantBackgroundRuns {
  maxConcurrent: number;
  maxSteps: number;
  presets: Array<{ id: string; label: string; description?: string; prompt: string; agent?: string }>;
  schedules?: Array<{
    id: string;
    label: string;
    description?: string;
    every: string;
    timezone?: string;
    agent?: string;
    enabled: boolean;
  }>;
  triggers?: Array<{
    id: string;
    label: string;
    description?: string;
    resource: string;
    on: Array<'create' | 'update'>;
    fields?: string[];
    agent?: string;
    enabled: boolean;
    cooldownSeconds: number;
  }>;
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

function parseMemory(raw: unknown, context: AssistantContext, where: string): AppAssistantMemory | undefined {
  if (raw === undefined || raw === false) return undefined;
  if (raw === true) return { scopes: ['person'], maxItems: DEFAULT_MEMORY_ITEMS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error(`${where} is true, false, or an object: { scopes, maxItems, sharedRoles }.`);
  const m = raw as Record<string, unknown>;
  for (const key of Object.keys(m)) {
    if (!(MEMORY_KEYS as readonly string[]).includes(key))
      throw new Error(`${where} has an unknown key "${key}"; it takes ${MEMORY_KEYS.join(', ')}.`);
  }
  const scopes =
    m.scopes === undefined ? (['person'] as AssistantMemoryScope[]) : subset(m.scopes, ASSISTANT_MEMORY_SCOPES, `${where}.scopes`);
  let maxItems = DEFAULT_MEMORY_ITEMS;
  if (m.maxItems !== undefined) {
    if (!Number.isSafeInteger(m.maxItems) || (m.maxItems as number) < 1 || (m.maxItems as number) > MAX_MEMORY_ITEMS)
      throw new Error(`${where}.maxItems is a whole number of memories, 1 to ${MAX_MEMORY_ITEMS}.`);
    maxItems = m.maxItems as number;
  }
  let sharedRoles: string[] | undefined;
  if (m.sharedRoles !== undefined) {
    if (!scopes.includes('app')) throw new Error(`${where}.sharedRoles requires "app" in ${where}.scopes.`);
    if (!context.roles) throw new Error(`${where}.sharedRoles names roles, and the App declares no "auth" with roles.`);
    sharedRoles = subset(m.sharedRoles, context.roles as string[], `${where}.sharedRoles`);
  }
  return { scopes, maxItems, ...(sharedRoles ? { sharedRoles } : {}) };
}

function parseKnowledge(raw: unknown, context: AssistantContext, where: string): Record<string, AppAssistantKnowledgeSource> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length)
    throw new Error(`${where} is a non-empty object of knowledge source declarations.`);
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_KNOWLEDGE_SOURCES)
    throw new Error(`${where} declares ${entries.length} knowledge sources; at most ${MAX_KNOWLEDGE_SOURCES} are allowed.`);
  const out: Record<string, AppAssistantKnowledgeSource> = {};
  for (const [id, entry] of entries) {
    const at = `${where}.${id}`;
    if (!KNOWLEDGE_NAME.test(id))
      throw new Error(`${at}: a knowledge source name is lowercase letters, digits, hyphens or underscores, starting with a letter.`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error(`${at} is an object: { resource, fields, title?, description?, where?, roles?, limit? }.`);
    const k = entry as Record<string, unknown>;
    for (const key of Object.keys(k)) {
      if (!(KNOWLEDGE_KEYS as readonly string[]).includes(key))
        throw new Error(`${at} has an unknown key "${key}"; it takes ${KNOWLEDGE_KEYS.join(', ')}.`);
    }
    if (typeof k.resource !== 'string' || !k.resource || !Object.hasOwn(context.actions, k.resource))
      throw new Error(`${at}.resource names "${String(k.resource)}", which is not one of the App's resources.`);
    if (!Array.isArray(k.fields) || !k.fields.length || k.fields.some((f) => typeof f !== 'string' || !FIELD_NAME.test(f)))
      throw new Error(`${at}.fields is a non-empty list of column names to search.`);
    const fields = [...new Set(k.fields as string[])];
    if (k.title !== undefined && (typeof k.title !== 'string' || !FIELD_NAME.test(k.title)))
      throw new Error(`${at}.title is a column name.`);
    if (k.description !== undefined && (typeof k.description !== 'string' || !k.description.trim() || k.description.trim().length > 240))
      throw new Error(`${at}.description is a non-empty string of at most 240 characters.`);
    if (k.where !== undefined && (typeof k.where !== 'string' || !k.where.trim() || k.where.trim().length > 400))
      throw new Error(`${at}.where is a non-empty filter expression of at most 400 characters.`);
    let roles: string[] | undefined;
    if (k.roles !== undefined) {
      if (!context.roles) throw new Error(`${at}.roles names roles, and the App declares no "auth" with roles.`);
      roles = subset(k.roles, context.roles as string[], `${at}.roles`);
    }
    let limit = DEFAULT_KNOWLEDGE_LIMIT;
    if (k.limit !== undefined) {
      if (!Number.isSafeInteger(k.limit) || (k.limit as number) < 1 || (k.limit as number) > MAX_KNOWLEDGE_LIMIT)
        throw new Error(`${at}.limit is a whole number of citations, 1 to ${MAX_KNOWLEDGE_LIMIT}.`);
      limit = k.limit as number;
    }
    out[id] = {
      id,
      resource: k.resource,
      fields,
      ...(k.title !== undefined ? { title: k.title as string } : {}),
      ...(k.description !== undefined ? { description: (k.description as string).trim() } : {}),
      ...(k.where !== undefined ? { where: (k.where as string).trim() } : {}),
      ...(roles ? { roles } : {}),
      limit,
    };
  }
  return out;
}

function validateCronEvery(raw: unknown, where: string): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error(`${where} is five cron fields, or @hourly, @daily, @weekly or @monthly.`);
  const trimmed = raw.trim();
  const expr = CRON_WORDS[trimmed] ?? trimmed;
  const parts = expr.split(/\s+/);
  if (parts.length !== 5) throw new Error(`${where} "${trimmed}" is not five cron fields: minute, hour, day of month, month, day of week.`);
  for (let idx = 0; idx < 5; idx++) {
    const [low, high] = CRON_BOUNDS[idx]!;
    for (const part of parts[idx]!.split(',')) {
      const match = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(part);
      if (!match) throw new Error(`${where} "${trimmed}", field ${idx + 1} "${part}" is invalid.`);
      const from = match[1] === '*' ? low : Number(match[2]);
      const to = match[1] === '*' ? high : match[3] !== undefined ? Number(match[3]) : match[4] !== undefined ? high : from;
      const step = match[4] === undefined ? 1 : Number(match[4]);
      if (from < low || to > high || from > to || step < 1)
        throw new Error(`${where} "${trimmed}", field ${idx + 1} "${part}" is outside ${low}-${high}.`);
    }
  }
  return trimmed;
}

function parseBackgroundRuns(
  raw: unknown,
  agents: Record<string, AppAssistantAgent> | undefined,
  context: AssistantContext,
  where: string,
): AppAssistantBackgroundRuns | undefined {
  if (raw === undefined || raw === false) return undefined;
  if (raw === true) return { maxConcurrent: DEFAULT_RUN_CONCURRENT, maxSteps: DEFAULT_RUN_STEPS, presets: [], schedules: [], triggers: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error(`${where} is true, false, or an object: { maxConcurrent, maxSteps, presets, schedules, triggers }.`);
  const cfg = raw as Record<string, unknown>;
  for (const key of Object.keys(cfg)) {
    if (!(BACKGROUND_RUNS_KEYS as readonly string[]).includes(key))
      throw new Error(`${where} has an unknown key "${key}"; it takes ${BACKGROUND_RUNS_KEYS.join(', ')}.`);
  }
  let maxConcurrent = DEFAULT_RUN_CONCURRENT;
  if (cfg.maxConcurrent !== undefined) {
    if (!Number.isSafeInteger(cfg.maxConcurrent) || (cfg.maxConcurrent as number) < 1 || (cfg.maxConcurrent as number) > MAX_RUN_CONCURRENT)
      throw new Error(`${where}.maxConcurrent is a whole number, 1 to ${MAX_RUN_CONCURRENT}.`);
    maxConcurrent = cfg.maxConcurrent as number;
  }
  let maxSteps = DEFAULT_RUN_STEPS;
  if (cfg.maxSteps !== undefined) {
    if (!Number.isSafeInteger(cfg.maxSteps) || (cfg.maxSteps as number) < 1 || (cfg.maxSteps as number) > MAX_ASSISTANT_STEPS)
      throw new Error(`${where}.maxSteps is a whole number of tool rounds, 1 to ${MAX_ASSISTANT_STEPS}.`);
    maxSteps = cfg.maxSteps as number;
  }
  const presets: AppAssistantRunPreset[] = [];
  if (cfg.presets !== undefined) {
    if (!Array.isArray(cfg.presets) || cfg.presets.length > MAX_RUN_PRESETS)
      throw new Error(`${where}.presets is a list of at most ${MAX_RUN_PRESETS} background run presets.`);
    const seen = new Set<string>();
    for (let i = 0; i < cfg.presets.length; i++) {
      const entry = cfg.presets[i];
      const at = `${where}.presets[${i}]`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        throw new Error(`${at} is an object: { id, label, description?, prompt, agent?, roles? }.`);
      const p = entry as Record<string, unknown>;
      for (const key of Object.keys(p)) {
        if (!(RUN_PRESET_KEYS as readonly string[]).includes(key))
          throw new Error(`${at} has an unknown key "${key}"; it takes ${RUN_PRESET_KEYS.join(', ')}.`);
      }
      if (typeof p.id !== 'string' || !RUN_PRESET_ID.test(p.id))
        throw new Error(`${at}.id is lowercase letters, digits, hyphens or underscores, starting with a letter.`);
      if (seen.has(p.id)) throw new Error(`${at}.id duplicates "${p.id}".`);
      seen.add(p.id);
      if (typeof p.label !== 'string' || !p.label.trim() || p.label.trim().length > 80)
        throw new Error(`${at}.label is a non-empty string of at most 80 characters.`);
      if (p.description !== undefined && (typeof p.description !== 'string' || !p.description.trim() || p.description.trim().length > 240))
        throw new Error(`${at}.description is a non-empty string of at most 240 characters.`);
      if (typeof p.prompt !== 'string' || !p.prompt.trim() || p.prompt.trim().length > 2000)
        throw new Error(`${at}.prompt is a non-empty string of at most 2000 characters.`);
      let agent: string | undefined;
      if (p.agent !== undefined) {
        if (!agents || typeof p.agent !== 'string' || !Object.hasOwn(agents, p.agent))
          throw new Error(`${at}.agent names "${String(p.agent)}", which is not one of assistant.agents.`);
        agent = p.agent;
      }
      let roles: string[] | undefined;
      if (p.roles !== undefined) {
        if (!context.roles) throw new Error(`${at}.roles names roles, and the App declares no "auth" with roles.`);
        roles = subset(p.roles, context.roles as string[], `${at}.roles`);
      }
      presets.push({
        id: p.id,
        label: p.label.trim(),
        ...(p.description !== undefined ? { description: (p.description as string).trim() } : {}),
        prompt: p.prompt.trim(),
        ...(agent ? { agent } : {}),
        ...(roles ? { roles } : {}),
      });
    }
  }
  const schedules: AppAssistantRunSchedule[] = [];
  if (cfg.schedules !== undefined) {
    if (!Array.isArray(cfg.schedules) || cfg.schedules.length > MAX_RUN_SCHEDULES)
      throw new Error(`${where}.schedules is a list of at most ${MAX_RUN_SCHEDULES} schedules.`);
    const seen = new Set<string>();
    for (let i = 0; i < cfg.schedules.length; i++) {
      const entry = cfg.schedules[i];
      const at = `${where}.schedules[${i}]`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        throw new Error(`${at} is an object: { id, label, every, prompt, ... }.`);
      const s = entry as Record<string, unknown>;
      for (const key of Object.keys(s)) {
        if (!(RUN_SCHEDULE_KEYS as readonly string[]).includes(key))
          throw new Error(`${at} has an unknown key "${key}"; it takes ${RUN_SCHEDULE_KEYS.join(', ')}.`);
      }
      if (typeof s.id !== 'string' || !RUN_PRESET_ID.test(s.id))
        throw new Error(`${at}.id is lowercase letters, digits, hyphens or underscores, starting with a letter.`);
      if (seen.has(s.id)) throw new Error(`${at}.id duplicates "${s.id}".`);
      seen.add(s.id);
      if (typeof s.label !== 'string' || !s.label.trim() || s.label.trim().length > 80)
        throw new Error(`${at}.label is a non-empty string of at most 80 characters.`);
      if (s.description !== undefined && (typeof s.description !== 'string' || !s.description.trim() || s.description.trim().length > 240))
        throw new Error(`${at}.description is a non-empty string of at most 240 characters.`);
      const every = validateCronEvery(s.every, `${at}.every`);
      let timezone: string | undefined;
      if (s.timezone !== undefined) {
        if (typeof s.timezone !== 'string' || !s.timezone.trim()) throw new Error(`${at}.timezone is an IANA time zone name.`);
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: s.timezone.trim() });
        } catch {
          throw new Error(`${at}.timezone "${s.timezone}" is not an IANA time zone name.`);
        }
        timezone = s.timezone.trim();
      }
      if (typeof s.prompt !== 'string' || !s.prompt.trim() || s.prompt.trim().length > 2000)
        throw new Error(`${at}.prompt is a non-empty string of at most 2000 characters.`);
      let agent: string | undefined;
      if (s.agent !== undefined) {
        if (!agents || typeof s.agent !== 'string' || !Object.hasOwn(agents, s.agent))
          throw new Error(`${at}.agent names "${String(s.agent)}", which is not one of assistant.agents.`);
        agent = s.agent;
      }
      let roles: string[] | undefined;
      if (s.roles !== undefined) {
        if (!context.roles) throw new Error(`${at}.roles names roles, and the App declares no "auth" with roles.`);
        roles = subset(s.roles, context.roles as string[], `${at}.roles`);
      }
      if (s.enabled !== undefined && typeof s.enabled !== 'boolean') throw new Error(`${at}.enabled is true or false.`);
      schedules.push({
        id: s.id,
        label: s.label.trim(),
        ...(s.description !== undefined ? { description: (s.description as string).trim() } : {}),
        every,
        ...(timezone ? { timezone } : {}),
        prompt: s.prompt.trim(),
        ...(agent ? { agent } : {}),
        ...(roles ? { roles } : {}),
        enabled: s.enabled !== false,
      });
    }
  }
  const triggers: AppAssistantRunTrigger[] = [];
  if (cfg.triggers !== undefined) {
    if (!Array.isArray(cfg.triggers) || cfg.triggers.length > MAX_RUN_TRIGGERS)
      throw new Error(`${where}.triggers is a list of at most ${MAX_RUN_TRIGGERS} triggers.`);
    const seen = new Set<string>();
    for (let i = 0; i < cfg.triggers.length; i++) {
      const entry = cfg.triggers[i];
      const at = `${where}.triggers[${i}]`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        throw new Error(`${at} is an object: { id, label, resource, prompt, ... }.`);
      const t = entry as Record<string, unknown>;
      for (const key of Object.keys(t)) {
        if (!(RUN_TRIGGER_KEYS as readonly string[]).includes(key))
          throw new Error(`${at} has an unknown key "${key}"; it takes ${RUN_TRIGGER_KEYS.join(', ')}.`);
      }
      if (typeof t.id !== 'string' || !RUN_PRESET_ID.test(t.id))
        throw new Error(`${at}.id is lowercase letters, digits, hyphens or underscores, starting with a letter.`);
      if (seen.has(t.id)) throw new Error(`${at}.id duplicates "${t.id}".`);
      seen.add(t.id);
      if (typeof t.label !== 'string' || !t.label.trim() || t.label.trim().length > 80)
        throw new Error(`${at}.label is a non-empty string of at most 80 characters.`);
      if (t.description !== undefined && (typeof t.description !== 'string' || !t.description.trim() || t.description.trim().length > 240))
        throw new Error(`${at}.description is a non-empty string of at most 240 characters.`);
      if (typeof t.resource !== 'string' || !Object.hasOwn(context.actions, t.resource))
        throw new Error(`${at}.resource names "${String(t.resource)}", which is not a declared resource.`);
      const on: Array<'create' | 'update'> = t.on === undefined ? ['create'] : subset(t.on, RUN_TRIGGER_EVENTS, `${at}.on`);
      let fields: string[] | undefined;
      if (t.fields !== undefined) {
        if (!Array.isArray(t.fields) || !t.fields.length || t.fields.length > 20)
          throw new Error(`${at}.fields is a non-empty list of at most 20 field names.`);
        fields = [];
        for (const f of t.fields) {
          if (typeof f !== 'string' || !FIELD_NAME.test(f)) throw new Error(`${at}.fields names invalid column "${String(f)}".`);
          if (!fields.includes(f)) fields.push(f);
        }
      }
      if (typeof t.prompt !== 'string' || !t.prompt.trim() || t.prompt.trim().length > 2000)
        throw new Error(`${at}.prompt is a non-empty string of at most 2000 characters.`);
      let agent: string | undefined;
      if (t.agent !== undefined) {
        if (!agents || typeof t.agent !== 'string' || !Object.hasOwn(agents, t.agent))
          throw new Error(`${at}.agent names "${String(t.agent)}", which is not one of assistant.agents.`);
        agent = t.agent;
      }
      let roles: string[] | undefined;
      if (t.roles !== undefined) {
        if (!context.roles) throw new Error(`${at}.roles names roles, and the App declares no "auth" with roles.`);
        roles = subset(t.roles, context.roles as string[], `${at}.roles`);
      }
      if (t.enabled !== undefined && typeof t.enabled !== 'boolean') throw new Error(`${at}.enabled is true or false.`);
      let cooldownSeconds = DEFAULT_TRIGGER_COOLDOWN;
      if (t.cooldownSeconds !== undefined) {
        if (
          !Number.isSafeInteger(t.cooldownSeconds) ||
          (t.cooldownSeconds as number) < 0 ||
          (t.cooldownSeconds as number) > MAX_TRIGGER_COOLDOWN
        )
          throw new Error(`${at}.cooldownSeconds is a whole number, 0 to ${MAX_TRIGGER_COOLDOWN}.`);
        cooldownSeconds = t.cooldownSeconds as number;
      }
      triggers.push({
        id: t.id,
        label: t.label.trim(),
        ...(t.description !== undefined ? { description: (t.description as string).trim() } : {}),
        resource: t.resource,
        on,
        ...(fields ? { fields } : {}),
        prompt: t.prompt.trim(),
        ...(agent ? { agent } : {}),
        ...(roles ? { roles } : {}),
        enabled: t.enabled !== false,
        cooldownSeconds,
      });
    }
  }
  return { maxConcurrent, maxSteps, presets, schedules, triggers };
}

function parseAgents(
  raw: unknown,
  placement: AppAssistant['placement'],
  customBlocks: Record<string, AppAssistantCustomBlock> | undefined,
  knowledge: Record<string, AppAssistantKnowledgeSource> | undefined,
  skills: Record<string, AppAssistantSkill> | undefined,
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
  const knowledgeNames = Object.keys(knowledge ?? {});
  const skillNames = Object.keys(skills ?? {});
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
    if (a.memory !== undefined && typeof a.memory !== 'boolean') throw new Error(`${at}.memory is true or false.`);
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
    let agentKnowledge: string[] | undefined;
    if (a.knowledge !== undefined) {
      if (!knowledgeNames.length) throw new Error(`${at}.knowledge names knowledge sources, and the assistant declares no "knowledge".`);
      agentKnowledge = subset(a.knowledge, knowledgeNames, `${at}.knowledge`);
    }
    let agentSkills: string[] | undefined;
    if (a.skills !== undefined) {
      if (!skillNames.length) throw new Error(`${at}.skills names skills, and the assistant declares no "skills".`);
      agentSkills = subset(a.skills, skillNames, `${at}.skills`);
    }
    let subagents: string[] | undefined;
    if (a.subagents !== undefined) {
      subagents = nameList(a.subagents, (name) => ids.has(name), `${at}.subagents`, 'agent ids', 'is not one of the declared agents');
      if (subagents.includes(id)) throw new Error(`${at}.subagents cannot name "${id}" itself.`);
    }
    const limits = a.limits === undefined ? undefined : parseLimits(a.limits, `${at}.limits`);
    const agentProvider = parseAssistantProvider(a.provider, `${at}.provider`);
    const agentFallbacks = parseFallbackModels(a.fallbackModels, `${at}.fallbackModels`);
    out[id] = {
      id,
      name: a.name.trim(),
      ...(a.description !== undefined ? { description: (a.description as string).trim() } : {}),
      ...(a.icon !== undefined ? { icon: a.icon as AppIconName } : {}),
      ...(a.instructions !== undefined ? { instructions: (a.instructions as string).trim() } : {}),
      ...(a.model !== undefined ? { model: a.model as string } : {}),
      ...(agentProvider ? { provider: agentProvider } : {}),
      ...(agentFallbacks ? { fallbackModels: agentFallbacks } : {}),
      ...(a.effort !== undefined ? { effort: a.effort as AppAssistant['effort'] } : {}),
      ...(starters ? { starters } : {}),
      ...(roles ? { roles } : {}),
      ...(tools ? { tools } : {}),
      ...(exclude ? { exclude } : {}),
      ...(blocks ? { blocks } : {}),
      ...(agentCustomBlocks ? { customBlocks: agentCustomBlocks } : {}),
      ...(subagents ? { subagents } : {}),
      ...(limits ? { limits } : {}),
      ...(a.memory !== undefined ? { memory: a.memory as boolean } : {}),
      ...(agentKnowledge ? { knowledge: agentKnowledge } : {}),
      ...(agentSkills ? { skills: agentSkills } : {}),
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
  const provider = parseAssistantProvider(a.provider, `${where}.provider`);
  const fallbackModels = parseFallbackModels(a.fallbackModels, `${where}.fallbackModels`);
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
  const roleInstructions = parseRoleInstructions(a.roleInstructions, context, `${where}.roleInstructions`);
  const autoApproveCommands = parseAutoApproveCommands(a.autoApproveCommands, `${where}.autoApproveCommands`);
  const limits = parseLimits(a.limits, `${where}.limits`, { tokensPerPersonPerDay: DEFAULT_TOKENS_PER_PERSON_PER_DAY });
  const customBlocks = parseCustomBlocks(a.customBlocks, `${where}.customBlocks`);
  const memory = parseMemory(a.memory, context, `${where}.memory`);
  const knowledge = parseKnowledge(a.knowledge, context, `${where}.knowledge`);
  const skills = parseAssistantSkills(a.skills, context.roles, `${where}.skills`);
  const agents = parseAgents(a.agents, placement, customBlocks, knowledge, skills, context, `${where}.agents`);
  const backgroundRuns = parseBackgroundRuns(a.backgroundRuns, agents, context, `${where}.backgroundRuns`);
  const evals = parseEvals(a.evals, agents, context, `${where}.evals`);
  const externalTools = parseExternalTools(a.externalTools, context.roles, `${where}.externalTools`);
  const mcpServers = parseMcpServers(a.mcpServers, context.roles, `${where}.mcpServers`);
  const webhooks = parseAssistantWebhooks(a.webhooks, agents ? new Set(Object.keys(agents)) : undefined, `${where}.webhooks`);
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
    ...(roleInstructions ? { roleInstructions } : {}),
    starters,
    model: (a.model as string | undefined) ?? DEFAULT_ASSISTANT_MODEL,
    ...(provider ? { provider } : {}),
    ...(fallbackModels ? { fallbackModels } : {}),
    ...(a.effort === undefined ? {} : { effort: a.effort as AppAssistant['effort'] }),
    ...(a.effortPicker === true ? { effortPicker: true } : {}),
    reasoning,
    presentations,
    defaultPresentation,
    ...(roles ? { roles } : {}),
    tools,
    exclude,
    ...(autoApproveCommands ? { autoApproveCommands } : {}),
    blocks,
    placement,
    limits,
    ...(agents ? { agents } : {}),
    ...(defaultAgent ? { defaultAgent } : {}),
    ...(customBlocks ? { customBlocks } : {}),
    ...(memory ? { memory } : {}),
    ...(knowledge ? { knowledge } : {}),
    ...(backgroundRuns ? { backgroundRuns } : {}),
    ...(evals ? { evals } : {}),
    ...(externalTools ? { externalTools } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(skills ? { skills } : {}),
    ...(webhooks ? { webhooks } : {}),
  };
}

const AUTO_APPROVE_ID = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

function parseRoleInstructions(raw: unknown, context: AssistantContext, where: string): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${where} is a map of role names to instruction strings.`);
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (!entries.length || entries.length > 24) {
    throw new Error(`${where} maps 1 to 24 declared role names to instruction strings.`);
  }
  if (!context.roles) {
    throw new Error(`${where} names roles, and the App declares no "auth" with roles.`);
  }
  const out: Record<string, string> = {};
  for (const [role, value] of entries) {
    if (!context.roles.includes(role)) {
      throw new Error(`${where}.${role} names a role "${role}" that is not declared in auth.roles.`);
    }
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 2000) {
      throw new Error(`${where}.${role} is a non-empty instruction string (up to 2,000 characters).`);
    }
    out[role] = value.trim();
  }
  return out;
}

function parseAutoApproveCommands(raw: unknown, where: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.length || raw.length > 20) {
    throw new Error(`${where} is a list of 1 to 20 command names.`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== 'string' || !AUTO_APPROVE_ID.test(item.trim())) {
      throw new Error(`${where}[${i}] is a command id or "resource.action" name.`);
    }
    const clean = item.trim();
    if (seen.has(clean)) throw new Error(`${where} lists "${clean}" more than once.`);
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function parseEvalStringList(raw: unknown, where: string): string[] {
  if (!Array.isArray(raw) || !raw.length || raw.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${where} is a non-empty list of non-empty strings.`);
  }
  return [...new Set((raw as string[]).map((item) => item.trim()))];
}

function parseEvals(
  raw: unknown,
  agents: Record<string, AppAssistantAgent> | undefined,
  context: AssistantContext,
  where: string,
): AppAssistantEvalCase[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_EVALS) {
    throw new Error(`${where} is a list of 1 to ${MAX_EVALS} evaluation cases.`);
  }
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const at = `${where}[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${at} is an object: { id, label, prompt, expect }.`);
    }
    const e = entry as Record<string, unknown>;
    for (const key of Object.keys(e)) {
      if (!(EVAL_KEYS as readonly string[]).includes(key)) {
        throw new Error(`${at} has an unknown key "${key}"; an eval case takes ${EVAL_KEYS.join(', ')}.`);
      }
    }
    if (typeof e.id !== 'string' || !RUN_PRESET_ID.test(e.id)) {
      throw new Error(`${at}.id is a lowercase identifier (letters, digits, hyphens, underscores).`);
    }
    if (seen.has(e.id)) throw new Error(`${at}.id "${e.id}" is declared more than once.`);
    seen.add(e.id);
    if (typeof e.label !== 'string' || !e.label.trim() || e.label.trim().length > 80) {
      throw new Error(`${at}.label is a non-empty string up to 80 characters.`);
    }
    if (e.description !== undefined && (typeof e.description !== 'string' || !e.description.trim() || e.description.trim().length > 240)) {
      throw new Error(`${at}.description is a non-empty string up to 240 characters.`);
    }
    if (typeof e.prompt !== 'string' || !e.prompt.trim() || e.prompt.trim().length > 2000) {
      throw new Error(`${at}.prompt is a non-empty string up to 2000 characters.`);
    }
    if (e.agent !== undefined) {
      if (!agents || typeof e.agent !== 'string' || !Object.hasOwn(agents, e.agent)) {
        throw new Error(`${at}.agent names "${String(e.agent)}", which is not one of assistant.agents.`);
      }
    }
    let evalRoles: string[] | undefined;
    if (e.roles !== undefined) {
      if (!context.roles) throw new Error(`${at}.roles names roles, and the App declares no "auth" with roles.`);
      evalRoles = subset(e.roles, context.roles as string[], `${at}.roles`);
    }
    if (!e.expect || typeof e.expect !== 'object' || Array.isArray(e.expect)) {
      throw new Error(`${at}.expect is an object declaring at least one expectation.`);
    }
    const ex = e.expect as Record<string, unknown>;
    for (const key of Object.keys(ex)) {
      if (!(EVAL_EXPECT_KEYS as readonly string[]).includes(key)) {
        throw new Error(`${at}.expect has an unknown key "${key}"; it takes ${EVAL_EXPECT_KEYS.join(', ')}.`);
      }
    }
    const expect: AppAssistantEvalExpect = {};
    if (ex.answerMatches !== undefined) {
      if (typeof ex.answerMatches !== 'string' || !ex.answerMatches.trim()) {
        throw new Error(`${at}.expect.answerMatches is a non-empty string.`);
      }
      expect.answerMatches = ex.answerMatches.trim();
    }
    if (ex.expectedTools !== undefined) expect.expectedTools = parseEvalStringList(ex.expectedTools, `${at}.expect.expectedTools`);
    if (ex.forbiddenTools !== undefined) expect.forbiddenTools = parseEvalStringList(ex.forbiddenTools, `${at}.expect.forbiddenTools`);
    if (ex.expectedBlocks !== undefined) expect.expectedBlocks = parseEvalStringList(ex.expectedBlocks, `${at}.expect.expectedBlocks`);
    if (ex.expectCitations !== undefined) {
      if (typeof ex.expectCitations !== 'boolean') throw new Error(`${at}.expect.expectCitations is true or false.`);
      expect.expectCitations = ex.expectCitations;
    }
    if (ex.expectReasoning !== undefined) {
      if (typeof ex.expectReasoning !== 'boolean') throw new Error(`${at}.expect.expectReasoning is true or false.`);
      expect.expectReasoning = ex.expectReasoning;
    }
    if (ex.maxTokens !== undefined) {
      if (typeof ex.maxTokens !== 'number' || !Number.isInteger(ex.maxTokens) || ex.maxTokens < 1) {
        throw new Error(`${at}.expect.maxTokens is a positive integer.`);
      }
      expect.maxTokens = ex.maxTokens;
    }
    if (ex.maxSteps !== undefined) {
      if (typeof ex.maxSteps !== 'number' || !Number.isInteger(ex.maxSteps) || ex.maxSteps < 1 || ex.maxSteps > 32) {
        throw new Error(`${at}.expect.maxSteps is an integer from 1 to 32.`);
      }
      expect.maxSteps = ex.maxSteps;
    }
    if (!Object.keys(expect).length) {
      throw new Error(`${at}.expect declares at least one expectation.`);
    }
    return {
      id: e.id,
      label: e.label.trim(),
      ...(e.description === undefined ? {} : { description: (e.description as string).trim() }),
      prompt: e.prompt.trim(),
      ...(e.agent === undefined ? {} : { agent: e.agent as string }),
      ...(evalRoles ? { roles: evalRoles } : {}),
      expect,
    };
  });
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

/** Whether a viewer holding `roles` may write or delete `'app'`-scoped shared memories. */
export function canWriteSharedMemory(memory: AppAssistantMemory | undefined, roles: readonly string[]): boolean {
  if (!memory || !memory.scopes.includes('app')) return false;
  return !memory.sharedRoles || memory.sharedRoles.some((role) => roles.includes(role));
}

/** Viewer-safe memory capability summary for `/api/app` (never leaks `sharedRoles`). */
export function memoryFor(
  memory: (ServedAssistantMemory & { sharedRoles?: readonly string[] }) | undefined,
  roles: readonly string[],
): ServedAssistantMemory | undefined {
  if (!memory) return undefined;
  const { sharedRoles, ...rest } = memory;
  const writable = memory.scopes.includes('app') && (!sharedRoles || sharedRoles.some((role) => roles.includes(role)));
  return { ...rest, ...(writable ? { canWriteShared: true } : {}) };
}

/** Viewer-safe knowledge source summaries for `/api/app` (filters by `roles` and strips `roles`). */
export function knowledgeFor(
  knowledge: ReadonlyArray<ServedAssistantKnowledge & { roles?: readonly string[] }> | undefined,
  roles: readonly string[],
): ServedAssistantKnowledge[] {
  if (!knowledge?.length) return [];
  return knowledge
    .filter((source) => !source.roles || source.roles.some((role) => roles.includes(role)))
    .map(({ roles: _roles, ...rest }) => rest);
}

/** Viewer-safe background runs capability for `/api/app` (filters presets/schedules/triggers by `roles` and strips `roles`). */
export function backgroundRunsFor(
  runs:
    | (Omit<ServedAssistantBackgroundRuns, 'presets' | 'schedules' | 'triggers'> & {
        presets: ReadonlyArray<ServedAssistantBackgroundRuns['presets'][number] & { roles?: readonly string[] }>;
        schedules?: ReadonlyArray<NonNullable<ServedAssistantBackgroundRuns['schedules']>[number] & { roles?: readonly string[] }>;
        triggers?: ReadonlyArray<NonNullable<ServedAssistantBackgroundRuns['triggers']>[number] & { roles?: readonly string[] }>;
      })
    | undefined,
  roles: readonly string[],
): ServedAssistantBackgroundRuns | undefined {
  if (!runs) return undefined;
  const schedules = (runs.schedules ?? [])
    .filter((each) => !each.roles || each.roles.some((role) => roles.includes(role)))
    .map(({ roles: _roles, ...rest }) => rest);
  const triggers = (runs.triggers ?? [])
    .filter((each) => !each.roles || each.roles.some((role) => roles.includes(role)))
    .map(({ roles: _roles, ...rest }) => rest);
  return {
    maxConcurrent: runs.maxConcurrent,
    maxSteps: runs.maxSteps,
    presets: runs.presets
      .filter((preset) => !preset.roles || preset.roles.some((role) => roles.includes(role)))
      .map(({ roles: _roles, ...rest }) => rest),
    ...(schedules.length ? { schedules } : {}),
    ...(triggers.length ? { triggers } : {}),
  };
}

/** Viewer-safe eval cases for `/api/app` (filters by `roles` and strips `roles`). */
export function evalsFor(
  evals: ReadonlyArray<ServedAssistantEvalCase & { roles?: readonly string[] }> | undefined,
  roles: readonly string[],
): ServedAssistantEvalCase[] {
  if (!evals?.length) return [];
  return evals.filter((each) => !each.roles || each.roles.some((role) => roles.includes(role))).map(({ roles: _roles, ...rest }) => rest);
}

const minDefined = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.min(a, b);

function filterKnowledge(
  knowledge: Record<string, AppAssistantKnowledgeSource> | undefined,
  viewerRoles: readonly string[] | undefined,
  agentKeys?: readonly string[],
): Record<string, AppAssistantKnowledgeSource> | undefined {
  if (!knowledge) return undefined;
  const entries = Object.entries(knowledge).filter(([id, source]) => {
    if (agentKeys && !agentKeys.includes(id)) return false;
    if (viewerRoles && source.roles && !source.roles.some((role) => viewerRoles.includes(role))) return false;
    return true;
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function filterExternalTools(
  tools: Record<string, AppAssistantExternalTool> | undefined,
  viewerRoles: readonly string[] | undefined,
): Record<string, AppAssistantExternalTool> | undefined {
  if (!tools) return undefined;
  const entries = Object.entries(tools).filter(([, tool]) => {
    if (viewerRoles && tool.roles && !tool.roles.some((role) => viewerRoles.includes(role))) return false;
    return true;
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/**
 * Resolve an active named agent onto the App's base assistant definition, strictly narrowing authority and budgets.
 * Returns `{ assistant: base }` (with role-filtered knowledge sources) when the App declares no `agents`. Throws an
 * error if `agentId` is explicitly requested and does not exist or is not permitted for `viewerRoles`.
 */
function filterMcpServers(
  servers: Record<string, AppAssistantMcpServer> | undefined,
  viewerRoles?: readonly string[],
): Record<string, AppAssistantMcpServer> | undefined {
  if (!servers) return undefined;
  const entries = Object.entries(servers).filter(
    ([, srv]) => !srv.roles || !viewerRoles || viewerRoles.some((r) => srv.roles!.includes(r)),
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function filterSkills(
  skills: Record<string, AppAssistantSkill> | undefined,
  viewerRoles?: readonly string[],
  subsetIds?: readonly string[],
): Record<string, AppAssistantSkill> | undefined {
  if (!skills) return undefined;
  const entries = Object.entries(skills).filter(
    ([id, skill]) =>
      (!subsetIds || subsetIds.includes(id)) && (!skill.roles || !viewerRoles || viewerRoles.some((r) => skill.roles!.includes(r))),
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function roleInstructionLines(
  roleInstructions: Record<string, string> | undefined,
  viewerRoles: readonly string[] | undefined,
): string | undefined {
  if (!roleInstructions || !viewerRoles?.length) return undefined;
  const matched = Object.entries(roleInstructions)
    .filter(([role]) => viewerRoles.includes(role))
    .map(([role, text]) => `Role guidance (${role}): ${text}`);
  return matched.length ? matched.join('\n') : undefined;
}

/** Whether a named business command is explicitly allowlisted for direct execution under the viewer's own grants. */
export function isAutoApprovedCommand(
  assistant: Pick<AppAssistant, 'autoApproveCommands'>,
  resource: string,
  actionId: string,
  commandId: string | undefined,
): boolean {
  const list = assistant.autoApproveCommands;
  if (!list?.length || !commandId) return false;
  return list.includes(commandId) || list.includes(`${resource}.${actionId}`) || list.includes(actionId);
}

export function resolveAgentAssistant(
  base: AppAssistant,
  agentId: string | undefined,
  viewerRoles?: readonly string[],
): { assistant: AppAssistant; agent?: AppAssistantAgent } {
  const filteredExternal = filterExternalTools(base.externalTools, viewerRoles);
  const filteredMcp = filterMcpServers(base.mcpServers, viewerRoles);
  const roleGuidance = roleInstructionLines(base.roleInstructions, viewerRoles);
  if (!base.agents || !Object.keys(base.agents).length) {
    if (agentId !== undefined) throw new Error('This assistant does not declare named agents.');
    const filteredKnowledge = filterKnowledge(base.knowledge, viewerRoles);
    const filteredSkills = filterSkills(base.skills, viewerRoles);
    const mergedInstructions = [base.instructions, roleGuidance].filter(Boolean).join('\n\n') || undefined;
    if (
      mergedInstructions === base.instructions &&
      filteredKnowledge === base.knowledge &&
      filteredExternal === base.externalTools &&
      filteredMcp === base.mcpServers &&
      filteredSkills === base.skills
    )
      return { assistant: base };
    return {
      assistant: {
        ...base,
        ...(mergedInstructions ? { instructions: mergedInstructions } : {}),
        ...(filteredKnowledge ? { knowledge: filteredKnowledge } : { knowledge: undefined }),
        ...(filteredExternal ? { externalTools: filteredExternal } : { externalTools: undefined }),
        ...(filteredMcp ? { mcpServers: filteredMcp } : { mcpServers: undefined }),
        ...(filteredSkills ? { skills: filteredSkills } : { skills: undefined }),
      },
    };
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
  if (!agent) {
    const filteredKnowledge = filterKnowledge(base.knowledge, viewerRoles);
    const filteredSkills = filterSkills(base.skills, viewerRoles);
    const mergedInstructions = [base.instructions, roleGuidance].filter(Boolean).join('\n\n') || undefined;
    return {
      assistant: {
        ...base,
        ...(mergedInstructions ? { instructions: mergedInstructions } : {}),
        ...(filteredKnowledge ? { knowledge: filteredKnowledge } : { knowledge: undefined }),
        ...(filteredExternal ? { externalTools: filteredExternal } : { externalTools: undefined }),
        ...(filteredMcp ? { mcpServers: filteredMcp } : { mcpServers: undefined }),
        ...(filteredSkills ? { skills: filteredSkills } : { skills: undefined }),
      },
    };
  }
  const tools = agent.tools ? base.tools.filter((tool) => agent.tools!.includes(tool)) : base.tools;
  const blocks = agent.blocks ? base.blocks.filter((block) => agent.blocks!.includes(block)) : base.blocks;
  const exclude = [...new Set([...base.exclude, ...(agent.exclude ?? [])])];
  const customBlocks =
    base.customBlocks && agent.customBlocks
      ? Object.fromEntries(Object.entries(base.customBlocks).filter(([name]) => agent.customBlocks!.includes(name)))
      : base.customBlocks;
  const memory = agent.memory === false ? undefined : base.memory;
  const knowledge = filterKnowledge(base.knowledge, viewerRoles, agent.knowledge);
  const skills = filterSkills(base.skills, viewerRoles, agent.skills);
  const instructions = [base.instructions, roleGuidance, agent.instructions].filter(Boolean).join('\n\n') || undefined;
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
      ...((agent.provider ?? base.provider) ? { provider: agent.provider ?? base.provider } : {}),
      ...((agent.fallbackModels ?? base.fallbackModels) ? { fallbackModels: agent.fallbackModels ?? base.fallbackModels } : {}),
      ...((agent.effort ?? base.effort) ? { effort: agent.effort ?? base.effort } : {}),
      starters: agent.starters ?? base.starters,
      tools,
      blocks,
      exclude,
      limits,
      ...(customBlocks && Object.keys(customBlocks).length ? { customBlocks } : { customBlocks: undefined }),
      ...(memory ? { memory } : { memory: undefined }),
      ...(knowledge ? { knowledge } : { knowledge: undefined }),
      ...(filteredExternal ? { externalTools: filteredExternal } : { externalTools: undefined }),
      ...(filteredMcp ? { mcpServers: filteredMcp } : { mcpServers: undefined }),
      ...(skills ? { skills } : { skills: undefined }),
    },
  };
}
