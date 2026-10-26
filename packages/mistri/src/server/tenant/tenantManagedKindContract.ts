/**
 * What a managed transaction needs of a principal's kind. runManaged
 * (tenantManagedTransaction.ts) owns the lifetime, the fail-stop queue and the
 * owner injection; each kind, one per module, answers only who the evidence
 * is: its exact keys, the tenant it places rows with, and which operations it
 * may ever perform. The kind is chosen by the evidence's own `realm`.
 */

/** The fields every kind's evidence carries; the kind checks the rest by its exact keys. */
export interface TenantManagedEvidence {
  readonly appId: string;
  readonly source: { readonly id: string; readonly connection: string };
  readonly deployment: string;
}
export interface TenantManagedKind {
  /** The evidence's `realm`; a tenant member's evidence carries none and reads as 'tenant'. */
  readonly realm: string;
  /** The evidence's exact keys: anything more or less is refused. */
  readonly keys: readonly string[];
  /** The tenant this transaction places rows with and holds keys to, validated;
   * undefined when the kind has no tenant of its own (it writes the platform's rows). */
  tenantOf(evidence: Readonly<Record<string, unknown>>): string | undefined;
  /** Validate the principal's own identifiers, where the kind has any. */
  identify(evidence: Readonly<Record<string, unknown>>): void;
  /** Whether the kind performs this operation at all, for this evidence. */
  allows(operation: 'insert' | 'update' | 'remove', evidence: Readonly<Record<string, unknown>>): boolean;
  /** Whether a kind with a tenant of its own also writes the platform's rows:
   * a platform command acting in one named tenant. Absent, a kind with a tenant writes none. */
  readonly platformRows?: boolean;
  /** What the kind may write in a transaction that is no command's: absent,
   * what it writes in a command's; 'platform-rows', the platform's own rows
   * alone, never a tenant's, never the profile's birth or end and
   * never a column a key stands on. The second layer under the platform
   * realm's generic edit, which its runtime has already narrowed. */
  readonly uncommanded?: 'platform-rows';
}
