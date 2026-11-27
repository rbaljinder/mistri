/**
 * A recorded model: a cassette is a JSON file of the requests a turn made and
 * the replies the model gave, keyed by the request, so an AI command or an Ask
 * is run again offline and asserted on — its proposal, its evidence — the same
 * every run (`replay` in the test kit, docs/test-workflow.md).
 *
 * Replay is the default and never reaches the network: a request the cassette
 * does not hold fails the turn, naming it. `MISTRI_REPLAY=record` asks the
 * operator's real model instead and writes what it answered, and refuses to
 * start without the operator's key. A cassette carries no key and no header:
 * the request kept is the model's input, scrubbed of anything that looks like
 * a credential, so one can be committed beside the test that reads it.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { streamCallbacks, type AssistantModel, type ModelBlock, type ModelMessage, type ModelRequest } from './assistantModel.js';
import { NOW_LINE } from './assistantCatalog.js';

type ModelReply = Awaited<ReturnType<AssistantModel['stream']>>;

interface CassetteEntry {
  /** The request's key: its model, system prompt, tools and messages, hashed. */
  key: string;
  /** What the person last said, for a reader of the file; not part of the key. */
  said?: string;
  request: { model: string; messages: ModelMessage[] };
  reply: ModelReply;
}
export interface Cassette {
  version: 1;
  entries: CassetteEntry[];
}

/** Named as a provider's refusal is, so the turn says it to the person (and the test) rather than a bare failure. */
class ModelUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelUnavailable';
  }
}

const REDACTED = '[redacted]';
/* Field names that carry a credential wherever they appear in what is kept. */
const SECRET_NAME =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|anthropic[-_]api[-_]key|openai[-_]api[-_]key)$/i;
/* A bearer token or a provider key written into text (a tool's answer, a quoted header). */
const SECRET_TEXT = /\b(Bearer\s+[A-Za-z0-9._~+/=-]{8,}|sk-(?:ant-)?[A-Za-z0-9_-]{8,})/g;

/** The value with every credential it carries replaced: the keys named here, and any secret-looking name or text. */
export function redact(value: unknown, keys: readonly string[] = providerKeys()): unknown {
  if (typeof value === 'string') {
    let text = value;
    for (const key of keys) if (key) text = text.split(key).join(REDACTED);
    return text.replace(SECRET_TEXT, REDACTED);
  }
  if (Array.isArray(value)) return value.map((each) => redact(each, keys));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([name, each]) => [name, SECRET_NAME.test(name) ? REDACTED : redact(each, keys)]));
  return value;
}

const providerKeys = (): string[] =>
  [process.env.ANTHROPIC_API_KEY ?? '', process.env.OPENAI_API_KEY ?? ''].filter((key) => key.length >= 8);

/* Object keys sorted, so a request is one text however its objects were built. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((name) => [name, canonical((value as Record<string, unknown>)[name])]),
        )
      : value;

/** A request's key: what the model is asked, not how much it may answer or how hard it thinks. Redacted first, so a recorded key and a replayed one agree whichever keys the environment holds. */
export function requestKey(request: ModelRequest, keys: readonly string[] = providerKeys()): string {
  const asked = redact({ model: request.model, system: request.system, tools: request.tools, messages: request.messages }, keys);
  /* The moment a person asked (assistantCatalog.ts nowLine) is not part of what was asked: a cassette recorded on
     Tuesday answers on Wednesday. */
  const timeless = (value: unknown): unknown =>
    typeof value === 'string'
      ? value.replace(NOW_LINE, 'Now.')
      : Array.isArray(value)
        ? value.map(timeless)
        : value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([name, each]) => [name, timeless(each)]))
          : value;
  return createHash('sha256')
    .update(JSON.stringify(canonical(timeless(asked))))
    .digest('hex')
    .slice(0, 24);
}

/** The person's last words in a request, for the file and for a miss's message. */
function lastSaid(messages: readonly ModelMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    const text = message.content.filter((block: ModelBlock) => block.type === 'text').map((block) => String(block.text));
    if (text.length) return text.join('\n');
  }
  return undefined;
}

export function readCassette(file: string): Cassette {
  if (!existsSync(file)) return { version: 1, entries: [] };
  const read = JSON.parse(readFileSync(file, 'utf8')) as Partial<Cassette>;
  if (read.version !== 1 || !Array.isArray(read.entries)) throw new Error(`${file} is not a cassette (version 1, with entries).`);
  return read as Cassette;
}

/** Answers from the cassette alone; a request it does not hold fails, named by its key and the person's words. */
export function replayModel(file: string): AssistantModel {
  const cassette = readCassette(file);
  const byKey = new Map(cassette.entries.map((entry) => [entry.key, entry]));
  return {
    async stream(request, sink) {
      const { onText, onReasoning } = streamCallbacks(sink);
      const key = requestKey(request);
      const entry = byKey.get(key);
      if (!entry) {
        const said = lastSaid(request.messages);
        throw new ModelUnavailable(
          `Replay: ${file} has no answer for request ${key}${said ? ` (after "${said.slice(0, 80)}")` : ''}. ` +
            'Record it again with MISTRI_REPLAY=record and the model key set.',
        );
      }
      let rIndex = 0;
      for (const block of entry.reply.content) {
        if (block.type === 'thinking' && typeof block.thinking === 'string') {
          const id = `r_replay_${rIndex++}`;
          onReasoning({ id, delta: block.thinking });
          onReasoning({ id, done: true, ...(typeof block.durationMs === 'number' ? { durationMs: block.durationMs } : {}) });
        } else if (block.type === 'redacted_thinking') {
          const id = `r_replay_${rIndex++}`;
          onReasoning({
            id,
            redacted: true,
            done: true,
            ...(typeof block.durationMs === 'number' ? { durationMs: block.durationMs } : {}),
          });
        } else if (block.type === 'text' && typeof block.text === 'string') {
          onText(block.text);
        }
      }
      return structuredClone(entry.reply);
    },
  };
}

/** Asks the real model and writes each request and its reply to the cassette, replacing what that request had. */
export function recordingModel(file: string, real: AssistantModel): AssistantModel {
  return {
    async stream(request, sink, signal) {
      const reply = await real.stream(request, sink, signal);
      const cassette = readCassette(file);
      const said = lastSaid(request.messages);
      const entry = redact({
        key: requestKey(request),
        ...(said === undefined ? {} : { said }),
        request: { model: request.model, messages: request.messages },
        reply,
      }) as CassetteEntry;
      cassette.entries = [...cassette.entries.filter((each) => each.key !== entry.key), entry];
      writeFileSync(file, `${JSON.stringify(cassette, null, 2)}\n`);
      return reply;
    },
  };
}

/** What `MISTRI_REPLAY=record` needs, said before anything runs: the operator's key, or a clear refusal. */
export function recordingKeyMissing(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY
    ? undefined
    : 'MISTRI_REPLAY=record asks the real model, and no model key is set: set ANTHROPIC_API_KEY or OPENAI_API_KEY, or leave MISTRI_REPLAY unset to replay the cassette.';
}
