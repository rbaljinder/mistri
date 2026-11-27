/**
 * The providers this server reaches, and each one's circuit.
 *
 * Which: a script the operator or a test names
 * (`MISTRI_DECIDE_SCRIPT`, a JSON file — for a demo or a browser test, never
 * a network call; not read under NODE_ENV=production, so a deployment's
 * decisions are a model's, never a canned answer left in its environment),
 * then each provider whose key the server's environment holds:
 * `ANTHROPIC_API_KEY` for Claude, `JEV_API_KEY` (and `JEV_BASE_URL`, if not
 * Jev's default) for Jev. The operator holds the keys and the bill, as for the
 * assistant; no key, no decisions — an App that declares some still starts.
 *
 * The circuit is per process and per provider: five failures in a row open
 * it for a minute, during which the provider is not asked and the next one
 * the declaration names is (and only suggests); the first call after the
 * minute is a trial, and a success closes it.
 */
import { readFileSync } from 'node:fs';
import { anthropicDecisions } from './anthropicDecisions.js';
import type { DecisionProvider, ProviderName } from './decisionProvider.js';
import { jevDecisions } from './jevDecisions.js';
import { scriptedDecisions, type DecisionScript } from './scriptedDecisions.js';

export type DecisionProviders = Readonly<Partial<Record<ProviderName, DecisionProvider>>>;

/** Every provider a script answers as. */
function scriptedProviders(script: DecisionScript): DecisionProviders {
  const names = script.providers ?? (['jev', 'anthropic'] as const);
  return Object.fromEntries(names.map((name) => [name, scriptedDecisions(script, name)]));
}

/** The providers reachable now, from the operator's script or the operator's keys. */
export function decisionProviders(env: NodeJS.ProcessEnv = process.env): DecisionProviders {
  const script = env.NODE_ENV === 'production' ? undefined : env.MISTRI_DECIDE_SCRIPT;
  if (script) return scriptedProviders(JSON.parse(readFileSync(script, 'utf8')) as DecisionScript);
  return {
    ...(env.ANTHROPIC_API_KEY ? { anthropic: anthropicDecisions(env.ANTHROPIC_API_KEY) } : {}),
    ...(env.JEV_API_KEY ? { jev: jevDecisions(env.JEV_API_KEY, env.JEV_BASE_URL || undefined) } : {}),
  };
}

/* ---------- the circuit ---------- */

const FAILURES_TO_OPEN = 5;
const OPEN_MS = 60_000;
interface Circuit {
  failures: number;
  openUntil: number;
  /** True while a single half-open trial probe is in flight after an open window elapsed. */
  probing: boolean;
}
const circuits = new Map<ProviderName, Circuit>();

/** Whether a provider may be asked now. */
export function circuitClosed(name: ProviderName, now: number): boolean {
  const circuit = circuits.get(name);
  return !circuit || (circuit.openUntil <= now && !circuit.probing);
}
/**
 * Claim the right to send a call to `name`. Once an open window expires, only
 * one concurrent caller receives the half-open trial lease so recovering AI
 * providers are not stampeded by a wall of waiting jobs.
 */
export function tryAcquireCircuit(name: ProviderName, now: number): boolean {
  const circuit = circuits.get(name);
  if (!circuit) return true;
  if (circuit.openUntil > now) return false;
  if (circuit.openUntil > 0) {
    if (circuit.probing) return false;
    circuit.probing = true;
  }
  return true;
}
/** Release an in-flight half-open trial lease if a call ends without recording an outcome. */
export function releaseCircuitTrial(name: ProviderName): void {
  const circuit = circuits.get(name);
  if (circuit) circuit.probing = false;
}
/** A call's outcome, as the circuit counts it. An explicit `Retry-After` pauses the provider immediately. */
export function recordCall(name: ProviderName, ok: boolean, now: number, retryAfterMs?: number): void {
  const circuit = circuits.get(name) ?? { failures: 0, openUntil: 0, probing: false };
  if (ok) {
    circuits.delete(name);
    return;
  }
  circuit.probing = false;
  circuit.failures += 1;
  // A trial after the minute that fails again opens it again at once.
  if (circuit.failures >= FAILURES_TO_OPEN) {
    circuit.openUntil = Math.max(circuit.openUntil, now + Math.max(OPEN_MS, retryAfterMs ?? 0));
    circuit.failures = FAILURES_TO_OPEN - 1;
  } else if (retryAfterMs !== undefined && retryAfterMs > 0) {
    circuit.openUntil = Math.max(circuit.openUntil, now + retryAfterMs);
  }
  circuits.set(name, circuit);
}
/** Every circuit closed again: for a test. */
export function resetCircuits(): void {
  circuits.clear();
}
