/**
 * A record that is gone — deleted under an open page, or a link to one that
 * never was — said once in plain words, with the way back to its list. It is
 * all the page has to say, so the block stands in the page's middle (the empty
 * block's `room`, Notes.tsx), and names no key: "1 names nothing" read like a bug to the person who followed
 * the link. The caller says the table's name as its page does (`spoken` in
 * pageContext.ts): this module imports nothing of the page around it, so the
 * page may import it without a cycle.
 */
import { go, tableView } from '../core.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { Button } from '@mistriwork/ui/Button.js';
import { Empty } from './Notes.js';
import { say } from '../copy/record/components/RecordGone.js';

export const recordNotFound = (spoken: string) => {
  const name = spoken.toLowerCase();
  return say('recordNotFound', { Spoken: name.charAt(0).toUpperCase() + name.slice(1) });
};

export function RecordGone({ base, spoken, className }: { base: TableMeta; spoken: string; className?: string }) {
  const name = spoken.toLowerCase();
  return (
    <Empty
      room
      className={className}
      text={say('common.thatIsNoLonger', { spoken: name })}
      action={
        <Button variant="secondary" onClick={() => go(tableView(base.id), 'push')}>
          {say('backToTheList', { spoken: name })}
        </Button>
      }
    />
  );
}
