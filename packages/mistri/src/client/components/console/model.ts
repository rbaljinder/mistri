/** Console's narrow browser DTOs. Handles are intent, never authorization. */
import type { AudienceDefinition, FlagOverride } from '../../../shared/appFlags.js';
import { say } from '../../copy/console/components/console/model.js';

export type Action = 'view' | 'manage' | 'kill';
export interface Target {
  id: string;
  name: string;
  environment: string;
  scopes: { id: string; label: string }[];
}
export interface FlagRow {
  id: string;
  flagId: string;
  revision: number;
  actions: Action[];
  owner?: string;
  disabled?: boolean;
  rollout?: number;
  type?: string;
  kind?: 'boolean' | 'variant' | 'experiment';
  changedAt?: string;
  expiry?: string;
}
export interface FlagDetail extends FlagRow {
  environment: string;
  type?: 'boolean' | 'string' | 'number' | 'object';
  variants?: unknown[];
  value?: unknown;
  /** The declared default: what everyone outside the rules and the rollout gets. */
  defaultValue?: unknown;
  /** What a kill switch serves, when the flag declares one. */
  safeValue?: unknown;
  disabled?: boolean;
  owner?: string;
  resultsAvailable: boolean;
  control?: Omit<FlagOverride, 'experiment'> | null;
  experimentAllocated?: boolean;
  /** The App's declared audiences, each as defined: a rule names them, it never edits one. */
  audiences?: Readonly<Record<string, AudienceDefinition>>;
  scope?: 'global' | 'tenant';
  lifecycleAvailable?: boolean;
}
export class ConsoleFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export type ConsoleRequest = <T>(path: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
export function consoleRequest(endpoint: string, account: string): ConsoleRequest {
  return async <T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(endpoint + path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
        headers: { 'x-mistri-account': account, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ConsoleFailure(
        body === undefined ? 'read_failed' : 'outcome_unknown',
        say(body === undefined ? 'readFailed' : 'changeUnconfirmed'),
      );
    }
    let value: { code?: string; error?: string };
    try {
      value = await response.json();
    } catch {
      throw new ConsoleFailure(body === undefined ? 'read_failed' : 'outcome_unknown', say('responseUnconfirmed'));
    }
    if (!response.ok) throw new ConsoleFailure(value.code ?? 'refused', value.error ?? say('operationUnavailable'));
    return value as T;
  };
}

export function editedValue(detail: FlagDetail, text: string): unknown {
  if (detail.variants) {
    const selected = detail.variants.find((value) => JSON.stringify(value) === text);
    if (selected === undefined) throw new Error(say('chooseDeclaredVariant'));
    return selected;
  }
  if (detail.type === 'string') return text;
  if (detail.type === 'boolean' && (text === 'true' || text === 'false')) return text === 'true';
  if (detail.type === 'number' && text.trim() && Number.isFinite(Number(text))) return Number(text);
  if (detail.type === 'object') {
    try {
      const value: unknown = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      /* say the field problem below */
    }
  }
  throw new Error(say('invalidValue', { type: detail.type ?? say('declaredValue') }));
}
