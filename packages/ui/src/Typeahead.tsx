/**
 * A box you type into and a list that answers, over UI SDK's Autocomplete.
 *
 * Three surfaces here are this shape — the record picker, the table picker
 * on the diagram, the reference filter box — and each walked its own list
 * with arrow keys, placed it by hand and closed it on a blur timer. UI SDK
 * owns that now: the combobox roles, arrows and Home/End, Enter on the
 * highlighted row, Tab and a click outside to leave, the first row lit as
 * you type. The caller ranks and fetches the items, so nothing is filtered
 * here; it draws each row in its own classes, and hears one `onPick`.
 *
 * The text is the caller's: on a pick UI SDK would fill the box with the
 * item's label, and that fill is refused here, so a picker that wants the
 * box emptied (a multi-select) or named (a single one) decides itself.
 * Escape closes only this layer, stopped, so the panel underneath does not
 * take the same key. The list is placed by UI SDK against the box (or the
 * caller's anchor) and drawn inside the enclosing dialog when there is one.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Autocomplete, AutocompleteContent, AutocompleteInput, AutocompleteItem, AutocompleteList } from '@ui-sdk/react/autocomplete';
import { changeDetails, type ChangeDetails } from './changeDetails.js';
import { popupContainer, useDialogContainer } from './internal/popups.js';
import { viewportBox } from './internal/ruler.js';
import { told } from './internal/told.js';
import { slotted } from './internal/uiKitContext.js';

/** Why a combobox's text or list moved: typed, cleared, an option pressed, Escape, the focus gone… */
export type TypeaheadReason =
  | 'trigger-press'
  | 'input-press'
  | 'outside-press'
  | 'item-press'
  | 'close-press'
  | 'escape-key'
  | 'list-navigation'
  | 'focus-out'
  | 'input-change'
  | 'input-clear'
  | 'clear-press'
  | 'chip-remove-press'
  | 'cancel-open'
  | 'implicit';

export interface TypeaheadProps<T> {
  text: string;
  onText: (text: string, details: ChangeDetails<TypeaheadReason>) => void;
  /** Already ranked and bounded; drawn in this order. */
  items: T[];
  itemKey: (item: T) => string;
  itemLabel: (item: T) => string;
  itemClassName: (item: T, highlighted: boolean) => string;
  renderItem: (item: T) => ReactNode;
  onPick: (item: T) => void;
  open: boolean;
  onOpenChange: (open: boolean, details: ChangeDetails<TypeaheadReason>) => void;
  /** The `<input>`'s own attributes — class, label, placeholder, title, the caller's keys. */
  inputProps: InputHTMLAttributes<HTMLInputElement>;
  inputRef?: Ref<HTMLInputElement>;
  /** The actual popup, including when it is portalled outside the input's parent. */
  popupRef?: Ref<HTMLDivElement>;
  /** The element the list is sized and placed against; the input by default. */
  anchorRef?: RefObject<HTMLElement | null>;
  /** `width` matches the anchor exactly; `min-width` lets a long name widen the list. */
  fit?: 'width' | 'min-width';
  popupClassName: string;
  listClassName: string;
  /** Shown in the list when nothing matches; nothing at all when omitted. */
  empty?: ReactNode;
  emptyClassName?: string;
  /**
   * Where the list is drawn: inside the enclosing dialog (the default), so
   * it shares the dialog's focus trap, or the body. A popover is a dialog
   * too, and a caller whose box stands in one may not want the list held
   * inside it (clipped to it, sized by it): `body` sends the list where
   * every popup on the page goes (internal/popups.ts).
   */
  portal?: 'dialog' | 'body';
  /** Light the first row as the reader types (the default), or nothing until they arrow in: a search box's Enter is its own. */
  autoHighlight?: boolean;
  /** Hears the row lit by the keys or the pointer, and undefined when none is. */
  onHighlight?: (item: T | undefined) => void;
}

/* UI SDK's word for why the text or the list moved, where it is one a caller here can hear; `implicit` otherwise. */
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

function DefaultTypeahead<T>({
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
}: TypeaheadProps<T>) {
  const byKey = new Map(items.map((item) => [itemKey(item), item]));
  /* The first row is lit while the reader types, so Enter takes it, and not by the list merely opening: a press on
     the box shows the list with no row in hand, and the arrows start from the top. UI SDK lights the first row of
     any list that opens over text, so it is told to only once something has been typed into this opening. */
  const [typed, setTyped] = useState(false);
  useEffect(() => {
    if (!open) setTyped(false);
  }, [open]);
  const lit = useRef<string | null>(null);
  /* Whether the press now being heard already chose its row, by the value it changed. */
  const pressed = useRef(false);
  const box = useRef<HTMLInputElement | null>(null);
  const dialog = useDialogContainer(box);
  /* Nothing matches: the message is a status beside the box, never a listbox with no option to hold (a pattern
     violation of its own). UI SDK's popup calls itself a listbox when it holds no list, so the message is drawn
     here instead, under the box, measured on the zoom-aware ruler as everything placed by hand is. */
  const nothing = open && items.length === 0 && empty !== undefined;
  const [under, setUnder] = useState<CSSProperties>();
  useLayoutEffect(() => {
    const anchor = anchorRef?.current ?? box.current;
    if (!nothing || !anchor) return;
    const at = viewportBox(anchor);
    setUnder({ position: 'fixed', left: at.left, top: at.bottom + 4, [fit === 'width' ? 'width' : 'minWidth']: at.width });
  }, [nothing, anchorRef, fit, text]);
  /* The list is named as its box is. A box named by a `<label for>` has no name attribute to copy, and pointing the
     list at the box itself would read out what is typed in it (an embedded textbox contributes its value), so the
     label's words are read off the input and given as the list's own name; failing a label, the input's title. */
  const named = inputProps['aria-label'] !== undefined || inputProps['aria-labelledby'] !== undefined;
  const [labelWords, setLabelWords] = useState<string | undefined>();
  useEffect(() => {
    if (named) return;
    const words = [...(box.current?.labels ?? [])]
      .map((label) => (label.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' ');
    setLabelWords(words || inputProps.title || undefined);
  }, [named, inputProps.title]);
  // The text is the caller's `text` and nothing else: an input's own value or change handler would be a second one.
  const { value: _value, defaultValue: _defaultValue, onChange: _onChange, onKeyDown, onClick, onBlur, ...input } = inputProps;
  /* Open with nothing to list: the caller still holds the list open (a search that found no one, with or without a
     message to say so), and UI SDK has no popup up to hear a press elsewhere or the keyboard leaving. Both are
     heard here, once, so the caller is told it closed as it is for a list with options in it. */
  const hollow = open && items.length === 0;
  const closing = useRef({ onOpenChange, closed: false });
  closing.current.onOpenChange = onOpenChange;
  const emptyBox = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!hollow) return;
    closing.current.closed = false;
    const outside = (event: PointerEvent) => {
      const at = event.target as Node | null;
      if (closing.current.closed || box.current?.contains(at) || anchorRef?.current?.contains(at) || emptyBox.current?.contains(at)) return;
      closing.current.closed = true;
      closing.current.onOpenChange(false, changeDetails('outside-press', event));
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [hollow, anchorRef]);
  /* The caller's ref is handed the popup and nothing else: React's development build calls a ref with arguments
     of its own after the node, which a caller that records what it was given would take for part of the answer. */
  const setPopup = useCallback(
    (node: HTMLDivElement | null) => {
      if (typeof popupRef === 'function') popupRef(node);
      else if (popupRef) (popupRef as { current: HTMLDivElement | null }).current = node;
    },
    [popupRef],
  );
  const popup: CSSProperties =
    fit === 'width' ? { width: '100%' } : { minWidth: 'var(--anchor-width)', maxWidth: 'var(--available-width)' };
  const targetContainer = (portal === 'body' ? null : dialog) ?? popupContainer();
  const emptyOverlay = nothing ? (
    <div ref={emptyBox} data-slot="autocomplete-content" data-kind="empty" data-fit={fit} style={under}>
      {/* The list's class is the popup's surface (ground, edge, shadow) to a caller, so while there is no list
          the message's box takes it: a message on a see-through popup over the form is unreadable. */}
      <div ref={setPopup} className={popupClassName} data-slot="autocomplete-popup" data-open="" style={popup}>
        <div className={listClassName}>
          <div className={emptyClassName} data-slot="autocomplete-empty" role="status">
            {empty}
          </div>
        </div>
      </div>
    </div>
  ) : null;
  return (
    <Autocomplete
      value={text}
      open={open && items.length > 0}
      filter={false}
      autoHighlight={autoHighlight && typed}
      onValueChange={(next, details) => {
        // Walking the list would fill the box with each row's label as it is lit.
        if (details.reason === 'list-navigation') return details.cancel();
        if (details.reason === 'item-press') {
          // The row in hand is the one chosen; a press that lit none (a tap) is found by the label it would fill.
          details.cancel();
          const picked =
            (lit.current !== null && byKey.get(lit.current)) || items.find((item) => itemLabel(item) === next || itemKey(item) === next);
          pressed.current = true;
          if (picked) onPick(picked);
          return;
        }
        setTyped(true);
        onText(next, told(reason(details.reason), details));
      }}
      onOpenChange={(next, details) => {
        /* A press on the row whose name is already the box's text changes no value, so UI SDK says only that the
           list closed for it: the row is chosen here, or typing a name out in full and pressing it chose nothing. */
        if (details.reason === 'item-press' && !pressed.current) {
          const picked = (lit.current !== null && byKey.get(lit.current)) || items.find((item) => itemLabel(item) === text);
          if (picked) onPick(picked);
        }
        pressed.current = false;
        onOpenChange(next, told(reason(details.reason), details));
      }}
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
          else if (inputRef) (inputRef as { current: HTMLInputElement | null }).current = node;
        }}
        onBlur={(event) => {
          onBlur?.(event);
          if (!hollow || closing.current.closed || emptyBox.current?.contains(event.relatedTarget)) return;
          closing.current.closed = true;
          onOpenChange(false, changeDetails('focus-out', event));
        }}
        // A press on the box opens the list, where arriving by Tab does not.
        onClick={(event) => {
          onClick?.(event);
          if (!open && !event.defaultPrevented) onOpenChange(true, changeDetails('input-press', event));
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          /* Only this layer: a drawer under the list listens for Escape too, and would close with it. The key
             stops here while the popup is up even when something before this handler already took it, before
             UI SDK's own listener hears it, so the close is said here: also for a list that holds only its empty
             message, which UI SDK has no popup open for. */
          if (event.key !== 'Escape' || !open) return;
          event.stopPropagation();
          if (event.defaultPrevented) return;
          event.preventDefault();
          onOpenChange(false, changeDetails('escape-key', event));
        }}
      />
      {/* UI SDK's content is the element that is placed, and inside it stands the caller's popup, with the
          caller's class and ref. A list that fits its anchor is sized on the placed element alone, so what the
          popup holds cannot widen it while options arrive; one that only starts at the anchor's width is sized on
          the popup. Inside a dialog the list is drawn into it; `portal="body"` and a page without one send it
          where every popup here goes (internal/popups.ts). */}
      <AutocompleteContent
        data-fit={fit}
        style={fit === 'width' ? { width: 'var(--anchor-width)', maxWidth: 'var(--available-width)' } : undefined}
        anchor={anchorRef ? { getBoundingClientRect: () => (anchorRef.current ?? box.current)!.getBoundingClientRect() } : undefined}
        container={targetContainer}
      >
        {/* The caller's popup says it is open itself: its class is what a caller's stylesheet and tests know, and
            they ask it, not the placed element round it, whether the list is up. */}
        <div ref={setPopup} className={popupClassName} data-slot="autocomplete-popup" data-open={open ? '' : undefined} style={popup}>
          {/* The list holds options and nothing else, and is not drawn at all while it has nothing to hold. */}
          {items.length > 0 ? (
            <AutocompleteList
              className={listClassName}
              aria-label={named ? input['aria-label'] : labelWords}
              aria-labelledby={input['aria-labelledby']}
            >
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
        </div>
      </AutocompleteContent>
      {emptyOverlay && (targetContainer ? createPortal(emptyOverlay, targetContainer) : emptyOverlay)}
    </Autocomplete>
  );
}

/* Slotted (UiKit.tsx): an App's control kit may draw its own in place of the default, with the same props. */
export const Typeahead = slotted('Typeahead', DefaultTypeahead, { onText: [1, 'input-change'], onOpenChange: [1, 'implicit'] });
