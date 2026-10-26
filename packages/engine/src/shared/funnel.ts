/**
 * A funnel over rows (`funnel()`, a dashboard section): how many of the rows a section holds reach each of its stages,
 * in order. The stages are conditions on the one table; a row reaches stage k when it holds the section's own query and
 * every required stage up to k. An optional stage is counted against the chain before it, and the stages after it do
 * not need it — so one key covers a strict road and an any-order checklist (every stage optional).
 *
 * Every stage is counted in the one statement (`count when [...]`, breakdown.ts): one snapshot, so a later stage can
 * never exceed an earlier one under concurrent writes, which separate counts could.
 *
 * Pure text in, text out: the client draws from it, the server asks from it for a first page (firstPaintRooms.ts), and
 * `mistri check` judges with it.
 */
import { andQuery, topLevelConditions } from './query.js';

export interface FunnelStage {
  /** The stage as a reader says it, said from the catalogs by the time it is parsed. */
  label: string;
  /** Conditions only (segments are words in it); absent, every row the section holds. */
  query?: string;
  /** Counted against the chain before it, and not required by the stages after it. */
  optional?: boolean;
}

export const FUNNEL_MIN_STAGES = 2;
export const FUNNEL_MAX_STAGES = 8;

/** The answer's column for stage `index` (0-based): the alias its measure is asked under. */
export const stageColumn = (index: number): string => `stage_${index + 1}`;

/**
 * The conditions of each stage's reached rows: the required stages before it, then its own. Empty text for a stage
 * that asks nothing of the rows, which are all of them.
 */
export function funnelChains(stages: readonly Pick<FunnelStage, 'query' | 'optional'>[]): string[] {
  const required: string[] = [];
  return stages.map((stage) => {
    const chain = andQuery(...required, stage.query);
    if (!stage.optional && stage.query?.trim()) required.push(stage.query);
    return chain;
  });
}

/**
 * The stage each stage is a share of: the last required stage before it. The first stage has none. A funnel whose
 * first stage is optional is refused where it is parsed (appViews.ts), so every later stage has one.
 */
export function funnelBasis(stages: readonly Pick<FunnelStage, 'optional'>[]): Array<number | null> {
  let last: number | null = null;
  return stages.map((stage, index) => {
    const basis = last;
    if (!stage.optional) last = index;
    return basis;
  });
}

/** The line a funnel asks: its table, the section's conditions, then one count per stage. */
export function funnelText(section: { table?: string; query?: string; stages?: readonly FunnelStage[] }): string | null {
  if (!section.table || !section.stages?.length) return null;
  const measures = funnelChains(section.stages).map((chain, index) =>
    chain ? `count when [${chain}] as ${stageColumn(index)}` : `count as ${stageColumn(index)}`,
  );
  return [section.table, section.query, measures.join(', ')].filter(Boolean).join(' ');
}

const COMPARE_OPPOSITE: Record<string, string> = { '=': '!=', '!=': '=', '>': '<=', '>=': '<', '<': '>=', '<=': '>' };
/* A value that is a phrase of the date grammar or a clock word, not a plain value: its opposite is not what `!=` says. */
const NOT_PLAIN_VALUE = /^(today|yesterday|tomorrow|now|this|next|last|previous)$/i;
const VALUE = String.raw`("[^"]*"|'[^']*'|[^\s"',()]+)`;

/**
 * One condition's opposite, or undefined where the language cannot say it exactly. The opposite is exact for a row
 * with nothing in the column too: `status = approved` is not `status != approved` (a SQL comparison skips an empty
 * value), it is `status != approved or status is empty`. Unsaid on purpose: a phrase of dates, a nested `or`, `has`,
 * anything the language has no word for, since the drill must open the rows the figure counted and no others.
 */
export function negateCondition(condition: string): string | undefined {
  const text = condition.replace(/\s+/g, ' ').trim();
  if (!text || text.startsWith('(')) return undefined;
  const rows = /^(any|no) (.+)$/i.exec(text);
  if (rows) return `${rows[1].toLowerCase() === 'any' ? 'no' : 'any'} ${rows[2]}`;
  const empty = /^([\w.$+]+) is (not )?empty$/i.exec(text);
  if (empty) return `${empty[1]} is ${empty[2] ? '' : 'not '}empty`;
  const compare = new RegExp(String.raw`^([\w.$+]+) (=|!=|>=|<=|>|<) ${VALUE}$`).exec(text);
  if (compare && !NOT_PLAIN_VALUE.test(compare[3]))
    return `${compare[1]} ${COMPARE_OPPOSITE[compare[2]]} ${compare[3]} or ${compare[1]} is empty`;
  const among = /^([\w.$+]+) in \((.+)\)$/i.exec(text);
  if (among) {
    const values = among[2].match(new RegExp(String.raw`${VALUE}(?=\s*(,|$))`, 'g'));
    const whole = new RegExp(String.raw`^\s*${VALUE}(\s*,\s*${VALUE})*\s*$`);
    if (!values?.length || !whole.test(among[2]) || values.some((value) => NOT_PLAIN_VALUE.test(value))) return undefined;
    return `${values.map((value) => `${among[1]} != ${value}`).join(' and ')} or ${among[1]} is empty`;
  }
  return undefined;
}

/**
 * The rows that do not hold a query, or undefined when any of its conditions cannot be turned over exactly. A query
 * is its conditions all at once, so its opposite is any one of their opposites.
 */
export function negateQuery(query: string, segments?: Readonly<Record<string, string>>): string | undefined {
  const held = topLevelConditions(query, segments);
  if (!held.length) return undefined;
  const opposites = held.map(negateCondition);
  return opposites.every((text): text is string => text !== undefined) ? opposites.join(' or ') : undefined;
}

/**
 * The rows a stage lost: those that reached the stage it is a share of and do not hold its own conditions. Only a
 * required stage drops rows (an optional one is a side road), and only where its conditions can be turned over.
 */
export function droppedQuery(
  stages: readonly FunnelStage[],
  index: number,
  segments?: Readonly<Record<string, string>>,
): string | undefined {
  const stage = stages[index];
  if (!stage || stage.optional || index === 0 || !stage.query?.trim()) return undefined;
  const opposite = negateQuery(stage.query, segments);
  if (!opposite) return undefined;
  const before = stages.slice(0, index).flatMap((earlier) => (!earlier.optional && earlier.query?.trim() ? [earlier.query] : []));
  return andQuery(...before, opposite);
}
