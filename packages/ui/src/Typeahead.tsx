/**
 * A box you type into and a list that answers, over Base UI's Autocomplete.
 *
 * Three surfaces here are this shape — the record picker, the table picker
 * on the diagram, the reference filter box — and each walked its own list
 * with arrow keys, placed it by hand and closed it on a blur timer. Base UI
 * owns that now: the combobox roles, arrows and Home/End, Enter on the
 * highlighted row, Tab and a click outside to leave, the first row lit as
 * you type. The caller ranks and fetches the items — `filteredItems` says
 * the list is already the answer — draws each row in its own classes, and
 * hears one `onPick`.
 *
 * The text is the caller's: Base UI is told the item's label to fill the
 * box with on a pick, and that fill is ignored here, so a picker that wants
 * the box emptied (a multi-select) or named (a single one) decides itself.
 * Escape closes only this layer, stopped, so the panel underneath does not
 * take the same key. The list is anchored on the zoom-aware ruler, fixed
 * to the viewport so a scrolling drawer cannot clip it, and drawn inside
 * the enclosing dialog when there is one.
 */
import { useEffect, useLayoutEffect, useRef, useState, type InputHTMLAttributes, type ReactNode, type Ref, type RefObject } from 'react';
import { Autocomplete } from '@base-ui/react/autocomplete';
import { viewportBox } from './internal/ruler.js';
import { layoutViewport, zoomAnchor } from './internal/anchor.js';
import { popupContainer } from './internal/popups.js';
import { changeDetails, fromBaseUi, type ChangeDetails } from './changeDetails.js';
import { slotted } from './internal/uiKitContext.js';

/** Base UI's reasons for a combobox's text or list moving: typed, cleared, an option pressed, Escape, the focus gone… */
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
   * Where the list is drawn: inside the enclosing dialog (the default), or
   * the body. A popover is a dialog too, but its positioner is placed by a
   * transform, which makes it the containing block of a fixed list inside
   * it — measured there on the unzoomed ruler, the list landed a zoom's
   * worth away from its box. Drawn to the body, Base UI's floating tree
   * still counts the list as the popover's, so a pick does not dismiss it.
   */
  portal?: 'dialog' | 'body';
  /** Light the first row as the reader types (the default), or nothing until they arrow in: a search box's Enter is its own. */
  autoHighlight?: boolean;
  /** Hears the row lit by the keys or the pointer, and undefined when none is. */
  onHighlight?: (item: T | undefined) => void;
}

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
  const input = useRef<HTMLInputElement | null>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setContainer(portal === 'body' ? null : (input.current?.closest('dialog, [role="dialog"]') as HTMLElement | null));
  }, [portal]);
  /* A fixed-fit list takes its width from the anchor alone. Base UI's
     --anchor-width is recomputed on every positioner update, snapped against
     the anchor's position, so a list growing as its options arrived flipped
     between two widths inside one ResizeObserver frame ("loop completed with
     undelivered notifications"). Measured here on the house ruler, and again
     only when the anchor itself resizes, the list's own size cannot move it. */
  const [anchorWidth, setAnchorWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const anchor = anchorRef?.current ?? input.current;
    if (!open || fit !== 'width' || !anchor) return;
    const measure = () => {
      const width = (viewportBox(anchor) as { width: number }).width;
      setAnchorWidth(width > 0 ? width : null);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(anchor);
    return () => observer.disconnect();
  }, [open, fit, anchorRef]);
  const setInput = (node: HTMLInputElement | null) => {
    input.current = node;
    if (typeof inputRef === 'function') inputRef(node);
    else if (inputRef) (inputRef as { current: HTMLInputElement | null }).current = node;
  };
  /* The list is named as its box is. A box named by a `<label for>` has no name attribute to copy, and pointing the list's
     aria-labelledby at the box itself would read its typed text (an embedded textbox contributes its value), so the
     label's words are read off the input and given as the list's own aria-label; failing a label, the input's title. */
  const [labelWords, setLabelWords] = useState<string | undefined>();
  const named = inputProps['aria-label'] !== undefined || inputProps['aria-labelledby'] !== undefined;
  useEffect(() => {
    if (named) return;
    const words = [...(input.current?.labels ?? [])]
      .map((label) => (label.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' ');
    setLabelWords(words || inputProps.title || undefined);
  });
  const listName = {
    label: named ? inputProps['aria-label'] : labelWords,
    labelledBy: inputProps['aria-labelledby'],
  };
  const { onKeyDown, onFocus, ...rest } = inputProps;
  return (
    <Autocomplete.Root
      items={items}
      filteredItems={items}
      itemToStringValue={itemLabel}
      value={text}
      onValueChange={(next, details) => {
        // Selection fills the input too; it is not a new search or a cleared key.
        if (details.reason !== 'item-press') onText(String(next ?? ''), fromBaseUi(details, 'input-change'));
      }}
      open={open}
      onOpenChange={(next, details) => onOpenChange(next, fromBaseUi(details, 'implicit'))}
      openOnInputClick
      autoHighlight={autoHighlight}
      onItemHighlighted={onHighlight && ((item) => onHighlight(item))}
    >
      <Autocomplete.Input
        {...rest}
        ref={setInput}
        onFocus={onFocus}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          /* Only this layer: a drawer under the list listens for Escape too. The key stops here while the popup is up even
             when something before this handler already took it, as the caller or Base UI may when the popup holds only
             its empty message — otherwise the drawer under it closes with it. */
          if (e.key === 'Escape' && open) {
            e.stopPropagation();
            if (e.defaultPrevented) return;
            e.preventDefault();
            onOpenChange(false, changeDetails('escape-key', e));
          }
        }}
      />
      <Autocomplete.Portal container={container ?? popupContainer()}>
        <Autocomplete.Positioner
          anchor={() => {
            const el = anchorRef?.current ?? input.current;
            return el ? zoomAnchor(el) : null;
          }}
          positionMethod="fixed"
          side="bottom"
          align="start"
          sideOffset={4}
          collisionBoundary={layoutViewport()}
          collisionPadding={8}
          style={{
            zIndex: 40,
            // Fixed-fit lists size the observed positioner itself; the child
            // should not determine its intrinsic width while options arrive.
            ...(fit === 'width'
              ? { width: anchorWidth === null ? 'var(--anchor-width)' : `${anchorWidth}px`, maxWidth: 'var(--available-width)' }
              : {}),
          }}
        >
          <Autocomplete.Popup
            ref={popupRef}
            className={popupClassName}
            style={{
              ...(fit === 'width' ? { width: '100%' } : { minWidth: 'var(--anchor-width)', maxWidth: 'var(--available-width)' }),
            }}
          >
            {/* The list is named as its box is: a listbox without a name is read as "listbox" and nothing more. It holds
                options and nothing else: the empty message is a status, which a listbox may not own, so it sits
                beside the list, and the list is not drawn at all while it has nothing to hold (a listbox with no option
                is a pattern violation of its own). */}
            {items.length > 0 ? (
              <Autocomplete.List className={listClassName} aria-label={listName.label} aria-labelledby={listName.labelledBy}>
                {items.map((item) => (
                  <Autocomplete.Item
                    key={itemKey(item)}
                    value={item}
                    className={(s) => itemClassName(item, s.highlighted)}
                    onClick={() => onPick(item)}
                  >
                    {renderItem(item)}
                  </Autocomplete.Item>
                ))}
              </Autocomplete.List>
            ) : null}
            {/* The list's class is the popup's surface (ground, edge, shadow), so while there is no list the empty message's
                box takes it: a message on a see-through popup over the form is unreadable. The box stays put either way, so
                the status inside it is one live region, not a new one each time the list empties. */}
            {empty !== undefined ? (
              <div className={items.length > 0 ? undefined : listClassName}>
                <Autocomplete.Empty className={emptyClassName}>{empty}</Autocomplete.Empty>
              </div>
            ) : null}
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
  );
}

/* Slotted (UiKit.tsx): an App's control kit may draw its own in place of the default, with the same props. */
export const Typeahead = slotted('Typeahead', DefaultTypeahead, { onText: [1, 'input-change'], onOpenChange: [1, 'implicit'] });
