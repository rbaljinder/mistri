/** Aggregate-only Console transport contract. No ingestion facts or identities. */
interface Interval {
  readonly lower: number;
  readonly upper: number;
}
interface Metric {
  readonly converted: number | null;
  readonly total: number;
  readonly rate: number | null;
  readonly interval95: Interval | null;
}
export interface ConsoleExperimentResult {
  readonly epoch: { readonly key: string; readonly fingerprint: string };
  readonly evidenceRevision: number;
  readonly declaration: {
    readonly version: string;
    readonly arms: readonly { readonly id: string; readonly value: unknown; readonly weight: number }[];
  };
  readonly statistics: {
    readonly status: 'descriptive' | 'final-blocked' | 'final-evidence';
    readonly complete: boolean;
    readonly finalized: boolean;
    readonly control: string;
    readonly mature: number;
    readonly immature: number;
    readonly finalizesAtMs: number;
    /** The fixed window the evidence is read over; optional because older evidence did not carry it. */
    readonly horizon?: { readonly startsAtMs: number; readonly endsAtMs: number; readonly nowMs: number };
    readonly completeness: { readonly pending: number; readonly failed: number; readonly incomplete: number };
    readonly blockers: readonly string[];
    readonly arms: readonly {
      readonly id: string;
      readonly weight: number;
      readonly exposed: number;
      readonly mature: number;
      readonly immature: number;
      readonly primary: Metric;
      readonly guardrails: readonly Metric[];
    }[];
    readonly comparisons: readonly {
      readonly arm: string;
      readonly metric: string;
      readonly difference: number | null;
      readonly adjustedInterval: Interval | null;
      readonly guardrail: string | null;
      readonly significance: string;
    }[];
    readonly guardrails: readonly { readonly id: string; readonly maxIncrease: number }[];
    readonly srm: { readonly status: string; readonly pValue: number | null };
    readonly methods: {
      readonly rate: string;
      readonly difference: string;
      readonly intervalAdjustment: string;
      readonly familySize: number;
      readonly familyAlpha: number;
      readonly family: string;
      readonly srm: string;
      readonly srmAlpha: number;
    };
  };
}
