/**
 * A timeline entry's reactions: a quiet row of the kinds the section offers, each said through the column's display
 * rule with its count, the reader's own pressed. The counts of every entry on the page are one breakdown, and the
 * reader's own one more read beside it (`<by> = me`), asked together; pressing a kind runs the App's own command on
 * the entry — found through the action of the entry's resource that offers it, as a composer's is — with the kind as
 * its input, so the command decides what a press means (give one, or take it back) under the reader's grants. A reader
 * not granted it reads the counts and presses nothing; a kind no one gave is not drawn for them. A part of its own,
 * with its stylesheet: a page whose timelines carry no reactions never fetches it (PageTimeline.tsx).
 */
import './TimelineReactions.css';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { TimelineReactions as Reactions } from '@mistriwork/engine/shared/pageModel.js';
import { columnDisplay, findTable } from '../core.js';
import { pageBridge } from '../uiBridge.js';
import { entryKey, type ReactionEntry, type ReactionTally } from './reactionTally.js';
import { choiceWord, type DisplayRule } from './valueModel.js';
import { Icon, type IconName } from './Icon.js';
import { say } from '../copy/record/components/TimelineReactions.js';

/** One entry's row of reactions. */
export function ReactionRow({ reactions, entry, tally }: { reactions: Reactions; entry: ReactionEntry; tally: ReactionTally }) {
  const queries = useQueryClient();
  const [busy, setBusy] = useState(false);
  const handle = pageBridge.commands?.command(reactions.command);
  const pressable = Boolean(handle?.granted);
  const table = findTable(reactions.from) as { id: string } | undefined;
  const rule = columnDisplay(table?.id ?? reactions.from, reactions.column!) as DisplayRule | null;
  const kinds = reactions.kinds.map((kind) => {
    const icon = rule?.icons && Object.hasOwn(rule.icons, kind) ? rule.icons[kind] : undefined;
    return {
      kind,
      word: choiceWord(rule, kind),
      icon,
      count: tally.counts.get(entryKey(entry.value, kind)) ?? 0,
      pressed: tally.mine.has(entryKey(entry.value, kind)),
    };
  });
  const shown = pressable ? kinds : kinds.filter((each) => each.count > 0);
  if (!shown.length) return null;
  const press = async (kind: string, word: string) => {
    if (!handle || busy) return;
    setBusy(true);
    try {
      const outcome = await handle.run({ [entry.column]: entry.value }, { [reactions.column!]: kind }, { label: word });
      if (outcome.status === 'applied') await queries.invalidateQueries({ queryKey: ['page-reactions'] });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="timeline-reactions" role="group" aria-label={say('reactions')}>
      {shown.map(({ kind, word, icon, count, pressed }) => {
        const said = (
          <>
            {icon && <Icon name={icon as IconName} size={14} className="timeline-reaction-icon" />}
            <span>{word}</span>
            {count > 0 && <span className="timeline-reaction-count">{count}</span>}
          </>
        );
        return pressable ? (
          <button
            key={kind}
            type="button"
            className="timeline-reaction"
            aria-pressed={pressed}
            aria-label={say('reactionCount', { kind: word, count })}
            disabled={busy}
            onClick={() => void press(kind, word)}
          >
            {said}
          </button>
        ) : (
          <span key={kind} className="timeline-reaction" data-pressed={pressed ? 'true' : undefined}>
            {said}
          </span>
        );
      })}
    </div>
  );
}
