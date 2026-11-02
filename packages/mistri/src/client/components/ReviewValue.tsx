/**
 * One answer on a review, as its `<dd>` holds it: the words sayInput gives, or — for a group — a short list, a line
 * per member by its label ("Urgent: Yes"), which reads on a phone where a comma-run of answers did not. Shared by the
 * one-submit form and the form saved on every step.
 *
 * A reference is the one answer the page cannot say from its own memory: what it holds is a key, and "1" names
 * nothing to the person confirming it (a field report: a payment's review said 1 and 2 for the two accounts its
 * pickers had named). Where the form reads its choices, an answer that holds one is said by its record's name, read
 * again by its key as the picker reads (CommandReference.tsx `ReviewNamed`), a part loaded with the picker.
 */
import type { AppCommandField } from '../../shared/command.js';
import { onDemand } from '@mistriwork/kit/client/components/onDemand.js';
import { reviewLines, sayInput } from './reviewValues.js';
import type { ChoiceSource } from './CommandReference.js';

const ReviewNamed = onDemand(() => import('./CommandReference.js'), 'ReviewNamed', { quiet: true });

/** Where a review reads a reference's name: the form's own source, and the reader it reads for. */
export interface ReviewSource {
  source: ChoiceSource;
  identityEpoch: number;
}

export function ReviewValue({ field, value, from }: { field: AppCommandField; value: unknown; from?: ReviewSource }) {
  if (
    from &&
    (field.type === 'reference'
      ? value !== '' && value != null
      : field.type === 'group' && field.fields.some((member) => member.type === 'reference'))
  )
    return <ReviewNamed field={field} value={value} from={from} />;
  if (field.type === 'group') {
    const lines = reviewLines(field, value);
    if (lines.length > 1)
      return (
        <ul className="review-lines">
          {lines.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      );
  }
  return <>{sayInput(field, value)}</>;
}
