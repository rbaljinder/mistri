---
title: Build a component on the behaviors
description: Reorder a list, carry a card between lanes, walk a month or read a chart, with the keyboard, a finger and a screen reader already answered, in a component you draw yourself.
---

Reorder a list, carry a card between lanes, walk a month or read a chart, with the keyboard, a finger and a screen reader already answered, in a component you draw yourself.

> **Preview.** The behaviors work as documented and may change in any 1.x release. See [status](/docs/status/).

```tsx
// pages/order.page.tsx
import { useState } from 'react';
import { Sortable, SortableHandle, SortableItem } from '@mistriwork/mistri/behaviors';
import { definePage } from '@mistriwork/mistri/page';
import './order.css';

export default definePage({ label: 'Order', reads: ['step'], component: Order });

function Order() {
  const [order, setOrder] = useState(['measure', 'cut', 'sand', 'paint']);
  return (
    <Sortable by="handle" value={order} onValueChange={setOrder} aria-label="Steps" className="c-page-order-steps">
      {(key) => (
        <SortableItem key={key} value={key} className="c-page-order-step">
          <SortableHandle aria-label={`Move ${key}`} />
          {key}
        </SortableItem>
      )}
    </Sortable>
  );
}
```

That is a list a reader orders: dragged by its grip, picked up with Space and placed with the arrows, put back with Escape, and read out as it is picked up, moved and dropped. The stylesheet is yours.

## What you'll see

Nothing, until you dress it. A behavior draws no box, no color and no icon: it puts the right roles, keys and `data-*` on the elements you give it, and your stylesheet does the rest. The one thing it brings is what it needs to work wherever it stands (a dragged item follows the pointer, a carried thing is not selected as text, a finger on a track still scrolls the page) and a plain grip of six dots, which a rule of yours replaces.

## When to use it, and when not

- Use a behavior when a [custom component](/docs/custom-components/) or a free-form page has something the reader moves, walks or edits in place, and the platform's own block does not draw it.
- Do not use one for what a block already is. A board of a resource's states is `boardView`; a calendar is `calendarView`; a table with widths a reader sets is a list. [Choose a building block](/docs/choose/) first.
- Do not use one to write to the database on its own. A behavior holds a value in the page; what a change means (a command, an action) is your component's to run.

## The nine

| Behavior | Parts | What it answers |
| --- | --- | --- |
| A list the reader orders | `Sortable`, `SortableItem`, `SortableHandle` | A drag; Space, the arrows, Home, End and Escape; vertical, horizontal or a grid; items picked up whole, or by a handle where they hold controls of their own. |
| Things carried between lists | `Transfer`, `TransferList`, `TransferItem`, `TransferHandle` | Several lists as one value; a carry by pointer, by a finger on the handle or by the keys; `accepts(key, list)`; which lists would take what is carried, as `data-takes`, `data-refuses` and `data-over`. |
| A month a keyboard walks | `Days`, `DaysDay` | One Tab stop; arrows by day and week, Page Up and Down by month, with the month following; a first and last day; days that cannot be picked. |
| Stretches along tracks | `Spans`, `SpansTrack`, `SpansSpan` | The bars of a plan, the visits of a day: carried along a track or lengthened from an edge, snapped to a step; Alt with an arrow from the keyboard. |
| A position read along a line | `Scrub`, `ScrubTrack` | A chart's crosshair: by pointer, finger or arrows; a slider to a screen reader, saying what is at each place. |
| One of a list, shown beside it | `Pick`, `PickList`, `PickOption`, `PickPane`, `PickBack` | A list with its detail: arrows walk and pick, Enter goes into the pane, Escape comes back; on a phone, one of the two at a time. |
| A list worked one at a time | `Turns`, `TurnsName`, `TurnsSkip` | A queue: the next comes into hand when one is dealt with, a skipped one comes round again, and the keyboard lands on the new one's name. |
| Column widths | `Widths`, `WidthsColumn`, `WidthsHandle` | A bar at a column's edge; Alt with the arrows from the column's own header; a double press gives a width back. |
| Values edited where they stand | `Editable`, `EditableValue`, `EditableInput` | One box at a time: Enter, F2 or typing starts, Enter and Tab keep, Escape puts back; `onCommit` may refuse what was typed. |

`Days` comes with the arithmetic its callers need: `addDays`, `addMonths`, `monthOf`, `inMonth`, `weeksOf`, `dayAt` and `localToday`. A day is `2026-11-14` and a month `2026-11`, in no zone.

## Every part

Each part takes what its element takes, and three props of its own:

- `render`: your own element, which receives the part's props, or a function of the props and the part's state. `<TransferList render={<section />} … />` is a list that is a section.
- `className` and `style`: a value, or a function of the part's state.

A part carries `data-slot` (`sortable-item`, `transfer-list`, `days-day`) and says its state in attributes, which is what a stylesheet reads:

```css
/* pages/order.css */
.c-page-order-step { display: flex; gap: var(--space-3); padding: var(--space-3) var(--space-4); border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.c-page-order-step[data-grabbed] { border-color: var(--accent); }
```

Name the classes `c-<id>-…` and use the look's tokens, as for any component, so every look dresses it.

## Hear a change, or refuse it

A root's `onValueChange` is given the value and then why it changed:

```tsx
<Transfer
  value={lanes}
  onValueChange={(next, details) => {
    // details: { reason, source, event, key, from, to, index, cancel(), canceled }
    if (details.to === 'done' && !ready(details.key)) return details.cancel();
    setLanes(next);
    void move({ id: details.key, lane: details.to });
  }}
>
```

- `reason` is one word per cause: `drag`, `move-key`, `imperative`.
- `source` is the hand: `pointer`, `keyboard`, or `program` for a change with no event behind it.
- `cancel()` leaves the value as it was. A change of a control's cannot be refused; a behavior's can.
- What the behavior adds rides beside them: the card that moved and where to, the column whose width changed, the stretch and what was done to it.

Give `value` and the root is controlled: it shows what it is given and asks for the change. Give `defaultValue` and it holds the value itself.

## What a screen reader is told

The pick-up, each move and the drop are announced by the behavior, in English, from the labels you give: `label` and `listLabel` on `Transfer`, `label` on `Spans`, `text` on `Scrub`, `say` on `Widths`. Pass your own words there for another language.

## It costs nothing until you use it

`@mistriwork/mistri/behaviors` is a module of its own. The page fetches it, with its small stylesheet, the first time a component imports it, so an App that builds nothing on a behavior downloads none of them.

## Common mistakes

- **Nothing moves with the keyboard between lists.** A `TransferItem` is carried with the keys by its `TransferHandle`. Put one in each item and name it (`aria-label`).
- **An item with a checkbox or a link in it will not pick up.** Say `by="handle"` on `Sortable` and add a `SortableHandle`: an item with controls of its own is picked up by its grip.
- **The dragged item is clipped by the box it is in.** Say `preview` on `Sortable`: a copy is carried over the page while the item shows where it would land.
- **A change is saved twice, or saved when the page set the value.** Read `details.source`: `program` is the page's own change.
- **The grip is invisible on a dark surface.** It is drawn in `currentColor`. Set the handle's `color`, or put your own icon inside it.

## Related

- [Custom components](/docs/custom-components/): where a component and a free-form page are declared.
- [Plug in a control kit](/docs/control-kits/): draw the platform's own controls with your components.
- [Looks](/docs/looks/): the tokens a component is dressed with.
