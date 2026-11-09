/**
 * A list whose rows were read but whose labels from another source were not
 * (a stitched reference's target is down): one quiet line over the grid, in
 * the muted ink, saying the cells hold the stored keys. Drawn only when the
 * read says so, so a healthy list reserves nothing for it.
 */
import { columnLabel } from '../core.js';
import { say } from '../copy/lists/components/PartialNote.js';

/** `carrier_id` → "Carrier", where the App gives the column no caption of its own. */
const plain = (column: string) => {
  const words = column.replace(/_id$/i, '').replace(/[_-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : column;
};

export function PartialNote({ partial, table }: { partial: Array<{ reference: string; reason: string }>; table: string }) {
  const names = [...new Set(partial.map(({ reference }) => columnLabel(table, reference) ?? plain(reference)))].join(', ');
  return (
    <p className="grid-partial" role="status">
      {say('partialLabels', { names })}
    </p>
  );
}
