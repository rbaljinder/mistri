/**
 * Jev as a decision provider — UNVERIFIED.
 *
 * Jev (TypeSafe AI) answers typed decisions with calibrated probabilities, by
 * its makers' account. Its API was not available when this adapter was
 * written (design R1): the request and reply below are shaped from the
 * design's needs, not from Jev's documentation, and have been exercised only
 * against a local HTTP fake (test/decide-providers.test.ts). Before a
 * deployment relies on it, check this file against Jev's published API with
 * a real key, and correct the shapes here — the rest of the runtime only
 * sees the DecisionProvider interface. Its speed, cost and calibration
 * claims are likewise Jev's own until `mistri decide eval` measures them.
 *
 * Assumed: `POST {JEV_BASE_URL}/v1/decisions` with a bearer key; a body of
 * `{ model?, decisions: [{ id, question, inputs, answer }] }` (batched: one
 * request for every ask); a reply of `{ model, model_version, decisions:
 * [{ id, answer, probability }], usage: { units, cost_micros } }`.
 */
import { asProviderFailure, failureOfStatus, type DecisionProvider } from './decisionProvider.js';

const DEFAULT_BASE = 'https://api.jev.ai';
const DEFAULT_MODEL = 'jev-1';

interface JevReply {
  model?: unknown;
  model_version?: unknown;
  decisions?: unknown;
  usage?: { units?: unknown; cost_micros?: unknown };
}
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0);

export function jevDecisions(key: string, base: string = DEFAULT_BASE, fetchImpl: typeof fetch = fetch): DecisionProvider {
  const url = `${base.replace(/\/+$/, '')}/v1/decisions`;
  return {
    name: 'jev',
    batches: true,
    /* Jev's price was not published when this was written (unverified, as the rest of this adapter): a tenth of a
       cent an ask, until its usage replies say otherwise. */
    estimateMicros: () => 1_000,
    async decide(call) {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({
            ...(call.model ? { model: call.model } : {}),
            decisions: call.asks.map((ask) => ({ id: ask.id, question: ask.question, inputs: ask.inputs, answer: ask.answer })),
          }),
          signal: call.signal,
        });
      } catch (error) {
        throw asProviderFailure(error, call.signal);
      }
      if (!response.ok) throw failureOfStatus(response.status, 'Jev');
      let body: JevReply;
      try {
        body = (await response.json()) as JevReply;
      } catch (error) {
        throw asProviderFailure(error, call.signal);
      }
      const decided = Array.isArray(body.decisions) ? (body.decisions as Array<Record<string, unknown>>) : [];
      const model = typeof body.model === 'string' && body.model ? body.model : (call.model ?? DEFAULT_MODEL);
      return {
        replies: call.asks.map((ask) => {
          const found = decided.find((each) => each && each.id === ask.id);
          return { id: ask.id, answer: found?.answer, probability: found?.probability };
        }),
        model,
        modelVersion: typeof body.model_version === 'string' && body.model_version ? body.model_version : model,
        units: count(body.usage?.units),
        costMicros: count(body.usage?.cost_micros),
      };
    },
  };
}
