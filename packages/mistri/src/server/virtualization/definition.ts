/** Authored virtual HTTP services. Definitions are trusted local test code;
 * each running instance clones state and owns its requests independently. */
import { validateRequestMatcher, type RequestMatcher, type VirtualRequest } from './matching.js';

export interface VirtualClock {
  now(): number;
  advance(milliseconds: number): void;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}
export interface VirtualReply {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** Wall-clock transport delay. Business time uses ctx.clock instead. */
  readonly delayMs?: number;
  readonly fault?: 'disconnect' | 'timeout';
}
export interface ServiceContext<State> extends VirtualRequest {
  readonly rawBody: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  /** A private transaction copy; committed only on successful handler completion. */
  readonly state: State;
  readonly clock: VirtualClock;
  readonly random: () => number;
  readonly signal: AbortSignal;
}
export interface ServiceRoute<State> {
  readonly id: string;
  readonly match: RequestMatcher;
  readonly reply: VirtualReply | ((context: ServiceContext<State>) => VirtualReply | Promise<VirtualReply>);
  /** Higher priorities win. Equal-priority multiple matches fail the test. */
  readonly priority?: number;
}
export interface ServiceDefinition<State> {
  readonly name: string;
  readonly state: State;
  readonly routes: readonly ServiceRoute<State>[];
  /** An active scenario replaces same-ID base routes, adding other IDs. */
  readonly scenarios?: Readonly<Record<string, readonly ServiceRoute<State>[]>>;
}

export function defineService<State>(definition: ServiceDefinition<State>): ServiceDefinition<State> {
  if (!definition.name?.trim()) throw new Error('Virtual service needs a name.');
  structuredClone(definition.state);
  const validate = (routes: readonly ServiceRoute<State>[]) => {
    if (!Array.isArray(routes)) throw new Error('Service routes must be an array.');
    const ids = new Set<string>();
    for (const route of routes) {
      if (!route.id || ids.has(route.id)) throw new Error('Route IDs must be nonempty and unique within a scenario.');
      ids.add(route.id);
      validateRequestMatcher(route.match);
      if (route.priority !== undefined && !Number.isSafeInteger(route.priority)) throw new Error('Route priority must be a safe integer.');
      if (!route.reply || !['object', 'function'].includes(typeof route.reply)) throw new Error('Route reply is required.');
    }
  };
  validate(definition.routes);
  for (const [name, routes] of Object.entries(definition.scenarios ?? {})) {
    if (!name.trim()) throw new Error('Scenario needs a name.');
    validate(routes);
  }
  return definition;
}
