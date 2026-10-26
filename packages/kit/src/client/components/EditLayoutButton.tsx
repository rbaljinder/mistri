/**
 * The control that opens the record layout editor, for the record page to
 * place. Apart from the editor (LayoutBuilder.tsx) because the editor is a
 * chunk of its own, loaded when it first opens, and every record's heading
 * draws this button.
 */
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { Template } from './LayoutBuilder.js';
import { say } from '../copy/record/components/EditLayoutButton.js';

export function EditLayoutButton({
  table,
  saved,
  onOpen,
}: {
  table: TableMeta | undefined;
  saved: Template | null | undefined;
  onOpen: () => void;
}) {
  /* The name shows on the button when it says something the table name does not. */
  const named = saved?.name && saved.name !== table?.name ? saved.name : null;
  return (
    <button
      type="button"
      className={`ghost record-layout${saved ? ' is-custom' : ''}`}
      title={named ? say('editingTheLayoutForEvery', { named, name: table?.name ?? '' }) : say('chooseWhatThisRecord')}
      onClick={onOpen}
    >
      <span>{say('layout')}</span>
      {named ? <span className="record-layout-name">{named}</span> : null}
      {!named && saved ? <span aria-hidden="true">✓</span> : null}
    </button>
  );
}
