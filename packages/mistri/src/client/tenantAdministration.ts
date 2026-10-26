import {
  ADMINISTRATION_HTTP_HEADER,
  ADMINISTRATION_HTTP_ROOT,
  ADMINISTRATION_OPERATIONS,
  ASSISTANT_CONSENT_MOST,
  ASSISTANT_USAGE_MOST,
  DECISION_USAGE_MOST,
  type AdministrationAssistantImage,
  type AdministrationAttempt,
  type AdministrationDecisionSwitch,
  type AdministrationDecisionUsagePage,
  type AdministrationImportPlan,
  type AdministrationIntent,
  type AdministrationMembershipImage,
  type AdministrationMembershipOperation,
  type AdministrationMembershipPage,
  type AdministrationResult,
  type AdministrationSession,
  type AdministrationTenantImage,
  type AdministrationTenantPage,
  type AdministrationTenantTarget,
  type AdministrationUsagePage,
} from '../shared/tenantAdministration.js';
import {
  assertAccountCurrent,
  captureAccountIdentity,
  sessionIdentity,
  subscribeSessionIdentity,
  type SessionIdentitySnapshot,
} from '@mistriwork/kit/client/sessionIdentity.js';
import { say } from './copy/tenancy/tenantAdministration.js';
import { isTenantName } from './tenantNames.js';
import { administrationAdmitted as admitted, administrationUnresolved as unresolved } from './tenantAccountState.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';
export { hasAdministrationSession, hasUnresolvedAdministration } from './tenantAccountState.js';

class TenantAdministrationError extends Error {
  constructor(
    readonly outcome: 'not_applied' | 'unknown',
    message = say('administrationAccessCouldNotBeVerified'),
  ) {
    super(message);
  }
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024 && value.trim() === value && !/\p{Cc}/u.test(value);
const version = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,127}$/.test(value);
const time = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
// A tenant id as the server takes a new one (tenantMembership.ts): a clone names its sandbox before it exists.
const isTenantId = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const roles = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 256 && value.every(id) && new Set(value).size === value.length;
function tenant(value: unknown): value is AdministrationTenantImage {
  return object(value) && id(value.tenantId) && version(value.version) && ['active', 'suspended', 'closed'].includes(String(value.status));
}
function membership(value: unknown): value is AdministrationMembershipImage {
  return (
    object(value) &&
    id(value.membershipId) &&
    id(value.tenantId) &&
    id(value.accountId) &&
    version(value.version) &&
    ['active', 'invited', 'revoked'].includes(String(value.status)) &&
    roles(value.roles) &&
    time(value.validUntil)
  );
}
/** A consent reference as the server takes one: one plain line, required to turn the assistant on. */
export const consentReference = (value: string, enabled: boolean): boolean =>
  value === value.trim() && [...value].length <= ASSISTANT_CONSENT_MOST && !/[\p{Cc}\p{Cs}]/u.test(value) && (!enabled || !!value);
function assistant(value: unknown): value is AdministrationAssistantImage {
  return object(value) && typeof value.enabled === 'boolean' && typeof value.consent === 'string';
}
function decision(value: unknown): value is AdministrationDecisionSwitch {
  return (
    object(value) &&
    typeof value.provider === 'string' &&
    /^[a-z]{1,32}$/.test(value.provider) &&
    typeof value.enabled === 'boolean' &&
    typeof value.consent === 'string'
  );
}
function page(value: unknown): value is Record<string, unknown> & { items: unknown[]; next: string | null } {
  return object(value) && Array.isArray(value.items) && value.items.length <= 20 && (value.next === null || id(value.next));
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function result(value: unknown, attempt: AdministrationAttempt): AdministrationResult {
  if (
    !object(value) ||
    !id(value.receiptId) ||
    !id(value.requestId) ||
    typeof value.completedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.completedAt)) ||
    typeof value.replayed !== 'boolean' ||
    !object(value.change)
  )
    throw new Error();
  const change = value.change,
    intent = attempt.intent;
  const validState = (state: unknown) =>
    object(state) &&
    tenant(state.tenant) &&
    state.tenant.tenantId === intent.tenantId &&
    (state.membership === undefined || (membership(state.membership) && state.membership.tenantId === intent.tenantId)) &&
    (state.assistant === undefined || assistant(state.assistant)) &&
    (state.decisions === undefined || decision(state.decisions));
  if (change.operation !== intent.operation || !validState(change.after) || (change.before !== null && !validState(change.before)))
    throw new Error();
  const after = change.after as unknown as AdministrationResult['change']['after'];
  const before = change.before as unknown as AdministrationResult['change']['before'];
  // A clone's and an import's own account, and no other change's.
  if (Object.hasOwn(change, 'clone') !== (intent.operation === 'cloneTenant')) throw new Error();
  if (Object.hasOwn(change, 'import') !== (intent.operation === 'importTenant')) throw new Error();
  if (intent.operation === 'cloneTenant') {
    const clone = change.clone;
    if (
      before !== null ||
      after.tenant.status !== 'active' ||
      !object(clone) ||
      clone.sourceTenantId !== intent.sourceTenantId ||
      clone.samples !== intent.samples ||
      !count(clone.rows)
    )
      throw new Error();
    return frozen(value as unknown as AdministrationResult);
  }
  if (intent.operation === 'importTenant') {
    const imported = change.import;
    if (
      !before ||
      before.tenant.version !== intent.expectedTenantVersion ||
      after.membership ||
      !object(imported) ||
      imported.sandboxTenantId !== intent.sandboxTenantId ||
      ![imported.inserted, imported.updated, imported.deleted].every(count)
    )
      throw new Error();
    return frozen(value as unknown as AdministrationResult);
  }
  if (intent.operation === 'createTenant') {
    if (before !== null || after.tenant.status !== 'active' || after.membership) throw new Error();
  } else {
    if (!before || before.tenant.version !== intent.expectedTenantVersion) throw new Error();
    if (intent.operation === 'setTenantStatus') {
      if (after.tenant.status !== intent.status || after.membership) throw new Error();
    } else if (intent.operation === 'setTenantAssistant') {
      if (after.membership || after.assistant?.enabled !== intent.enabled || after.assistant.consent !== intent.consent) throw new Error();
    } else if (intent.operation === 'setTenantDecisions') {
      if (
        after.membership ||
        after.decisions?.provider !== intent.provider ||
        after.decisions.enabled !== intent.enabled ||
        after.decisions.consent !== intent.consent
      )
        throw new Error();
    } else {
      const member = after.membership;
      if (!member) throw new Error();
      if (intent.operation === 'grantMembership') {
        if (member.accountId !== intent.accountId) throw new Error();
      } else if (
        member.membershipId !== intent.membershipId ||
        before.membership?.membershipId !== intent.membershipId ||
        before.membership.version !== intent.expectedMembershipVersion
      )
        throw new Error();
      if (intent.operation === 'revokeMembership') {
        if (member.status !== 'revoked') throw new Error();
      } else if (
        member.status !== 'active' ||
        member.validUntil !== intent.validUntil ||
        member.roles.length !== intent.roles.length ||
        member.roles.some((role) => !intent.roles.includes(role))
      )
        throw new Error();
    }
  }
  return frozen(value as unknown as AdministrationResult);
}

/** Deliberately independent of the business API: administration has no selected
 * tenant, tab, lease or revision headers, including for zero-membership operators. */
async function request(
  owner: SessionIdentitySnapshot,
  session: AdministrationSession | null,
  route: string,
  query: Record<string, string> = {},
  attempt?: AdministrationAttempt,
): Promise<{ data: Record<string, unknown>; context: string | null }> {
  let dispatched = false;
  try {
    assertAccountCurrent(owner);
    if (owner.mode !== 'authenticated' || !owner.accountId || !owner.appId) throw new Error();
    if (
      route !== 'open' &&
      (!session || session.appId !== owner.appId || session.accountId !== owner.accountId || session.expiresAt <= Date.now())
    )
      throw new Error();
    const post = route === 'open' || !!attempt;
    dispatched = true;
    const response = await fetchServer(`${ADMINISTRATION_HTTP_ROOT}/${route}?${new URLSearchParams({ app: owner.appId, ...query })}`, {
      method: post ? 'POST' : 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
      headers: {
        'x-mistri-account': owner.accountId,
        'x-mistri-app': owner.appId,
        ...(session && route !== 'open' ? { [ADMINISTRATION_HTTP_HEADER]: session.context } : {}),
        ...(post ? { 'content-type': 'application/json' } : {}),
      },
      ...(post ? { body: JSON.stringify(attempt ?? {}) } : {}),
    });
    const verify = () => {
      assertAccountCurrent(owner);
      const account = response.headers.get('x-mistri-account'),
        app = response.headers.get('x-mistri-app');
      const context = response.headers.get(ADMINISTRATION_HTTP_HEADER);
      // Refusals deliberately disclose no owner. A fresh execute can accept an
      // explicit not_applied refusal; status never settles a prior uncertainty.
      if (
        ((response.ok || account !== null) && account !== owner.accountId) ||
        ((response.ok || app !== null) && app !== owner.appId) ||
        (route !== 'open' && (response.ok || context !== null) && context !== session!.context)
      )
        throw new Error();
    };
    verify();
    const data: unknown = await response.json();
    verify();
    if (!object(data)) throw new Error();
    if (!response.ok) {
      if (route === 'execute' && data.outcome === 'not_applied') throw new TenantAdministrationError('not_applied', say('theChangeWasNot'));
      throw new Error();
    }
    return { data, context: response.headers.get(ADMINISTRATION_HTTP_HEADER) };
  } catch (error) {
    if (route !== 'status' && error instanceof TenantAdministrationError) throw error;
    throw new TenantAdministrationError(
      route === 'status' || (route === 'execute' && dispatched) ? 'unknown' : 'not_applied',
      route === 'status' || (route === 'execute' && dispatched) ? say('theChangeIsUnconfirmed') : undefined,
    );
  }
}

export async function openAdministration(owner: SessionIdentitySnapshot): Promise<AdministrationSession | null> {
  const { data, context } = await request(owner, null, 'open');
  if (data.session === null && context === null) return null;
  const s = data.session;
  if (
    !object(s) ||
    s.appId !== owner.appId ||
    s.accountId !== owner.accountId ||
    !id(s.context) ||
    s.context !== context ||
    !time(s.expiresAt) ||
    s.expiresAt <= Date.now() ||
    !time(s.maxMembershipLifetimeMs)
  )
    throw new TenantAdministrationError('not_applied');
  return frozen(s as unknown as AdministrationSession);
}
export async function listAdministrationTenants(
  owner: SessionIdentitySnapshot,
  session: AdministrationSession,
  after?: string,
): Promise<AdministrationTenantPage> {
  const { data } = await request(owner, session, 'tenants', { limit: '20', ...(after ? { after } : {}) });
  if (
    !page(data.page) ||
    !data.page.items.every(
      (item) =>
        object(item) &&
        id(item.tenantId) &&
        (item.name === undefined || isTenantName(item.name)) &&
        (item.tenant === null || (tenant(item.tenant) && item.tenant.tenantId === item.tenantId)) &&
        Array.isArray(item.capabilities) &&
        item.capabilities.length <= ADMINISTRATION_OPERATIONS.length &&
        (item.assistant === undefined || assistant(item.assistant)) &&
        (item.decisions === undefined ||
          (Array.isArray(item.decisions) &&
            item.decisions.length <= 8 &&
            item.decisions.every(decision) &&
            new Set(item.decisions.map((d) => d.provider)).size === item.decisions.length)) &&
        (item.sandbox === undefined || (object(item.sandbox) && id(item.sandbox.sourceTenantId))) &&
        (item.sandboxes === undefined || (Array.isArray(item.sandboxes) && item.sandboxes.length <= 50 && item.sandboxes.every(tenant))) &&
        new Set(item.capabilities.map((c) => object(c) && c.operation)).size === item.capabilities.length &&
        item.capabilities.every((c) => object(c) && ADMINISTRATION_OPERATIONS.includes(c.operation as never) && roles(c.roles)),
    )
  )
    throw new TenantAdministrationError('not_applied');
  return frozen(data.page as unknown as AdministrationTenantPage);
}
export async function listAdministrationMemberships(
  owner: SessionIdentitySnapshot,
  session: AdministrationSession,
  tenantId: string,
  operation: AdministrationMembershipOperation,
  after?: string,
): Promise<AdministrationMembershipPage> {
  const { data } = await request(owner, session, 'memberships', { tenantId, operation, limit: '20', ...(after ? { after } : {}) });
  const p = data.page;
  if (
    !page(p) ||
    !object(p) ||
    p.operation !== operation ||
    !roles(p.roles) ||
    !(p.tenant === null || (tenant(p.tenant) && p.tenant.tenantId === tenantId)) ||
    !p.items.every((m) => membership(m) && m.tenantId === tenantId && m.roles.every((role) => (p.roles as string[]).includes(role)))
  )
    throw new TenantAdministrationError('not_applied');
  return frozen(p as unknown as AdministrationMembershipPage);
}
/** Assistant tokens by tenant and day, newest first: an operator's bill, from `since` (YYYY-MM-DD). */
async function assistantUsage(
  owner: SessionIdentitySnapshot,
  session: AdministrationSession,
  since?: string,
): Promise<AdministrationUsagePage> {
  const { data } = await request(owner, session, 'assistant-usage', since ? { since } : {});
  const usage = data.usage;
  if (
    !object(usage) ||
    typeof usage.truncated !== 'boolean' ||
    !Array.isArray(usage.rows) ||
    usage.rows.length > ASSISTANT_USAGE_MOST ||
    !usage.rows.every(
      (row) =>
        object(row) &&
        id(row.tenantId) &&
        typeof row.day === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(row.day) &&
        Number.isSafeInteger(row.tokens),
    )
  )
    throw new TenantAdministrationError('not_applied');
  return frozen(usage as unknown as AdministrationUsagePage);
}
/** Decision calls, units and cost by tenant and day, newest first: an operator's bill, from `since` (YYYY-MM-DD). */
async function decisionUsage(
  owner: SessionIdentitySnapshot,
  session: AdministrationSession,
  since?: string,
): Promise<AdministrationDecisionUsagePage> {
  const { data } = await request(owner, session, 'decision-usage', since ? { since } : {});
  const usage = data.usage;
  if (
    !object(usage) ||
    typeof usage.truncated !== 'boolean' ||
    !Array.isArray(usage.rows) ||
    usage.rows.length > DECISION_USAGE_MOST ||
    !usage.rows.every(
      (row) =>
        object(row) &&
        id(row.tenantId) &&
        typeof row.day === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(row.day) &&
        count(row.calls) &&
        count(row.units) &&
        count(row.costMicros),
    )
  )
    throw new TenantAdministrationError('not_applied');
  return frozen(usage as unknown as AdministrationDecisionUsagePage);
}
/** What importing `sandboxTenantId` into `tenantId` would do, and each row that conflicts: read before an approval. */
async function importPlan(
  owner: SessionIdentitySnapshot,
  session: AdministrationSession,
  tenantId: string,
  sandboxTenantId: string,
): Promise<AdministrationImportPlan> {
  const { data } = await request(owner, session, 'import-plan', { tenantId, sandboxTenantId });
  const plan = data.plan;
  const counts = (value: unknown): value is Record<string, unknown> =>
    object(value) && count(value.inserted) && count(value.updated) && count(value.deleted);
  if (
    !counts(plan) ||
    typeof plan.truncated !== 'boolean' ||
    !object(plan.resources) ||
    !Object.values(plan.resources).every(counts) ||
    !Array.isArray(plan.conflicts) ||
    plan.conflicts.length > 100 ||
    !plan.conflicts.every(
      (conflict) =>
        object(conflict) &&
        id(conflict.resource) &&
        typeof conflict.key === 'string' &&
        ['changed', 'removed', 'taken', 'reference'].includes(String(conflict.reason)),
    )
  )
    throw new TenantAdministrationError('not_applied');
  return frozen(plan as unknown as AdministrationImportPlan);
}
export async function executeAdministration(
  owner: SessionIdentitySnapshot,
  session: AdministrationSession,
  attempt: AdministrationAttempt,
): Promise<AdministrationResult> {
  const { data } = await request(owner, session, 'execute', {}, attempt);
  try {
    if (data.outcome !== 'applied') throw new Error();
    return result(data.result, attempt);
  } catch {
    throw new TenantAdministrationError('unknown');
  }
}
export async function statusAdministration(
  owner: SessionIdentitySnapshot,
  session: AdministrationSession,
  attempt: AdministrationAttempt,
): Promise<AdministrationResult | null> {
  try {
    const { data } = await request(owner, session, 'status', {}, attempt);
    if (data.status === 'not_found' && data.outcome === 'unknown' && data.result === null) return null;
    if (data.status !== 'completed' || data.outcome !== 'applied') throw new Error();
    return result(data.result, attempt);
  } catch {
    throw new TenantAdministrationError('unknown');
  }
}

export interface AdministrationView {
  readonly session: AdministrationSession | null;
  readonly page: AdministrationTenantPage | null;
  readonly target: AdministrationTenantTarget | null;
  readonly memberships: AdministrationMembershipPage | null;
  readonly phase: 'idle' | 'review' | 'executing' | 'unknown' | 'checking';
  readonly loading: boolean;
  readonly attempt: AdministrationAttempt | null;
  readonly result: AdministrationResult | null;
  readonly message: string;
  /** The assistant's token counts, once asked for (the Usage tab). */
  readonly usage: AdministrationUsagePage | null;
  /** The decisions' calls, units and cost, once asked for (the Decision usage tab). */
  readonly decisionUsage: AdministrationDecisionUsagePage | null;
  /** What importing one of the target's sandboxes would do, once asked for. */
  readonly importPlan: Readonly<{ sandbox: AdministrationTenantImage; plan: AdministrationImportPlan }> | null;
}
const empty = (): AdministrationView => ({
  session: null,
  page: null,
  target: null,
  memberships: null,
  phase: 'idle',
  loading: false,
  attempt: null,
  result: null,
  message: '',
  usage: null,
  decisionUsage: null,
  importPlan: null,
});

/** One account-menu owner, including dialog reopenings. No timer or rerender
 * mints contexts; only explicit expired-context recovery opens another one. */
export class TenantAdministrationController {
  private value = empty();
  private listeners = new Set<() => void>();
  private retired = false;
  private generation = 0;
  private opening?: Promise<AdministrationSession | null>;
  private unsubscribe: () => void = () => {};
  readonly owner: SessionIdentitySnapshot;
  private observing = false;
  constructor(owner = sessionIdentity()) {
    this.owner = captureAccountIdentity(owner);
  }
  snapshot = (): AdministrationView => this.value;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  current = (): boolean => !this.retired && this.owner === captureAccountIdentity() && sessionIdentity().mode === 'authenticated';
  locked = (): boolean => ['executing', 'unknown', 'checking'].includes(this.value.phase);
  private publish(patch: Partial<AdministrationView>) {
    if (!this.current()) return;
    this.value = { ...this.value, ...patch };
    if (this.locked()) unresolved.add(this);
    else unresolved.delete(this);
    for (const listener of this.listeners) listener();
  }
  retire() {
    if (this.retired) return;
    this.retired = true;
    this.generation++;
    unresolved.delete(this);
    admitted.delete(this);
    this.unsubscribe();
    this.opening = undefined;
    this.value = empty();
    for (const listener of this.listeners) listener();
  }
  open(): Promise<AdministrationSession | null> {
    if (!this.current()) return Promise.resolve(null);
    if (!this.observing) {
      this.observing = true;
      this.unsubscribe = subscribeSessionIdentity(() => {
        if (captureAccountIdentity() !== this.owner) this.retire();
      });
    }
    this.opening ??= openAdministration(this.owner)
      .then((session) => {
        if (session && this.current()) admitted.add(this);
        this.publish({ session, message: '' });
        return this.current() ? session : null;
      })
      .catch(() => {
        this.opening = undefined;
        this.publish({ message: say('administrationAccessCouldNotBeLoaded') });
        return null;
      });
    return this.opening;
  }
  async loadTenants(after?: string) {
    if (!this.current() || this.locked() || !this.value.session) return;
    const ticket = ++this.generation,
      session = this.value.session;
    this.publish({ page: null, target: null, memberships: null, attempt: null, phase: 'idle', loading: true });
    try {
      const page = await listAdministrationTenants(this.owner, session, after);
      if (ticket === this.generation) this.publish({ page });
    } catch {
      if (ticket === this.generation) this.publish({ message: say('theAuthorizedTenantList') });
    } finally {
      if (ticket === this.generation) this.publish({ loading: false });
    }
  }
  select(tenantId: string) {
    if (!this.current() || this.locked()) return;
    const target = this.value.page?.items.find((item) => item.tenantId === tenantId);
    if (!target) return;
    this.generation++;
    this.publish({ target, memberships: null, attempt: null, phase: 'idle', loading: false, result: null, message: '' });
  }
  async loadMemberships(operation: AdministrationMembershipOperation, after?: string) {
    const { target, session } = this.value;
    if (!this.current() || this.locked() || !target || !session || !target.capabilities.some((c) => c.operation === operation)) return;
    const ticket = ++this.generation;
    this.publish({ memberships: null, attempt: null, phase: 'idle', loading: true, message: '' });
    try {
      const memberships = await listAdministrationMemberships(this.owner, session, target.tenantId, operation, after);
      const capability = target.capabilities.find((c) => c.operation === operation)!;
      if (memberships.roles.length !== capability.roles.length || memberships.roles.some((role) => !capability.roles.includes(role)))
        throw new Error();
      if (ticket === this.generation) this.publish({ memberships });
    } catch {
      if (ticket === this.generation) this.publish({ message: say('theAuthorizedMembershipList') });
    } finally {
      if (ticket === this.generation) this.publish({ loading: false });
    }
  }
  async loadUsage() {
    const { session } = this.value;
    if (!this.current() || this.locked() || !session) return;
    const ticket = ++this.generation;
    this.publish({ usage: null, loading: true, message: '' });
    try {
      const usage = await assistantUsage(this.owner, session);
      if (ticket === this.generation) this.publish({ usage });
    } catch {
      if (ticket === this.generation) this.publish({ message: say('assistantUsageCouldNotBeLoaded') });
    } finally {
      if (ticket === this.generation) this.publish({ loading: false });
    }
  }
  async loadDecisionUsage() {
    const { session } = this.value;
    if (!this.current() || this.locked() || !session) return;
    const ticket = ++this.generation;
    this.publish({ decisionUsage: null, loading: true, message: '' });
    try {
      const usage = await decisionUsage(this.owner, session);
      if (ticket === this.generation) this.publish({ decisionUsage: usage });
    } catch {
      if (ticket === this.generation) this.publish({ message: say('decisionUsageCouldNotBeLoaded') });
    } finally {
      if (ticket === this.generation) this.publish({ loading: false });
    }
  }
  async loadImportPlan(sandboxTenantId: string) {
    const { target, session } = this.value;
    const sandbox = target?.sandboxes?.find((image) => image.tenantId === sandboxTenantId);
    if (!this.current() || this.locked() || !target || !session || !sandbox) return;
    if (!target.capabilities.some((c) => c.operation === 'importTenant')) return;
    const ticket = ++this.generation;
    this.publish({ importPlan: null, attempt: null, phase: 'idle', loading: true, message: '' });
    try {
      const plan = await importPlan(this.owner, session, target.tenantId, sandboxTenantId);
      if (ticket === this.generation) this.publish({ importPlan: { sandbox, plan } });
    } catch {
      if (ticket === this.generation) this.publish({ message: say('theImportCouldNotBeRead') });
    } finally {
      if (ticket === this.generation) this.publish({ loading: false });
    }
  }
  clearOperation() {
    if (!this.current() || this.locked()) return;
    this.generation++;
    this.publish({ memberships: null, importPlan: null, attempt: null, phase: 'idle', loading: false, message: '' });
  }
  prepare(intent: AdministrationIntent): boolean {
    const { target, session, memberships } = this.value;
    if (!this.current() || this.locked() || this.value.loading || !target || !session || session.expiresAt <= Date.now()) return false;
    const capability = target.capabilities.find((c) => c.operation === intent.operation);
    if (!capability) return false;
    /* A clone is asked of its source, which the copy is made from, into a
       sandbox not made yet; an import names the sandbox whose plan was read,
       and is refused here, as at the server, where that plan conflicts. */
    if (intent.operation === 'cloneTenant') {
      if (
        intent.sourceTenantId !== target.tenantId ||
        target.sandbox ||
        target.tenant?.status !== 'active' ||
        target.tenant.version !== intent.expectedSourceVersion ||
        !isTenantId(intent.tenantId) ||
        intent.tenantId === target.tenantId
      )
        return false;
    } else if (intent.operation === 'importTenant') {
      const read = this.value.importPlan;
      if (
        intent.tenantId !== target.tenantId ||
        target.tenant?.status !== 'active' ||
        target.tenant.version !== intent.expectedTenantVersion ||
        read?.sandbox.tenantId !== intent.sandboxTenantId ||
        read.sandbox.version !== intent.expectedSandboxVersion ||
        read.plan.conflicts.length > 0
      )
        return false;
    }
    if (intent.operation === 'cloneTenant' || intent.operation === 'importTenant') {
      const attempt = frozen({ idempotencyKey: crypto.randomUUID(), intent: structuredClone(intent) });
      this.publish({ attempt, phase: 'review', result: null, message: '' });
      return true;
    }
    if (intent.tenantId !== target.tenantId) return false;
    const memberOperation = intent.operation === 'replaceMembership' || intent.operation === 'revokeMembership';
    const currentTenant = memberOperation ? memberships?.tenant : target.tenant;
    if (
      intent.operation === 'createTenant'
        ? target.tenant !== null
        : !currentTenant ||
          (currentTenant.status === 'closed' && intent.operation !== 'revokeMembership') ||
          currentTenant.version !== intent.expectedTenantVersion
    )
      return false;
    if ((intent.operation === 'grantMembership' || intent.operation === 'replaceMembership') && currentTenant?.status !== 'active')
      return false;
    if (intent.operation === 'grantMembership' && !id(intent.accountId)) return false;
    if (
      intent.operation === 'setTenantAssistant' &&
      (!consentReference(intent.consent, intent.enabled) || (intent.enabled && currentTenant?.status !== 'active'))
    )
      return false;
    if (
      intent.operation === 'setTenantDecisions' &&
      (!target.decisions?.some((d) => d.provider === intent.provider) ||
        !consentReference(intent.consent, intent.enabled) ||
        (intent.enabled && currentTenant?.status !== 'active'))
    )
      return false;
    if (
      'roles' in intent &&
      (!roles(intent.roles) ||
        !intent.roles.length ||
        intent.roles.some((role) => !capability.roles.includes(role)) ||
        !time(intent.validUntil) ||
        intent.validUntil <= Date.now() ||
        intent.validUntil > Date.now() + session.maxMembershipLifetimeMs)
    )
      return false;
    if (
      memberOperation &&
      (memberships?.operation !== intent.operation ||
        !memberships.items.some(
          (m) => m.membershipId === intent.membershipId && m.version === intent.expectedMembershipVersion && m.status !== 'revoked',
        ))
    )
      return false;
    const attempt = frozen({ idempotencyKey: crypto.randomUUID(), intent: structuredClone(intent) });
    this.publish({ attempt, phase: 'review', result: null, message: '' });
    return true;
  }
  cancelReview() {
    if (this.value.phase === 'review') this.publish({ phase: 'idle', attempt: null });
  }
  async execute() {
    const { attempt, session, phase } = this.value;
    if (!this.current() || phase !== 'review' || !attempt || !session) return;
    this.publish({ phase: 'executing', message: '' });
    try {
      await this.complete(await executeAdministration(this.owner, session, attempt));
    } catch (error) {
      this.publish(
        error instanceof TenantAdministrationError && error.outcome === 'not_applied'
          ? { phase: 'idle', attempt: null, target: null, memberships: null, page: null, message: error.message }
          : { phase: 'unknown', message: say('theChangeIsUnconfirmedCheck') },
      );
    }
  }
  private async complete(result: AdministrationResult) {
    if (!this.current()) return;
    this.publish({ phase: 'idle', attempt: null, importPlan: null, result, message: say('changeConfirmedTheReceipt') });
    await this.loadTenants();
  }
  async check() {
    const { attempt, session, phase } = this.value;
    if (!this.current() || phase !== 'unknown' || this.value.loading || !attempt || !session) return;
    this.publish({ phase: 'checking', message: '' });
    try {
      const result = await statusAdministration(this.owner, session, attempt);
      if (result) await this.complete(result);
      else this.publish({ phase: 'unknown', message: say('common.noReceiptWasFound') });
    } catch {
      this.publish({ phase: 'unknown', message: say('common.statusCouldNotBeVerified') });
    }
  }
  async recoverContext() {
    const { session, phase } = this.value;
    if (
      !this.current() ||
      !session ||
      session.expiresAt > Date.now() ||
      this.value.loading ||
      phase === 'executing' ||
      phase === 'checking'
    )
      return;
    this.generation++;
    this.publish({ loading: true, page: null, target: null, memberships: null });
    try {
      const fresh = await openAdministration(this.owner);
      if (!fresh) throw new Error();
      this.publish({
        session: fresh,
        message: this.value.attempt ? say('accessRefreshedCheckTheRetained') : say('accessRefreshedLoadTheAuthorized'),
      });
    } catch {
      this.publish({ message: say('common.accessCouldNotBeRefreshed') });
    } finally {
      this.publish({ loading: false });
    }
  }
}
