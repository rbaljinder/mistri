/**
 * How a grid's columns share their room: each column's floor from its head and its values, the width it would like,
 * and which give way first when the room is short. An App's head may wrap to two lines, so its floor is its widest
 * line, and the wrap is taken only when the heads set on one line would run past the room.
 */
interface GridColumnSize {
  label: string;
  /** The label as the head sets it, measured in the head's own font, case and tracking; absent, its characters are counted. */
  headWidth?: number;
  /** An App's head may wrap to two lines, so its floor is the label's widest line when broken at the best word, not the whole label. `headWrap` is that line measured like `headWidth`; absent, its characters are counted. */
  wrapHead?: boolean;
  headWrap?: number;
  /** An App's text column whose values may wrap at their words: where the heads wrapped still run past the room, its
      floor is its widest value's two-line width rather than its whole width, so the value is kept whole on two lines
      rather than cut or scrolled to. The row's name is the first to take it (sizeHints); never a chip or a figure. */
  wrapValues?: boolean;
  kind: string;
  values: unknown[];
  /** The second line a display rule draws under each value, in the smaller type. */
  subValues?: unknown[];
  /** Values drawn as tone chips: the dot, padding and border are width too. */
  chip?: boolean;
  /** Measured in the first row: what a chip draws beyond its words (the dot, gap and padding of the look wearing it). */
  chipExtra?: number;
  controls?: boolean;
  showTime?: boolean;
  /** The column that names the row: it is read whole before the others are. */
  title?: boolean;
  /** Values drawn beside an initials disc: the disc and its gap are width too. */
  avatar?: boolean;
  /** The row's state (a tone chip, or a vocabulary named status or stage): kept with the name when columns are left out. */
  status?: boolean;
  /** Every value is the words the cell draws ("4 weeks ago", "$22,495"), not a raw value it formats, and nothing beside them (a bar, a ring, an App's own renderer). */
  dressed?: boolean;
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
/** An avatar's disc (24px) and the gap before its name. */
const AVATAR_WIDTH = 32;
/** How wide a head's characters set: a sentence-case label in the interface
    face. A look whose heads are capitals sets wider — small capitals' and Mono's
    clipped their last head into a stray "…" — and says by how much through
    `--grid-head-char` (themeFamilies.css), which the grid reads where it
    measures its room. */
export const GRID_HEAD_CHAR = 7;

/**
 * The width of a label's widest line when it is broken into two at the best word: the narrowest a head can be
 * and still read as at most two lines. One word cannot break, so it is its own width. `width` measures a piece.
 */
export function twoLineWidth(label: string, width: (text: string) => number): number {
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length < 2) return width(label);
  let best = width(label);
  for (let at = 1; at < words.length; at++)
    best = Math.min(best, Math.max(width(words.slice(0, at).join(' ')), width(words.slice(at).join(' '))));
  return best;
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
): { minimum: number; wanted: number; least: number; whole?: number; twoLines?: number } {
  /* A head with controls keeps room for its sort's padding and arrow; its menu caret and its move buttons stand past the
     label's end where a pointer hovers (style.css), so they are not reserved. */
  const counted = Math.min(column.label.length, 22) * headChar;
  const around = column.controls ? 34 : 28;
  const header = Math.ceil(column.headWidth === undefined ? counted : Math.min(column.headWidth, counted * 1.15)) + around;
  /* An App's head wraps before it widens its column: the floor is its two-line width, and the whole label stays
     what the column wants, so a table with room for it still draws every head on one line. */
  const countedWrap = twoLineWidth(column.label, (text) => Math.min(text.length, 22) * headChar);
  const headLeast = column.wrapHead
    ? Math.min(header, Math.ceil(column.headWrap === undefined ? countedWrap : Math.min(column.headWrap, countedWrap * 1.15)) + around)
    : header;
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
  const length = longest(column.values) + (column.chip ? 5 : 0);
  const textWidth =
    (measure ? Math.ceil(widest(column.values)) + (column.chip ? (column.chipExtra ?? CHIP_EXTRA) : 0) : length * 8) +
    (column.avatar ? AVATAR_WIDTH : 0);
  /* A second line asks for room, never lowers the floor: an email under a
     name wants its width, but a narrow panel still keeps the name's minimum.
     It is set a size down (12.5px under 14px). */
  const under = (measure ? Math.ceil(widest(column.subValues, 0.9)) : longest(column.subValues) * 7) + 24;
  const fixed = (
    minimum: number,
    wanted = minimum,
  ): { minimum: number; wanted: number; least: number; whole?: number; twoLines?: number } => ({
    minimum,
    wanted,
    least: minimum,
  });
  /* A date or a number said in a display rule's own words — "4 weeks ago", a priority's chip — is as wide as
     those words measure. Its usual width held a relative date at 112px and a one-digit chip at 97px while the
     name and the owner beside them were cut: the room went to the columns that could not use it. A date or a
     number the cell formats itself keeps its width, since the raw value is not what is drawn. */
  const measured = measure && sample(column.values).length > 0;
  /* A yes-or-no is a mark, 64px, unless its display says it in words: an SLA's "On track" and "Breached" in tone
     chips were held to the mark's width and cut to "On trac…" (G187). Said in words, it is as wide as they are. */
  if (column.kind === 'boolean') {
    const width = (column.chip || column.dressed) && sample(column.values).length > 0 ? Math.min(264, textWidth + 24) : 64;
    return fixed(Math.max(headLeast, width), Math.max(header, width));
  }
  if (column.kind === 'date') {
    const width = measured && column.dressed ? Math.min(column.showTime ? 176 : 112, textWidth + 24) : column.showTime ? 176 : 112;
    return fixed(Math.max(headLeast, width), Math.max(header, width));
  }
  /* A number measured as it is drawn ("$22,495", "18,340 mi") is as wide as
     those figures: counted at 8px a character with four to spare, Forecourt's
     price, miles and days held 56px each past their figures while the car's
     name beside them was cut to "2024 Toyota C…". */
  if (column.kind === 'number') {
    const width =
      measured && (column.chip || column.dressed) ? Math.min(264, textWidth + 24) : Math.min(264, Math.max(88, (length + 4) * 8 + 24));
    return fixed(Math.max(headLeast, width), Math.max(header, width));
  }
  /* Past about 24 characters a text is a sentence that may be cut, not a name
     that must be whole: 24 characters of a 14px sans measure about 168px. At
     190 a 25-character name in a heavier first column kept its whole width
     and four columns of minima ran past a half-width panel. */
  const verbose = measure ? textWidth > 168 : length > 24;
  /* Its values on two lines, each broken at its best word: the widest of them is the floor it may take. */
  const wrapped =
    column.wrapValues && !column.chip
      ? (measure
          ? Math.ceil(sample(column.values).reduce<number>((max, text) => Math.max(max, twoLineWidth(text, measure)), 0))
          : sample(column.values).reduce<number>(
              (max, text) =>
                Math.max(
                  max,
                  twoLineWidth(text, (part) => part.length * 8),
                ),
              0,
            )) +
        24 +
        (column.avatar ? AVATAR_WIDTH : 0)
      : undefined;
  /* The row's name holds up to TITLE_TEXT as its floor; every other text
     column holds at most SECONDARY_TEXT and asks for the rest as room it
     wants, so when a table is tight the secondary columns are the ones cut.
     The name never gives way below its floor: where the minima run past the
     room, the table scrolls (or an embedded one leaves columns out). Giving
     way first cut "2024 Toyota C…" and "Frame Bag…" in tables that scrolled
     sideways anyway, so nothing was gained for the cut. */
  // A tone chip is a short word that is never cut; it keeps its whole width.
  const floor = (title: boolean) => (title ? TITLE_TEXT : column.chip ? 216 : verbose ? 128 : SECONDARY_TEXT);
  const minimum = Math.max(headLeast, Math.min(floor(Boolean(column.title)), Math.max(80, Math.min(textWidth + 24, wrapped ?? Infinity))));
  /* What a secondary text column gives way to before the table scrolls: its
     head. A dealer's name cut at the head's width reads better than a table
     that scrolls 45px to show the rest of it at the edge. */
  /* In a column of its own (an aside's list, a half-width block) the name is the last to give way, not a floor under
     the table: where the kept columns still run past the room, the name is cut to an ellipsis at its head's width
     rather than the table scrolled sideways under cut-off heads. */
  const least = column.chip
    ? minimum
    : column.title
      ? squeezeName
        ? Math.max(headLeast, Math.min(minimum, SECONDARY_TEXT - 24))
        : minimum
      : Math.max(headLeast, Math.min(minimum, 80));
  return {
    minimum,
    least,
    wanted: Math.max(minimum, header, Math.min(READABLE_TEXT, Math.max(textWidth + 24, under))),
    /* What its widest value needs on one line, and on two: a column given less than the one and at least the other
       wraps its values rather than cutting them (fitGridColumns). */
    ...(wrapped !== undefined ? { whole: textWidth + 24, twoLines: wrapped } : {}),
  };
}

/**
 * The hints for a grid's columns, and whether its values wrap. A table is fitted to its room in this order, each
 * step taken only where the one before still runs past it (docs/design.md, Standing layout rules): every head and
 * value whole on one line; an App's heads on two lines at their words; the row's name on two lines, kept whole;
 * the other text values on two lines too; and only then the secondary text given way to its head, cut. A table whose heads fit whole keeps them on
 * one line, as it always did, and a value is cut only where nothing else spares the sideways scroll.
 */
function sizeHints(
  columns: GridColumnSize[],
  room: number,
  headChar: number,
  measure?: (text: string, column: number) => number,
  squeezeName = false,
): ReturnType<typeof columnSizeHint>[] {
  /* `values` says whose words may take their two-line floor: nobody's, only the row's name, or every text column's. */
  const hints = (heads: boolean, values: 'none' | 'title' | 'all') =>
    columns.map((column, index) =>
      columnSizeHint(
        {
          ...column,
          wrapHead: heads && column.wrapHead,
          wrapValues: column.wrapValues && (values === 'all' || (values === 'title' && Boolean(column.title))),
        },
        headChar,
        measure && ((text) => measure(text, index)),
        squeezeName,
      ),
    );
  const fits = (list: { minimum: number }[]) => list.reduce((sum, hint) => sum + hint.minimum, 0) <= room;
  const whole = hints(false, 'none');
  if (fits(whole) || !columns.some((column) => column.wrapHead || column.wrapValues)) return giveWay(whole, room);
  const heads = hints(true, 'none');
  if (fits(heads) || !columns.some((column) => column.wrapValues)) return giveWay(heads, room);
  /* The row's name is the most important text in the row, so it takes its second line before a short secondary value
     (a person's two-word name) is given one: the others keep their floors while the name's alone still spares the room. */
  const named = hints(true, 'title');
  if (columns.some((column) => column.title && column.wrapValues) && fits(named)) return giveWay(named, room);
  return giveWay(hints(true, 'all'), room);
}

/* Where the minima together run past the room, the secondary text columns
   give way, the last first, down to their heads; the name, the chips and the
   figures never do. Where giving way would not spare the scroll, nothing is
   cut for it: a phone's table cut a SKU to "BAG-FRB-…" and scrolled anyway. */
function giveWay<T extends { minimum: number; least: number }>(hints: T[], room: number): T[] {
  let over = hints.reduce((sum, hint) => sum + hint.minimum, 0) - room;
  if (over <= 0 || hints.reduce((sum, hint) => sum + hint.least, 0) > room) return hints;
  const given = [...hints];
  for (let i = given.length - 1; i >= 0 && over > 0; i--) {
    const less = Math.min(over, given[i]!.minimum - given[i]!.least);
    given[i] = { ...given[i]!, minimum: given[i]!.minimum - less };
    over -= less;
  }
  return given;
}

/**
 * The columns an embedded grid keeps in its width: a dashboard's list in half
 * a row cut "Sep 22, 202" behind a scroll bar. Past the width, columns are
 * left out from the end, as an aside's list says names rather than a table;
 * the row's name, the first column and its status always stay — a related
 * list beside an aside cut its status first, as the last column written,
 * which was the one a reader came to it for. Null when all fit, or before
 * the room is measured.
 */
export function keepFitting(
  columns: GridColumnSize[],
  available: number,
  expandable = false,
  trailing = false,
  headChar = GRID_HEAD_CHAR,
  measure?: (text: string, column: number) => number,
): boolean[] | null {
  if (!(available > 0)) return null;
  let room = available - (expandable ? GRID_EXPANDER_WIDTH : 0) - (trailing ? GRID_TRAIL_WIDTH : 0);
  const hints = sizeHints(columns, room, headChar, measure);
  if (hints.reduce((sum, hint) => sum + hint.minimum, 0) <= room) return null;
  const kept = columns.map((column, index) => index === 0 || Boolean(column.title) || Boolean(column.status));
  room -= hints.reduce((sum, hint, index) => sum + (kept[index] ? hint.minimum : 0), 0);
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

export function fitGridColumns(
  columns: GridColumnSize[],
  available: number,
  expandable = false,
  trailing = false,
  headChar = GRID_HEAD_CHAR,
  measure?: (text: string, column: number) => number,
  squeezeName = false,
): { width: number; columns: number[]; wraps: boolean[] } {
  const gutter = (expandable ? GRID_EXPANDER_WIDTH : 0) + (trailing ? GRID_TRAIL_WIDTH : 0);
  const hints = sizeHints(columns, Number.isFinite(available) ? Math.floor(available) - gutter : Infinity, headChar, measure, squeezeName);
  const minimum = hints.reduce((sum, hint) => sum + hint.minimum, gutter);
  const width = Math.max(minimum, Number.isFinite(available) ? Math.floor(available) : 0);
  const extra = width - minimum;
  const short = hints.reduce((sum, hint) => sum + hint.wanted - hint.minimum, 0);
  const filling = Math.min(extra, short);
  const spare = extra - filling;
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
  const named = columns.findIndex((column) => column.title);
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
  let remaining = extra;
  const sizes = hints.map((hint, index) => {
    const share = index === hints.length - 1 ? remaining : given[index]! + Math.floor(spare / hints.length);
    remaining -= share;
    return hint.minimum + share;
  });
  /* A column given less than its widest value and enough for it on two lines wraps at its words (Grid.tsx, style.css
     `td.wraps`): the value stays whole rather than cut. One given less than that is a sentence, and is cut. */
  const wraps = columns.map((column, index) => {
    if (!column.wrapValues) return false;
    const { whole, twoLines } = columnSizeHint({ ...column, wrapHead: false }, headChar, measure && ((text) => measure(text, index)));
    return whole !== undefined && twoLines !== undefined && sizes[index]! < whole && sizes[index]! >= twoLines;
  });
  return { width, columns: sizes, wraps };
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
