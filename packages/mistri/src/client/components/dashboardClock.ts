/**
 * When a dashboard's reads are asked again: on the minute for a read that depends on the time, and how long a
 * tile's answer stands. Its own module so the tiles, the lists and the worklist keep one clock.
 */
import { liveFollowing } from '@mistriwork/kit/client/liveState.js';

/* What a read says about the time it is asked at: a window ("last 30 days"), a day or a period named from now. A
   figure that says none changes only when the data does, and live sync (liveSync.ts) tells the page when. */
const TIME_RELATIVE =
  /\b(?:now|today|yesterday|tomorrow|ago|(?:this|last|next|past|previous)\s+(?:\d+\s+)?(?:day|week|month|quarter|year)s?)\b/i;

/* The youngest answer the minute reads again. Query asks the interval again after every answer, so a tile read at
   :00.2 ticks at the next :00, a minute old; one read at :58 waits for the minute after. */
const TICK_FLOOR = 15_000;

/**
 * The minute tick: asked again on the wall-clock minute, asleep with the tab (Query's refetchIntervalInBackground is
 * off). A read that depends on the time always ticks; every other read ticks while the page follows no changes to its
 * table (an App without `live: true`, `--no-live`, or a resource's own `live: false`), since nothing else would tell a
 * dashboard left on a wall that its data moved.
 */
export const minuteTick = (
  text: string | null | undefined,
  table?: string,
  following: (table?: string) => boolean = liveFollowing,
): ((query?: { state: { dataUpdatedAt: number } }) => number | false) | false => {
  if (!text) return false;
  const timed = TIME_RELATIVE.test(text);
  return (query) => {
    if (!timed && following(table)) return false;
    const now = Date.now();
    const next = 60_000 - (now % 60_000);
    /* An answer read moments before the minute (a page opened at :58, the first paint's carried answers) is not read
       again at :00: the tick that would land on it goes to the minute after. */
    const read = query?.state.dataUpdatedAt;
    return read && now + next - read < TICK_FLOOR ? next + 60_000 : next;
  };
};

/* A tile is an aggregate, and says what it is as of: re-read when a change
   to its tables is announced (liveSync.ts), a write that invalidates it, the
   minute for a read that depends on the time, or after two minutes, not every
   time the dashboard is opened again or its tab regains focus. */
export const TILE_FRESH = 120_000;
