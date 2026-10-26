/*
 * Who and what a write is, held around the work that makes it. It is part of
 * the write path every server has, not of the App's record history that
 * reads it (history/recordHistory.ts): the database MCP marks its tool calls
 * as an agent's, the Workbench's routes name Undo, and an App's door names
 * its person and action, all through the same frame.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const WRITE_VIAS = ['app', 'workbench', 'agent', 'api', 'form', 'system'] as const;
export type WriteVia = (typeof WRITE_VIAS)[number];

/** Who and what a write is. Set only by trusted server code around the work. */
interface WriteAttribution {
  /** The verified account (its email), or none: who the write is attributed to, kept and never shown. */
  readonly actor?: string;
  /** Its display name at the time, as a history entry and a notice say who wrote it. Words only: never who a write is attributed to. */
  readonly name?: string;
  readonly via: WriteVia;
  /** The action or command the write came from, in the App's words. */
  readonly action?: string;
}

const attributions = new AsyncLocalStorage<WriteAttribution>();

/** Run `work` with its writes attributed; a nested call refines the outer one. */
export function attributeWrites<T>(attribution: WriteAttribution, work: () => T): T {
  const outer = attributions.getStore();
  return attributions.run(Object.freeze({ ...outer, ...attribution }), work);
}

/** Name the action or command a write came from, keeping who made it. */
export function attributeAction<T>(action: string | undefined, work: () => T): T {
  const outer = attributions.getStore();
  if (!action) return work();
  return attributions.run(Object.freeze({ ...(outer ?? { via: 'system' as const }), action }), work);
}

export const currentWriteAttribution = (): WriteAttribution | undefined => attributions.getStore();
