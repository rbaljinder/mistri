/** Internal portable DTO proposal. No storage capability, public wire contract,
 * authentication or event delivery is supplied by these types. */
type CommandEventScalar = string | number | boolean | null;
export type CommandEventJson = CommandEventScalar | readonly CommandEventJson[] | { readonly [key: string]: CommandEventJson };

/** Shared hard ceilings for declaration capture, generation and storage reads.
 * Payload JSON is an object of at most fields explicitly allowed top-level keys;
 * values may be nested JSON. Strings are
 * well-formed UTF-8; integer numbers must be safe (large IDs stay strings). */
export const COMMAND_EVENT_LIMITS = Object.freeze({
  events: 32,
  fields: 16,
  nameBytes: 128,
  fieldBytes: 64,
  stringBytes: 1024,
  payloadBytes: 16_384,
  batchPayloadBytes: 65_536,
  manifestBytes: 65_536,
  // Payload JSON strings are escaped again in the serialized draft array.
  batchBytes: 196_608,
  outputBytes: 16_384,
});

interface CommandEventIdentity {
  readonly name: string;
  /** Business payload semantics; independent of command and envelope versions. */
  readonly version: number;
}

interface CommandEventDraft extends CommandEventIdentity {
  readonly payloadJson: string;
}

/** Exact nonempty ordered identity list for receipt lookup. Omitted expectation
 * means no events and must refuse an existing batch; empty lists are invalid.
 * Changing emission meaning/order requires a command-version change; changing
 * payload shape/meaning also requires a payload-version change. */
export type CommandEventManifest = readonly CommandEventIdentity[];
/** The manifest used as the exact receipt-lookup expectation. */
export type CommandEventExpectation = CommandEventManifest;

/** One draft for each expected identity, in the same order. The journal must
 * independently capture/validate its bounds and persist a complete association.
 * Drafts intentionally carry no authored provenance or generated IDs. */
export type CommandEventBatch = readonly CommandEventDraft[];

type CommandEventScope = 'app' | 'tenant';

/** Who a batch is written as: the verified source owner the journal is bound
 * to, with the receipt's actor. Never a request field, and structural typing
 * is not proof of that authority: the journal builds it. */
export type CommandEventOwner =
  | Readonly<{ scope: 'app'; appId: string; storeId: string; sourceId: string; actorId: string }>
  | Readonly<{ scope: 'tenant'; appId: string; storeId: string; sourceId: string; tenantId: string; actorId: string }>;

/** To be supplied ONLY by the verified runtime/source owner, never by a request,
 * projector or declaration. Structural typing is not proof of that authority.
 * Membership revisions/roles/deployment remain in the paired private audit;
 * they must not change durable event/receipt uniqueness on renewed admission. */
export interface CommandEventRuntimeContext {
  readonly appId: string;
  readonly storeId: string;
  readonly sourceId: string;
  /** 'app': an App-scope command emitted it, and there is no tenant.
   * 'tenant': one tenant's command did, and `tenantId` names that tenant. */
  readonly scope: CommandEventScope;
  /** Present exactly when the scope is 'tenant'. */
  readonly tenantId?: string;
  readonly actorId: string;
  readonly commandId: string;
  readonly commandVersion: number;
  readonly resource: string;
  readonly key: Readonly<Record<string, string | number>>;
  readonly receiptId: string;
  readonly requestId: string;
  /** Runtime occurrence time, not proof of the instant SQLite committed. */
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly causation: Readonly<{ kind: 'command'; receiptId: string }>;
}

/** Proposed immutable persisted envelope. The integration owner must capture,
 * bound and attest runtime context against its actual writer/receipt/audit.
 * No builder here accepts unverified structural data as runtime authority. */
export interface CommandEventEnvelope extends CommandEventRuntimeContext {
  readonly envelopeVersion: 2;
  readonly eventId: string;
  /** Zero-based position in the receipt's immutable ordered batch. */
  readonly ordinal: number;
  readonly name: string;
  /** Payload version, independent of envelopeVersion and commandVersion. */
  readonly version: number;
  readonly payloadJson: string;
}
