/**
 * A moment whose reads belong together: a write's refresh asks the record's
 * page, its lists and its counts at once, and a transport that can carry
 * several reads in one request (the tenant transport's `POST /api/boot`,
 * mistri client/tenantTransport.ts) sends what is asked in it as one, where
 * each went as its own request: on a remote database every request is a
 * round trip, a context's admission and a snapshot of its own. Outside such a
 * moment every read goes the moment it is asked, as it always did.
 *
 * The moment is this task and its promises; it ends at the next timer's turn.
 */
let open = false;

/** Reads asked from now until this task ends may be sent as one. */
export function gatherReads(): void {
  if (open) return;
  open = true;
  setTimeout(() => {
    open = false;
  }, 0);
}

/** Whether a read asked now is asked in a moment whose reads belong together. */
export const gatheringReads = (): boolean => open;
