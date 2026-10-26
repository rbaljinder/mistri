/**
 * A value renderer where a display rule stands: the author's component draws
 * one value in a grid cell, a record field or a card, and only draws it —
 * sort, filter, totals, export and search keep the raw value, and the
 * Workbench never runs one.
 *
 * A cell never waits for one. The value is drawn the platform's way (the
 * `fallback`) until the module has arrived, the first draw that names it
 * having asked for it; then every slot showing it redraws once. A renderer
 * that throws draws that value the platform's way from then on, said once in
 * the console. Small and in the first chunk, since Value and Grid use it; the
 * loading itself is the shell's (shellMode.ts `components`: in an App,
 * sdk/componentLoader.ts, with the page's side of the SDK, a chunk of its
 * own), and the slot is the kit's one (componentSlot.tsx).
 */
import type { ReactNode } from 'react';
import { shell } from '../shellMode.js';
import { componentSlot } from './componentSlot.js';

/** What a value renderer receives: `ValueProps` in packages/mistri/schema/ui.d.ts. */
interface ValueRendererProps {
  value: unknown;
  row?: Record<string, unknown>;
  column: { name: string; resource: string };
  context: 'grid' | 'record' | 'card';
  compact: boolean;
  /** The tone the column's display rule gives this value, and the word it says it as (valueModel's ruleSays). */
  tone?: string;
  word?: string;
}

const Slot = componentSlot<ValueRendererProps>({
  className: 'custom-value',
  load: (id) => shell().components.load(id),
  couldNotLoad: (id, error) => console.error(`the value renderer "${id}" could not be loaded; its values are drawn plain.`, error),
  threw: (id, error) => console.error(`the value renderer "${id}" threw; its values are drawn plain.`, error),
});

/** One value, drawn by the renderer `id` once it is here, and by `fallback` until then (or for good, if it cannot be). */
export function ValueSlot({ id, fallback, ...props }: ValueRendererProps & { id: string; fallback: ReactNode }) {
  return <Slot id={id} fallback={fallback} props={props} />;
}
