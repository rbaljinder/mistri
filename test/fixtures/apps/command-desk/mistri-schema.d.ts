/* The shape `tablewalk --export types` would print for this fixture, kept
   beside seed.mjs, which is the schema: change one and change the other.
   It is written rather than exported for one reason — every key here is an
   INTEGER PRIMARY KEY holding a handful of small rows, so the ids are numbers
   and the command's `id()` output can say so, where the exporter widens every
   key to a number-or-text union against the day a deployment passes 2^53. */
import type { TypedAppConfig, TypedFeature } from '@mistriwork/mistri/app';

/** Every table, and every column it had when this file was written.
    A type alias, not an interface: the TypedAppConfig constraint needs
    the structural index an interface refuses to imply. */
export type Tables = {
  application_document: "id" | "name" | "application_id" | "status" | "received_on";
  application_review: "id" | "name" | "application_id" | "reviewer_id" | "status" | "opened_on" | "summary";
  assignment_history: "id" | "name" | "application_id" | "assigned_to" | "assigned_by" | "assigned_on" | "reason";
  loan_application: "id" | "name" | "reference" | "team_id" | "reviewer_id" | "status" | "version";
  loan_decision: "id" | "name" | "application_id" | "decided_by" | "outcome" | "recorded_on" | "record_note";
  review_team: "id" | "name";
  reviewer: "id" | "name" | "team_id" | "role" | "active";
};

/** Each table's row as a command handler reads it, every column with its
    value's type: what `defineSource<Rows>` in @mistriwork/mistri/commands types. */
export type Rows = {
  application_document: { id: number; name: string; application_id: number; status: string; received_on: string | null };
  application_review: { id: number; name: string; application_id: number; reviewer_id: number; status: string; opened_on: string; summary: string };
  assignment_history: { id: number; name: string; application_id: number; assigned_to: number; assigned_by: number; assigned_on: string; reason: string };
  loan_application: { id: number; name: string; reference: string; team_id: number; reviewer_id: number | null; status: string; version: number };
  loan_decision: { id: number; name: string; application_id: number; decided_by: number; outcome: string; recorded_on: string; record_note: string };
  review_team: { id: number; name: string };
  reviewer: { id: number; name: string; team_id: number; role: string; active: boolean };
};

/** The app config with this schema’s own names: use `satisfies App`
    (TS) or a JSDoc `@type` line (JS) on the default export. */
export type App = TypedAppConfig<Tables>;

/** A feature of the app, in the same names: `defineFeature({ … } satisfies Feature)`. */
export type Feature = TypedFeature<Tables>;

/** Schema-checked pieces for separate authoring modules. Use `satisfies`
    to retain literal names for defineApp's cross-module reference checks. */
export type Resources = NonNullable<App['resources']>;
export type Views = NonNullable<App['views']>;
export type Pages = NonNullable<App['pages']>;
export type Page = Pages[string];
export type Navigation = NonNullable<App['nav']>;
