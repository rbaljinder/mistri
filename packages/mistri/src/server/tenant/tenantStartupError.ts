/**
 * Tenant startup's refusals. They live apart from the startup pipeline so a
 * feature's startup check (tenantFeature*.ts) can raise one without importing
 * the module that runs it.
 */
export class TenantStartupError extends Error {
  /** `cause` is for the operator who started the deployment, whose terminal
   * already shows the stage sentence: startup happens before any request, so
   * no untrusted caller is on the other end of it. Nothing prints or serializes
   * it, and a refusal raised without one still carries no `cause` at all. */
  /** The stores the App's start attests and its database holds none of, by their id in the store list: the
   * operator is told the one command that makes them (cli/tenant.ts). Store ids only, never where they live. */
  readonly absentStores?: readonly string[];
  constructor(
    message = 'The tenant deployment could not be validated. Check its existing store and server-only policy.',
    options?: { readonly cause?: unknown; readonly absentStores?: readonly string[] },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TenantStartupError';
    if (options?.absentStores?.length) this.absentStores = Object.freeze([...options.absentStores]);
  }
}

/** Only the metadata preflight emits these messages; provider failures stay private. */
export class TenantCommandStartupError extends TenantStartupError {}

/** The authoring check's own refusal, which names the problems it found: an
 * operator ran `mistri check` to be told what is wrong, and these lines are the
 * answer. Kept a class of its own because the pipeline replaces an ordinary
 * refusal's message with the stage it was validating, which is right for every
 * other failure and would throw this diagnosis away. */
export class TenantAuthoringStartupError extends TenantStartupError {}
