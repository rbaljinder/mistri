/**
 * A successful empty list explains what belongs here and offers an available
 * next room — as the one empty block (Notes.tsx), at body size on the list's
 * edge. It was a heading at the list title's size, louder than the section
 * it stood in.
 */
import type { AppListEmpty } from '@mistriwork/engine/shared/listPresentations.js';
import { useListNavigation } from './listNavigation.js';
import { Empty } from './Notes.js';

export function ListEmpty({ spec }: { spec: AppListEmpty }) {
  const navigate = useListNavigation();
  const link = spec.action ? navigate?.(spec.action.view, 'reset') : undefined;
  return (
    <Empty
      className="list-empty"
      text={<span className="empty-note-title">{spec.title}</span>}
      detail={spec.description}
      action={spec.action && link ? <a {...link}>{spec.action.label}</a> : undefined}
    />
  );
}
