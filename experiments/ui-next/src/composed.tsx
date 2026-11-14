import { ArrowLeft, ArrowRight, DotsSixVertical } from '@phosphor-icons/react';
import { Checkbox, CheckboxIndicator } from '@ui-sdk/react/checkbox';
import type { ReactNode } from 'react';
import { Sortable, SortableHandle, SortableItem } from './behaviors/Sortable';
import { Transfer, TransferHandle, TransferItem, TransferList } from './behaviors/Transfer';
import type { Option } from './fields';
import { words } from './words';

/* Two components that are a behavior and a few lines: what composing on Sortable and Transfer buys. Neither has
   a pointer handler, a key handler or an announcement of its own. */

export type PickListProps = {
  label: string;
  options: Option[];
  /* The values chosen, in the order the reader put them. */
  value: string[];
  onValueChange: (value: string[]) => void;
  /* The most that may be chosen. Reached, the chosen list takes no more and says so. */
  max?: number;
  /* What the two lists are called. */
  from?: string;
  to?: string;
};

/* Some of many, in an order: what is on offer on one side, what was chosen on the other. An item crosses by being
   carried (a pointer, a finger on its grip, or the keyboard), or by the arrow at its end, which is one press and
   needs no aim; and the chosen side keeps the order it was given, which a multi-select cannot. */
export function PickList({ label, options, value, onValueChange, max, from = words.available, to = words.chosen }: PickListProps) {
  const named = new Map(options.map((option) => [option.value, option]));
  const chosen = value.filter((each) => named.has(each));
  const offered = options.map((option) => option.value).filter((each) => !chosen.includes(each));
  const full = max !== undefined && chosen.length >= max;
  const said = { offered: from, chosen: to };
  return (
    <Transfer
      data-kind="pick-list"
      role="group"
      aria-label={label}
      value={{ offered, chosen }}
      order={['offered', 'chosen']}
      accepts={(key, list) => list !== 'chosen' || !full || chosen.includes(key)}
      label={(key) => named.get(key)?.label}
      listLabel={(list) => said[list as keyof typeof said]}
      onValueChange={(next) => onValueChange(next.chosen ?? [])}
    >
      {(['offered', 'chosen'] as const).map((list) => (
        <TransferList
          key={list}
          value={list}
          render={<section />}
          aria-label={said[list]}
          around={(items, state) => (
            <>
              <h3>
                {said[list]}
                <small>
                  {list === 'chosen' && max !== undefined
                    ? state.refuses
                      ? words.fullAt(max)
                      : words.countOf(state.keys.length, max)
                    : state.keys.length}
                </small>
              </h3>
              <ul>
                {items}
                {state.keys.length === 0 && (
                  <li data-slot="pick-list-empty">{list === 'chosen' ? words.nothingChosen : words.everythingChosen}</li>
                )}
              </ul>
            </>
          )}
        >
          {(key) => {
            const option = named.get(key);
            if (!option) return null;
            const across = list === 'offered';
            return (
              <TransferItem key={key} value={key}>
                <TransferHandle aria-label={words.carry(option.label)}>
                  <DotsSixVertical aria-hidden="true" weight="bold" />
                </TransferHandle>
                <span data-slot="pick-list-words">
                  {option.label}
                  {option.hint && <small>{option.hint}</small>}
                </span>
                <button
                  type="button"
                  data-slot="pick-list-cross"
                  aria-label={across ? words.choose(option.label) : words.takeOut(option.label)}
                  disabled={across && full}
                  onClick={() => onValueChange(across ? [...chosen, key] : chosen.filter((each) => each !== key))}
                >
                  {across ? <ArrowRight aria-hidden="true" weight="bold" /> : <ArrowLeft aria-hidden="true" weight="bold" />}
                </button>
              </TransferItem>
            );
          }}
        </TransferList>
      ))}
    </Transfer>
  );
}

export type ChecklistItem = { id: string; label: ReactNode; done?: boolean };

/* Things to do, ticked as they are done and put in the order they will be done in. */
export function Checklist({
  label,
  items,
  onItemsChange,
}: {
  label: string;
  items: ChecklistItem[];
  onItemsChange: (items: ChecklistItem[]) => void;
}) {
  const byId = new Map(items.map((item) => [item.id, item]));
  return (
    <Sortable
      by="handle"
      data-kind="checklist"
      aria-label={label}
      value={items.map((item) => item.id)}
      onValueChange={(order) => onItemsChange(order.flatMap((id) => byId.get(id) ?? []))}
    >
      {(id) => {
        const item = byId.get(id);
        if (!item) return null;
        return (
          <SortableItem key={id} value={id} data-done={item.done ? '' : undefined}>
            <SortableHandle aria-label={words.moveStep}>
              <DotsSixVertical aria-hidden="true" weight="bold" />
            </SortableHandle>
            <label>
              <Checkbox
                checked={item.done === true}
                onCheckedChange={(next) => onItemsChange(items.map((each) => (each.id === id ? { ...each, done: next === true } : each)))}
              >
                <CheckboxIndicator />
              </Checkbox>
              <span>{item.label}</span>
            </label>
          </SortableItem>
        );
      }}
    </Sortable>
  );
}
