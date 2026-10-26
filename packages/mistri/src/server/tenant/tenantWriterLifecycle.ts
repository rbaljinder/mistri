/**
 * How a tenant store closed by an uncertain outcome comes back: the App's
 * writer (tenantWriteSource.ts) and the administration owner
 * (tenantAdministration.ts), whose invitations and support receipts write
 * through it. One rule for every store that writes, so none of them latches
 * shut on one lost connection.
 */
import { markTenantWriterPaused } from './tenantWriterHealth.js';
import { tenantWriteFailed } from './tenantWriteKindContract.js';

/*
 * A writer an uncertain write closed, and how it comes back.
 *
 * When a transaction's outcome cannot be confirmed (a COMMIT sent and never
 * acknowledged, a ROLLBACK that failed), its connection is discarded and the
 * source stops taking writes: nothing may be queued behind a transaction in an
 * unknown state, and a source must never reopen at a location that has since
 * been pointed somewhere else. Until 0.9.9 that close was for good, so one
 * cancelled COMMIT under load left every write of the App refused until a
 * restart, with `/readyz` still answering 200 (G193).
 *
 * Now the source reopens itself. Once the old connection is closed, nothing of
 * that transaction is still in flight on this side; the reopen then opens a new
 * adapter at the same place, attests it against the opening's own baseline
 * (the same file or URL, the same tables and keys, the same tenant store) and
 * rebinds the App's stores to it. Where the uncertain write was a command, it
 * reads that attempt's receipt by its id: present, the write committed;
 * absent, it did not. Either way a retry is safe, because a command's retry
 * carries the same idempotency key and the journal's unique scope answers it
 * with the stored receipt rather than running the handler again; a record
 * edit's caller was told the outcome is unknown and to reconcile first, as
 * anywhere else in mistri.
 *
 * Attempts back off from `firstMs` doubling to `maxMs`, and go on until one
 * succeeds or the source is retired. A SQLite file whose path now resolves to
 * another file is never reopened: that writer stays closed until a restart,
 * which is the one case the old rule existed for. While any writer is closed,
 * `/readyz` answers 503 (tenantWriterHealth.ts, read by the serve command), so
 * an orchestrator sends traffic elsewhere and, if it does not come back,
 * replaces the instance. One line is logged when a writer closes and one when
 * it reopens; the retries in between are silent.
 */
export const tenantWriterReopen = { firstMs: 1000, maxMs: 60_000 };

/** A reopen that must never be tried again: the source's location now resolves elsewhere. */
export class WriterRetargeted extends Error {}

export function writerLifecycle<Handle extends { close(): Promise<void> }>(input: {
  readonly owner: { readonly appId: string; readonly source: { readonly id: string } };
  /** What the log calls it, and what `/readyz` lists while it is closed; the App's writer when left out. */
  readonly name?: string;
  readonly paused?: string;
  readonly initial: Handle;
  /** Run on the writer's queue, behind every write already admitted. */
  readonly drain: (work: () => Promise<void>) => Promise<void>;
  /** Open, attest and bind a new handle where the first was; `committed` is the receipt's answer when one was named. */
  readonly reopen: (receipt: string | undefined) => Promise<{ handle: Handle; committed?: boolean }>;
  /** Let go of what was bound to a handle (live sync's hub) before it closes, at a pause as at shutdown. */
  readonly release?: (handle: Handle) => Promise<void>;
}) {
  let resume: (() => void) | undefined;
  const name = input.name ?? `${input.owner.appId}'s tenant writer (source "${input.owner.source.id}")`;
  let handle = input.initial;
  let closing = false,
    pausedAt = 0,
    attempt = 0;
  let retired: Promise<void> | undefined, shutting: Promise<void> | undefined, reopening: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const shut = (): Promise<void> => {
    const closingHandle = handle;
    const done = input.drain(async () => {
      try {
        await input.release?.(closingHandle);
        await closingHandle.close();
      } catch (error) {
        throw tenantWriteFailed('unknown', error);
      }
    });
    void done.catch(() => {});
    return done;
  };
  const schedule = (receipt: string | undefined): number => {
    const delay = Math.min(tenantWriterReopen.firstMs * 2 ** Math.min(attempt, 30), tenantWriterReopen.maxMs);
    attempt++;
    timer = setTimeout(() => {
      timer = undefined;
      reopening = tryReopen(receipt).finally(() => {
        reopening = undefined;
      });
    }, delay);
    timer.unref?.();
    return delay;
  };
  const tryReopen = async (receipt: string | undefined): Promise<void> => {
    if (retired) return;
    let opened: { handle: Handle; committed?: boolean };
    try {
      opened = await input.reopen(receipt);
    } catch (error) {
      if (retired) return;
      if (error instanceof WriterRetargeted) {
        console.error(`mistri: ${name} stays closed: its database file is no longer the one it opened. Restart the server.`);
        return;
      }
      schedule(receipt);
      return;
    }
    if (retired) {
      await opened.handle.close().catch(() => {});
      return;
    }
    handle = opened.handle;
    closing = false;
    attempt = 0;
    resume?.();
    const outcome =
      opened.committed === undefined
        ? ''
        : opened.committed
          ? '; the uncertain command committed'
          : '; the uncertain command did not commit';
    console.error(`mistri: ${name} reopened after ${Math.round((Date.now() - pausedAt) / 1000)}s${outcome}.`);
  };
  return {
    handle: () => handle,
    closing: () => closing,
    /** An uncertain write: refuse new work, close the connection behind what is queued, and come back. */
    pause(receipt: string | undefined): void {
      if (closing || retired) return;
      closing = true;
      pausedAt = Date.now();
      resume = markTenantWriterPaused({}, input.paused ?? `${input.owner.appId}/${input.owner.source.id}`);
      shutting = shut();
      void shutting
        .catch(() => {})
        .then(() => {
          if (retired) return;
          const delay = schedule(receipt);
          console.error(
            `mistri: ${name} closed after a write whose outcome could not be confirmed; ` +
              `its writes are refused and /readyz answers 503 until it reopens (first try in ${delay / 1000}s).`,
          );
        });
    },
    close(): Promise<void> {
      if (!retired) {
        const wasClosing = closing;
        closing = true;
        retired = (async () => {
          if (timer) clearTimeout(timer);
          timer = undefined;
          resume?.();
          if (wasClosing) {
            await shutting?.catch(() => {});
            await reopening?.catch(() => {});
            return;
          }
          await shut();
        })();
        void retired.catch(() => {});
      }
      return retired;
    },
  };
}
