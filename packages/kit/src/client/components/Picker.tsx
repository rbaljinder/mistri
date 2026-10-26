/**
 * A typeahead over a short list of named things — the tables the diagram
 * can be limited to. Ranked by the palette's own `score`, so the same
 * letters find the same table here and in ⌘K; the list and its keyboard
 * are Typeahead's.
 */
import { useState } from 'react';
import { score } from './paletteModel.js';
import { Typeahead } from '@mistriwork/ui/Typeahead.js';
import { say } from '../copy/forms/components/Picker.js';

interface PickerItem {
  value: string;
  label: string;
  detail?: string;
}

export function Picker({
  items,
  onPick,
  placeholder = say('searchMore'),
  ariaLabel = say('navigation.search'),
  max = 8,
}: {
  items: PickerItem[];
  onPick: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  max?: number;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const shown = items
    .map((item) => ({ item, points: score(`${item.label} ${item.detail ?? ''}`.trim(), query.trim()) }))
    .filter(({ points }) => points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, max)
    .map(({ item }) => item);
  return (
    <div className="picker">
      <Typeahead
        text={query}
        onText={setQuery}
        open={open}
        onOpenChange={setOpen}
        items={shown}
        itemKey={(item) => item.value}
        itemLabel={(item) => item.label}
        itemClassName={(_item, highlighted) => `picker-option${highlighted ? ' active' : ''}`}
        renderItem={(item) => (
          <>
            <span className="picker-label">{item.label}</span>
            {item.detail ? <span className="picker-detail">{item.detail}</span> : null}
          </>
        )}
        onPick={(item) => {
          setQuery('');
          setOpen(false);
          onPick(item.value);
        }}
        inputProps={{
          type: 'text',
          className: 'picker-input',
          placeholder,
          'aria-label': ariaLabel,
          autoComplete: 'off',
          spellCheck: false,
        }}
        popupClassName="picker-popup"
        listClassName="picker-list"
        empty={say('noTableMatches')}
        emptyClassName="picker-empty"
      />
    </div>
  );
}
