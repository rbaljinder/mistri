/*
 * The durable keys a workflow's hops carry. Each is derived from what the hop
 * is about, never from a row or an attempt, so a redelivery, a retry of the
 * advance and a second host all land on the same key.
 */
import { createHash } from 'node:crypto';

/** The reserved prefix of a workflow's job id: a jobs module cannot declare a job under it. */
export const WORKFLOW_JOB_PREFIX = 'wf-';
/** A workflow's wake-up job is at this version, always: an instance carries its workflow's own. */
export const WORKFLOW_JOB_VERSION = 1;
export const workflowJobId = (name: string): string => `${WORKFLOW_JOB_PREFIX}${name}`;
export const isWorkflowJob = (id: string): boolean => id.startsWith(WORKFLOW_JOB_PREFIX);
/** A workflow's delivery destination, as a job's is `job:<id>@<version>`. */
export const workflowDestinationId = (name: string, version: number): string => `workflow:${name}@${version}`;

const digest = (...parts: readonly (string | number)[]): string => createHash('sha256').update(parts.join('\n')).digest('hex');

/** A step command's receipt key: the instance and the step, hashed. A receipt key cannot carry ':' (inbound keys are hashed for the same reason). */
export const stepReceiptKey = (instance: string, step: string): string => `wf-${digest(instance, step)}`;

/** A step command's request id, as the command door takes one (`[A-Za-z0-9_:-]`, at most 128): the job and the
 * step when the step's name is plain, and the step's digest when it is not. A step made in a loop is named
 * `advance[0]`, and a name may hold a space or a dot, so the plain form refused every such step as invalid input. */
export const stepRequestId = (jobId: string, step: string): string => {
  const plain = `workflow:${jobId}:${step}`;
  return /^[A-Za-z0-9_:-]{1,128}$/.test(plain) ? plain : `workflow:${digest(jobId, step).slice(0, 64)}`;
};

/** A wake-up's job key (the job store's pattern: letters, digits, `_` and `-`, 16 to 128). */
export const wakeKey = (kind: 'start' | 'timer' | 'signal' | 'resume' | 'retry', ...parts: readonly (string | number)[]): string =>
  `${kind}-${digest(...parts)}`;

/* A tenant App's instances (tenant/tenantJobs.ts): the store's `workflow` is
   the workflow's name and its tenant, so every statement the store makes of
   one — a start's key, a signal recorded, the signals a wait reads, a waiting
   instance found, a retry's live-key check — is of that tenant's instances
   alone, and tenant B's event never wakes or answers tenant A's instance of
   the same key. A tenant id is `[a-z0-9_-]`; one too long for the column is
   named by its digest after `#`, which no tenant id spells. */
const PARTITION_MAX = 128;
/** The store's `workflow` for a workflow's instances: its name, or on a tenant App its name and the tenant's. */
export const workflowPartition = (name: string, tenantId?: string): string => {
  if (tenantId === undefined) return name;
  const plain = `${name}~${tenantId}`;
  return Buffer.byteLength(plain) <= PARTITION_MAX ? plain : `${name}~#${createHash('sha256').update(tenantId).digest('hex').slice(0, 48)}`;
};
/** The workflow a store's `workflow` names, and whether it is one tenant's partition. */
export const workflowOfPartition = (partition: string): Readonly<{ name: string; tenant: boolean }> => {
  const at = partition.indexOf('~');
  return at < 0 ? { name: partition, tenant: false } : { name: partition.slice(0, at), tenant: true };
};
/** Whether a retry may wake an instance of this store `workflow`: an ordinary
 * App's when no tenant is named, a tenant's partition only when its own tenant
 * is — the wake-up carries it, and nothing else may say whose it is. */
export const retryAdmits =
  (tenantId: string | undefined) =>
  (partition: string): boolean => {
    const { name, tenant } = workflowOfPartition(partition);
    return tenant ? tenantId !== undefined && workflowPartition(name, tenantId) === partition : tenantId === undefined;
  };
