/**
 * Declarative multi-provider model routing, fallback parsing, and cost estimation for `assistant(...)` (Wave 4A).
 *
 * Pure shared module: no server or client runtime imports, safe for both DSL parsing and observability rollups.
 */

const ASSISTANT_PROVIDERS = ['anthropic', 'openai', 'gemini', 'openai-compatible'] as const;
export type AssistantProvider = (typeof ASSISTANT_PROVIDERS)[number];

const MAX_FALLBACK_MODELS = 4;

/** Parse an optional `provider` field (`'anthropic' | 'openai' | 'gemini' | 'openai-compatible'`). */
export function parseAssistantProvider(raw: unknown, where: string): AssistantProvider | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !(ASSISTANT_PROVIDERS as readonly string[]).includes(raw)) {
    throw new Error(`${where} is one of ${ASSISTANT_PROVIDERS.join(', ')}.`);
  }
  return raw as AssistantProvider;
}

/** Parse an optional `fallbackModels` array (1–4 non-empty model spec strings, optionally `provider:model`). */
export function parseFallbackModels(raw: unknown, where: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_FALLBACK_MODELS) {
    throw new Error(`${where} is an array of 1 to ${MAX_FALLBACK_MODELS} model names.`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== 'string' || !entry.trim() || entry.trim().length > 120) {
      throw new Error(`${where}[${i}] is a non-empty model string (up to 120 characters).`);
    }
    const clean = entry.trim();
    if (seen.has(clean)) throw new Error(`${where} lists "${clean}" more than once.`);
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

/** Infer provider from a model name when no explicit `provider` or `provider:` prefix is declared. */
function inferProviderForModel(model: string): AssistantProvider {
  const clean = model.trim().toLowerCase();
  if (clean.startsWith('claude')) return 'anthropic';
  if (/^(gpt-|gpt4|o[1-9]|chatgpt)/.test(clean)) return 'openai';
  if (clean.startsWith('gemini')) return 'gemini';
  return 'anthropic';
}

/** Parse a model spec (`"gpt-4.1-mini"` or `"openai:gpt-4.1-mini"`) into `{ provider, model }`. */
export function parseModelTarget(spec: string, explicitProvider?: AssistantProvider): { provider: AssistantProvider; model: string } {
  const trimmed = spec.trim();
  const colon = trimmed.indexOf(':');
  if (colon > 0) {
    const prefix = trimmed.slice(0, colon).toLowerCase();
    const rest = trimmed.slice(colon + 1).trim();
    if ((ASSISTANT_PROVIDERS as readonly string[]).includes(prefix) && rest) {
      return { provider: prefix as AssistantProvider, model: rest };
    }
  }
  return {
    provider: explicitProvider ?? inferProviderForModel(trimmed),
    model: trimmed,
  };
}

interface ModelRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Reference per-1M-token USD pricing for Trace Inspector cost estimates (cached reads at provider discount). */
const MODEL_RATES: Array<{ match: RegExp; rates: ModelRates }> = [
  { match: /claude.*opus/i, rates: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
  { match: /claude.*haiku/i, rates: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 } },
  { match: /claude/i, rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { match: /gpt-4\.1-nano|gpt-4o-mini|o4-mini|o3-mini/i, rates: { input: 0.15, output: 0.6, cacheRead: 0.04, cacheWrite: 0.15 } },
  { match: /gpt-4\.1-mini/i, rates: { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0.4 } },
  { match: /gpt-4|gpt-5|o1|o3/i, rates: { input: 2.5, output: 10, cacheRead: 0.625, cacheWrite: 2.5 } },
  { match: /gemini.*flash/i, rates: { input: 0.15, output: 0.6, cacheRead: 0.0375, cacheWrite: 0.15 } },
  { match: /gemini/i, rates: { input: 1.25, output: 10, cacheRead: 0.3125, cacheWrite: 1.25 } },
];

const DEFAULT_RATES: ModelRates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

/** Estimate USD cost for one or more model calls given token counts (rounded to 6 decimal places). */
export function estimateModelCostUsd(
  modelSpec: string | undefined,
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
): number {
  const target = modelSpec ? parseModelTarget(modelSpec).model : '';
  const rates = MODEL_RATES.find((entry) => entry.match.test(target))?.rates ?? DEFAULT_RATES;
  const cost =
    (Math.max(0, usage.input) * rates.input +
      Math.max(0, usage.output) * rates.output +
      Math.max(0, usage.cacheRead ?? 0) * rates.cacheRead +
      Math.max(0, usage.cacheWrite ?? 0) * rates.cacheWrite) /
    1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
