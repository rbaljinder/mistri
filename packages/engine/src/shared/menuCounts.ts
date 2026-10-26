/**
 * Which menu rows carry a count (ui.shell.counts), on both sides: the client's menu (sidebarModel.ts) and the
 * server's first paint, which asks for the same counts before the menu draws (firstPaintRooms.ts).
 *
 * A count beside a list says work is waiting. A number beside every list made the menu a column of figures —
 * Products 218, Customers 40, Stock 900 — in which the one that mattered did not stand out, and a catalog's size
 * is not news. So a list is counted where its standing condition says it is work:
 *
 * - (a) its machine's states that are not final: `status = to_pick`, `status != shipped` where shipped is the one
 *   final state, `status in (draft, sent)`, `status is open`, or a group of open states (`status is onBench`);
 * - (b) a date at or before today: `ship_by <= today`, `due before today`;
 * - (c) the reader: `owner = me`.
 *
 * A plain filter (`status = active`) is not work. An author says otherwise for one list with its `count`.
 * A count of (b), work past its date, is said in the danger's ink; no other count is an alarm.
 *
 * A list's query may name its resource's segments (appSegments.ts): `query: 'open'` is read as the conditions
 * the segment names, so it is counted exactly as the same conditions written inline are.
 */
import { expandSegments } from './query.js';

export interface CountedMachine {
  column: string;
  states: readonly { value: string; final?: true }[];
  groups?: Readonly<Record<string, readonly string[]>>;
}

const PAST = /(?:<=?|\bbefore)\s*(?:today|now)\b/i;
const ME = /(?:^|[\s(,=])me(?=$|[\s),])/;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = (list: string) =>
  list
    .split(',')
    .map((word) => word.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);

/** Whether a condition is of work past its date. */
function pastDue(condition: string): boolean {
  return PAST.test(condition);
}

/** Whether the condition picks out only states its machine has not finished with. */
function openStates(condition: string, machine: CountedMachine | undefined): boolean {
  if (!machine) return false;
  const final = new Set(machine.states.filter((state) => state.final).map((state) => state.value));
  const open = (value: string) => machine.states.some((state) => state.value === value) && !final.has(value);
  // The machine's own column, never a path through a reference to another table's column of that name.
  const column = `(?<![\\w.])${escape(machine.column)}`;
  const value = `["']?([\\w-]+)["']?`;
  /* `status is open` is the machine's own name for its unfinished states (query.ts). */
  if (new RegExp(`${column}\\s+is\\s+open\\b`, 'i').test(condition) && machine.states.some((state) => !final.has(state.value))) return true;
  /* A group the machine names (`status is onBench`) is work when every state it holds is. */
  for (const [, group] of condition.matchAll(new RegExp(`${column}\\s+is\\s+(\\w+)\\b`, 'gi'))) {
    const held = machine.groups && Object.hasOwn(machine.groups, group!) ? machine.groups[group!] : undefined;
    if (held?.length && held.every(open)) return true;
  }
  for (const [, state] of condition.matchAll(new RegExp(`${column}\\s*=\\s*${value}`, 'g'))) if (open(state!)) return true;
  for (const [, list] of condition.matchAll(new RegExp(`${column}\\s+in\\s*\\(([^)]*)\\)`, 'gi')))
    if (words(list!).length && words(list!).every(open)) return true;
  const left = new Set<string>();
  for (const [, state] of condition.matchAll(new RegExp(`${column}\\s*!=\\s*${value}`, 'g'))) left.add(state!);
  for (const [, list] of condition.matchAll(new RegExp(`${column}\\s+not\\s+in\\s*\\(([^)]*)\\)`, 'gi')))
    words(list!).forEach((w) => left.add(w));
  return final.size > 0 && left.size > 0 && [...final].every((state) => left.has(state));
}

/**
 * Whether a menu row counts its list, and whether that count is late. `count` is the list's own say
 * (`count: true` or `false`), which wins. `segments` are the list's resource's, by name, to their conditions.
 */
export function menuCount(
  written: string,
  machine: CountedMachine | undefined,
  count?: boolean,
  segments?: Readonly<Record<string, string>>,
): { counted: boolean; late: boolean } {
  const condition = expandSegments(written, segments).text;
  const late = pastDue(condition);
  if (count !== undefined) return { counted: count, late: count && late };
  const counted = late || ME.test(condition) || openStates(condition, machine);
  return { counted, late: counted && late };
}
