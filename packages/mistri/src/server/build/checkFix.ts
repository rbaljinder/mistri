/**
 * `mistri check --design --fix`: delete what the App restates, in its own
 * source, and name a query it repeats as a segment (fixRepeatedQueries). The set is exactly the `restated` warnings' (displayDefaults.ts
 * restatedDefaults): a display rule or concern the conventions give anyway,
 * a form default that is the schema's DEFAULT, a verb's `set` of the stamp its
 * state writes on entry.
 *
 * The App is TypeScript a person wrote, so the rewrite is minimal: the
 * property's text and its comma go, nothing else moves. The files are read
 * with a small scanner of object literals — strings, templates and comments
 * skipped — rather than a parser the package does not ship: a rule is found
 * by the key it sits under (`display`, `defaults`, `set`), its column and its
 * literal value, and is deleted only where that finds exactly as many places
 * as the App restates it. Anything less certain is left, and said.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AppDef } from '../../shared/appModel.js';
import { restatedDefaults, type RestatedRule } from '@mistriwork/engine/shared/displayDefaults.js';
import { tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { repeatedQueries } from '../../shared/appSegments.js';
import { authored } from './checkProblems.js';

/** A literal value, or OPAQUE where the source computes it. */
export const OPAQUE = Symbol('opaque');
export type Literal = string | number | boolean | null | Literal[] | { [key: string]: Literal } | typeof OPAQUE;

export interface Property {
  key: string;
  /** Where the property's text starts (its key) and ends (after its value). */
  start: number;
  end: number;
  /** Where its value's text starts. */
  valueStart?: number;
  value: Literal;
  /** The object literal its value is, when it is one. */
  object?: ObjectNode;
  /** The items of the array literal its value is, when it is one: each one's text and object. */
  items?: ArrayItem[];
}
interface ArrayItem {
  start: number;
  end: number;
  value: Literal;
  object?: ObjectNode;
}
export interface ObjectNode {
  start: number;
  end: number;
  props: Property[];
}

/* The DSL's stamp constants, read as the words they stand for. */
const WORDS: Record<string, Literal> = { true: true, false: false, null: null, now: 'now', today: 'today', me: 'me' };

export class Scanner {
  i = 0;
  /** Where the last value read ended, before any space after it. */
  ended = 0;
  constructor(readonly text: string) {}
  /** Past whitespace and comments. */
  skip(): void {
    const t = this.text;
    for (;;) {
      while (this.i < t.length && /\s/.test(t[this.i])) this.i++;
      if (t.startsWith('//', this.i)) this.i = t.indexOf('\n', this.i) < 0 ? t.length : t.indexOf('\n', this.i);
      else if (t.startsWith('/*', this.i)) this.i = t.indexOf('*/', this.i) < 0 ? t.length : t.indexOf('*/', this.i) + 2;
      else return;
    }
  }
  /** A quoted string from its opening quote; the index ends past it. */
  string(): string {
    const t = this.text;
    const quote = t[this.i++];
    let out = '';
    while (this.i < t.length && t[this.i] !== quote) {
      if (t[this.i] === '\\') {
        out += t[this.i + 1];
        this.i += 2;
      } else out += t[this.i++];
    }
    this.i++;
    return out;
  }
  /** Past a template literal, with its `${…}` holes balanced. */
  template(): void {
    const t = this.text;
    this.i++;
    while (this.i < t.length && t[this.i] !== '`') {
      if (t[this.i] === '\\') this.i += 2;
      else if (t.startsWith('${', this.i)) {
        this.i += 2;
        this.balanced('}');
      } else this.i++;
    }
    this.i++;
  }
  /** Past everything up to the closing character at this depth (consumed). */
  balanced(close: string): void {
    const t = this.text;
    while (this.i < t.length) {
      this.skip();
      const c = t[this.i];
      if (c === close) {
        this.i++;
        return;
      }
      if (c === '"' || c === "'") this.string();
      else if (c === '`') this.template();
      else if (c === '{' || c === '(' || c === '[') this.nested();
      else this.i++;
    }
  }
  /** Past a bracketed group from its opening bracket. */
  nested(): void {
    const close = { '{': '}', '(': ')', '[': ']' }[this.text[this.i] as '{' | '(' | '['];
    this.i++;
    this.balanced(close);
  }
  /** A value up to the `,` or closing bracket that ends it. */
  value(): { value: Literal; object?: ObjectNode; items?: ArrayItem[] } {
    this.skip();
    const t = this.text;
    const start = this.i;
    const c = t[this.i];
    let value: Literal;
    let object: ObjectNode | undefined;
    let positions: ArrayItem[] | undefined;
    if (c === '{') {
      object = this.object();
      value = Object.fromEntries(object.props.map((prop) => [prop.key, prop.value]));
      if (object.props.some((prop) => prop.value === OPAQUE)) value = OPAQUE;
    } else if (c === '[') {
      this.i++;
      const items: Literal[] = [];
      positions = [];
      for (;;) {
        this.skip();
        if (t[this.i] === ']') {
          this.i++;
          break;
        }
        const itemStart = this.i;
        const read = this.value();
        const item = read.value;
        items.push(item);
        positions.push({ start: itemStart, end: this.ended, value: item, ...(read.object ? { object: read.object } : {}) });
        this.skip();
        if (t[this.i] === ',') this.i++;
        else if (t[this.i] !== ']') {
          this.rest();
          return { value: OPAQUE };
        }
      }
      value = items.includes(OPAQUE) ? OPAQUE : items;
    } else if (c === '"' || c === "'") value = this.string();
    else if (/[-\d]/.test(c)) {
      const m = /^-?\d+(\.\d+)?/.exec(t.slice(this.i));
      this.i += m ? m[0].length : 1;
      value = m ? Number(m[0]) : OPAQUE;
    } else {
      const m = /^[A-Za-z_$][\w$]*/.exec(t.slice(this.i));
      this.i += m ? m[0].length : 0;
      value = m && Object.hasOwn(WORDS, m[0]) ? WORDS[m[0]] : OPAQUE;
    }
    // Anything after the first token that is not the end of the value (a call, an operator, `as const`) makes it opaque.
    this.ended = this.i;
    this.skip();
    if (t[this.i] !== ',' && t[this.i] !== '}' && t[this.i] !== ']' && this.i < t.length) {
      if (/^as\s+const\b/.test(t.slice(this.i))) {
        this.i += /^as\s+const/.exec(t.slice(this.i))![0].length;
        this.ended = this.i;
        this.skip();
        if (t[this.i] === ',' || t[this.i] === '}' || t[this.i] === ']')
          return { value, ...(object ? { object } : {}), ...(positions ? { items: positions } : {}) };
      }
      this.i = start;
      this.rest();
      this.ended = this.i;
      return { value: OPAQUE };
    }
    return { value, ...(object ? { object } : {}), ...(positions ? { items: positions } : {}) };
  }
  /** Past an opaque expression, to the `,` or closing bracket at its depth. */
  rest(): void {
    const t = this.text;
    while (this.i < t.length) {
      this.skip();
      const c = t[this.i];
      if (c === ',' || c === '}' || c === ']' || c === ')') return;
      if (c === '"' || c === "'") this.string();
      else if (c === '`') this.template();
      else if (c === '{' || c === '(' || c === '[') this.nested();
      else this.i++;
    }
  }
  /** An object literal from its `{`. */
  object(): ObjectNode {
    const t = this.text;
    const start = this.i++;
    const props: Property[] = [];
    for (;;) {
      this.skip();
      if (this.i >= t.length) break;
      if (t[this.i] === '}') {
        this.i++;
        break;
      }
      const keyStart = this.i;
      let key: string | undefined;
      if (t[this.i] === '"' || t[this.i] === "'") key = this.string();
      else if (t.startsWith('...', this.i)) {
        this.i += 3;
        this.rest();
      } else {
        const m = /^[\w$]+/.exec(t.slice(this.i));
        if (m) {
          key = m[0];
          this.i += m[0].length;
        } else this.rest();
      }
      this.skip();
      if (key !== undefined && t[this.i] === ':') {
        this.i++;
        this.skip();
        const valueStart = this.i;
        const { value, object, items } = this.value();
        props.push({
          key,
          start: keyStart,
          end: this.ended,
          valueStart,
          value,
          ...(object ? { object } : {}),
          ...(items ? { items } : {}),
        });
      } else if (key !== undefined && (t[this.i] === ',' || t[this.i] === '}')) {
        props.push({ key, start: keyStart, end: keyStart + key.length, value: OPAQUE });
      } else if (key !== undefined) this.rest();
      this.skip();
      if (t[this.i] === ',') this.i++;
      else if (t[this.i] !== '}') this.rest();
      if (this.i >= t.length) break;
    }
    return { start, end: this.i, props };
  }
}

/** Every object literal written under one of these keys (`display: { … }`), with the property that holds it. */
function objectsUnder(text: string, keys: readonly string[]): Array<{ key: string; holder: Property }> {
  const found: Array<{ key: string; holder: Property }> = [];
  const scanner = new Scanner(text);
  const pattern = new RegExp(`(^|[^\\w$.'"])(${keys.join('|')})\\s*:\\s*\\{`, 'g');
  /* A key inside a string or a comment is not one: mark both away first. */
  const masked = maskedText(text);
  for (const match of masked.matchAll(pattern)) {
    const keyStart = match.index! + match[1].length;
    scanner.i = masked.indexOf('{', keyStart);
    const object = scanner.object();
    found.push({ key: match[2], holder: { key: match[2], start: keyStart, end: scanner.i, value: OPAQUE, object } });
  }
  return found;
}

/* The text with strings, templates and comments blanked, so a search for keys finds only code. */
export function maskedText(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const scanner = new Scanner(text);
  while (scanner.i < text.length) {
    const c = text[scanner.i];
    const at = scanner.i;
    if (text.startsWith('//', at) || text.startsWith('/*', at)) {
      scanner.skip();
      blank(at, scanner.i);
    } else if (c === '"' || c === "'") {
      scanner.string();
      blank(at + 1, scanner.i - 1);
    } else if (c === '`') {
      scanner.template();
      blank(at + 1, scanner.i - 1);
    } else scanner.i++;
  }
  return out.join('');
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== 'object') return value;
  if ('auto' in value && Object.keys(value).length === 1) return (value as { auto: unknown }).auto;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sorted(v)]),
  );
}

/** The range a property takes with its comma: the line it stands on when it has one to itself. */
function cut(text: string, object: ObjectNode, prop: Property): [number, number] {
  let end = prop.end;
  let k = end;
  /* A block comment between the value and its comma is the property's, and goes with it: stopping at it took the
     comma before instead, and a first property's cut left the comment and its comma standing alone. */
  for (;;) {
    while (k < object.end && /[ \t]/.test(text[k])) k++;
    const close = text.startsWith('/*', k) ? text.indexOf('*/', k) : -1;
    if (close < 0 || text.slice(k, close).includes('\n')) break;
    k = close + 2;
  }
  let start = prop.start;
  if (text[k] === ',') end = k + 1;
  else {
    // The last property: its comma is the one before it.
    let back = start - 1;
    while (back > object.start && /\s/.test(text[back])) back--;
    if (text[back] === ',') start = back;
  }
  // A property on a line of its own takes the line with it.
  const lineStart = text.lastIndexOf('\n', prop.start - 1) + 1;
  const lineEnd = text.indexOf('\n', end);
  if (start === prop.start && /^\s*$/.test(text.slice(lineStart, prop.start)) && lineEnd >= 0 && /^\s*$/.test(text.slice(end, lineEnd)))
    return [lineStart, lineEnd + 1];
  if (start === prop.start) while (end < text.length && text[end] === ' ') end++;
  return [start, end];
}

/** A merged run of cuts that ends its object takes the comma before it, and one that
    empties it leaves `{}`: `{ a: 1, b: 2, c: 3 }` losing b and c is `{ a: 1 }`, not `{ a: 1,  }`. */
function settle(text: string, range: [number, number]): void {
  let after = range[1];
  while (after < text.length && /\s/.test(text[after])) after++;
  if (text[after] !== '}') return wholeLines(text, range);
  let before = range[0] - 1;
  while (before >= 0 && /\s/.test(text[before])) before--;
  // On lines of their own the last property keeps its trailing comma, so only a one-line object needs this.
  if (text.slice(before, after).includes('\n')) return wholeLines(text, range);
  if (text[before] === ',') range[0] = before;
  else if (text[before] === '{') [range[0], range[1]] = [before + 1, after];
}

/** A run of cuts that leaves its lines blank (two properties sharing a line, both gone) takes the lines too. */
function wholeLines(text: string, range: [number, number]): void {
  const lineStart = text.lastIndexOf('\n', range[0] - 1) + 1;
  const lineEnd = text.indexOf('\n', range[1]);
  if (lineEnd >= 0 && /^[ \t]*$/.test(text.slice(lineStart, range[0])) && /^[ \t]*$/.test(text.slice(range[1], lineEnd)))
    [range[0], range[1]] = [lineStart, lineEnd + 1];
}

/**
 * The text with the ranges cut: nested cuts (a rule's key and then the whole rule) keep the outermost, overlapping
 * ones (two neighbours, the last taking the comma the one before it also takes) are one, and each run is settled
 * against what is left around it. `moved` says where a position of the old text stands in the new one.
 */
function applyCuts(text: string, ranges: Array<[number, number]>): { text: string; moved: (at: number) => number | undefined } {
  const merge = (list: Array<[number, number]>) => {
    const kept: Array<[number, number]> = [];
    for (const [start, end] of [...list].sort((a, b) => a[0] - b[0] || b[1] - a[1])) {
      const last = kept[kept.length - 1];
      if (last && start <= last[1]) last[1] = Math.max(last[1], end);
      else kept.push([start, end]);
    }
    return kept;
  };
  const merged = merge(ranges);
  for (const range of merged) settle(text, range);
  /* Settling can reach back over a comma a neighbouring cut already took; cut twice, that text broke the braces around it. */
  const kept = merge(merged);
  let out = text;
  for (const [start, end] of [...kept].reverse()) out = out.slice(0, start) + out.slice(end);
  const moved = (at: number) => {
    let shift = 0;
    for (const [start, end] of kept) {
      if (at >= end) shift += end - start;
      else if (at >= start) return undefined;
    }
    return at - shift;
  };
  return { text: out, moved };
}

/* Where a fix deletes keys: the anchors restatements sit under. */
const ANCHORS = ['display', 'defaults', 'set', 'labels'] as const;

/** Every object literal with something in it, written under an anchor, by where it starts. */
function filledObjects(text: string): Set<number> {
  const found = new Set<number>();
  const visit = (object: ObjectNode) => {
    if (object.props.length) found.add(object.start);
    for (const prop of object.props) if (prop.object) visit(prop.object);
  };
  for (const { holder } of objectsUnder(text, ANCHORS)) visit(holder.object!);
  return found;
}

/**
 * Cut, then take away what the cuts emptied: an object that held something and holds nothing now goes with its
 * key (`method: {}` once its `values` went, and then a `display: {}` that held only it), so a fix never leaves an
 * empty rule behind. An object written empty, or holding only a spread or a comment, is the App's and stays.
 */
function cutAndTidy(text: string, ranges: Array<[number, number]>): string {
  let filled = filledObjects(text);
  for (let round = 0; ranges.length && round < 16; round++) {
    const cutText = applyCuts(text, ranges);
    filled = new Set([...filled].map(cutText.moved).filter((at): at is number => at !== undefined));
    text = cutText.text;
    ranges = [];
    const visit = (prop: Property, outer: ObjectNode) => {
      const inner = prop.object!;
      if (!inner.props.length && filled.has(inner.start) && /^\s*$/.test(text.slice(inner.start + 1, inner.end - 1)))
        ranges.push(cut(text, outer, prop));
      else for (const each of inner.props) if (each.object) visit(each, inner);
    };
    for (const { holder } of objectsUnder(text, ANCHORS)) visit(holder, { start: 0, end: text.length, props: [] });
  }
  return text;
}

/* Brackets that close in order and no comma standing alone (`{ ,`, `, ,`): the shape the rewrite must keep. */
function wellFormed(text: string): boolean {
  const masked = maskedText(text);
  const open: string[] = [];
  for (const c of masked) {
    if (c === '{' || c === '(' || c === '[') open.push(c);
    else if (c === '}' || c === ')' || c === ']') {
      if (open.pop() !== { '}': '{', ')': '(', ']': '[' }[c]) return false;
    }
  }
  return !open.length;
}
const strayCommas = (text: string) => (maskedText(text).match(/[{[(,]\s*,/g) ?? []).length;

/** A scalar property written anywhere (`recordLabel: 'name'`): its key, range and literal value. */
function scalarsNamed(text: string, key: string): Array<{ holder: ObjectNode; prop: Property }> {
  const found: Array<{ holder: ObjectNode; prop: Property }> = [];
  const masked = maskedText(text);
  const scanner = new Scanner(text);
  for (const match of masked.matchAll(new RegExp(`(^|[^\\w$.])(${key})\\s*:`, 'g'))) {
    const start = match.index! + match[1].length;
    scanner.i = start + match[0].length - match[1].length;
    const { value } = scanner.value();
    /* Its comma is found by the cut, within the whole text. */
    found.push({ holder: { start: 0, end: text.length, props: [] }, prop: { key, start, end: scanner.ended, value } });
  }
  return found;
}

/** Each place a restatement is written as the App declares it: the object holding its keys, and that object's holder. */
interface Place {
  file: string;
  /** The object the keys are deleted from, and the property holding it (with the object around that one). */
  object: ObjectNode;
  holder: Property;
  outer: ObjectNode;
  /** The key the place was found under (`display: { … }`), when the holder sits inside it. */
  anchor?: Property;
}

function locate(rule: RestatedRule, declared: unknown, texts: Map<string, string>): Place[] {
  const places: Place[] = [];
  for (const [file, text] of texts) {
    if (!rule.at.length) {
      for (const { holder, prop } of scalarsNamed(text, rule.keys[0]))
        if (prop.value !== OPAQUE && same(prop.value, declared)) places.push({ file, object: holder, holder: prop, outer: holder });
      continue;
    }
    for (const { holder: anchor } of objectsUnder(text, [rule.at[0]])) {
      let outer: ObjectNode = { start: 0, end: text.length, props: [] };
      let holder: Property | undefined = anchor;
      for (const key of rule.at.slice(1)) {
        const next: Property | undefined = holder?.object?.props.find((prop) => prop.key === key);
        if (!next?.object) {
          holder = undefined;
          break;
        }
        outer = holder!.object!;
        holder = next;
      }
      const object = holder?.object;
      if (!holder || !object) continue;
      /* The parser adds what a rule implies (a tone is humanized), so the source is matched key by key: each written key as declared, and the restated keys all written. */
      const held = (declared ?? {}) as Record<string, unknown>;
      if (object.props.some((prop) => prop.value === OPAQUE || !(prop.key in held) || !same(prop.value, held[prop.key]))) continue;
      if (!rule.keys.every((key) => object.props.some((prop) => prop.key === key))) continue;
      places.push({ file, object, holder, outer, ...(holder !== anchor && outer === anchor.object ? { anchor } : {}) });
    }
  }
  return places;
}

interface FixResult {
  /** One line per deletion made: the file and what went. */
  fixed: string[];
  /** One line per restatement left as it was, and why. */
  left: string[];
}

/** The App's own TypeScript and JavaScript sources: what a person wrote, never generated types, and only the
    modules that author the App (checkProblems.ts authored) — a test or a seed beside it that writes the same
    rule would make a deletion two places, and leave it. */
export function appSources(dir: string): string[] {
  const files: Array<{ path: string; lines: string[] }> = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|mts|js|mjs)$/.test(name) && !name.endsWith('.d.ts'))
        files.push({ path, lines: readFileSync(path, 'utf8').split('\n') });
    }
  };
  walk(dir);
  authored(dir, files);
  return files.map((file) => file.path);
}

/* What a restatement's warning says it is, for a line of the fix's report. */
const what = (rule: RestatedRule) =>
  rule.warning.replace(/^resources "([^"]+)" \[restated\]: /, 'resources "$1": ').replace(/[,.] (which|Delete).*$/, '');

/**
 * Delete every restatement in the App's sources (the `restated` warnings'
 * set). `app` is the App as loaded; `dir` its directory.
 */
export function fixRestated(
  app: AppDef,
  schema: DatabaseSchema,
  dir: string,
  /* What the warnings leave out (a label said through a message is a translation, not a restatement): never a deletion either. */
  unsaid: (warning: string) => boolean = () => false,
): FixResult {
  const restated = restatedDefaults(app, schema).filter((rule) => !unsaid(rule.warning));
  const result: FixResult = { fixed: [], left: [] };
  if (!restated.length) return result;
  const texts = new Map(appSources(dir).map((file) => [file, readFileSync(file, 'utf8')] as const));
  /* A restatement is found by what the App says there; the same words in two places are two deletions, never one guessed. */
  const groups = new Map<string, { rules: RestatedRule[]; declared: unknown }>();
  for (const rule of restated) {
    const declared = rule.at.length ? rule.held : (app.resources?.[rule.resource] as Record<string, unknown> | undefined)?.[rule.keys[0]];
    const id = JSON.stringify([rule.at, rule.at.length ? null : rule.keys, sorted(declared)]);
    const group = groups.get(id) ?? { rules: [], declared };
    group.rules.push(rule);
    groups.set(id, group);
  }
  /* What each object loses, by the place that holds it, so one emptied goes whole: `display: {}` says nothing. */
  /* Keyed by file and offset: each group's search parses afresh, so the same object is a new node each time. */
  const losing = new Map<
    string,
    { file: string; object: ObjectNode; holder: Property; outer: ObjectNode; anchor?: Property; keys: Set<string> }
  >();
  for (const { rules, declared } of groups.values()) {
    const places = locate(rules[0], declared, texts);
    /* Where the same declaration is written once for each restatement of it, each is one; otherwise it is the App's to say. */
    const resources = new Set(rules.map((rule) => rule.resource));
    if (places.length !== resources.size) {
      for (const rule of rules)
        result.left.push(
          `${what(rule)}: ${places.length ? `written in ${places.length} places` : 'not found as written'}; delete it by hand`,
        );
      continue;
    }
    for (const place of places) {
      /* A scalar's place is the whole text (no object), so its own offset tells two apart. */
      const at = `${place.file}:${place.object.start}:${place.object.props.length ? '' : place.holder.start}`;
      const held = losing.get(at) ?? { ...place, keys: new Set<string>() };
      for (const rule of rules) for (const key of rule.keys) held.keys.add(key);
      losing.set(at, held);
    }
    const files = [...new Set(places.map((place) => relative(dir, place.file)))].join(', ');
    for (const rule of rules) result.fixed.push(`${files}: ${what(rule)}: deleted`);
  }
  const edits = new Map<string, Array<[number, number]>>();
  /* The holders each anchor loses whole: an anchor emptied (every rule under `display` gone) goes itself. */
  const emptied = new Map<string, { file: string; anchor: Property; gone: Set<number> }>();
  for (const { file, object, holder, outer, anchor, keys } of losing.values()) {
    const text = texts.get(file)!;
    const list = edits.get(file) ?? [];
    const props = object.props.filter((prop) => keys.has(prop.key));
    if (!object.props.length || props.length === object.props.length) {
      list.push(cut(text, outer, holder));
      if (anchor) {
        const gone = emptied.get(`${file}:${anchor.start}`) ?? { file, anchor, gone: new Set<number>() };
        gone.gone.add(holder.start);
        emptied.set(`${file}:${anchor.start}`, gone);
      }
    } else for (const prop of props) list.push(cut(text, object, prop));
    edits.set(file, list);
  }
  for (const { file, anchor, gone } of emptied.values())
    if (gone.size === anchor.object!.props.length) {
      const text = texts.get(file)!;
      edits.get(file)!.push(cut(text, { start: 0, end: text.length, props: [] }, anchor));
    }
  for (const [file, ranges] of edits) {
    const before = texts.get(file)!;
    const text = cutAndTidy(before, ranges);
    /* The scanner is not a parser: a rewrite whose brackets no longer close, or that leaves a comma standing alone,
       is not written, and its deletions are the person's. */
    if (wellFormed(before) && (!wellFormed(text) || strayCommas(text) > strayCommas(before))) {
      const here = (line: string) => line.split(': ')[0].split(', ').includes(relative(dir, file));
      for (const line of result.fixed.filter(here))
        result.left.push(`${line.replace(/: deleted$/, '')}: the rewrite would not parse; delete it by hand`);
      result.fixed = result.fixed.filter((line) => !here(line));
      continue;
    }
    writeFileSync(file, text);
  }
  return result;
}

/** Every object literal assigned to or held under `resources` (`export const resources = { … }`, `resources: { … }`). */
function resourceObjects(text: string): ObjectNode[] {
  const masked = maskedText(text);
  const scanner = new Scanner(text);
  const found: ObjectNode[] = [];
  for (const match of masked.matchAll(/(^|[^\w$.'"])resources\s*(?::|=)\s*\{/g)) {
    scanner.i = masked.indexOf('{', match.index! + match[1].length);
    found.push(scanner.object());
  }
  return found;
}

const said = (query: string) => query.trim().replace(/\s+/g, ' ');

/**
 * The tables the text says the `query:` written at `at` reads: a `table:` or
 * `from:` beside it, or the strings the call it is an argument of names before
 * it (`count('thread', { query })`, `field.reference('board', { query })`).
 * The same words over another table are another query, and are left alone.
 */
function tablesAround(text: string, at: number): string[] {
  const masked = maskedText(text);
  /* The bracket left open before `from`: brackets inside strings and comments are masked away. */
  const opener = (from: number) => {
    let depth = 0;
    for (let k = from; k >= 0; k--) {
      const c = masked[k];
      if (c === '}' || c === ')' || c === ']') depth++;
      else if (c === '{' || c === '(' || c === '[') {
        if (depth === 0) return k;
        depth--;
      }
    }
    return -1;
  };
  const open = opener(at - 1);
  if (open < 0 || masked[open] !== '{') return [];
  const scanner = new Scanner(text);
  scanner.i = open;
  const named = scanner
    .object()
    .props.filter((prop) => (prop.key === 'table' || prop.key === 'from') && typeof prop.value === 'string')
    .map((prop) => prop.value as string);
  const call = opener(open - 1);
  if (call < 0 || masked[call] !== '(') return named;
  /* The call's own arguments before the object: a quote at depth 0, its contents masked, closes at the next same quote. */
  let depth = 0;
  for (let k = call + 1; k < open; k++) {
    const c = masked[k];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (depth === 0 && (c === "'" || c === '"')) {
      const end = masked.indexOf(c, k + 1);
      if (end < 0 || end > open) break;
      named.push(text.slice(k + 1, end));
      k = end;
    }
  }
  return named;
}

/**
 * Lift each query the `repeated-query` warnings name into a segment of its
 * resource, and say its name where the query was written: `query: 'status =
 * open'` in each place becomes `query: 'open'`, and the resource gains
 * `segments: { open: 'status = open' }`. Only where the name reads off the
 * query (or the resource already declares it), every place is found as a
 * `query:` written word for word, and the resource's own object is found
 * once; anything else is said and left.
 */
export function fixRepeatedQueries(app: AppDef, schema: DatabaseSchema, dir: string): FixResult {
  const result: FixResult = { fixed: [], left: [] };
  const repeated = repeatedQueries(app, schema);
  if (!repeated.length) return result;
  const texts = new Map(appSources(dir).map((file) => [file, readFileSync(file, 'utf8')] as const));
  for (const query of repeated) {
    const what = `resources "${query.resource}": the query '${query.query}'`;
    if (!query.name) {
      result.left.push(`${what}: no name reads off it; name it as a segment by hand`);
      continue;
    }
    /* Its places are the ones over its own table, as the warning counted them (appSegments.ts repeatedQueries). */
    const table = tableNamed(schema, app.resources?.[query.resource]?.physical ?? query.resource);
    const places = [...texts].flatMap(([file, text]) =>
      scalarsNamed(text, 'query')
        .filter(({ prop }) => typeof prop.value === 'string' && said(prop.value) === query.query)
        .filter(({ prop }) => !!table && tablesAround(text, prop.start).some((name) => tableNamed(schema, name)?.id === table.id))
        .map(({ prop }) => ({ file, prop })),
    );
    if (places.length !== query.places.length) {
      result.left.push(`${what}: written in ${query.places.length} places, found as \`query:\` in ${places.length}; lift it by hand`);
      continue;
    }
    const holders = query.declared
      ? []
      : [...texts].flatMap(([file, text]) =>
          resourceObjects(text).flatMap((object) => {
            const prop = object.props.find((item) => item.key === query.resource && item.object);
            return prop ? [{ file, object: prop.object! }] : [];
          }),
        );
    if (!query.declared && holders.length !== 1) {
      result.left.push(
        `${what}: the resource "${query.resource}" is ${holders.length ? 'declared in several places' : 'not found as an object'}; lift it by hand`,
      );
      continue;
    }
    const edits = new Map<string, Array<{ at: number; end: number; text: string }>>();
    const edit = (file: string, at: number, end: number, text: string) => edits.set(file, [...(edits.get(file) ?? []), { at, end, text }]);
    for (const { file, prop } of places) edit(file, prop.start, prop.end, `query: '${query.name}'`);
    if (holders.length) {
      const { file, object } = holders[0];
      const segments = object.props.find((prop) => prop.key === 'segments' && prop.object);
      const entry = `${query.name}: '${query.query.replaceAll("'", "\\'")}'`;
      /* Written as the object is: on a line of its own, at its first property's indent, where the object has lines. */
      const into = (open: number, put: string) => {
        const text = texts.get(file)!;
        const line = /^[ \t]*\n([ \t]*)/.exec(text.slice(open + 1));
        edit(file, open + 1, open + 1, line ? `\n${line[1]}${put}` : ` ${put}`);
      };
      if (segments) into(segments.object!.start, `${entry},`);
      else into(object.start, `segments: { ${entry} },`);
    }
    for (const [file, list] of edits) {
      let text = texts.get(file)!;
      for (const { at, end, text: put } of list.sort((a, b) => b.at - a.at)) text = text.slice(0, at) + put + text.slice(end);
      texts.set(file, text);
      writeFileSync(file, text);
    }
    const files = [...new Set(places.map((place) => relative(dir, place.file)))].join(', ');
    result.fixed.push(`${files}: ${what}: named "${query.name}" in ${places.length} places`);
  }
  return result;
}
