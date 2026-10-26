/**
 * One answer on a review, as its `<dd>` holds it: the words sayInput gives, or — for a group — a short list, a line
 * per member by its label ("Urgent: Yes"), which reads on a phone where a comma-run of answers did not. Shared by the
 * one-submit form and the form saved on every step.
 */
import type { AppCommandField } from '../../shared/command.js';
import { reviewLines, sayInput } from './reviewValues.js';

export function ReviewValue({ field, value }: { field: AppCommandField; value: unknown }) {
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
