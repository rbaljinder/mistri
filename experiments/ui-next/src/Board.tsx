import { DotsSixVertical, DotsThree } from '@phosphor-icons/react';
import { Menu, MenuContent, MenuGroup, MenuGroupLabel, MenuItem, MenuTrigger } from '@ui-sdk/react/menu';
import { type ReactNode, useId, useMemo } from 'react';
import { Transfer, TransferHandle, TransferItem, TransferList } from './behaviors/Transfer';
import { Skeleton } from './Skeleton';
import type { Tone } from './Status';
import { words } from './words';

export type BoardLane = { value: string; label: string; tone?: Tone };

export type BoardVerb = { value: string; label: string };

export type BoardProps<T> = {
  label: string;
  lanes: BoardLane[];
  cards: T[];
  cardKey: (card: T) => string;
  cardName: (card: T) => string;
  laneOf: (card: T) => string;
  card: (card: T) => ReactNode;
  /* A card that may stand in any lane moves through its menu, to the lane chosen, or is carried there. */
  onMove?: (card: T, lane: string) => void;
  /* A card whose moves are its own (a workflow's verbs: this one may be scheduled, that one closed) says them
     itself, and its menu lists those in place of the lanes. */
  verbs?: (card: T) => BoardVerb[];
  onVerb?: (card: T, verb: string) => void;
  /* What carrying a card to a lane means, for a card with verbs: the verb that leads there, or nothing where no
     verb does. Carrying is then a second way to say a verb, never a way around one. */
  drop?: (card: T, lane: string) => BoardVerb | undefined;
  onOpen?: (card: T) => void;
  /* What an empty lane says. */
  empty?: string;
  /* The cards are still being read: the lanes stand and a few cards wait in each. */
  loading?: boolean;
};

/* A list as lanes, composed on the Transfer behavior (behaviors/transfer.ts): the lanes are its lists and the
   cards its items, so everything about carrying one is that behavior's. A mouse or a pen carries a card from
   anywhere on it; a finger and a keyboard carry it by its grip (Space picks it up, Left and Right change lanes,
   Space lets go, Escape puts it back), and a screen reader hears each step. While a card is carried the lanes
   that would take it say what letting go there does and the others stand back.

   The board adds what a move means. Its cards stand in the order they are given, so a move only ever changes a
   card's lane; and a card with verbs is not moved by being carried at all: the verb that leads to the lane is
   run, and the card moves when whatever holds the cards says it has. Every move is also in the card's menu. */
export function Board<T>({
  label,
  lanes,
  cards,
  cardKey,
  cardName,
  laneOf,
  card,
  onMove,
  verbs,
  onVerb,
  drop,
  onOpen,
  empty,
  loading,
}: BoardProps<T>) {
  const how = useId();
  const carries = Boolean(drop ?? onMove) && !loading;
  const byKey = useMemo(() => new Map(cards.map((item) => [cardKey(item), item])), [cards, cardKey]);
  const lists = useMemo(
    () =>
      Object.fromEntries(
        lanes.map((lane) => [lane.value, loading ? [] : cards.filter((item) => laneOf(item) === lane.value).map(cardKey)]),
      ),
    [lanes, cards, laneOf, cardKey, loading],
  );
  const offer = (item: T | undefined, lane: string): BoardVerb | undefined =>
    !item || lane === laneOf(item) ? undefined : drop ? drop(item, lane) : onMove ? { value: lane, label: words.moveHere } : undefined;

  return (
    <Transfer
      data-kind="board"
      role="group"
      aria-label={label}
      aria-busy={loading || undefined}
      value={lists}
      order={lanes.map((lane) => lane.value)}
      accepts={(key, lane) => Boolean(offer(byKey.get(key), lane))}
      label={(key) => {
        const item = byKey.get(key);
        return item ? cardName(item) : undefined;
      }}
      listLabel={(lane) => lanes.find((one) => one.value === lane)?.label}
      onValueChange={(_next, details) => {
        const item = byKey.get(details.key);
        const verb = offer(item, details.to);
        // The lanes are drawn from the cards, so the move is not the board's to keep: it is asked of the caller.
        if (drop || !verb || !item) details.cancel();
        if (!item || !verb) return;
        if (drop) onVerb?.(item, verb.value);
        else onMove?.(item, verb.value);
      }}
    >
      {carries && (
        <p id={how} hidden>
          {words.carryHow}
        </p>
      )}
      {lanes.map((lane, at) => (
        <TransferList
          key={lane.value}
          value={lane.value}
          render={<section />}
          data-kind="board-lane"
          aria-label={loading ? lane.label : `${lane.label}, ${lists[lane.value]?.length ?? 0}`}
          around={(items, state) => {
            const offered = state.takes ? offer(byKey.get(state.carrying ?? ''), lane.value) : undefined;
            return (
              <>
                <header>
                  <span data-slot="status" data-tone={lane.tone ?? 'neutral'}>
                    {lane.label}
                  </span>
                  {offered ? (
                    <span data-slot="board-offer">{offered.label}</span>
                  ) : (
                    !loading && <span data-slot="list-count">{state.keys.length}</span>
                  )}
                </header>
                <ul>
                  {loading &&
                    Array.from({ length: 3 - (at % 2) }, (_, index) => (
                      // eslint-disable-next-line react/no-array-index-key
                      <li key={index} data-kind="board-card" data-waiting="">
                        <Skeleton width={index % 2 ? '58%' : '82%'} />
                        <span />
                        <div data-slot="board-card-body">
                          <Skeleton width="44%" />
                          <Skeleton width="5rem" height="1.75rem" />
                        </div>
                      </li>
                    ))}
                  {items}
                  {!loading && state.keys.length === 0 && (
                    <li data-slot="board-empty">{offered ? offered.label : (empty ?? words.nothingHere)}</li>
                  )}
                </ul>
              </>
            );
          }}
        >
          {(key) => {
            const item = byKey.get(key);
            if (!item) return null;
            const name = cardName(item);
            const own = verbs?.(item);
            const choices = own ?? (onMove ? lanes.filter((other) => other.value !== lane.value) : []);
            return (
              <TransferItem key={key} value={key} data-kind="board-card" data-carries={carries ? '' : undefined}>
                {carries && (
                  <TransferHandle aria-label={words.carry(name)} aria-describedby={how}>
                    <DotsSixVertical aria-hidden="true" weight="bold" />
                  </TransferHandle>
                )}
                {onOpen ? (
                  <a
                    href="#"
                    data-slot="board-card-name"
                    draggable={false}
                    onClick={(event) => {
                      event.preventDefault();
                      onOpen(item);
                    }}
                  >
                    {name}
                  </a>
                ) : (
                  <span data-slot="board-card-name">{name}</span>
                )}
                {choices.length > 0 ? (
                  <Menu onAction={(value) => (own ? onVerb?.(item, String(value)) : onMove?.(item, String(value)))}>
                    <MenuTrigger aria-label={own ? words.moreFor(name) : words.move(name)} data-variant="quiet">
                      <DotsThree aria-hidden="true" weight="bold" />
                    </MenuTrigger>
                    <MenuContent align="end">
                      {own ? (
                        choices.map((choice) => (
                          <MenuItem key={choice.value} value={choice.value}>
                            {choice.label}
                          </MenuItem>
                        ))
                      ) : (
                        <MenuGroup>
                          <MenuGroupLabel>{words.moveTo}</MenuGroupLabel>
                          {choices.map((choice) => (
                            <MenuItem key={choice.value} value={choice.value}>
                              {choice.label}
                            </MenuItem>
                          ))}
                        </MenuGroup>
                      )}
                    </MenuContent>
                  </Menu>
                ) : (
                  <span />
                )}
                <div data-slot="board-card-body">{card(item)}</div>
              </TransferItem>
            );
          }}
        </TransferList>
      ))}
    </Transfer>
  );
}
