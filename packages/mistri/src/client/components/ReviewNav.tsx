/**
 * The For review key in the App bar, beside the bell: the AI mark and how many proposals and unconfirmed writes wait
 * for this reader, going to the room (ReviewRoom.tsx). Drawn only while something waits, so an App with nothing to
 * review shows nothing new. The count is the shell's one review list (commandProposals.ts `useReview`), read after
 * first paint, and the same list the room and a record's head line read: no request of its own.
 *
 * Loaded after first paint and only where the App offers review (AccountControl.tsx): no first page carries it.
 */
import { go, state } from '@mistriwork/kit/client/core.js';
import { AiMark } from '@mistriwork/kit/client/components/AiMark.js';
import { useReview } from '../commandProposals.js';
import { reviewEntry } from '../publicAddress.js';
import { say } from '../copy/review/components/ReviewNav.js';
import './InboxBell.css';

export function ReviewNav() {
  const list = useReview(state.activeConnection ?? null, true);
  const count = (list?.proposals ?? []).filter((each) => each.state === 'proposed').length + (list?.unconfirmed?.length ?? 0);
  if (!count) return null;
  const name = say('waiting', { count });
  return (
    <button
      type="button"
      className="icon-button inbox-trigger review-trigger"
      title={name}
      aria-label={name}
      onClick={() => go(reviewEntry(), 'push')}
    >
      <AiMark quiet />
      <span className="inbox-count" aria-hidden="true">
        {count > 99 ? '99+' : count}
      </span>
    </button>
  );
}
