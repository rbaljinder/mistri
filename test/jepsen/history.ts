/**
 * Jepsen-compatible operation history recorder and EDN/JSONL serializer.
 *
 * Every concurrent operation records an `:invoke` event before work starts and
 * a matching completion event (`:ok`, `:fail`, or `:info` for indeterminate
 * outcomes such as `TransactionOutcomeUnknown`, HTTP 503, or TCP resets).
 *
 * The EDN format matches what Jepsen and `elle-cli` expect for `list-append`
 * and general black-box histories.
 */
import { writeFileSync } from 'node:fs';

export type OpType = 'invoke' | 'ok' | 'fail' | 'info';

/** One Elle `list-append` micro-operation: read a key's list, or append a unique integer value. */
export type ListAppendMicroOp = readonly ['r', string, readonly number[] | null] | readonly ['append', string, number];

export interface HistoryOp<V = unknown> {
  readonly index: number;
  /** Elapsed nanoseconds since the history started. */
  readonly time: number;
  readonly process: number | 'nemesis';
  readonly type: OpType;
  readonly f: string;
  readonly value: V;
  readonly error?: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export class HistoryRecorder<V = unknown> {
  private readonly startedNs = process.hrtime.bigint();
  private readonly ops: HistoryOp<V>[] = [];

  /** Append one event to the history and return its monotonic entry. */
  record(entry: Omit<HistoryOp<V>, 'index' | 'time'>): HistoryOp<V> {
    const op: HistoryOp<V> = {
      index: this.ops.length,
      time: Number(process.hrtime.bigint() - this.startedNs),
      ...entry,
    };
    this.ops.push(op);
    return op;
  }

  invoke(processId: number | 'nemesis', f: string, value: V, meta?: Readonly<Record<string, unknown>>): HistoryOp<V> {
    return this.record({ process: processId, type: 'invoke', f, value, ...(meta ? { meta } : {}) });
  }

  ok(processId: number | 'nemesis', f: string, value: V, meta?: Readonly<Record<string, unknown>>): HistoryOp<V> {
    return this.record({ process: processId, type: 'ok', f, value, ...(meta ? { meta } : {}) });
  }

  fail(processId: number | 'nemesis', f: string, value: V, error?: string, meta?: Readonly<Record<string, unknown>>): HistoryOp<V> {
    return this.record({
      process: processId,
      type: 'fail',
      f,
      value,
      ...(error !== undefined ? { error } : {}),
      ...(meta ? { meta } : {}),
    });
  }

  info(processId: number | 'nemesis', f: string, value: V, error?: string, meta?: Readonly<Record<string, unknown>>): HistoryOp<V> {
    return this.record({
      process: processId,
      type: 'info',
      f,
      value,
      ...(error !== undefined ? { error } : {}),
      ...(meta ? { meta } : {}),
    });
  }

  entries(): readonly HistoryOp<V>[] {
    return this.ops;
  }

  toJsonLines(): string {
    return this.ops.map((op) => JSON.stringify(op)).join('\n') + (this.ops.length ? '\n' : '');
  }

  toEdn(): string {
    return formatHistoryEdn(this.ops);
  }

  writeFiles(basePathWithoutExt: string): { readonly jsonl: string; readonly edn: string } {
    const jsonl = `${basePathWithoutExt}.jsonl`;
    const edn = `${basePathWithoutExt}.edn`;
    writeFileSync(jsonl, this.toJsonLines(), 'utf8');
    writeFileSync(edn, this.toEdn(), 'utf8');
    return { jsonl, edn };
  }
}

/** Format a keyword token safely for EDN (`:ok`, `:txn`, `:nemesis`). */
function ednKeyword(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9*+!_?\-./]/g, '-');
  return `:${safe}`;
}

function ednString(text: string): string {
  return JSON.stringify(text);
}

/** Serialize an arbitrary value into EDN, preserving Elle micro-op vectors `[:r k [...]]` / `[:append k v]`. */
export function toEdnValue(value: unknown): string {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'nil';
  if (typeof value === 'string') return ednString(value);
  if (Array.isArray(value)) {
    // Recognize Elle list-append micro-ops: ['r', key, val] or ['append', key, val]
    if (value.length === 3 && (value[0] === 'r' || value[0] === 'append')) {
      const [tag, key, arg] = value;
      return `[${ednKeyword(tag)} ${toEdnValue(key)} ${toEdnValue(arg)}]`;
    }
    return `[${value.map((item) => toEdnValue(item)).join(' ')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${ednKeyword(k)} ${toEdnValue(v)}`);
    return `{${entries.join(', ')}}`;
  }
  return ednString(String(value));
}

/** Serialize a list of history operations as newline-delimited Jepsen EDN maps. */
export function formatHistoryEdn<V>(ops: readonly HistoryOp<V>[]): string {
  if (ops.length === 0) return '';
  return (
    ops
      .map((op) => {
        const proc = op.process === 'nemesis' ? ':nemesis' : String(op.process);
        const parts = [
          `:index ${op.index}`,
          `:time ${op.time}`,
          `:type ${ednKeyword(op.type)}`,
          `:process ${proc}`,
          `:f ${ednKeyword(op.f)}`,
          `:value ${toEdnValue(op.value)}`,
        ];
        if (op.error !== undefined) parts.push(`:error ${ednString(op.error)}`);
        return `{${parts.join(', ')}}`;
      })
      .join('\n') + '\n'
  );
}
