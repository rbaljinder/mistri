/**
 * An input component where a form draws a field: a record's column in its
 * edit and New forms (`resources.<name>.inputs`), a command's input in an
 * action's or a signed-in form's command form (`inputs` beside the command).
 * The author's component draws the control and hands back a value through
 * `onChange`; the form keeps it, says its problems beside it and submits it,
 * and what the value must be is still the form's rules and the server's to
 * judge — a component cannot make a value valid.
 *
 * Until the module has arrived the platform's own control stands in its
 * place, so a form never waits on it; one that throws is the platform's
 * control from then on, said once in the console. Small and in the first
 * chunk beside the value renderers, since the forms use it; the loading
 * itself is the shell's (shellMode.ts `components`: in an App, the SDK's
 * chunk, componentLoader.ts), and the slot is the kit's one
 * (componentSlot.tsx).
 */
import type { ReactNode } from 'react';
import { pageBridge } from '../uiBridge.js';
import { shell } from '../shellMode.js';
import { componentSlot } from './componentSlot.js';

/** What an input component receives: `InputProps` in packages/mistri/schema/ui.d.ts. */
interface InputComponentProps {
  /** The form's value: a column's text (null for none) in a record's form, the field's value in a command's. */
  value: string | number | boolean | null;
  onChange(value: string | number | boolean | null): void;
  /** The control's id, which the field's label points at, and what describes it (the hint, the problem). */
  id: string;
  describedBy?: string;
  invalid: boolean;
  disabled: boolean;
  required: boolean;
  /** The field's caption, for a control that names itself. */
  label: string;
  /** The column, or the command's input, it stands for. */
  field: { name: string; resource?: string };
  /** Which form: a record's edit, a New form, or a command's. */
  context: 'edit' | 'new' | 'command';
}

/* The platform's own inputs for a display rule's formats — stars, a slider, a color, a time, a month, a year, a JSON document — are
   named like this and loaded like an author's, from one chunk of their own (builtInInputs.tsx). */
const BUILT_IN = 'mistri:';

const Slot = componentSlot<InputComponentProps>({
  className: 'custom-input',
  load: (id) => (id.startsWith(BUILT_IN) ? shell().components.builtIn(id.slice(BUILT_IN.length)) : shell().components.load(id)),
  couldNotLoad: (id, error) => console.error(`the input "${id}" could not be loaded; its field is the platform's control.`, error),
  threw: (id, error) => console.error(`the input "${id}" threw; its field is the platform's control.`, error),
});

type RuleLike = { format?: string; slider?: unknown; scan?: unknown; signature?: unknown };

/** The formats a field is edited in an input of the platform's own for. */
const OWN_INPUTS = new Set(['rating', 'color', 'time', 'month', 'year', 'json']);

/** The App's input component for a resource's column, where it declares one (`resources.<name>.inputs`), else the
    platform's own for the column's display rule, where it has one (a rating's stars, a slider, a color). */
export function columnInput(tableId: string, column: string): string | undefined {
  const resources = (
    pageBridge.activeApp() as {
      resources?: Record<string, { inputs?: Record<string, { id: string }>; display?: Record<string, RuleLike> }>;
    } | null
  )?.resources;
  const input = resources?.[tableId]?.inputs;
  if (input && Object.hasOwn(input, column)) return input[column].id;
  const display = resources?.[tableId]?.display;
  const rule = display && Object.hasOwn(display, column) ? display[column] : undefined;
  if (rule?.slider) return `${BUILT_IN}slider`;
  if (rule?.scan) return `${BUILT_IN}scan`;
  /* A signature whose file resource did not resolve here is a plain box: there is nowhere to keep the drawing. */
  if (rule?.signature && typeof rule.signature === 'object') return `${BUILT_IN}signature`;
  return rule?.format && OWN_INPUTS.has(rule.format) ? `${BUILT_IN}${rule.format}` : undefined;
}

/** One field's control, drawn by the input component `id` once it is here, and by `fallback` until then (or for good, if it cannot be). */
export function InputSlot({ component, fallback, ...props }: InputComponentProps & { component: string; fallback: ReactNode }) {
  return <Slot id={component} fallback={fallback} props={props} />;
}
