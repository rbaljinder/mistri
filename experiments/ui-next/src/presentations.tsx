import { ArrowLeft, CaretDown, Check, ImageSquare } from '@phosphor-icons/react';
import { announce } from '@ui-sdk/core';
import { useShortcut } from '@ui-sdk/react/shortcuts';
import { Tree as TreeRoot, TreeGroup, TreeItem, TreeItemIndicator, TreeItemLabel } from '@ui-sdk/react/tree';
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { Mark } from './Mark';
import { useWidth } from './measure';
import { Skeleton } from './Skeleton';
import type { Tone } from './Status';
import { words } from './words';

/* The other ways a list is read than as a table: as cards, as a tree, as a list with the picked one beside it,
   and as a queue worked one at a time. Each is handed its rows and says how one is drawn. */

/* ---------- cards ---------- */

export type Card = {
  id: string;
  title: string;
  /* The one number a card is read for: a rent, a price. */
  figure?: ReactNode;
  /* A few facts, each under its caption. */
  facts?: { label: string; value: ReactNode }[];
  badge?: { label: string; tone?: Tone };
  /* A picture's address. A card with `picture` set and none to show draws a placeholder of the same size. */
  picture?: string | null;
  href?: string;
};

/* Rows as cards. The title is the card's one link, stretched over the whole card, so a card is one stop for the
   keyboard and opens from anywhere on it. A picture's box has its size before the picture arrives, so nothing
   moves as they load. The columns are by the room the cards were given, not the window. */
export function Cards({
  label,
  cards,
  onOpen,
  loading,
  empty,
  ratio = '4 / 3',
}: {
  label: string;
  cards: Card[];
  onOpen?: (card: Card) => void;
  loading?: boolean;
  empty?: ReactNode;
  /* The picture's shape, as CSS `aspect-ratio`. */
  ratio?: string;
}) {
  const pictured = cards.some((card) => card.picture !== undefined);
  if (!loading && cards.length === 0) return <p data-slot="cards-empty">{empty ?? words.nothingHere}</p>;
  return (
    <ul data-slot="cards" aria-label={label} aria-busy={loading || undefined}>
      {loading
        ? Array.from({ length: 6 }, (_, at) => (
            // eslint-disable-next-line react/no-array-index-key
            <li key={at} data-slot="card" data-waiting="">
              <span data-slot="card-picture" style={{ aspectRatio: ratio }} />
              <span data-slot="card-body">
                <Skeleton width={at % 2 ? '62%' : '78%'} />
                <Skeleton width="40%" />
              </span>
            </li>
          ))
        : cards.map((card) => (
            <li key={card.id} data-slot="card">
              {pictured && (
                <span data-slot="card-picture" style={{ aspectRatio: ratio }}>
                  {card.picture ? <img src={card.picture} alt="" loading="lazy" decoding="async" /> : <ImageSquare aria-hidden="true" />}
                </span>
              )}
              <span data-slot="card-body">
                <span data-slot="card-head">
                  <a
                    data-slot="card-title"
                    href={card.href ?? '#'}
                    onClick={(click) => {
                      if (!onOpen || click.metaKey || click.ctrlKey || click.shiftKey) return;
                      click.preventDefault();
                      onOpen(card);
                    }}
                  >
                    <Mark>{card.title}</Mark>
                  </a>
                  {card.badge && (
                    <span data-slot="status" data-tone={card.badge.tone ?? 'neutral'}>
                      {card.badge.label}
                    </span>
                  )}
                </span>
                {card.figure !== undefined && <strong data-slot="card-figure">{card.figure}</strong>}
                {card.facts && card.facts.length > 0 && (
                  <dl data-slot="card-facts">
                    {card.facts.map((fact) => (
                      <div key={fact.label}>
                        <dt>{fact.label}</dt>
                        <dd>{fact.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </span>
            </li>
          ))}
    </ul>
  );
}

/* ---------- tree ---------- */

export type TreeNode = {
  id: string;
  label: string;
  /* What stands at the row's far end: a count, an amount. */
  meta?: ReactNode;
  icon?: ReactNode;
  href?: string;
  children?: TreeNode[];
};

const branches = (nodes: TreeNode[], deep: number): string[] =>
  deep <= 0 ? [] : nodes.flatMap((node) => (node.children?.length ? [node.id, ...branches(node.children, deep - 1)] : []));

/* Rows as the tree their parents make, over UI SDK's tree: one stop for the keyboard, Up and Down through what
   is open, Right into a branch and Left out of it, typing a name to go to it, Enter to open. What is open is
   kept by `remember` across visits, so a reader who folded half the tree away finds it folded. */
export function Tree({
  label,
  nodes,
  onOpen,
  open,
  remember,
  current,
}: {
  label: string;
  nodes: TreeNode[];
  onOpen?: (id: string) => void;
  /* How many levels are open to start with. */
  open?: number;
  /* A name to keep what is open under, in this browser. */
  remember?: string;
  /* The row that is the page being read. */
  current?: string;
}) {
  const store = remember ? `m-tree:${remember}` : undefined;
  const [expanded, setExpanded] = useState<string[]>(() => {
    try {
      const kept = store ? window.localStorage.getItem(store) : null;
      if (kept) return JSON.parse(kept) as string[];
    } catch {
      // A browser that keeps nothing starts from what the page asked for.
    }
    return branches(nodes, open ?? 1);
  });
  const draw = (level: TreeNode[]): ReactNode =>
    level.map((node) => (
      <TreeItem key={node.id} value={node.id} branch={node.children !== undefined}>
        <TreeItemLabel render={node.href ? <a href={node.href} /> : undefined}>
          {node.children !== undefined && (
            <TreeItemIndicator>
              <CaretDown aria-hidden="true" weight="bold" />
            </TreeItemIndicator>
          )}
          {node.icon && (
            <span data-slot="tree-icon" aria-hidden="true">
              {node.icon}
            </span>
          )}
          <span data-slot="tree-words">{node.label}</span>
          {node.meta !== undefined && <span data-slot="tree-meta">{node.meta}</span>}
        </TreeItemLabel>
        {node.children && <TreeGroup>{draw(node.children)}</TreeGroup>}
      </TreeItem>
    ));
  return (
    <TreeRoot
      data-kind="tree"
      aria-label={label}
      current={current}
      expanded={expanded}
      onExpandedChange={(next: string[]) => {
        setExpanded(next);
        try {
          if (store) window.localStorage.setItem(store, JSON.stringify(next));
        } catch {
          // Nothing kept: the tree still opens and folds.
        }
      }}
      onAction={onOpen ? (id: string) => onOpen(id) : undefined}
    >
      {draw(nodes)}
    </TreeRoot>
  );
}

/* ---------- a list with the picked one beside it ---------- */

export type ListDetailProps<Item> = {
  label: string;
  items: Item[];
  keyOf: (item: Item) => string;
  /* What the picked one is called: the detail's name, and what is read out. */
  titleOf: (item: Item) => string;
  /* One row of the list. */
  row: (item: Item) => ReactNode;
  /* The picked one, read in full. */
  detail: (item: Item) => ReactNode;
  pick?: string | null;
  defaultPick?: string | null;
  onPickChange?: (key: string | null) => void;
  /* What the detail's place says while nothing is picked. */
  hint?: ReactNode;
  empty?: ReactNode;
};

/* A list and the one picked from it, side by side where there is room for both. The list is a listbox: one stop
   for the keyboard, Up and Down pick as they go, so reading down a list is one key a row and the detail keeps
   up. Enter goes into the detail and Escape comes back to the row it was opened from.

   Where there is room for one, the list is the page and a pick turns it to the detail, with the way back above
   it; the keyboard is put on the detail as it arrives and on the row again on the way back, so neither turn
   loses the reader's place. */
export function ListDetail<Item>({
  label,
  items,
  keyOf,
  titleOf,
  row,
  detail,
  pick: given,
  defaultPick = null,
  onPickChange,
  hint,
  empty,
}: ListDetailProps<Item>) {
  const [own, setOwn] = useState<string | null>(defaultPick);
  const pick = given === undefined ? own : given;
  const [root, width] = useWidth(960);
  const narrow = width < 640;
  const pane = useRef<HTMLElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  /* Where the keyboard goes after the next draw: into the detail, or back onto a row. */
  const land = useRef<'detail' | string | null>(null);
  const picked = items.find((item) => keyOf(item) === pick);
  const cursor = picked ? pick : items[0] ? keyOf(items[0]) : null;

  const arrive = () => {
    const to = land.current;
    if (!to) return;
    land.current = null;
    if (to === 'detail') pane.current?.focus();
    else list.current?.querySelector<HTMLElement>(`[role="option"][data-key="${CSS.escape(to)}"]`)?.focus();
  };
  const choose = (key: string | null, then?: 'detail' | string) => {
    if (then) land.current = then;
    // Already picked: nothing is drawn again, so the keyboard is moved now.
    if (key === pick) return arrive();
    if (given === undefined) setOwn(key);
    onPickChange?.(key);
  };

  useEffect(arrive);

  const onListKey = (event: KeyboardEvent<HTMLElement>, key: string) => {
    const at = items.findIndex((item) => keyOf(item) === key);
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
    const next = to === undefined ? undefined : items[Math.min(Math.max(to, 0), items.length - 1)];
    if (next) {
      event.preventDefault();
      const nextKey = keyOf(next);
      // Where both are seen, walking the list picks as it goes; where one is, a row is only walked to.
      if (narrow) list.current?.querySelector<HTMLElement>(`[role="option"][data-key="${CSS.escape(nextKey)}"]`)?.focus();
      else choose(nextKey, nextKey);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(key, 'detail');
    }
  };

  const showList = !narrow || !picked;
  const showDetail = !narrow || picked;
  return (
    <div data-slot="list-detail" data-narrow={narrow ? '' : undefined} ref={root}>
      {showList && (
        <ul ref={list} role="listbox" aria-label={label} data-slot="list-detail-list">
          {items.length === 0 && <li data-slot="list-detail-empty">{empty ?? words.nothingHere}</li>}
          {items.map((item) => {
            const key = keyOf(item);
            return (
              <li
                key={key}
                role="option"
                data-key={key}
                aria-selected={key === pick}
                tabIndex={key === cursor ? 0 : -1}
                onClick={() => choose(key, narrow ? 'detail' : undefined)}
                onKeyDown={(event) => onListKey(event, key)}
              >
                {row(item)}
              </li>
            );
          })}
        </ul>
      )}
      {showDetail && (
        <section
          ref={pane}
          data-slot="list-detail-pane"
          aria-label={picked ? titleOf(picked) : label}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || event.defaultPrevented || !picked) return;
            event.preventDefault();
            const key = keyOf(picked);
            if (narrow) choose(null, key);
            else list.current?.querySelector<HTMLElement>(`[role="option"][data-key="${CSS.escape(key)}"]`)?.focus();
          }}
        >
          {narrow && picked && (
            <Button intent="quiet" size="sm" data-slot="list-detail-back" onClick={() => choose(null, keyOf(picked))}>
              <ArrowLeft aria-hidden="true" />
              {words.backTo(label)}
            </Button>
          )}
          {picked ? detail(picked) : <p data-slot="list-detail-hint">{hint ?? words.pickOne}</p>}
        </section>
      )}
    </div>
  );
}

/* ---------- a queue, one at a time ---------- */

export type QueueVerb = {
  value: string;
  label: string;
  intent?: 'primary' | 'default' | 'danger';
  /* One key that does it, while the reader is not typing. */
  shortcut?: string;
};

export type QueueProps<Item> = {
  label: string;
  items: Item[];
  keyOf: (item: Item) => string;
  titleOf: (item: Item) => string;
  /* The one being worked, read in full. */
  children: (item: Item) => ReactNode;
  verbs: QueueVerb[] | ((item: Item) => QueueVerb[]);
  /* Asked when a verb is chosen. The queue steps on when it settles, and stays if it throws. */
  onVerb: (item: Item, verb: string) => void | Promise<void>;
  /* What is said when nothing is left. */
  done?: ReactNode;
};

/* A list worked through one at a time: the one in hand, in full, with what can be done to it as buttons that
   each have a key. Choosing one does it and brings the next, with the keyboard on its name so it is read out;
   skipping leaves one for the end, where what was skipped is offered again. The count says where the reader is
   and the bar how much is behind them, so a long queue has an end in sight. */
export function Queue<Item>({ label, items, keyOf, titleOf, children, verbs, onVerb, done }: QueueProps<Item>) {
  const [handled, setHandled] = useState<string[]>([]);
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const name = useRef<HTMLHeadingElement | null>(null);
  const arrive = useRef(false);

  const left = items.filter((item) => !handled.includes(keyOf(item)));
  const current = left[at];
  const total = handled.length + left.length;
  const offered = current ? (typeof verbs === 'function' ? verbs(current) : verbs) : [];

  useEffect(() => {
    if (!arrive.current) return;
    arrive.current = false;
    name.current?.focus();
  });

  const run = async (verb: QueueVerb) => {
    if (!current || busy) return;
    setBusy(verb.value);
    setProblem(null);
    try {
      await onVerb(current, verb.value);
      arrive.current = true;
      setHandled((now) => [...now, keyOf(current)]);
      // The next one slides into this place; past the last, what was skipped is what is left, from its start.
      if (at >= left.length - 1) setAt(0);
      announce(words.queueDid(verb.label, titleOf(current)));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : words.queueFailed);
    } finally {
      setBusy(null);
    }
  };
  const step = (by: number) => {
    if (!left.length) return;
    arrive.current = true;
    setProblem(null);
    setAt((now) => (now + by + left.length) % left.length);
  };

  const typing = () =>
    !(document.activeElement instanceof HTMLElement && document.activeElement.matches('input, textarea, select, [contenteditable="true"]'));
  const keyed = (place: number) => offered[place]?.shortcut ?? null;
  // A fixed number of hooks whatever the verbs are: the first four that have a key.
  useShortcut(keyed(0), () => offered[0] && void run(offered[0]), { when: typing, description: offered[0]?.label ?? '' });
  useShortcut(keyed(1), () => offered[1] && void run(offered[1]), { when: typing, description: offered[1]?.label ?? '' });
  useShortcut(keyed(2), () => offered[2] && void run(offered[2]), { when: typing, description: offered[2]?.label ?? '' });
  useShortcut(keyed(3), () => offered[3] && void run(offered[3]), { when: typing, description: offered[3]?.label ?? '' });
  useShortcut(current && left.length > 1 ? 's' : null, () => step(1), { when: typing, description: words.skip });

  if (!current) {
    return (
      <section data-slot="queue" data-done="" aria-label={label}>
        <span data-slot="queue-done-mark" aria-hidden="true">
          <Check weight="bold" />
        </span>
        <h2 ref={name} tabIndex={-1}>
          {words.queueDone}
        </h2>
        <p>{done ?? words.queueHandled(handled.length)}</p>
      </section>
    );
  }
  return (
    <section data-slot="queue" aria-label={label}>
      <header data-slot="queue-head">
        <span data-slot="queue-count">{words.countOf(handled.length + 1, total)}</span>
        <span
          data-slot="queue-bar"
          role="progressbar"
          aria-label={words.queueProgress}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={handled.length}
        >
          <span style={{ width: `${(handled.length / Math.max(total, 1)) * 100}%` }} />
        </span>
        {left.length > 1 && (
          <Button intent="quiet" size="sm" onClick={() => step(1)}>
            {words.skip}
            <kbd data-slot="kbd">S</kbd>
          </Button>
        )}
      </header>
      <div data-slot="queue-body" aria-busy={busy ? true : undefined}>
        <h2 ref={name} tabIndex={-1}>
          {titleOf(current)}
        </h2>
        {children(current)}
      </div>
      {problem && (
        <p data-slot="queue-problem" role="alert">
          {problem}
        </p>
      )}
      <footer data-slot="queue-verbs">
        {offered.map((verb) => (
          <Button
            key={verb.value}
            intent={verb.intent ?? 'default'}
            busy={busy === verb.value}
            disabled={busy !== null && busy !== verb.value}
            onClick={() => void run(verb)}
          >
            {verb.label}
            {verb.shortcut && <kbd data-slot="kbd">{verb.shortcut.toUpperCase()}</kbd>}
          </Button>
        ))}
      </footer>
    </section>
  );
}
