/**
 * The listbox (packages/ui/src/Dropdown.tsx), named in the reader's language
 * where its caller names it nothing: the ui primitive takes its words as
 * props and reads no catalog, so the shell's word for an unnamed list is
 * supplied here.
 */
import { Dropdown as Listbox, type DropdownProps } from '@mistriwork/ui/Dropdown.js';
import { say } from '../copy/shell/components/Dropdown.js';

export function Dropdown(props: DropdownProps) {
  return <Listbox {...props} ariaLabel={props.ariaLabel ?? say('select')} />;
}
