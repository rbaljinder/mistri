/**
 * The context control's other door. On a phone the App bar is one row
 * (design.md), and the menu, the brand, search, New, the bell and the account
 * left the context's name a letter wide ("E ▾"): there the control leaves the
 * bar and is the account menu's first item, which opens the same dialog. The
 * bar's control says what it is and how to open it here; the account menu
 * reads it. A module of its own, so the account menu does not load the
 * tenancy code to say one line of it.
 */
interface TenantContextEntry {
  /** "Tenant:" or the App's own word ("Dealer:"). */
  readonly word: string;
  /** The context's name: its profile record's, never its id where it has a name. */
  readonly name: string;
  /** Said beside the name where the context is a sandbox ("Sandbox"). */
  readonly sandbox?: string;
  readonly busy: boolean;
  /** Opens the context dialog the bar's control opens. */
  readonly open: () => void;
}

let entry: TenantContextEntry | undefined;
const listeners = new Set<() => void>();

/** Said by the control while it is mounted; undefined takes it back. Only the entry that is current may take itself back. */
export function setTenantContextEntry(next: TenantContextEntry | undefined, replacing?: TenantContextEntry): void {
  if (next === undefined && replacing !== undefined && entry !== replacing) return;
  entry = next;
  for (const listener of [...listeners]) listener();
}

export const tenantContextEntry = (): TenantContextEntry | undefined => entry;

export function subscribeTenantContextEntry(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
