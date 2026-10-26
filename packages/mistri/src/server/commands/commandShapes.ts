/**
 * Output shapes: the small builders a command's `output` is written with.
 *
 * A command's output is kept whole in its receipt and returned on every
 * replay, so it is checked before commit and again before a replay is
 * disclosed. A shape is that check and the handler's return type in one
 * declaration: `shape({ leadId: id(), message: literal('Lead converted.') })`
 * types what `handle` may return and refuses anything else at run time.
 *
 * A shape is any synchronous `parse(value)` — the contract `output` has always
 * had — and these builders are the way to write one. `shape` projects: the
 * value it returns holds its declared keys and nothing more, so a stray field
 * never lands in a receipt. Every parse builds a fresh value and never keeps
 * the one it was given.
 */

/** What `output` takes: a synchronous parser from anything to the output. */
export interface Shape<T> {
  parse(value: unknown): T;
}

/** The value a shape parses to: `ShapeOf<typeof convertOutput>`. */
export type ShapeOf<S> = S extends Shape<infer T> ? T : never;

/** Internal output vocabulary, not JSON Schema: projection, UTF-16 lengths,
 * regexp flags and undefined are explicit rather than silently approximated. */
export type ShapeDescriptor =
  | Readonly<{ kind: 'opaque'; reason: 'custom-parser' | 'non-json-constraint' }>
  | Readonly<{ kind: 'text'; lengthUnit: 'utf16'; max?: number; pattern?: Readonly<{ source: string; flags: string }> }>
  | Readonly<{ kind: 'integer'; min: number; max: number }>
  | Readonly<{ kind: 'number'; finite: true; min?: number; max?: number }>
  | Readonly<{ kind: 'boolean' }>
  | Readonly<{ kind: 'date'; format: 'YYYY-MM-DD'; minYear: 0; maxYear: 9999 }>
  | Readonly<{ kind: 'literal'; values: readonly (string | number | boolean | null)[] }>
  | Readonly<{ kind: 'list'; item: ShapeDescriptor; min?: number; max?: number }>
  | Readonly<{ kind: 'optional' | 'nullable'; item: ShapeDescriptor }>
  | Readonly<{ kind: 'anyOf'; selection: 'first-match'; alternatives: readonly ShapeDescriptor[] }>
  | Readonly<{ kind: 'object'; projection: 'declared-keys'; fields: Readonly<Record<string, ShapeDescriptor>> }>;

/* Source and built-package copies share provenance without believing metadata
   attached to arbitrary application parsers. This is trusted-code bookkeeping,
   not protection from application code deliberately mutating process globals. */
const REGISTRY = Symbol.for('mistri.commandShapes.descriptors.v1');
const registryHost = globalThis as typeof globalThis & { [REGISTRY]?: WeakMap<object, ShapeDescriptor> };
if (!Object.hasOwn(registryHost, REGISTRY)) Object.defineProperty(registryHost, REGISTRY, { value: new WeakMap() });
const descriptors = registryHost[REGISTRY]!;
if (!(descriptors instanceof WeakMap)) throw new TypeError('Invalid command shape descriptor registry.');
const OPAQUE: ShapeDescriptor = Object.freeze({ kind: 'opaque', reason: 'custom-parser' });
const NON_JSON: ShapeDescriptor = Object.freeze({ kind: 'opaque', reason: 'non-json-constraint' });

/** Never runs parse or reads user properties. Unknown parsers stay opaque. */
export function describeShape(value: unknown): ShapeDescriptor {
  return value !== null && (typeof value === 'object' || typeof value === 'function') ? (descriptors.get(value) ?? OPAQUE) : OPAQUE;
}

/** Registration's synchronous guard preserves the captured built-in provenance. */
export function preserveShapeDescriptor<T>(source: unknown, wrapper: Shape<T>): Shape<T> {
  descriptors.set(wrapper, describeShape(source));
  return wrapper;
}

/** An opaque child makes the whole result unpublishable; runtime use stays valid. */
export function hasOpaqueShape(descriptor: ShapeDescriptor): boolean {
  switch (descriptor.kind) {
    case 'opaque':
      return true;
    case 'optional':
    case 'nullable':
    case 'list':
      return hasOpaqueShape(descriptor.item);
    case 'anyOf':
      return descriptor.alternatives.some(hasOpaqueShape);
    case 'object':
      return Object.values(descriptor.fields).some(hasOpaqueShape);
    default:
      return false;
  }
}

const OPTIONAL = Symbol('mistri.optionalShape');
interface OptionalShape<T> extends Shape<T | undefined> {
  readonly [OPTIONAL]: true;
}

/** A refusal names what failed, never the value: an output can hold anything. */
class ShapeError extends Error {
  constructor(what: string) {
    super(`The command's output does not match its shape: ${what}.`);
    this.name = 'ShapeError';
  }
}
const invalid = (what: string): never => {
  throw new ShapeError(what);
};

const make = <T>(parse: (value: unknown) => T, descriptor: ShapeDescriptor): Shape<T> => {
  const result = Object.freeze({ parse });
  descriptors.set(result, Object.freeze(descriptor));
  return result;
};
const jsonBounds = ({ min, max }: { min?: number; max?: number }) =>
  (min === undefined || Number.isFinite(min)) && (max === undefined || Number.isFinite(max));

/**
 * The output of a command that declares none: the handler returns nothing,
 * and the receipt keeps an empty body. Not a builder an author writes — it
 * is what an omitted `output` means. A handler that returns something is
 * refused rather than projected to nothing, since a value it meant to keep
 * would otherwise vanish from the receipt without a word.
 */
export const NO_OUTPUT: Shape<void> = make<void>(
  (value) => {
    if (value === undefined) return {} as unknown as void;
    if (value && typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) return {} as unknown as void;
    return invalid('this command declares no output, so its handler returns nothing');
  },
  { kind: 'object', projection: 'declared-keys', fields: Object.freeze({}) },
);

/** Text, at most `max` characters, matching `pattern` when given. */
export function text(options: { max?: number; pattern?: RegExp } = {}): Shape<string> {
  const { max, pattern } = options;
  const captured = pattern === undefined ? undefined : Object.freeze({ source: pattern.source, flags: pattern.flags.replace(/[gy]/g, '') });
  return make(
    (value) =>
      typeof value === 'string' &&
      (max === undefined || value.length <= max) &&
      (captured === undefined || new RegExp(captured.source, captured.flags).test(value))
        ? value
        : invalid('expected text'),
    jsonBounds({ max })
      ? { kind: 'text', lengthUnit: 'utf16', ...(max === undefined ? {} : { max }), ...(captured ? { pattern: captured } : {}) }
      : NON_JSON,
  );
}

/** A safe integer, within `min` and `max` when given. */
export function int(options: { min?: number; max?: number } = {}): Shape<number> {
  const bounds = { min: options.min, max: options.max };
  return make(
    (value) => (typeof value === 'number' && Number.isSafeInteger(value) && within(value, bounds) ? value : invalid('expected an integer')),
    jsonBounds(bounds)
      ? {
          kind: 'integer',
          min: Math.max(Number.MIN_SAFE_INTEGER, bounds.min ?? Number.MIN_SAFE_INTEGER),
          max: Math.min(Number.MAX_SAFE_INTEGER, bounds.max ?? Number.MAX_SAFE_INTEGER),
        }
      : NON_JSON,
  );
}

/** A finite number, within `min` and `max` when given. */
export function number(options: { min?: number; max?: number } = {}): Shape<number> {
  const { min, max } = options;
  const bounds = { ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
  return make(
    (value) => (typeof value === 'number' && Number.isFinite(value) && within(value, bounds) ? value : invalid('expected a number')),
    jsonBounds(bounds) ? { kind: 'number', finite: true, ...bounds } : NON_JSON,
  );
}

const within = (value: number, { min, max }: { min?: number; max?: number }) =>
  (min === undefined || value >= min) && (max === undefined || value <= max);

/** A record's id: a positive safe integer. */
export function id(): Shape<number> {
  return make((value) => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : invalid('expected an id')), {
    kind: 'integer',
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  });
}

export function bool(): Shape<boolean> {
  return make((value) => (typeof value === 'boolean' ? value : invalid('expected a boolean')), { kind: 'boolean' });
}

/** A calendar date that exists, `YYYY-MM-DD`. */
export function date(): Shape<string> {
  return make(
    (value) => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return invalid('expected a date');
      const parsed = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : invalid('expected a date');
    },
    { kind: 'date', format: 'YYYY-MM-DD', minYear: 0, maxYear: 9999 },
  );
}

/** Exactly one of these values. */
export function literal<const Values extends readonly (string | number | boolean | null)[]>(...values: Values): Shape<Values[number]> {
  if (!values.length) throw new TypeError('literal() needs at least one value.');
  const allowed = [...values];
  return make(
    (value) =>
      allowed.some((candidate) => Object.is(candidate, value)) ? (value as Values[number]) : invalid('expected one of its values'),
    allowed.some(
      (value) =>
        (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) ||
        (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))),
    )
      ? NON_JSON
      : { kind: 'literal', values: Object.freeze(allowed) },
  );
}

/** A list of `item`, between `min` and `max` long when given. */
export function list<T>(item: Shape<T>, options: { min?: number; max?: number } = {}): Shape<T[]> {
  const { min, max } = options;
  const bounds = { ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
  return make(
    (value) => {
      if (!Array.isArray(value) || !within(value.length, bounds)) return invalid('expected a list of its length');
      return value.map((entry) => item.parse(entry));
    },
    jsonBounds(bounds) ? { kind: 'list', item: describeShape(item), ...bounds } : NON_JSON,
  );
}

/** `shape`, or absent: the key may be left out of an object. */
export function optional<T>(shape: Shape<T>): OptionalShape<T> {
  const result = Object.freeze({
    [OPTIONAL]: true as const,
    parse: (value: unknown) => (value === undefined ? undefined : shape.parse(value)),
  });
  descriptors.set(result, Object.freeze({ kind: 'optional', item: describeShape(shape) }));
  return result;
}

/** `shape`, or null. */
export function nullable<T>(shape: Shape<T>): Shape<T | null> {
  return make((value) => (value === null ? null : shape.parse(value)), { kind: 'nullable', item: describeShape(shape) });
}

/** The first of these shapes the value fits. */
export function oneOf<const Shapes extends readonly Shape<unknown>[]>(...shapes: Shapes): Shape<ShapeOf<Shapes[number]>> {
  if (!shapes.length) throw new TypeError('oneOf() needs at least one shape.');
  return make(
    (value) => {
      for (const candidate of shapes) {
        try {
          return candidate.parse(value) as ShapeOf<Shapes[number]>;
        } catch {
          /* the next one */
        }
      }
      return invalid('fits none of its shapes');
    },
    { kind: 'anyOf', selection: 'first-match', alternatives: Object.freeze(shapes.map(describeShape)) },
  );
}

type Fields = Readonly<Record<string, Shape<unknown>>>;
type OptionalKeys<F extends Fields> = { [K in keyof F]: F[K] extends OptionalShape<unknown> ? K : never }[keyof F];
type Flat<T> = { [K in keyof T]: T[K] } & {};
/** The object a `shape({ … })` parses to: each key its shape's value, an `optional` one optional. */
type ShapeObject<F extends Fields> = Flat<
  { [K in Exclude<keyof F, OptionalKeys<F>>]: ShapeOf<F[K]> } & { [K in OptionalKeys<F>]?: ShapeOf<F[K]> }
>;

/** An object with these keys, each parsed by its shape; any other key is dropped. */
export function shape<const F extends Fields>(fields: F): Shape<ShapeObject<F>> {
  const entries = Object.entries(fields);
  for (const [key, field] of entries) {
    if (!field || typeof field.parse !== 'function') throw new TypeError(`shape() key "${key}" is not a shape.`);
  }
  return make(
    (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('expected an object');
      const result: Record<string, unknown> = {};
      for (const [key, field] of entries) {
        const present = Object.hasOwn(value, key);
        const parsed = field.parse(present ? (value as Record<string, unknown>)[key] : undefined);
        if (parsed !== undefined) result[key] = parsed;
      }
      return result as ShapeObject<F>;
    },
    entries.some(([key]) => key === '__proto__')
      ? NON_JSON
      : {
          kind: 'object',
          projection: 'declared-keys',
          fields: Object.freeze(Object.fromEntries(entries.map(([key, field]) => [key, describeShape(field)]))),
        },
  );
}
