import { useState } from 'react';
import { RecordTimeline, type TimelineEntry } from '../../src';

/* The lease's timeline: what the record wrote about itself and what the office said about it, with the box to add
   to it. The times are made from now, so the last few read as they would on a working day. */
const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

const START: TimelineEntry[] = [
  { id: 't1', kind: 'event', at: ago(60 * 24 * 9), title: 'Late fee charged: $75' },
  {
    id: 't2',
    author: 'Maya Lin',
    at: ago(60 * 24 * 9 - 30),
    body: 'Called Andre about the late fee. He was travelling and **will pay by Friday**.\n\n- rent for August\n- the fee itself',
    reactions: [{ key: '👍', count: 2, mine: true }],
  },
  { id: 't3', kind: 'event', at: ago(60 * 26), title: 'Payment received: $1,285' },
  {
    id: 't4',
    author: 'Jonas Weber',
    at: ago(60 * 25),
    body: 'Receipt sent. The fee is still open, see https://lintel.example/charges/118.',
  },
  {
    id: 't5',
    author: 'Maya Lin',
    at: ago(42),
    body: 'He asked whether the fee can be _waived once_. I said I would ask.',
    reactions: [{ key: '👀', count: 1 }],
  },
];

export function LeaseNotes() {
  const [entries, setEntries] = useState(START);
  return (
    <div data-part="lease-notes">
      <RecordTimeline
        label="Lease timeline"
        entries={entries}
        me="Maya Lin"
        draftKey="lease-ac-101"
        placeholder="Add a note. One with the word offline in it will not send, to show what that looks like."
        onSend={async (said) => {
          await new Promise((settle) => window.setTimeout(settle, 700));
          if (/offline/i.test(said)) throw new Error('Not sent: the connection dropped.');
          setEntries((now) => [...now, { id: `n${now.length}`, author: 'Maya Lin', at: new Date().toISOString(), body: said }]);
        }}
        onReact={(entry, key) =>
          setEntries((now) =>
            now.map((one) => {
              if (one.id !== entry.id) return one;
              const had = one.reactions?.find((reaction) => reaction.key === key);
              const others = (one.reactions ?? []).filter((reaction) => reaction.key !== key);
              if (!had) return { ...one, reactions: [...others, { key, count: 1, mine: true }] };
              const count = had.count + (had.mine ? -1 : 1);
              return { ...one, reactions: count > 0 ? [...others, { key, count, mine: !had.mine }] : others };
            }),
          )
        }
      />
    </div>
  );
}
