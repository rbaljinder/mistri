/**
 * The dress of a conversation's other side, as a part of its own: a timeline with a `side` waits for it before its rows
 * draw (PageTimeline.tsx), so they never move when it arrives, and a page with no sides never fetches it.
 */
import './TimelineSides.css';

/** Draws nothing: what it brings is its stylesheet. */
export function TimelineSides() {
  return null;
}
