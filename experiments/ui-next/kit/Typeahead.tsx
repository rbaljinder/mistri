import { Autocomplete, AutocompleteContent, AutocompleteInput, AutocompleteItem, AutocompleteList } from '@ui-sdk/react/autocomplete';
import { useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties } from 'react';
import type { UiKitSlots } from '@mistriwork/ui/UiKit.js';
import type { TypeaheadReason } from '@mistriwork/ui/Typeahead.js';
import { useDialogContainer } from './container';
import { told } from './told';

type Slot = Parameters<UiKitSlots['Typeahead']>[0];
type Props = Omit<Slot, 'items' | 'itemKey' | 'itemLabel' | 'itemClassName' | 'renderItem' | 'onPick' | 'onHighlight'>;

interface Items<T> {
  items: T[];
  itemKey: (item: T) => string;
  itemLabel: (item: T) => string;
  itemClassName: (item: T, highlighted: boolean) => string;
  renderItem: (item: T) => React.ReactNode;
  onPick: (item: T) => void;
  onHighlight?: (item: T | undefined) => void;
}

const REASONS = new Set<string>([
  'trigger-press',
  'input-press',
  'outside-press',
  'item-press',
  'close-press',
  'escape-key',
  'list-navigation',
  'focus-out',
  'input-change',
  'input-clear',
  'clear-press',
  'chip-remove-press',
  'cancel-open',
]);
const reason = (said: string | undefined): TypeaheadReason => (said && REASONS.has(said) ? (said as TypeaheadReason) : 'implicit');

/* A box you type into and a list that answers. The caller ranks and fetches the items, so nothing is filtered
   here, and the text is the caller's: when a row is chosen UI SDK would fill the box with its label, which is
   refused, and the caller hears one `onPick` and decides what the box says. The list is drawn in place, in the
   top layer, so inside a dialog it is inside the dialog. */
export function Typeahead<T>({
  text,
  onText,
  items,
  itemKey,
  itemLabel,
  itemClassName,
  renderItem,
  onPick,
  open,
  onOpenChange,
  inputProps,
  inputRef,
  popupRef,
  anchorRef,
  fit = 'min-width',
  popupClassName,
  listClassName,
  empty,
  emptyClassName,
  portal = 'dialog',
  autoHighlight = true,
  onHighlight,
}: Props & Items<T>) {
  const byKey = new Map(items.map((item) => [itemKey(item), item]));
  const lit = useRef<string | null>(null);
  const box = useRef<HTMLInputElement | null>(null);
  const container = useDialogContainer(box);
  /* Nothing matches: the message is a status beside the box, never a listbox with no option to hold. UI SDK's
     popup calls itself a listbox when it holds no list, so the message is drawn here instead, under the box. */
  const nothing = open && items.length === 0 && empty !== undefined;
  const [under, setUnder] = useState<CSSProperties>();
  useLayoutEffect(() => {
    const anchor = anchorRef?.current ?? box.current;
    if (!nothing || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    setUnder({ position: 'fixed', left: rect.left, top: rect.bottom + 4, [fit === 'width' ? 'width' : 'minWidth']: rect.width });
  }, [nothing, anchorRef, fit, text]);
  const { value: _value, defaultValue: _defaultValue, onChange: _onChange, ...input } = inputProps;
  return (
    <Autocomplete
      value={text}
      open={open && items.length > 0}
      filter={false}
      autoHighlight={autoHighlight}
      onValueChange={(next, details) => {
        if (details.reason === 'list-navigation') return details.cancel();
        if (details.reason === 'item-press') {
          // The row in hand is the one chosen; a press that lit none (a tap) is found by the label it would fill.
          details.cancel();
          const picked =
            (lit.current !== null && byKey.get(lit.current)) || items.find((item) => itemLabel(item) === next || itemKey(item) === next);
          if (picked) onPick(picked);
          return;
        }
        onText(next, told(reason(details.reason), details));
      }}
      onOpenChange={(next, details) => onOpenChange(next, told(reason(details.reason), details))}
      onHighlight={(key) => {
        lit.current = key;
        onHighlight?.(key === null ? undefined : byKey.get(key));
      }}
    >
      <AutocompleteInput
        {...(input as ComponentProps<typeof AutocompleteInput>)}
        ref={(node: HTMLInputElement | null) => {
          box.current = node;
          if (typeof inputRef === 'function') inputRef(node);
          else if (inputRef) inputRef.current = node;
        }}
      />
      <AutocompleteContent
        ref={popupRef}
        className={popupClassName}
        data-fit={fit}
        anchor={anchorRef ? { getBoundingClientRect: () => (anchorRef.current ?? box.current)!.getBoundingClientRect() } : undefined}
        container={portal === 'body' ? undefined : container}
      >
        {items.length > 0 ? (
          <AutocompleteList className={listClassName} aria-label={input['aria-label'] ?? input.title ?? input.placeholder}>
            {items.map((item) => (
              <AutocompleteItem
                key={itemKey(item)}
                value={itemKey(item)}
                label={itemLabel(item)}
                className={(state: { highlighted?: boolean }) => itemClassName(item, state.highlighted === true)}
              >
                {renderItem(item)}
              </AutocompleteItem>
            ))}
          </AutocompleteList>
        ) : null}
      </AutocompleteContent>
      {nothing ? (
        <div ref={popupRef} className={popupClassName} data-slot="autocomplete-content" data-kind="empty" style={under}>
          <div className={emptyClassName} data-slot="autocomplete-empty" role="status">
            {empty}
          </div>
        </div>
      ) : null}
    </Autocomplete>
  );
}
