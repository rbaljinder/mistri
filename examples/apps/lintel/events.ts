// The committed facts Lintel's automation runs on. A period and counts only:
// each is kept until pruned and copied into the workflow it wakes, so none
// carries a resident's name or an amount owed.
import { defineEvent, int, shape, text } from '@mistriwork/mistri/commands';

/** A month's rent was posted: `posted` new charges for `period`, due on `dueOn`. Starts that month's late-fee workflow. */
export const rentPosted = defineEvent(
  'rent.posted',
  shape({
    period: text({ pattern: /^\d{4}-\d{2}$/ }),
    dueOn: text({ pattern: /^\d{4}-\d{2}-\d{2}$/ }),
    posted: int({ min: 0, max: 100_000 }),
  }),
);
