/** An App's assistant, as declared: who is offered it, which of the fixed
 * tools and blocks it may use, which of the App's verbs it may never propose,
 * and what it may spend. The declaration only narrows: every read and every
 * proposal is still the person's own, under their grants (docs/assistant.md). */

/** The tool core, the same for every App: discovery is a tool, not a preamble. */
export const ASSISTANT_TOOLS = ['find', 'describe', 'query', 'show', 'run'] as const;
type AssistantTool = (typeof ASSISTANT_TOOLS)[number];
/** The blocks the model may compose: the App's own components, never markup. */
export const ASSISTANT_BLOCKS = ['table', 'metric', 'chart', 'breakdown', 'record'] as const;
type AssistantBlockKind = (typeof ASSISTANT_BLOCKS)[number];
/** Where it is offered: a panel beside every room, with a record as its context, and a room of its own (`/{app}/assistant`). */
export const ASSISTANT_PLACEMENTS = ['panel', 'record', 'page'] as const;
export const ASSISTANT_EFFORTS = ['low', 'medium', 'high'] as const;
/** The model an App gets unless it names one; the operator's key decides whether any is reachable. */
const DEFAULT_ASSISTANT_MODEL = 'claude-sonnet-5-5';
const LIMIT_KEYS = ['tokensPerTurn', 'tokensPerPersonPerDay', 'tokensPerDay'] as const;
/** What one person may spend in a UTC day when the App names no figure: an assistant is a bill the operator pays,
 * so an open sign-up is not an open tab. A modest day's use fits; an App that expects more names its own
 * `limits.tokensPerPersonPerDay`. */
export const DEFAULT_TOKENS_PER_PERSON_PER_DAY = 200_000;
/** How long a conversation untouched is kept, in days, when nothing says otherwise: every App's, and a tenant App's
 * unless its policy names `assistant.retentionDays`. */
export const ASSISTANT_RETENTION_DAYS = 90;
const KEYS = ['instructions', 'starters', 'model', 'effort', 'roles', 'tools', 'exclude', 'blocks', 'placement', 'limits'] as const;
/** An empty conversation offers a few of the App's own questions, each a line the person sends with one press: at
    most six in any one place, however many the App declares for its different places. */
const MAX_STARTERS = 6;
const MAX_STARTER = 120;
const STARTER_KEYS = ['text', 'views', 'records'] as const;

/**
 * A starter offered in some places only: in the named views (their own rooms, a list or a dashboard), on a record of
 * the named tables, or both. A starter that is a bare line is offered everywhere.
 *
 *   starters: ['Find stale deals', { text: 'Summarize this ticket', records: ['incident'] }]
 */
export interface AssistantStarter {
  text: string;
  /** View keys: offered while one of these views is the room. */
  views?: string[];
  /** Table names: offered while a record of one of these tables is open. */
  records?: string[];
}

interface AssistantLimits {
  /** Input and output tokens one turn may spend, every model call in it counted; a call's cached input (the turn so far,
   * read again) counts at a tenth, as it is billed. */
  tokensPerTurn?: number;
  /** One person's tokens in a UTC day, across their conversations; `DEFAULT_TOKENS_PER_PERSON_PER_DAY` when not named. */
  tokensPerPersonPerDay?: number;
  /** Every person's tokens in the App in a UTC day. */
  tokensPerDay?: number;
}

export interface AppAssistant {
  /** What the App's assistant is for and how it should answer: the author's words, prefixed by the platform's own rules. */
  instructions?: string;
  /** Questions an empty conversation offers, in the App's words: each sent as the person's own when pressed. A bare
      line is offered everywhere, a starter with `views` or `records` only there. */
  starters: Array<string | AssistantStarter>;
  model: string;
  effort?: (typeof ASSISTANT_EFFORTS)[number];
  /** The roles offered the assistant; absent, everyone who may open the App. */
  roles?: string[];
  tools: AssistantTool[];
  /** Verbs it may never propose, as `resource.action` (an action's key, or `new` for the New form). */
  exclude: string[];
  blocks: AssistantBlockKind[];
  placement: Array<(typeof ASSISTANT_PLACEMENTS)[number]>;
  limits: AssistantLimits;
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
  const exclude: string[] = [];
  if (a.exclude !== undefined) {
    if (!Array.isArray(a.exclude)) throw new Error(`${where}.exclude is a list of "resource.action".`);
    for (const entry of a.exclude) {
      const [resource, action, rest] = typeof entry === 'string' ? entry.split('.') : [];
      if (!resource || !action || rest !== undefined)
        throw new Error(`${where}.exclude has "${String(entry)}"; each is "resource.action", or "resource.new" for its New form.`);
      const actions = context.actions[resource];
      if (!actions) throw new Error(`${where}.exclude names "${resource}", which is not one of the App's resources.`);
      if (action !== 'new' && !actions.includes(action)) {
        throw new Error(
          `${where}.exclude names "${entry}"; resources.${resource} has no action "${action}"${actions.length ? ` (it has ${actions.join(', ')})` : ''}.`,
        );
      }
      exclude.push(entry);
    }
  }
  const limits: AssistantLimits = { tokensPerPersonPerDay: DEFAULT_TOKENS_PER_PERSON_PER_DAY };
  if (a.limits !== undefined) {
    if (!a.limits || typeof a.limits !== 'object' || Array.isArray(a.limits)) throw new Error(`${where}.limits is an object.`);
    for (const [key, value] of Object.entries(a.limits)) {
      if (!(LIMIT_KEYS as readonly string[]).includes(key))
        throw new Error(`${where}.limits has an unknown key "${key}"; it takes ${LIMIT_KEYS.join(', ')}.`);
      if (!Number.isSafeInteger(value) || (value as number) < 1000)
        throw new Error(`${where}.limits.${key} is a whole number of tokens, at least 1000.`);
      limits[key as keyof AssistantLimits] = value as number;
    }
  }
  return {
    ...(a.instructions === undefined ? {} : { instructions: (a.instructions as string).trim() }),
    starters,
    model: (a.model as string | undefined) ?? DEFAULT_ASSISTANT_MODEL,
    ...(a.effort === undefined ? {} : { effort: a.effort as AppAssistant['effort'] }),
    ...(roles ? { roles } : {}),
    tools,
    exclude,
    blocks,
    placement,
    limits,
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
    throw new Error(`${where} is a list of questions an empty conversation offers: a line, or { text, views, records }.`);
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
    if (starter.views === undefined && starter.records === undefined)
      throw new Error(`${at} names no place: give it views, records or both, or write the line alone to offer it everywhere.`);
    const out: AssistantStarter = { text: line };
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
  /* At most six in any one place: everywhere's, with a view's own or a record's own. */
  const everywhere = starters.filter((s) => typeof s === 'string').length;
  const places = [
    ['everywhere', everywhere] as const,
    ...Object.keys(views).map(
      (key) => [`in view "${key}"`, everywhere + starters.filter((s) => typeof s !== 'string' && s.views?.includes(key)).length] as const,
    ),
    ...[...tables].map(
      (table) =>
        [`on a ${table} record`, everywhere + starters.filter((s) => typeof s !== 'string' && s.records?.includes(table)).length] as const,
    ),
  ];
  const crowded = places.find(([, count]) => count > MAX_STARTERS);
  if (crowded) throw new Error(`${where} offers ${crowded[1]} starters ${crowded[0]}; at most ${MAX_STARTERS} are offered in one place.`);
  return starters;
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
