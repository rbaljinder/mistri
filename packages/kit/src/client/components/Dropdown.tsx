/**
 * The listbox (packages/ui/src/Dropdown.tsx), named in the reader's language
 * where its caller names it nothing: the ui primitive takes its words as
 * props and reads no catalog, so the shell's word for an unnamed list is
 * supplied here.
 */
import { Dropdown as Listbox, type DropdownProps } from '@mistriwork/ui/Dropdown.js';
import { say } from '../copy/shell/components/Dropdown.js';

/**
 * Whether a field's label can stand after "Choose": a short name ("Status", "Assigned to") can, a question
 * ("What would you like to know?") or a sentence cannot, and "Choose what would you like to know?" is what a
 * placeholder built from one read as. Callers fall back to a plain "Choose one".
 */
export function readsAsName(label: string): boolean {
  return !/[?？]/.test(label) && label.trim().split(/\s+/).length <= 2;
}

export function Dropdown(props: DropdownProps) {
  return <Listbox {...props} ariaLabel={props.ariaLabel ?? say('select')} />;
}
