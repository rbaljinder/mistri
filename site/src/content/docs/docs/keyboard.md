---
title: Keyboard
description: Move through tables, records and the query bar without the mouse; press `?` anywhere for the keys of the room you are in.
---

Move through tables, records and the query bar without the mouse; press `?` anywhere for the keys of the room you are in.

```text
/  invoice total > 500  Enter  Tab  ↓ ↓  Enter  j j  Backspace
```

That is: focus the bar, ask, step into the grid, open the third row, step
to the next two records in that list, and walk back.

<!-- no picture: the ? panel lists these same keys in the running browser. -->

## Anywhere on the page

Single keys work when the caret is not in a text field, and never through a
dialog.

| Key | Does |
| --- | --- |
| `/` | Focus the query bar |
| `⌘/` | The query bar as a panel, with room to write in |
| `⌘K` | The command palette: tables, pages, actions, recent queries |
| `h` | Home: the schema, your work, the diagram |
| `t` | The table filter in the sidebar |
| `⌘B` | Show or hide the table list |
| `Backspace`, `⌘[` | Back one step along the trail |
| `?` | The keys for this room, and the query language |
| `Esc` | Leave the field, or close what is open |

## In a grid

Tab into the table; the arrow keys then move a cell cursor.

| Key | Does |
| --- | --- |
| `↑ ↓ ← →` | Move one cell (hold `⌘` to jump to the end of a row or column) |
| `Home`, `End` | First and last column |
| `Enter` | Open the record for that row, or the document in a JSON cell |
| `Space` | Glance at that row's record without leaving the list |
| `⌘C` | Copy the cell under the cursor |
| `Esc` | Back to the query bar |

## In a record

A record opened from a list (its page, a glance or a dialog) steps through
that list, in its order and filter, and past its page.

| Key | Does |
| --- | --- |
| `j` | The next record in the list |
| `k` | The previous record |
| `←`, `→` | The same, with the arrows beside the record's name |

An App's reader gets the grid and record keys too; `?` there lists only those.

## Related

- [tablewalk, the database browser](/docs/database-browser/): what `Enter` and `Backspace` move between.
- [Query language](/docs/query/): what to type after `/`.
