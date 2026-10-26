/* The shape `tablewalk --export types` would print for this fixture, kept beside seed.mjs, which is the schema:
   change one and change the other. Written rather than exported because every key is an INTEGER PRIMARY KEY of a
   handful of rows, so ids are numbers where the exporter would widen them. */
import type { TypedAppConfig, TypedFeature } from '@mistriwork/mistri/app';

/** Every table, and every column it had when this file was written. */
export type Tables = {
  canned_reply: "id" | "title" | "body";
  change: "id" | "name" | "starts_on" | "ends_on";
  freeze: "id" | "name" | "starts_on" | "ends_on";
  holiday: "id" | "name" | "starts_on" | "ends_on";
  message: "id" | "name" | "ticket_id" | "body" | "kind" | "sent_at" | "author_id";
  person: "id" | "name";
  ticket: "id" | "name" | "requester" | "status" | "priority" | "caller_id" | "agent_id" | "opened_at";
};

/** Each table's row as a command handler reads it. */
export type Rows = {
  canned_reply: { id: number; title: string; body: string };
  change: { id: number; name: string; starts_on: string; ends_on: string };
  freeze: { id: number; name: string; starts_on: string; ends_on: string };
  holiday: { id: number; name: string; starts_on: string; ends_on: string };
  message: { id: number; name: string; ticket_id: number; body: string; kind: string; sent_at: string; author_id: number | null };
  person: { id: number; name: string };
  ticket: {
    id: number;
    name: string;
    requester: string;
    status: string;
    priority: string;
    caller_id: number | null;
    agent_id: number | null;
    opened_at: string;
  };
};

export type App = TypedAppConfig<Tables>;
export type Feature = TypedFeature<Tables>;
export type Resources = NonNullable<App['resources']>;
export type Views = NonNullable<App['views']>;
export type Pages = NonNullable<App['pages']>;
export type Page = Pages[string];
export type Navigation = NonNullable<App['nav']>;
