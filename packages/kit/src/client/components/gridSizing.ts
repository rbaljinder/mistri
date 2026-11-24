/**
 * How a grid's columns share their room: each column's floor from its head and its values, the width it would like,
 * and which give way first when the room is short. A row is one line and so is a head: nothing wraps, a figure, a
 * date and a chip keep their whole width, and what is cut is secondary text, with the whole value on hover.
 */
interface GridColumnSize {
  label: string;
  /** The label as the head sets it, measured in the head's own font, case and tracking; absent, its characters are counted. */
  headWidth?: number;
  kind: string;
  values: unknown[];
  /** The second line a display rule draws under each value, in the smaller type. */
  subValues?: unknown[];
  /** The words the totals row draws under the column, in its heavier weight: a sum is wider than any row it adds up,
      and a total cut to "$102,795...." is the one figure that must be read whole. */
  total?: string;
  /** The cell's own padding, both sides, as its row draws it; absent, 24px. */
  pad?: number;
  /** Measured: what the head stands its label off its edges by (the cell's padding and its sort's), and the width of
      the sort's arrow in the head's face. A look that pads a head's leading edge, or sets its arrow wider, took the
      room from the label: "Code" over a short key was cut to "Co…" under its own arrow. */
  headPad?: number;
  arrow?: number;
  /** Values drawn as tone chips: the dot, padding and border are width too. */
  chip?: boolean;
  /** Measured in the first row: what a chip draws beyond its words (the dot, gap and padding of the look wearing it). */
  chipExtra?: number;
  controls?: boolean;
  /** What the sort draws beside the label on its line, the gap before it included: a reference's arrow. */
  mark?: number;
  /** What stands in the head's flow beside the sort on a device that cannot hover (its caret and move buttons,
      style.css): room on both floors, as `mark` is. */
  touchControls?: number;
  showTime?: boolean;
  /** The column that names the row: it is read whole before the others are. */
  title?: boolean;
  /** Values drawn beside an initials disc: the disc and its gap are width too. */
  avatar?: boolean;
  /** The row's state (a tone chip, or a vocabulary named status or stage): kept with the name when columns are left out. */
  status?: boolean;
  /** Every value is the words the cell draws ("4 weeks ago", "$22,495"), not a raw value it formats, and nothing beside them but what `beside` counts (a bar, a ring; never an App's own renderer). */
  dressed?: boolean;
  /** What the cell draws beside its words (a percent's bar or ring, a meter's bar, and the gap): width the words do not measure. */
  beside?: number;
  /** A date no rule dresses: its values are the words the cell draws ("Aug 22, 2026"), measured in the cell's font. */
  drawnDate?: boolean;
}

export const GRID_SIZE_SAMPLE = 40;
export const GRID_EXPANDER_WIDTH = 32;
/** The trailing cell a row's own menu sits in. */
export const GRID_TRAIL_WIDTH = 44;

/** A long title is read up to about this wide before it earns an ellipsis. */
const READABLE_TEXT = 360;
/** The name of a row keeps about this much before any other text column
    grows past SECONDARY_TEXT: an issue's name was cut at 155px while Project
    and Cycle kept their whole words as their minimum. */
const TITLE_TEXT = 240;
const SECONDARY_TEXT = 120;
/** How much wider a figure sets in the totals row's 600 weight than in a cell's 400 (features.css). */
const TOTAL_WEIGHT = 1.1;
/** What a secondary text column keeps when it is cut: its padding and about ten characters, so a person's name is cut
    to a first name and a letter, never to "T…". A column whose values are shorter keeps their width. */
const CUT_FLOOR = 96;
/** A cell's padding where none was measured: 12px a side. */
const CELL_PAD = 24;
/** What a head keeps of its label when it is cut: about four letters and the ellipsis. */
const HEAD_KEEP = 36;
/** An avatar's disc (24px) and the gap before its name. */
const AVATAR_WIDTH = 32;
/** How wide a head's characters set: a sentence-case label in the interface
    face. A look whose heads are capitals sets wider — small capitals' and Mono's
    clipped their last head into a stray "…" — and says by how much through
    `--grid-head-char` (themeFamilies.css), which the grid reads where it
    measures its room. */
export const GRID_HEAD_CHAR = 7;

/** Whether every value is digits in groups: figures with the marks that set them apart, and nothing to read as words. */
export function isGroupedNumber(values: readonly string[]): boolean {
  const said = values.filter((text) => text.trim() !== '');
  return said.length > 0 && said.every((text) => text.length <= 24 && /\d/.test(text) && /^[\d\s()+\-./#x]+$/i.test(text));
}

/** Measures a text in the grid's cell font, in pixels (Grid.tsx, a canvas). */
export type TextMeasure = (text: string) => number;

/** Bounded hints: readable minima survive small containers. Text is measured in
    the cells' own font where the grid can (`measure`); without it, a character
    counts 8px, which ran a 14px sans 20–40% wide — five short columns held a
    third of the room while the title beside them was cut to "Preserve filt…". */
export function columnSizeHint(
  column: GridColumnSize,
  headChar = GRID_HEAD_CHAR,
  measure?: TextMeasure,
  squeezeName = false,
): { minimum: number; wanted: number; least: number; head: number } {
  /* A head with controls keeps room for its sort's leading padding, its arrow and the resizer's 12px at its trailing
     edge, which the sort never reaches under (style.css); a reference's arrow beside the label is room too (`mark`).
     Its menu caret and its move buttons stand past the label's end where a pointer hovers, so they are not reserved. */
  const counted = Math.min(column.label.length, 22) * headChar;
  /* Never less than the room a head had before it was measured: only a look that draws more is given more. */
  const drawn = column.headPad === undefined ? 0 : Math.ceil(column.headPad + 4 + (column.arrow ?? 8));
  const around = (column.controls ? Math.max(34, drawn) : 28) + (column.mark ?? 0) + (column.touchControls ?? 0);
  const header = Math.ceil(column.headWidth === undefined ? counted : Math.min(column.headWidth, counted * 1.15)) + around;
  /* A head wider than what its column draws gives way before any value does (giveWay): cut to about four letters
     and an ellipsis, its whole label in its sort's title. "Listed online" over a tick is the head to cut, not the
     resident's name three columns before it. */
  const headFloor = Math.min(header, around + HEAD_KEEP);
  /* What a cell stands its value off its edges by: measured, the cell's own padding (Grid.tsx); unmeasured, 12px a
     side. Four pixels a column past the padding every look draws added up to a name cut in a ten-column list. */
  const pad = column.pad ?? CELL_PAD;
  const sample = (values: unknown[] = []) =>
    values
      .slice(0, GRID_SIZE_SAMPLE)
      .filter((value) => value != null)
      .map(String);
  const longest = (values: unknown[] = []) => sample(values).reduce<number>((max, text) => Math.max(max, text.length), 0);
  const widest = (values: unknown[] = [], scale = 1) =>
    sample(values).reduce<number>((max, text) => Math.max(max, measure!(text) * scale), 0);
  /* An "In progress" chip is its words plus a dot, a gap, padding and a
     border; sized as bare text it spilled over the next column's edge once
     spare room stopped arriving evenly. Counted as five more characters, or
     measured, 40px: Lumen's "In progress" chip draws 41px past its words (dot,
     gap, 8px and 10px of padding), and at 22 its cell cut it to "In progress …"
     in Thread's issues and Compass's ratings. */
  const length = Math.max(longest(column.values), column.total?.length ?? 0) + (column.chip ? 5 : 0);
  /* The total is set in the totals row's semibold, a tenth wider than the cell's own weight. */
  const totalWidth = measure && column.total ? Math.ceil(measure(column.total) * TOTAL_WEIGHT) : 0;
  const textWidth =
    (measure ? Math.max(Math.ceil(widest(column.values)), totalWidth) + (column.chip ? (column.chipExtra ?? CHIP_EXTRA) : 0) : length * 8) +
    (column.avatar ? AVATAR_WIDTH : 0) +
    (column.beside ?? 0);
  /* A second line asks for room, never lowers the floor: an email under a
     name wants its width, but a narrow panel still keeps the name's minimum.
     It is set a size down (12.5px under 14px). */
  const under = (measure ? Math.ceil(widest(column.subValues, 0.9)) : longest(column.subValues) * 7) + pad;
  /* A column whose values are never cut (a mark, a date, a figure): as wide as they are, or as its head. */
  const fixed = (body: number): { minimum: number; wanted: number; least: number; head: number } => {
    const minimum = Math.max(header, body);
    const least = Math.max(body, headFloor);
    return { minimum, wanted: minimum, least, head: minimum - least };
  };
  /* A date or a number said in a display rule's own words — "4 weeks ago", a priority's chip — is as wide as
     those words measure. Its usual width held a relative date at 112px and a one-digit chip at 97px while the
     name and the owner beside them were cut: the room went to the columns that could not use it. A date or a
     number the cell formats itself keeps its width, since the raw value is not what is drawn. */
  const measured = measure && sample(column.values).length > 0;
  /* A yes-or-no is a mark, 64px, unless its display says it in words: an SLA's "On track" and "Breached" in tone
     chips were held to the mark's width and cut to "On trac…" (G187). Said in words, it is as wide as they are. */
  if (column.kind === 'boolean') {
    const width = (column.chip || column.dressed) && sample(column.values).length > 0 ? Math.min(264, textWidth + pad) : 64;
    return fixed(width);
  }
  if (column.kind === 'date') {
    const usual = column.showTime ? 176 : 112;
    /* Drawn by the cell in its own font, a date is as wide as it measures: the data face runs wider than the sans
       the usual width was set for, and "Aug 22, 2026" was cut to "Aug 22, 20…" at 1280. A narrower face gives the
       room back, down to a floor a page of short dates ("May 1, 2026") cannot take it under: the next page's
       "Sep 28, 2026" stands in the same column. */
    const width =
      measured && column.dressed
        ? Math.min(usual, textWidth + pad)
        : measured && column.drawnDate
          ? Math.max(usual - 16, Math.min(column.showTime ? 240 : 176, textWidth + pad))
          : usual;
    return fixed(width);
  }
  /* A number measured as it is drawn ("$22,495", "18,340 mi") is as wide as
     those figures: counted at 8px a character with four to spare, Forecourt's
     price, miles and days held 56px each past their figures while the car's
     name beside them was cut to "2024 Toyota C…". */
  if (column.kind === 'number') {
    const width =
      measured && (column.chip || column.dressed)
        ? Math.min(264, textWidth + pad)
        : Math.min(264, Math.max(88, (length + 4) * 8 + 24 + (column.beside ?? 0)));
    return fixed(width);
  }
  /* A number set in groups (a telephone number, a card's last digits, a part number of digits) is a number that
     happens to be stored as text: it is never cut and never broken at its spaces (docs/design.md, Truncation), so
     its column is as wide as its widest value, measured or, before the cells' face has loaded, counted. Held to a
     text's floor it wrapped "(720) 555-" over "4381" in a look whose cells are a size up, where every other column
     kept one line. */
  if (isGroupedNumber(sample(column.values))) {
    const width = Math.min(264, textWidth + pad);
    return fixed(width);
  }
  /* Past about 24 characters a text is a sentence that may be cut, not a name
     that must be whole: 24 characters of a 14px sans measure about 168px. At
     190 a 25-character name in a heavier first column kept its whole width
     and four columns of minima ran past a half-width panel. */
  const verbose = measure ? textWidth > 168 : length > 24;
  /* The row's name holds up to TITLE_TEXT as its floor; every other text
     column holds at most SECONDARY_TEXT and asks for the rest as room it
     wants, so when a table is tight the secondary columns are the ones cut.
     The name never gives way below its floor: where the minima run past the
     room, the table scrolls (or an embedded one leaves columns out). Giving
     way first cut "2024 Toyota C…" and "Frame Bag…" in tables that scrolled
     sideways anyway, so nothing was gained for the cut. */
  // A tone chip is a short word that is never cut; it keeps its whole width.
  const floor = (title: boolean) => (title ? TITLE_TEXT : column.chip ? 216 : verbose ? 128 : SECONDARY_TEXT);
  /* Measured, a short key ("AC-101") is as wide as it is; counted, a column keeps 80px against a guess that ran short. */
  const body = Math.min(floor(Boolean(column.title)), Math.max(measure ? 56 : 80, textWidth + pad));
  const minimum = Math.max(header, body);
  /* What a secondary text column gives way to before the table scrolls: its
     head. A dealer's name cut at the head's width reads better than a table
     that scrolls 45px to show the rest of it at the edge. */
  /* In a column of its own (an aside's list, a half-width block) the name is the last to give way, not a floor under
     the table: where the kept columns still run past the room, the name is cut to an ellipsis at its head's width
     rather than the table scrolled sideways under cut-off heads. */
  const least =
    column.chip || (column.title && !squeezeName)
      ? Math.max(body, headFloor)
      : column.title
        ? Math.max(headFloor, Math.min(minimum, SECONDARY_TEXT - 24))
        : Math.max(headFloor, Math.min(body, CUT_FLOOR + (column.avatar ? AVATAR_WIDTH : 0)));
  return {
    minimum,
    least,
    head: Math.max(0, minimum - Math.max(body, headFloor)),
    wanted: Math.max(minimum, header, Math.min(READABLE_TEXT, Math.max(textWidth + pad, under))),
  };
}

/**
 * The hints for a grid's columns. A table is fitted to its room in this order, each step taken only where the one
 * before still runs past it (docs/design.md, Standing layout rules): every head and value whole on one line; the
 * secondary text given way to its floor, the last column first, cut with its whole value on hover; and only then the
 * columns that still do not fit folded under the row's name or left out (keepFitting). Nothing wraps: a row is one
 * line at every width a table is drawn at.
 */
function sizeHints(
  columns: GridColumnSize[],
  room: number,
  headChar: number,
  measure?: (text: string, column: number) => number,
  squeezeName = false,
  cut = true,
): ReturnType<typeof columnSizeHint>[] {
  const hints = columns.map((column, index) => columnSizeHint(column, headChar, measure && ((text) => measure(text, index)), squeezeName));
  return cut ? giveWay(hints, room, squeezeName) : hints;
}

/**
 * The least a reader may drag a column to. Text keeps its ellipsis (no floor of its own); a date, a figure, a yes-or-no
 * and a status chip are cut by no one, so each holds the width its value measures (its minimum, as sized above): a date
 * is never "Aug 22, 20…" and a pill never "In rev…" because a handle was dragged a pixel too far.
 */
export function columnFloor(column: GridColumnSize, headChar = GRID_HEAD_CHAR, measure?: TextMeasure): number {
  const whole =
    column.kind === 'date' ||
    column.kind === 'number' ||
    column.kind === 'boolean' ||
    column.chip ||
    isGroupedNumber(
      (column.values ?? [])
        .slice(0, GRID_SIZE_SAMPLE)
        .filter((value) => value != null)
        .map(String),
    );
  return whole ? columnSizeHint(column, headChar, measure).least : 0;
}

/* Where the minima together run past the room, the heads wider than their columns' values give way first, the
   last first, and then the secondary text columns, the last first, down to their floors; the name, the chips and
   the figures never do. Where giving way would not spare the scroll, nothing is cut for it: a phone's table cut a
   SKU to "BAG-FRB-…" and scrolled anyway — unless the grid is squeezed into a bounded Card or fit list (`squeeze`),
   which may not scroll sideways and scales its kept columns to fit `room`. */
function giveWay<T extends { minimum: number; least: number; head: number; wanted: number }>(
  hints: T[],
  room: number,
  squeeze = false,
): T[] {
  let over = hints.reduce((sum, hint) => sum + hint.minimum, 0) - room;
  if (over <= 0 || (!squeeze && hints.reduce((sum, hint) => sum + hint.least, 0) > room)) return hints;
  const given = [...hints];
  const give = (most: (hint: T) => number, head: boolean) => {
    for (let i = given.length - 1; i >= 0 && over > 0; i--) {
      const less = Math.min(over, most(given[i]!));
      /* What a head gave it does not ask back: left wanting it, the head stood among the columns cut short and took
         the room a value was then lent (lendHeads), so the head stayed whole and the name beside it stayed cut. */
      given[i] = head
        ? { ...given[i]!, minimum: given[i]!.minimum - less, wanted: given[i]!.wanted - less, head: given[i]!.head - less }
        : { ...given[i]!, minimum: given[i]!.minimum - less };
      over -= less;
    }
  };
  give((hint) => Math.min(hint.head, hint.minimum - hint.least), true);
  give((hint) => hint.minimum - hint.least, false);
  if (squeeze && over > 0 && room > 0) {
    const cellFloor = Math.max(24, Math.min(56, Math.floor(room / Math.max(1, given.length))));
    const slack = given.map((hint) => Math.max(0, hint.minimum - cellFloor));
    const totalSlack = slack.reduce((a, b) => a + b, 0);
    if (totalSlack > 0) {
      let left = Math.min(over, totalSlack);
      for (let i = given.length - 1; i >= 0 && left > 0; i--) {
        const share = i === 0 ? left : Math.min(slack[i]!, Math.ceil((over * slack[i]!) / totalSlack));
        const less = Math.min(left, slack[i]!, share);
        const nextMin = given[i]!.minimum - less;
        given[i] = { ...given[i]!, minimum: nextMin, wanted: Math.max(nextMin, given[i]!.wanted - less) };
        left -= less;
      }
    }
  }
  return given;
}

/**
 * The columns an embedded grid keeps in its width: a dashboard's list in half
 * a row cut "Sep 22, 202" behind a scroll bar. Past the width, columns are
 * left out from the end, as an aside's list says names rather than a table;
 * the row's name and the first column always stay, and status columns stay
 * while they fit `room` — a related list beside an aside cut its status first,
 * as the last column written, which was the one a reader came to it for, while
 * a narrow Card with three status chips must fold the excess rather than overflow.
 * Null when all fit, or before the room is measured.
 */
export function keepFitting(
  columns: GridColumnSize[],
  available: number,
  expandable = false,
  trailing = false,
  headChar = GRID_HEAD_CHAR,
  measure?: (text: string, column: number) => number,
  /* An App's own list cuts its secondary text to its floor before it folds a column (sizeHints); an embedded grid
     leaves a column out before it cuts one, as it always did. */
  cut = false,
): boolean[] | null {
  if (!(available > 0)) return null;
  let room = available - (expandable ? GRID_EXPANDER_WIDTH : 0) - (trailing ? GRID_TRAIL_WIDTH : 0);
  const hints = sizeHints(columns, room, headChar, measure, false, cut);
  if (hints.reduce((sum, hint) => sum + hint.minimum, 0) <= room) return null;
  const squeezed = columns.map((column, index) => columnSizeHint(column, headChar, measure && ((text) => measure(text, index)), true));
  const kept = columns.map((column, index) => index === 0 || Boolean(column.title));
  let statusRoom = room - squeezed.reduce((sum, hint, index) => sum + (kept[index] ? hint.least : 0), 0);
  room -= hints.reduce((sum, hint, index) => sum + (kept[index] ? hint.minimum : 0), 0);
  columns.forEach((column, index) => {
    if (kept[index] || !column.status) return;
    if (hints[index]!.minimum <= statusRoom) {
      kept[index] = true;
      statusRoom -= hints[index]!.minimum;
      room -= hints[index]!.minimum;
    }
  });
  // In order, until one does not fit: a narrower column after it is not a reason to leave a gap.
  let full = false;
  hints.forEach((hint, index) => {
    if (kept[index] || full) return;
    if (hint.minimum > room) {
      full = true;
      return;
    }
    kept[index] = true;
    room -= hint.minimum;
  });
  return kept;
}

/** A fold decided: what it kept, at what width, for which columns and rows (`of`, compared by identity). */
export interface FoldHeld {
  kept: boolean[];
  width: number;
  of: readonly unknown[];
}

/* Wider than any scrollbar a browser draws, so the one a fold brings or takes away never unfolds what it folded. */
const FOLD_SLACK = 24;

/**
 * The columns an App's list keeps, held against its own scrollbar. A fold changes the rows' height, and with it the
 * page's scrollbar: the room a scrollbar gave back unfolded the columns, whose taller rows took the scrollbar again,
 * and the list re-laid itself out without end (a field report). A folded column comes back only once the room grows
 * past a scrollbar's width from where it folded; a narrower room folds at once, and other columns or other rows are
 * sized afresh.
 */
export function holdFold(
  held: FoldHeld | null,
  next: boolean[] | null,
  width: number,
  of: readonly unknown[],
): { kept: boolean[] | null; held: FoldHeld | null } {
  const same = held !== null && held.of.length === of.length && held.of.every((part, index) => part === of[index]);
  if (same && width >= held.width && width < held.width + FOLD_SLACK) {
    const unfolds = next === null || next.some((keep, index) => keep && !held.kept[index]);
    const foldsMore = next !== null && next.some((keep, index) => !keep && held.kept[index]);
    if (unfolds && !foldsMore) return { kept: held.kept, held };
  }
  return { kept: next, held: next ? { kept: next, width, of } : null };
}

/* Room past the minima goes first to the columns still cut short — an issue
   title at "Preserve filters when op…" beside a "Cycle 18" column holding
   twice its text's width — and only then, evenly, to everyone. Long text
   used to take a double share of all of it, and grew past its sentence
   while the name beside it lost its second line. Among the columns cut
   short, the one that needs least is made whole first: shared in proportion
   to what each wanted, a deal's committee gave "Karen Olstad" five of the
   twenty pixels her name lacked and a note the rest, so both were cut. */
/* Short of its whole width by no more than this, a column is made whole before the name grows. */
const NEARLY_WHOLE = 40;
/* What a tone chip draws beyond its words, measured (see columnSizeHint). */
const CHIP_EXTRA = 40;

/* Where the columns fit and a value is still a few pixels short of whole — a resident's "Lucas Mendoza" cut to
   "Lucas Mendo…" under capital heads that held 113px for "ASKING RENT" over "$1,285" — the heads wider than their
   values lend it the difference, the last first: a head gives way before a value does (giveWay), here as there. Only
   to a column nearly whole, so a long description's wish for a readable line never cuts a table's heads. */
function lendHeads<T extends { minimum: number; least: number; head: number; wanted: number }>(hints: T[], room: number): T[] {
  if (!Number.isFinite(room)) return hints;
  const spare = room - hints.reduce((sum, hint) => sum + hint.minimum, 0);
  const nearly = hints.reduce((sum, hint) => {
    const lacks = hint.wanted - hint.minimum;
    return lacks > 0 && lacks <= NEARLY_WHOLE ? sum + lacks : sum;
  }, 0);
  const owed = nearly - Math.max(0, spare);
  return owed <= 0 || spare < 0 ? hints : lendFromHeads(hints, owed);
}

/* `owed` pixels taken from the heads wider than their values, the last first; the same hints where none has any. */
function lendFromHeads<T extends { minimum: number; least: number; head: number; wanted: number }>(hints: T[], owed: number): T[] {
  let lent: T[] | undefined;
  for (let i = hints.length - 1; i >= 0 && owed > 0; i--) {
    const hint = (lent ?? hints)[i]!;
    const less = Math.min(owed, hint.head, hint.minimum - hint.least);
    if (less <= 0) continue;
    lent ??= [...hints];
    /* Lent, not kept wanting: the room it gave is the value's, and a lender that still wanted it took it back first,
       as the column least short (shareRoom). */
    lent[i] = { ...hint, minimum: hint.minimum - less, wanted: hint.wanted - less, head: hint.head - less };
    owed -= less;
  }
  return lent ?? hints;
}

/* What each column is given of the room past the minima (`filling`), and what is then left to spread evenly. */
function shareRoom(
  hints: readonly { minimum: number; wanted: number }[],
  named: number,
  extra: number,
): { given: number[]; spare: number } {
  const short = hints.reduce((sum, hint) => sum + hint.wanted - hint.minimum, 0);
  const filling = Math.min(extra, short);
  /* A column a few pixels short of whole is made whole first — an owner's
     "Karen Olstad" short by 20px — then the row's name, up to its readable
     width: Thread's issues cut every name at 274px while Status, Project and
     Cycle shared the room. Then each in turn, least wanting first, takes what
     it lacks or an even share of what is left, whichever is less. */
  const given = hints.map(() => 0);
  let left = filling;
  const lacking = hints
    .map((hint, index) => ({ index, lacks: hint.wanted - hint.minimum }))
    .filter(({ lacks }) => lacks > 0)
    .sort((a, b) => a.lacks - b.lacks);
  for (const { index, lacks } of lacking) {
    if (index === named || lacks > NEARLY_WHOLE || lacks > left) continue;
    given[index] = lacks;
    left -= lacks;
  }
  if (named >= 0) {
    given[named] = Math.min(left, hints[named]!.wanted - hints[named]!.minimum);
    left -= given[named]!;
  }
  const wanting = lacking.filter(({ index }) => given[index] === 0 && index !== named);
  wanting.forEach(({ index, lacks }, turn) => {
    const share = Math.min(lacks, Math.floor(left / (wanting.length - turn)));
    given[index] = share;
    left -= share;
  });
  return { given, spare: extra - filling };
}

export function fitGridColumns(
  columns: GridColumnSize[],
  available: number,
  expandable = false,
  trailing = false,
  headChar = GRID_HEAD_CHAR,
  measure?: (text: string, column: number) => number,
  squeezeName = false,
): { width: number; columns: number[] } {
  const gutter = (expandable ? GRID_EXPANDER_WIDTH : 0) + (trailing ? GRID_TRAIL_WIDTH : 0);
  const room = Number.isFinite(available) ? Math.floor(available) - gutter : Infinity;
  let hints = lendHeads(sizeHints(columns, room, headChar, measure, squeezeName), room);
  const named = columns.findIndex((column) => column.title);
  const fill = () => {
    const minimum = hints.reduce((sum, hint) => sum + hint.minimum, gutter);
    const width = Math.max(minimum, Number.isFinite(available) ? Math.floor(available) : 0);
    return { width, extra: width - minimum, ...shareRoom(hints, named, width - minimum) };
  };
  let filled = fill();
  /* A value the shared room still leaves a few pixels short — an email cut to "marcus.morales@example.te…" beside
     "RESIDENT SINCE" over a date — is lent the rest by the heads wider than their values, as a value short before
     the sharing is (lendHeads): the room is shared once more with what they lent. */
  if (Number.isFinite(room)) {
    const still = hints.reduce((sum, hint, index) => {
      const lacks = hint.wanted - hint.minimum - filled.given[index]!;
      return lacks > 0 && lacks <= NEARLY_WHOLE ? sum + lacks : sum;
    }, 0);
    const lent = still > 0 ? lendFromHeads(hints, still) : hints;
    if (lent !== hints) {
      hints = lent;
      filled = fill();
    }
  }
  const { width, extra, given, spare } = filled;
  let remaining = extra;
  const sizes = hints.map((hint, index) => {
    const share = index === hints.length - 1 ? remaining : given[index]! + Math.floor(spare / hints.length);
    remaining -= share;
    return hint.minimum + share;
  });
  return { width, columns: sizes };
}

/**
 * How many of a cell's tag chips are drawn whole in `room`: as many as fit
 * beside the "+N" that counts the rest, and at least one. `widths` are the
 * chips that may be drawn (the first few of `total`); `more` measures the
 * count for so many left out.
 */
export function tagsThatFit(widths: number[], total: number, gap: number, room: number, more: (rest: number) => number): number {
  const needs = (count: number) =>
    widths.slice(0, count).reduce((sum, width) => sum + width, 0) + gap * (count - 1) + (count < total ? gap + more(total - count) : 0);
  let count = Math.min(widths.length, total);
  while (count > 1 && needs(count) > room) count -= 1;
  return count;
}
