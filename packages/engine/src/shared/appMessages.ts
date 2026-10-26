/**
 * A message of an App's catalog, named where a caption goes: `msg('lead.title')`,
 * `msg('lead.due', { days: 'due_in' })`. The catalogs (`messages/<locale>.ts`)
 * are read and said on the server (server/app/appMessages.ts): every caption is
 * a plain string by the time a parser or a browser sees it, in the reader's
 * language. What is shared is only the shape, so the loader, the check and a
 * notify rule agree on what a reference is.
 */
export interface AppMessageRef {
  readonly message: string;
  /** ICU argument → the column path it reads (`{ title: 'thread_id.title' }`). */
  readonly args?: Readonly<Record<string, string>>;
}

/**
 * The keys whose text a reader reads: a caption, wherever the definition holds
 * one. Every one takes `msg()` (packages/mistri/schema/app.d.ts, held by test/app-messages.test.ts),
 * said by the loader however deep it sits, and `mistri messages extract`
 * lists those still written as literal text. `text` is a caption except where
 * it names a column: `ui.messages`' `fields`, a composer's `templates`.
 */
export const CAPTION_KEYS: ReadonlySet<string> = new Set([
  'label',
  'title',
  'tab',
  'description',
  'heading',
  'tagline',
  'subtitle',
  'placeholder',
  'empty',
  'hint',
  'help',
  'submitLabel',
  'lead',
  'next',
  'skip',
  'question',
  'answer',
  'text',
  'noun',
  'unit',
  'total',
  'eyebrow',
  'alt',
  'message',
  'note',
  'before',
  'after',
]);

/** Whether the value under `key`, in an object found under `parent`, is a caption. */
export const isCaptionKey = (key: string, parent: string | number | undefined): boolean =>
  CAPTION_KEYS.has(key) && !(key === 'text' && (parent === 'fields' || parent === 'templates'));

/** A shape as it is served: each `msg()` it may hold said by the loader, so a caption is a string. */
export type SaidCaptions<T> = T extends AppMessageRef
  ? string
  : T extends readonly (infer Item)[]
    ? readonly SaidCaptions<Item>[]
    : T extends object
      ? { [K in keyof T]: SaidCaptions<T[K]> }
      : T;

/** A message's key: dotted words, `lead.title`, `people.payRate`. */
export const MESSAGE_KEY = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/;
/** An ICU argument's name: no dot, so a path is bound explicitly. */
const MESSAGE_ARG = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MESSAGE_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
/** The arguments the framework supplies itself: a count, a flow notify step's words, a transition's state. */
export const FRAMEWORK_ARGS = ['count', 'message', 'to'] as const;

const plain = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null);

/**
 * Whether a value is what `msg()` made: `{ message }` with a key, and `args`
 * of names bound to paths. Nothing else in a definition has that shape — a
 * text rule's or a form's `message` is a sentence, which is never a dotted key
 * alone in its object.
 */
export function isMessageRef(raw: unknown): raw is AppMessageRef {
  if (!plain(raw) || typeof raw.message !== 'string' || !MESSAGE_KEY.test(raw.message)) return false;
  const keys = Object.keys(raw);
  if (keys.some((key) => key !== 'message' && key !== 'args')) return false;
  if (raw.args === undefined) return true;
  return (
    plain(raw.args) &&
    Object.entries(raw.args).every(([name, path]) => MESSAGE_ARG.test(name) && typeof path === 'string' && MESSAGE_PATH.test(path))
  );
}

/**
 * A caption as a parser reads it: text, trimmed. The loader has said every
 * `msg()` by now (localizeDefinition); one that reaches a parser was given to
 * it directly, with no catalog to say it from.
 */
export function parseCaption(raw: unknown, at: string): string {
  if (isMessageRef(raw))
    throw new Error(
      `[message-missing] ${at}: msg('${raw.message}') is said from the App's messages/ catalogs, which only a loaded App has.`,
    );
  if (typeof raw !== 'string' || !raw.trim()) throw new Error(`Invalid caption at ${at}: it must be non-empty text.`);
  return raw.trim();
}
