/**
 * Query-language strings, checked by the types where a helper knows its table.
 *
 * `listView('Deals', 'opportunity', { query: 'stage = won' })` is a string
 * the server parses at startup; this file reads the same string at the call
 * site, against the table's columns, so `tsc` (an agent's edit loop as much
 * as an editor) names a column that is not there, an operator the language
 * does not have, or a value the column can never hold — where it is written:
 *
 *   Type '"stage = won"' is not assignable to type '{ "won is not a value of stage: prospecting, …": true; }'.
 *
 * The schema comes from the App's generated mistri-schema.d.ts, which
 * registers its `Columns` (each column's kind, a declared vocabulary as its
 * values) and `References` in `Register`, the mechanism the generated
 * commands file already uses. Without that file nothing is checked, and
 * loading the App judges the strings as before.
 *
 * It is a guard, not the parser: it reads conditions joined by `and`/`or`
 * and parentheses, the operators, `is (not) empty`, `is (not) open` and `is (not) <group>`, measures, group-bys and
 * sorts, and walks a path two references deep. Whatever it cannot read for
 * certain passes and `mistri check` judges it: a quoted value, `between`,
 * an operator without spaces around it, an upper-case AND, a third hop.
 * A string that reads costs one pass over it and builds nothing; only a
 * fault builds the shape that names it beside the string that has it.
 *
 * Where it reads: a helper's query, sort, measure and by (`QueryGuard`), and
 * a metric's compare and target too (`MetricGuard`); a rollup's column
 * (`RollupColumn`); a page section's `when` against the page's base
 * (`SectionsGuard`); a custom section's rows, each against its own `from`
 * (`RowsGuard`); and a fixed action's, notify rule's and machine verb's
 * `when` against the resource block `defineApp` or `defineFeature` keys them
 * under (`ResourceGuard`). The generated `Columns` names an App's computed
 * columns and rollups with its columns, so each is read like one.
 */
import type { Register } from './app.js';

/** A column's kind, as the generated `Columns` says it: a declared vocabulary is the list of its values. */
export type QueryColumnKind = 'text' | 'number' | 'date' | 'boolean' | 'other' | readonly string[];

/* ---------- the registered schema ---------- */

type QSame<A, B> = (<G>() => G extends A ? 1 : 2) extends (<G>() => G extends B ? 1 : 2) ? true : false;
/* The generated file registers a method, not a property: a program that reaches two Apps' files (a test, a
   monorepo's root) gets two overloads that merge rather than clash, and the checker stands down instead of
   judging one App by another's columns. One overload infers the same type twice. */
type QRegistered = Register extends { schema: { (): infer A; (): infer B } } ? QSame<A, B> extends true ? A : never : never;
type QColumns = QRegistered extends { columns: infer C } ? C : never;
type QReferences = QRegistered extends { references: infer R } ? R : never;
/* Each table's segments by name (resources.<table>.segments): a word a condition may say, and what a source names. */
type QSegments = QRegistered extends { segments: infer S } ? S : never;
type QSegmentsOf<T> = [QSegments] extends [never] ? never : T extends keyof QSegments ? QSegments[T] & string : never;
/** The table a source names: `work_order`, or `work_order.overdue`, a segment of it. */
export type QueryTable<T> = T extends keyof QColumns ? T : T extends `${infer R}.${string}` ? (R extends keyof QColumns ? R : T) : T;
/** Whether T's strings are checked: a schema is registered, and T is one of its tables. */
type QOn<T> = [QColumns] extends [never] ? false : T extends keyof QColumns ? true : false;

/** A fault, carried where a kind would be. */
interface QBad<Message extends string> { readonly bad: Message }
type QOwn<T> = T extends keyof QColumns ? QColumns[T] : never;
type QHops<T> = T extends keyof QReferences ? QReferences[T] : {};
type QName<T> = T & string;

/** The kind of a column or a label path of T, or the fault: two hops are walked, a third is taken on trust. */
type QKindAt<T, P extends string, Walked extends 0[] = []> =
  P extends keyof QOwn<T> ? QOwn<T>[P]
  : P extends `${infer Hop}.${infer Rest}`
    ? Hop extends keyof QHops<T> ? Walked['length'] extends 2 ? 'other' : QKindAt<QHops<T>[Hop], Rest, [...Walked, 0]>
      : QBad<`\`${Hop}\` is not a reference of ${QName<T>}`>
    /* The parser folds case on a column name; so does this, and only on the way to a fault. */
    : Lowercase<P> extends Lowercase<keyof QOwn<T> & string> ? 'other'
    : QBad<`\`${P}\` is not a column of ${QName<T>}`>;
type QColumnErr<T, P extends string> = QKindAt<T, P> extends QBad<infer M> ? M : never;

/* ---------- values ---------- */

type QUnit = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';
/** What `dateWindow` (packages/engine/src/shared/queryDates.ts) reads, lower-cased. */
type QDatePhrase = 'today' | 'yesterday' | 'tomorrow' | `${'this' | 'last'} ${'week' | 'month' | 'year'}` | `${'this' | 'last' | 'next'} quarter`
  | `${'last' | 'next' | 'previous'} ${bigint} ${QUnit}${'' | 's'}`;
/** A date's value: a phrase, a day, or `now`, the instant (query.ts binds it so on every engine). */
type QDateValue = QDatePhrase | 'now' | `${number}-${number}-${string}`;
type QJoin<L> = L extends readonly [infer A extends string, ...infer R] ? R extends readonly [] ? A : `${A}, ${QJoin<R>}` : string;
/** The marker a quoted value is replaced by before anything is read: quoted is text, and passes. */
type QQuoted = '§';

/** What is wrong with one value beside column C of kind K, where a value stands alone or in a list. */
type QValueErr<T, K, C extends string, V extends string> =
  V extends 'me' | QQuoted | '' ? never
  /* A path on the right is another column (`on_hand < product_id.reorder_level`); the view parser judges it. */
  : V extends `${string}.${string}` ? (V extends `${number}` ? QKindValueErr<T, K, C, V> : never)
  : QKindValueErr<T, K, C, V>;
type QKindValueErr<T, K, C extends string, V extends string> =
  K extends readonly string[] ? (V extends K[number] ? never : `${V} is not a value of ${C}: ${QJoin<K>}`)
  /* Beside a number, a date or a flag, a bare word naming a column is that column. */
  : V extends keyof QOwn<T> ? never
  : K extends 'number' ? (V extends `${number}` ? never : Lowercase<V> extends 'true' | 'false' | 'yes' | 'no' ? never : `${C} is a number, and ${V} is not one`)
  : K extends 'date' ? (Lowercase<V> extends QDateValue ? never : `${C} is a date: write today, now, last 30 days, this month or 2026-01-31, not ${V}`)
  : K extends 'boolean' ? (Lowercase<V> extends 'true' | 'false' | 'yes' | 'no' | '1' | '0' ? never : `${C} is true or false, not ${V}`)
  : never;

type QTrim<S extends string> = S extends ` ${infer R}` ? QTrim<R> : S extends `${infer R} ` ? QTrim<R> : S;
type QStrip<S extends string> = S extends `(${infer R}` ? QStrip<R> : S extends `${infer R})` ? QStrip<R> : QTrim<S>;
type QListErr<T, K, C extends string, L extends string> =
  L extends `${infer A},${infer B}` ? QValueErr<T, K, C, QTrim<A>> | QListErr<T, K, C, B> : QValueErr<T, K, C, QTrim<L>>;

/* ---------- conditions ---------- */

type QOperator = '=' | '!=' | '<' | '<=' | '>' | '>=';
type QCondErr<T, C extends string, Op extends string, V extends string, K> =
  K extends QBad<infer M> ? M
  : Op extends QOperator
    ? V extends `${string} ${string}`
      /* A bare multi-word value is a missing pair of quotes, unless it is a date phrase: the parser's own words. */
      ? Lowercase<V> extends QDatePhrase ? (K extends 'date' | 'other' ? never : QKindValueErr<T, K, C, V>)
        : `The value ${V} has a space, so quote it: ${C} ${Op} "${V}"`
      : QValueErr<T, K, C, V>
  : Op extends 'in' ? QListErr<T, K, C, QStrip<V>>
  : Op extends 'not' ? (V extends `${'in' | 'IN'} ${infer L}` ? QListErr<T, K, C, QStrip<L>> : never)
  : Op extends 'contains' | 'startswith' | 'endswith' | 'like' ? never
  /* A record's tags hold any of the labels: `tags has bug`, `tags has (bug, docs)`. */
  : Op extends 'has' ? never
  : `\`${Op}\` is not an operator: = != < <= > >= in, not in, contains, startswith, endswith, like, has, between, is empty, is not empty, is open, is not open, is <group>`;
/* A bare word is a segment's name (appSegments.ts): one T does not declare is said with those it does. */
type QWordErr<T, W extends string> =
  [QSegmentsOf<T>] extends [never] ? never
  /* `status=open` is a condition written tight, not a word. */
  : W extends QSegmentsOf<T> | '' | QQuoted | `${string}${'=' | '<' | '>' | '§'}${string}` ? never
  : `${W} is not a segment of ${QName<T>}`;
type QAtomErr<T, A extends string> =
  A extends `${string} ${string}` ? QAtomPairErr<T, A> : QWordErr<T, A>;
type QAtomPairErr<T, A extends string> =
  A extends `${infer C} is not empty` | `${infer C} is empty` ? QColumnErr<T, C>
  /* A machine's open states, its final ones, or a group it names (`status is onBench`): the server judges that the
     column has a machine and the group is one of its. */
  : A extends `${infer C} is not ${infer G}` ? QIsPairErr<T, A, C, G>
  : A extends `${infer C} is ${infer G}` ? QIsPairErr<T, A, C, G>
  : QOpErr<T, A>;
type QIsPairErr<T, A extends string, C extends string, G extends string> =
  C extends `${string} ${string}` ? QOpErr<T, A> : G extends `${string} ${string}` ? QOpErr<T, A> : QIsErr<T, C, G, QKindAt<T, C>>;
/* `is` reads open or a word of the column's vocabulary, where its machine's groups are listed beside its states. */
type QIsErr<T, C extends string, G extends string, K> =
  K extends QBad<infer M> ? M
  : Lowercase<G> extends 'open' ? never
  : K extends readonly string[] ? (G extends K[number] ? never : `\`${C} is ${G}\` reads open or a group of ${C}'s machine`)
  : never;
type QOpErr<T, A extends string> =
  A extends `${infer C} ${infer Op} ${infer V}` ? QCondErr<T, C, Lowercase<Op>, V, QKindAt<T, C>> : never;
type QAtoms<Q extends string> =
  Q extends `${infer A} or ${infer B}` ? QAtoms<A> | QAtoms<B>
  : Q extends `${infer A} and ${infer B}` ? QAtoms<A> | QAtoms<B>
  : QStrip<Q>;
type QEachAtom<T, A> = A extends string ? QAtomErr<T, A> : never;
type QUnquote<Q extends string> =
  Q extends `${infer A}"${string}"${infer B}` ? `${A}${QQuoted}${QUnquote<B>}`
  : Q extends `${infer A}'${string}'${infer B}` ? `${A}${QQuoted}${QUnquote<B>}` : Q;
/** Every fault of a condition string (a `query`, a command's `when`), read against T. */
type QQueryErr<T, Q extends string> = string extends Q ? never : QConditionsErr<T, QUnquote<Q>>;
type QConditionsErr<T, Q extends string> =
  Lowercase<Q> extends `${string} between ${string}` ? never
  : Q extends `${string} ${'AND' | 'OR' | 'And' | 'Or'} ${string}` ? never
  : Lowercase<Q> extends `${string} sort ${string}` | `sort ${string}` ? 'A query holds conditions only: say the order with sort'
  : QEachAtom<T, QAtoms<Q>>;

/* ---------- sorts, measures, group-bys ---------- */

type QSortErr<T, S extends string> = string extends S ? never
  : S extends `${infer A},${infer B}` ? QSortKeyErr<T, QTrim<A>> | QSortErr<T, B> : QSortKeyErr<T, QTrim<S>>;
/* The parser reads a key's first word as its column and `desc` after it; anything else after it reads as asc. */
type QSortKeyErr<T, K extends string> = K extends `${infer C} ${string}` ? QColumnErr<T, C> : K extends '' ? never : QColumnErr<T, K>;

type QMeasureFn = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'median';
type QNotMeasure<X extends string> = `\`${X}\` is not a measure: count, or sum, avg, min, max or median and a column`;
type QTermErr<T, X extends string> =
  X extends `${number}` ? never
  : X extends `${infer F} distinct ${infer C}` | `${infer F} ${infer C}` ? (Lowercase<F> extends QMeasureFn ? QColumnErr<T, C> : QNotMeasure<X>)
  : Lowercase<X> extends 'count' ? never
  : Lowercase<X> extends QMeasureFn ? `${X} needs a column: ${X} amount`
  : QNotMeasure<X>;
/* Word by word, a term ending at each operator: a pattern over the four operators at once split "sum a / sum b * 100"
   at every one of them, and read "a / sum b" as a column. */
type QOp = '+' | '-' | '*' | '/';
type QTermsErr<T, E extends string, Term extends string = ''> =
  E extends `${infer W} ${infer R}`
    ? W extends QOp ? QTermErr<T, Term> | QTermsErr<T, QTrim<R>> : QTermsErr<T, QTrim<R>, Term extends '' ? W : `${Term} ${W}`>
    : QTermErr<T, Term extends '' ? E : `${Term} ${E}`>;
type QMeasureErr<T, M extends string> = string extends M ? never : M extends `${infer E} as ${string}` ? QTermsErr<T, QTrim<E>> : QTermsErr<T, QTrim<M>>;

/* `auto` is a dashboard chart's word (the unit follows the window); the check refuses it anywhere else. */
type QPeriod = 'auto' | 'day' | 'week' | 'month' | 'quarter' | 'year' | 'weekday' | 'hour';
type QKeyErr<T, B extends string> =
  B extends `${infer K} as ${string}` ? QKeyErr<T, K>
  : B extends `${infer U} ${infer C}`
    ? Lowercase<U> extends QPeriod
      ? QKindAt<T, C> extends infer K ? K extends QBad<infer M> ? M : K extends 'date' | 'other' ? never : `${C} is not a date, so it has no ${Lowercase<U>}` : never
      : `\`${U}\` is not a period: day, week, month, quarter, year, weekday or hour`
  : QColumnErr<T, B>;
type QByErr<T, B extends string> = string extends B ? never
  : B extends `${infer A},${infer R}` ? QKeyErr<T, QTrim<A>> | QByErr<T, R> : QKeyErr<T, QTrim<B>>;

/* ---------- what the helpers take ---------- */

/** A fault set beside a string, as keys the string lacks, so tsc names them where the string is written. */
type QFault<E> = [E] extends [never] ? unknown : { [Fault in E & string]: true };
type QSortsErr<T, S> = S extends string ? QSortErr<T, S> : S extends readonly (infer E)[] ? (E extends { sort: infer X extends string } ? QSortErr<T, X> : never) : never;
/** A segment named where its table is the place's (`{ segment: 'open' }`, a tab), or the fault. */
export type SegmentErr<T, S extends string> = string extends S ? never : QWordErr<T, S>;
type QTabErr<T, Tab> = (Tab extends string ? SegmentErr<T, Tab> : never)
  | (Tab extends { segment: infer N extends string } ? SegmentErr<T, N> : never)
  | (Tab extends { query: infer Q extends string } ? QQueryErr<T, Q> : never) | (Tab extends { sort: infer S extends string } ? QSortErr<T, S> : never);
type QErrs<T, O> =
  (O extends { query: infer Q extends string } ? QQueryErr<T, Q> : never)
  | (O extends { segment: infer N extends string } ? SegmentErr<T, N> : never)
  | (O extends { measure: infer M extends string } ? QMeasureErr<T, M> : never)
  | (O extends { sort: infer S } ? QSortsErr<T, S> : never)
  | (O extends { tabs: readonly (infer Tab)[] } ? QTabErr<T, Tab> : never);
type QSortDetail<T, S> = S extends string ? QFault<QSortErr<T, S>>
  : { [I in keyof S]: S[I] extends { sort: infer X extends string } ? { sort: QFault<QSortErr<T, X>> } : unknown };
type QTabDetail<T, Tab> = (Tab extends string ? QFault<SegmentErr<T, Tab>> : unknown)
  & (Tab extends { segment: infer N extends string } ? { segment: QFault<SegmentErr<T, N>> } : unknown)
  & (Tab extends { query: infer Q extends string } ? { query: QFault<QQueryErr<T, Q>> } : unknown)
  & (Tab extends { sort: infer S extends string } ? { sort: QFault<QSortErr<T, S>> } : unknown);
type QDetail<T, O> =
  (O extends { query: infer Q extends string } ? { query: QFault<QQueryErr<T, Q>> } : unknown)
  & (O extends { segment: infer N extends string } ? { segment: QFault<SegmentErr<T, N>> } : unknown)
  & (O extends { measure: infer M extends string } ? { measure: QFault<QMeasureErr<T, M>> } : unknown)
  & (O extends { sort: infer S } ? { sort: QSortDetail<T, S> } : unknown)
  & (O extends { tabs: infer Tabs } ? { tabs: { [I in keyof Tabs]: QTabDetail<T, Tabs[I]> } } : unknown);

/**
 * A helper's options, read against its table T: `unknown` while every
 * `query`, `measure`, `sort` (or named sort) and tab `query`/`sort` reads;
 * otherwise, beside each string that does not, its faults as keys it lacks.
 * Written `opts: O & NoInfer<QueryGuard<T, O>>`.
 */
export type QueryGuard<F, O> = QOn<QueryTable<F>> extends true ? [QErrs<QueryTable<F>, O>] extends [never] ? unknown : QDetail<QueryTable<F>, O> : unknown;
/** A source (`from`): a table, or `table.segment` (`'work_order.overdue'`) — `unknown` while it reads, or the fault beside it. */
export type SourceGuard<F> = F extends `${infer T}.${infer S}` ? T extends keyof QColumns ? QFault<SegmentErr<T, S>> : unknown : unknown;
/* A metric's `compare` is a second query over its table, or the phrase that derives one; its `target` is a measure
   and a query over its own table (`from`), the metric's when it names none. Read only where a metric is written, so the
   other helpers pay nothing for keys they never have. */
type QCompareErr<T, C> = C extends 'previous period' ? never : C extends string ? QQueryErr<T, C> : never;
type QTargetOn<T, G> = G extends { from: infer U extends string } ? U : T;
type QTargetErr<T, G> = G extends object ? QOn<QTargetOn<T, G>> extends true
  ? (G extends { query: infer Q extends string } ? QQueryErr<QTargetOn<T, G>, Q> : never) | (G extends { measure: infer M extends string } ? QMeasureErr<QTargetOn<T, G>, M> : never)
  : never : never;
type QMetricErrs<T, O> = QErrs<T, O> | (O extends { compare: infer C } ? QCompareErr<T, C> : never) | (O extends { target: infer G } ? QTargetErr<T, G> : never);
type QMetricDetail<T, O> = QDetail<T, O>
  & (O extends { compare: infer C } ? { compare: QFault<QCompareErr<T, C>> } : unknown)
  & (O extends { target: infer G extends object } ? QOn<QTargetOn<T, G>> extends true ? { target:
    (G extends { query: infer Q extends string } ? { query: QFault<QQueryErr<QTargetOn<T, G>, Q>> } : unknown)
    & (G extends { measure: infer M extends string } ? { measure: QFault<QMeasureErr<QTargetOn<T, G>, M>> } : unknown) } : unknown : unknown);
/** A metric's options: what QueryGuard reads, and its `compare` and `target` too. */
export type MetricGuard<F, O> = QOn<QueryTable<F>> extends true ? [QMetricErrs<QueryTable<F>, O>] extends [never] ? unknown : QMetricDetail<QueryTable<F>, O> : unknown;
/* A picker's query may end in its order (`'active = true sort min_score desc'`): the conditions and the sort are each read. */
type QPickerErr<T, Q extends string> = string extends Q ? never
  : QUnquote<Q> extends `${infer C} sort ${infer S}` ? QConditionsErr<T, C> | QSortErr<T, S>
  : QUnquote<Q> extends `sort ${infer S}` ? QSortErr<T, S> : QQueryErr<T, Q>;
/** A reference field's options (`field.reference`), read against the resource it picks from: its `query` may end in a sort. */
export type PickerGuard<T, O> = QOn<T> extends true ? O extends { query: infer Q extends string } ? QFault<QPickerErr<T, Q>> extends infer F
  ? unknown extends F ? unknown : { query: F } : never : unknown : unknown;
/** A condition (a command's `when`): `unknown` when it reads against T, or its faults beside it. */
export type WhenGuard<T, W extends string> = QOn<T> extends true ? { when?: QFault<QQueryErr<T, W>> } : unknown;
/** A column of T as a command's lines hand it over (`field.lines`): a number, text, a day, yes or no, or one of its
    declared values; any of those where no schema is registered. */
export type ColumnValue<T, C extends string> = QOn<T> extends true
  ? QKindAt<T, C> extends infer K ? K extends 'number' ? number : K extends 'boolean' ? boolean
    : K extends readonly (infer V)[] ? V : K extends 'text' | 'date' ? string : string | number | boolean : never
  : string | number | boolean;
/** The columns of T a line shows, each once: a name that is not one of T's columns is refused where it is written. */
export type ShowGuard<T, S extends readonly string[]> = QOn<T> extends true
  ? { [I in keyof S]: S[I] extends keyof QOwn<T> ? S[I] : `${S[I] & string} is not a column of ${QName<T>}` } : S;
/** A positional group-by — `'month close_date'`, `'stage, month close_date'` — as written, or what is wrong with it. */
export type GroupBy<F, B extends string> = QueryTable<F> extends infer T ? QOn<T> extends true ? [QByErr<T, B>] extends [never] ? B : QByErr<T, B> : B : B;

/* ---------- where the table is the place's, not the helper's ---------- */

/** A rollup's column — `sum('order_line', 'amount')` — as written, or what is wrong with it: one of the rows' own
    columns (a computed one or a rollup of theirs among them), a number for a sum, a number or a date for a min or a max,
    any column for a latest. */
export type RollupColumn<F, Fn extends string, C extends string> = QOn<F> extends true
  ? C extends keyof QOwn<F> ? Fn extends 'latest' ? C : QOwn<F>[C] extends (Fn extends 'sum' ? 'number' | 'other' : 'number' | 'date' | 'other') ? C
      : `${C} is ${QOwn<F>[C] extends readonly string[] ? 'a vocabulary' : QOwn<F>[C] & string}; a ${Fn} reads ${Fn extends 'sum' ? 'numbers' : 'numbers or dates'}`
    : C extends `${string}.${string}` ? `${C} is a path; a rollup reads a column of its own rows` : QColumnErr<F, C>
  : C;

/* A `when` beside a condition's other words, read against T. */
type QWhenErr<T, X> = X extends { when: infer W extends string } ? QQueryErr<T, W> : never;
type QWhenDetail<T, X> = X extends { when: infer W extends string } ? { when?: QFault<QQueryErr<T, W>> } : unknown;
type QVerbs<M> = M extends { states: infer S } ? { [K in keyof S]: S[K] extends { on: infer On } ? On[keyof On] : never }[keyof S] : never;
type QResourceErrs<T, R> =
  (R extends { actions: infer A } ? { [K in keyof A]: QWhenErr<T, A[K]> }[keyof A] : never)
  | (R extends { notify: readonly (infer N)[] } ? QWhenErr<T, N> : never)
  | (R extends { machine: infer M } ? QWhenErr<T, QVerbs<M>> : never)
  | (R extends { segments: infer G } ? { [K in keyof G]: QSegmentQueryErr<T, G[K]> }[keyof G] : never);
/* A segment's conditions: written alone, or as `{ query, label }`. */
type QSegmentQueryErr<T, G> = G extends string ? QQueryErr<T, G> : G extends { query: infer Q extends string } ? QQueryErr<T, Q> : never;
type QResourceDetail<T, R> =
  (R extends { actions: infer A } ? { actions: { [K in keyof A]: QWhenDetail<T, A[K]> } } : unknown)
  & (R extends { notify: infer N } ? { notify: { [I in keyof N]: QWhenDetail<T, N[I]> } } : unknown)
  & (R extends { machine: { states: infer S } } ? { machine: { states: { [K in keyof S]: S[K] extends { on: infer On }
    ? { on: { [V in keyof On]: QWhenDetail<T, On[V]> } } : unknown } } } : unknown)
  & (R extends { segments: infer G } ? { segments: { [K in keyof G]: G[K] extends string ? QFault<QSegmentQueryErr<T, G[K]>>
    : { query: QFault<QSegmentQueryErr<T, G[K]>> } } } : unknown);
/**
 * A resource block read against its table T, where `defineApp` and `defineFeature` see it whole: each fixed
 * action's, notify rule's and machine verb's `when`, and each segment's conditions. `action()` and a notify rule do not know their table where
 * they are written; the block they are keyed under does.
 */
export type ResourceGuard<T, R> = QOn<T> extends true ? [QResourceErrs<T, R>] extends [never] ? unknown : QResourceDetail<T, R> : unknown;

/* A page section's `when` is about the page's record, so it is read against the page's base. */
type QSectionErr<T, Sec> = Sec extends unknown ? QWhenErr<T, Sec> : never;
/** A page's sections, read against its base T: `unknown` while every section's `when` reads, or its faults. */
export type SectionsGuard<T, Sec> = QOn<T> extends true ? QFault<QSectionErr<T, Sec>> : unknown;

/* A custom section's reads, each over its own `from`. */
type QRowErr<R> = R extends { from: infer F } ? QOn<F> extends true ? QErrs<F, R> : never : never;
/** A custom section's options: each of its `rows` read against the table it names. */
export type RowsGuard<O> = O extends { rows: infer Rows } ? [{ [K in keyof Rows]: QRowErr<Rows[K]> }[keyof Rows]] extends [never] ? unknown
  : { rows: { [K in keyof Rows]: Rows[K] extends { from: infer F } ? QOn<F> extends true ? QDetail<F, Rows[K]> : unknown : unknown } } : unknown;
