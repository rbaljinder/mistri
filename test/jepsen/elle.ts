/**
 * Elle `list-append` transactional isolation checker (built-in TypeScript DSG
 * analyzer) plus optional external `elle-cli` runner.
 *
 * Implements the core Adya / Elle `list-append` checks directly on recorded
 * histories:
 *  - G0 (dirty writes / ww-cycle)
 *  - G1a (aborted reads: observing a value appended by a `:fail`ed transaction)
 *  - G1b (intermediate reads: observing a non-final append of a multi-append txn)
 *  - G1c (circular information flow: cycle in `ww ∪ wr`)
 *  - Duplicate appends, incompatible list versions (forked history / P4 lost updates)
 *  - Lost updates (`:ok` append missing from a later read of the same key)
 *  - G-SI / G-single (cycles in `ww ∪ wr ∪ rw` with at most one `rw` edge, and
 *    incompatible snapshot observations / fractured reads)
 *
 * Also bridges to the official `elle-cli` (which bundles Jepsen's Clojure Elle
 * and Knossos checkers) when `ELLE_CLI_BIN` or `ELLE_CLI_JAR` is configured.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HistoryOp, ListAppendMicroOp } from './history.js';

const execFileAsync = promisify(execFile);

export type AnomalyKind =
  | 'G0'
  | 'G1a'
  | 'G1b'
  | 'G1c'
  | 'G-single'
  | 'G-SI'
  | 'duplicate-append'
  | 'incompatible-order'
  | 'lost-update'
  | 'internal-inconsistency';

export interface ElleAnomaly {
  readonly kind: AnomalyKind;
  readonly key?: string;
  readonly detail: string;
  readonly transactions?: readonly number[];
}

export interface ElleCheckResult {
  readonly valid: boolean;
  readonly transactionCount: number;
  readonly okCount: number;
  readonly failCount: number;
  readonly infoCount: number;
  readonly edgeCounts: { readonly ww: number; readonly wr: number; readonly rw: number; readonly rt: number };
  readonly anomalies: readonly ElleAnomaly[];
}

interface TxnRecord {
  readonly id: number;
  readonly process: number;
  readonly invokeIndex: number;
  readonly completeIndex: number;
  readonly type: 'ok' | 'fail' | 'info';
  readonly ops: readonly ListAppendMicroOp[];
  /** Values appended by this txn per key, in micro-op order. */
  readonly appendsByKey: ReadonlyMap<string, readonly number[]>;
  /** Final list read by this txn per key (if any). */
  readonly readsByKey: ReadonlyMap<string, readonly (readonly number[])[]>;
}

type EdgeKind = 'ww' | 'wr' | 'rw' | 'rt';
interface Edge {
  readonly from: number;
  readonly to: number;
  readonly kind: EdgeKind;
  readonly key?: string;
}

/** Check whether `shorter` is an exact prefix of `longer`. */
function isPrefix(shorter: readonly number[], longer: readonly number[]): boolean {
  if (shorter.length > longer.length) return false;
  for (let i = 0; i < shorter.length; i++) if (shorter[i] !== longer[i]) return false;
  return true;
}

/** Pair `:invoke` and completion events into transactions for the `txn` workload. */
function extractTransactions(history: readonly HistoryOp<readonly ListAppendMicroOp[]>[]): TxnRecord[] {
  const open = new Map<number, HistoryOp<readonly ListAppendMicroOp[]>>();
  const txns: TxnRecord[] = [];
  for (const op of history) {
    if (op.process === 'nemesis' || op.f !== 'txn') continue;
    if (op.type === 'invoke') {
      open.set(op.process, op);
      continue;
    }
    const start = open.get(op.process);
    if (!start) continue;
    open.delete(op.process);
    const ops = Array.isArray(op.value) && op.value.length > 0 ? op.value : start.value;
    const appendsByKey = new Map<string, number[]>();
    const readsByKey = new Map<string, (readonly number[])[]>();
    for (const mop of ops) {
      if (mop[0] === 'append') {
        const list = appendsByKey.get(mop[1]) ?? [];
        list.push(mop[2]);
        appendsByKey.set(mop[1], list);
      } else if (mop[0] === 'r' && mop[2] !== null) {
        const list = readsByKey.get(mop[1]) ?? [];
        list.push(mop[2]);
        readsByKey.set(mop[1], list);
      }
    }
    txns.push({
      id: txns.length,
      process: op.process,
      invokeIndex: start.index,
      completeIndex: op.index,
      type: op.type,
      ops,
      appendsByKey,
      readsByKey,
    });
  }
  return txns;
}

/** Find a directed cycle in an adjacency graph (returns node ids forming the cycle, or null). */
function findCycle(nodeCount: number, edges: readonly Edge[]): number[] | null {
  const adj = Array.from({ length: nodeCount }, () => [] as number[]);
  for (const edge of edges) if (edge.from !== edge.to) adj[edge.from].push(edge.to);
  const color = new Uint8Array(nodeCount); // 0 = unvisited, 1 = visiting, 2 = done
  const parent = new Int32Array(nodeCount).fill(-1);

  const stack: Array<{ node: number; next: number }> = [];
  for (let start = 0; start < nodeCount; start++) {
    if (color[start] !== 0) continue;
    color[start] = 1;
    stack.push({ node: start, next: 0 });
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const neighbors = adj[top.node];
      if (top.next < neighbors.length) {
        const to = neighbors[top.next++];
        if (color[to] === 1) {
          const cycle = [to];
          for (let cur = top.node; cur !== to && cur !== -1; cur = parent[cur]) cycle.push(cur);
          cycle.push(to);
          cycle.reverse();
          return cycle;
        }
        if (color[to] === 0) {
          color[to] = 1;
          parent[to] = top.node;
          stack.push({ node: to, next: 0 });
        }
      } else {
        color[top.node] = 2;
        stack.pop();
      }
    }
  }
  return null;
}

/**
 * Find a G-single cycle: a cycle in `ww ∪ wr ∪ rw` containing **exactly one** `rw` edge.
 * Under Snapshot Isolation, G-single (including read-skew / fractured reads) is forbidden.
 */
function findSingleRwCycle(nodeCount: number, wwWrEdges: readonly Edge[], rwEdges: readonly Edge[]): number[] | null {
  const adj = Array.from({ length: nodeCount }, () => [] as number[]);
  for (const e of wwWrEdges) if (e.from !== e.to) adj[e.from].push(e.to);

  // For each rw edge (u -> v), check if there is a path (v ->* u) using only ww/wr edges.
  for (const rw of rwEdges) {
    if (rw.from === rw.to) continue;
    const visited = new Uint8Array(nodeCount);
    const prev = new Int32Array(nodeCount).fill(-1);
    const queue = [rw.to];
    visited[rw.to] = 1;
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      if (cur === rw.from) {
        const path = [rw.from];
        for (let at = rw.from; at !== rw.to && at !== -1; at = prev[at]) path.push(prev[at]);
        path.reverse();
        path.push(rw.to);
        return path;
      }
      for (const next of adj[cur]) {
        if (!visited[next]) {
          visited[next] = 1;
          prev[next] = cur;
          queue.push(next);
        }
      }
    }
  }
  return null;
}

/**
 * Check an Elle `list-append` history for isolation anomalies.
 *
 * `consistency` selects the isolation target:
 * - `'read-committed'`: checks G0, G1a, G1b, G1c, duplicates, incompatible versions, lost updates.
 * - `'snapshot-isolation'` (default): also checks G-single (fractured reads / single-rw cycles) and P4.
 * - `'serializable'`: also forbids general `ww ∪ wr ∪ rw` cycles (G2-item / write skew).
 */
export function checkListAppendHistory(
  history: readonly HistoryOp<readonly ListAppendMicroOp[]>[],
  options: { readonly consistency?: 'read-committed' | 'snapshot-isolation' | 'serializable' } = {},
): ElleCheckResult {
  const consistency = options.consistency ?? 'snapshot-isolation';
  const txns = extractTransactions(history);
  const anomalies: ElleAnomaly[] = [];

  // Map (key, appendedValue) -> producing txn + position within that txn's appends to that key.
  const writerOf = new Map<string, { readonly txn: TxnRecord; readonly posInTxn: number; readonly totalInTxn: number }>();
  for (const txn of txns) {
    for (const [key, vals] of txn.appendsByKey) {
      for (let i = 0; i < vals.length; i++) {
        writerOf.set(`${key}:${vals[i]}`, { txn, posInTxn: i, totalInTxn: vals.length });
      }
    }
  }

  // 1. Per-transaction internal consistency (read-your-own-writes & monotonic reads inside one txn).
  for (const txn of txns) {
    if (txn.type !== 'ok') continue;
    const seenByKey = new Map<string, readonly number[]>();
    const ownAppendsByKey = new Map<string, number[]>();
    for (const mop of txn.ops) {
      if (mop[0] === 'append') {
        const list = ownAppendsByKey.get(mop[1]) ?? [];
        list.push(mop[2]);
        ownAppendsByKey.set(mop[1], list);
      } else if (mop[0] === 'r' && mop[2] !== null) {
        const key = mop[1];
        const observed = mop[2];
        // Duplicate element inside a single read list
        if (new Set(observed).size !== observed.length) {
          anomalies.push({
            kind: 'duplicate-append',
            key,
            detail: `txn #${txn.id} read duplicate elements on key ${key}: [${observed.join(', ')}]`,
            transactions: [txn.id],
          });
        }
        // Check own prior appends appear at the tail of subsequent reads in the same txn
        const own = ownAppendsByKey.get(key) ?? [];
        for (const v of own) {
          if (!observed.includes(v)) {
            anomalies.push({
              kind: 'internal-inconsistency',
              key,
              detail: `txn #${txn.id} appended ${v} to ${key} then failed to observe it in a subsequent read`,
              transactions: [txn.id],
            });
          }
        }
        // Under snapshot isolation, repeated reads of a key before own appends must match; after appends must extend.
        const prev = seenByKey.get(key);
        if (prev && !isPrefix(prev, observed)) {
          anomalies.push({
            kind: 'internal-inconsistency',
            key,
            detail: `txn #${txn.id} observed non-monotonic lists on key ${key}: [${prev.join(', ')}] then [${observed.join(', ')}]`,
            transactions: [txn.id],
          });
        }
        if (consistency !== 'read-committed' && prev && own.length === 0 && prev.length !== observed.length) {
          anomalies.push({
            kind: 'G-single',
            key,
            detail: `txn #${txn.id} observed non-repeatable read on key ${key}: [${prev.join(', ')}] then [${observed.join(', ')}]`,
            transactions: [txn.id],
          });
        }
        seenByKey.set(key, observed);
      }
    }
  }

  // 2. Collect all observed versions per key, check G1a (aborted reads), G1b (intermediate reads),
  //    and verify all observed versions form a single linear prefix chain (no forked histories / P4).
  const versionsByKey = new Map<string, Array<{ readonly version: readonly number[]; readonly txn: TxnRecord }>>();
  for (const txn of txns) {
    if (txn.type !== 'ok') continue;
    for (const [key, reads] of txn.readsByKey) {
      for (const observed of reads) {
        const list = versionsByKey.get(key) ?? [];
        list.push({ version: observed, txn });
        versionsByKey.set(key, list);

        // Check every value in observed list for G1a (aborted) and G1b (intermediate)
        for (let idx = 0; idx < observed.length; idx++) {
          const val = observed[idx];
          const prod = writerOf.get(`${key}:${val}`);
          if (!prod) continue;
          if (prod.txn.type === 'fail') {
            anomalies.push({
              kind: 'G1a',
              key,
              detail: `txn #${txn.id} read value ${val} on key ${key} from failed txn #${prod.txn.id}`,
              transactions: [prod.txn.id, txn.id],
            });
          }
          // G1b: if another txn appended multiple values to `key`, reading an earlier one without its final one
          if (prod.txn.id !== txn.id && prod.posInTxn < prod.totalInTxn - 1) {
            const allOwn = prod.txn.appendsByKey.get(key)!;
            const lastVal = allOwn[allOwn.length - 1];
            if (!observed.includes(lastVal)) {
              anomalies.push({
                kind: 'G1b',
                key,
                detail: `txn #${txn.id} read intermediate value ${val} on key ${key} from txn #${prod.txn.id} without its final value ${lastVal}`,
                transactions: [prod.txn.id, txn.id],
              });
            }
          }
        }
      }
    }
  }

  // Reconstruct canonical final list per key (longest observed version) and check prefix compatibility.
  const longestByKey = new Map<string, readonly number[]>();
  for (const [key, observations] of versionsByKey) {
    const sorted = [...observations].sort((a, b) => a.version.length - b.version.length);
    for (let i = 1; i < sorted.length; i++) {
      if (!isPrefix(sorted[i - 1].version, sorted[i].version)) {
        anomalies.push({
          kind: 'incompatible-order',
          key,
          detail: `incompatible versions on key ${key}: [${sorted[i - 1].version.join(', ')}] (txn #${sorted[i - 1].txn.id}) vs [${sorted[i].version.join(', ')}] (txn #${sorted[i].txn.id})`,
          transactions: [sorted[i - 1].txn.id, sorted[i].txn.id],
        });
        break;
      }
    }
    if (sorted.length > 0) longestByKey.set(key, sorted[sorted.length - 1].version);
  }

  // 3. Check for lost updates: any `:ok` append whose value never appears in a strictly later read of that key
  //    or is absent from the longest observed list when a strictly later write IS present.
  for (const txn of txns) {
    if (txn.type !== 'ok') continue;
    for (const [key, vals] of txn.appendsByKey) {
      const canonical = longestByKey.get(key);
      if (!canonical) continue;
      for (const v of vals) {
        if (canonical.includes(v)) continue;
        // Check if any read that started strictly after `txn` completed observed `key` without `v`.
        const laterRead = (versionsByKey.get(key) ?? []).find((obs) => obs.txn.invokeIndex > txn.completeIndex);
        if (laterRead) {
          anomalies.push({
            kind: 'lost-update',
            key,
            detail: `ok txn #${txn.id} appended ${v} to key ${key}, but strictly later txn #${laterRead.txn.id} read [${laterRead.version.join(', ')}] without it`,
            transactions: [txn.id, laterRead.txn.id],
          });
        }
      }
    }
  }

  // 4. Build Direct Serialization Graph (ww, wr, rw, rt).
  const edges: Edge[] = [];
  const seenEdge = new Set<string>();
  const addEdge = (from: number, to: number, kind: EdgeKind, key?: string) => {
    if (from === to) return;
    const id = `${kind}:${from}:${to}`;
    if (seenEdge.has(id)) return;
    seenEdge.add(id);
    edges.push({ from, to, kind, ...(key ? { key } : {}) });
  };

  // ww edges from canonical element order on each key
  for (const [key, canonical] of longestByKey) {
    const order: number[] = [];
    for (const val of canonical) {
      const prod = writerOf.get(`${key}:${val}`);
      if (!prod) continue;
      if (order[order.length - 1] !== prod.txn.id) order.push(prod.txn.id);
    }
    for (let i = 0; i < order.length - 1; i++) {
      addEdge(order[i], order[i + 1], 'ww', key);
    }

    // wr and rw edges from every read observation on `key`
    for (const { version, txn: reader } of versionsByKey.get(key) ?? []) {
      if (version.length > 0) {
        const lastVal = version[version.length - 1];
        const prod = writerOf.get(`${key}:${lastVal}`);
        if (prod && prod.txn.id !== reader.id) {
          addEdge(prod.txn.id, reader.id, 'wr', key);
        }
      }
      // Next element after what `reader` observed implies an anti-dependency: reader -rw-> nextWriter
      if (version.length < canonical.length && isPrefix(version, canonical)) {
        const nextVal = canonical[version.length];
        const nextProd = writerOf.get(`${key}:${nextVal}`);
        if (nextProd && nextProd.txn.id !== reader.id) {
          addEdge(reader.id, nextProd.txn.id, 'rw', key);
        }
      }
    }
  }

  // Real-time (rt) edges for metadata (not added to SI cycle checks since SI is not strict-serializable)
  let rtCount = 0;
  for (const a of txns) {
    if (a.type !== 'ok') continue;
    for (const b of txns) {
      if (b.type === 'ok' && a.completeIndex < b.invokeIndex) rtCount++;
    }
  }

  const wwEdges = edges.filter((e) => e.kind === 'ww');
  const wrEdges = edges.filter((e) => e.kind === 'wr');
  const rwEdges = edges.filter((e) => e.kind === 'rw');

  // 5. Cycle detection: G0 (ww), G1c (ww ∪ wr), G-single (ww ∪ wr + 1 rw), G2/G-SI (ww ∪ wr ∪ rw).
  const g0 = findCycle(txns.length, wwEdges);
  if (g0) {
    anomalies.push({ kind: 'G0', detail: `write-write cycle (G0): ${g0.map((id) => `#${id}`).join(' -> ')}`, transactions: g0 });
  }
  const g1c = findCycle(txns.length, [...wwEdges, ...wrEdges]);
  if (g1c && !g0) {
    anomalies.push({
      kind: 'G1c',
      detail: `circular information flow (G1c in ww ∪ wr): ${g1c.map((id) => `#${id}`).join(' -> ')}`,
      transactions: g1c,
    });
  }
  if (consistency === 'snapshot-isolation' || consistency === 'serializable') {
    const gSingle = findSingleRwCycle(txns.length, [...wwEdges, ...wrEdges], rwEdges);
    if (gSingle) {
      anomalies.push({
        kind: 'G-single',
        detail: `snapshot isolation anomaly (G-single, 1 rw edge): ${gSingle.map((id) => `#${id}`).join(' -> ')}`,
        transactions: gSingle,
      });
    }
  }
  if (consistency === 'serializable') {
    const g2 = findCycle(txns.length, [...wwEdges, ...wrEdges, ...rwEdges]);
    if (g2 && !anomalies.some((a) => a.kind === 'G0' || a.kind === 'G1c' || a.kind === 'G-single')) {
      anomalies.push({
        kind: 'G-SI',
        detail: `serializability cycle (G2 in ww ∪ wr ∪ rw): ${g2.map((id) => `#${id}`).join(' -> ')}`,
        transactions: g2,
      });
    }
  }

  return {
    valid: anomalies.length === 0,
    transactionCount: txns.length,
    okCount: txns.filter((t) => t.type === 'ok').length,
    failCount: txns.filter((t) => t.type === 'fail').length,
    infoCount: txns.filter((t) => t.type === 'info').length,
    edgeCounts: { ww: wwEdges.length, wr: wrEdges.length, rw: rwEdges.length, rt: rtCount },
    anomalies,
  };
}

export interface ElleCliResult {
  readonly ran: boolean;
  readonly valid?: boolean;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly reason?: string;
}

/**
 * Optionally run the official `elle-cli` verifier against an emitted `.edn` history file.
 *
 * Resolution order:
 *  1. `options.cliPath` or `process.env.ELLE_CLI_BIN` (executable binary)
 *  2. `options.jarPath` or `process.env.ELLE_CLI_JAR` (invoked with `java -jar <jar>`)
 */
export async function runElleCli(
  ednPath: string,
  options: {
    readonly model?: 'list-append' | 'rw-register' | 'knossos-register';
    readonly consistency?: 'read-committed' | 'snapshot-isolation' | 'serializable' | 'strict-serializable';
    readonly cliPath?: string;
    readonly jarPath?: string;
  } = {},
): Promise<ElleCliResult> {
  const model = options.model ?? 'list-append';
  const consistency = options.consistency ?? 'snapshot-isolation';
  const bin = options.cliPath ?? process.env.ELLE_CLI_BIN;
  const jar = options.jarPath ?? process.env.ELLE_CLI_JAR;

  if (!bin && !jar) {
    return { ran: false, reason: 'Neither --elle-cli, ELLE_CLI_BIN, nor ELLE_CLI_JAR is set; used built-in Elle DSG checker.' };
  }

  const args = ['--model', model, '--consistency-models', consistency, ednPath];
  try {
    const { stdout, stderr } = bin ? await execFileAsync(bin, args) : await execFileAsync('java', ['-jar', jar!, ...args]);
    // elle-cli prints `<file>\ttrue` by default, or EDN/JSON with `:valid? true` / `"valid?":true` when verbose.
    const valid = /(?:"valid\?"\s*:\s*true|:valid\?\s+true|\t\s*true\s*$)/m.test(stdout.trim());
    return { ran: true, valid, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ran: true,
      valid: false,
      stdout: err.stdout?.trim(),
      stderr: err.stderr?.trim() ?? err.message,
    };
  }
}
