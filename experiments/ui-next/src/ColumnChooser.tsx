import { DotsSixVertical, SlidersHorizontal } from '@phosphor-icons/react';
import { Button } from '@ui-sdk/react/button';
import { Checkbox, CheckboxIndicator } from '@ui-sdk/react/checkbox';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@ui-sdk/react/popover';
import { Sortable, SortableHandle, SortableItem } from './behaviors/Sortable';
import { words } from './words';

export type ChosenColumns = {
  /* Every column's id, in the order the reader has put them. */
  order: string[];
  /* The ids the reader has put away. */
  hidden: string[];
};

/* Which columns a table shows and in what order, set where the table is: a reader with a narrow window, or one
   who only ever looks at three of nine columns, should not have to scroll past the rest every time. It is the
   Sortable behavior with a checkbox in each item, and nothing more: a column is carried by its grip (or by the
   row, with a mouse), ticked to show and unticked to put away, and the table follows as it is done, with no Apply.
   The column that names the row cannot be put away, since a row with no name opens nothing. */
export function ColumnChooser({
  columns,
  value,
  onValueChange,
  changed,
  onReset,
}: {
  columns: { id: string; header: string; primary?: boolean }[];
  value: ChosenColumns;
  onValueChange: (value: ChosenColumns) => void;
  /* Whether the columns stand differently from how the table was given them, which is when Reset is offered. */
  changed?: boolean;
  onReset?: () => void;
}) {
  const named = new Map(columns.map((column) => [column.id, column]));
  const shown = value.order.filter((id) => !value.hidden.includes(id)).length;
  return (
    <Popover>
      <PopoverTrigger data-variant="quiet" data-size="sm" data-kind="column-chooser" data-active={changed ? '' : undefined}>
        <SlidersHorizontal aria-hidden="true" />
        {words.columns}
        {changed && <span data-slot="filter-chip-value">{words.shownOf(shown, columns.length)}</span>}
      </PopoverTrigger>
      <PopoverContent align="end" data-kind="column-chooser">
        <header>
          <PopoverTitle>{words.columns}</PopoverTitle>
          {changed && onReset && (
            <Button data-variant="quiet" data-size="sm" onClick={onReset}>
              {words.reset}
            </Button>
          )}
        </header>
        <Sortable
          by="handle"
          aria-label={words.columnsOrder}
          value={value.order}
          onValueChange={(order) => onValueChange({ ...value, order })}
        >
          {(id) => {
            const column = named.get(id);
            if (!column) return null;
            const on = !value.hidden.includes(id);
            return (
              <SortableItem key={id} value={id}>
                <SortableHandle aria-label={words.move(column.header)}>
                  <DotsSixVertical aria-hidden="true" weight="bold" />
                </SortableHandle>
                <label>
                  <Checkbox
                    checked={on}
                    disabled={column.primary}
                    onCheckedChange={(next) =>
                      onValueChange({
                        ...value,
                        hidden: next === true ? value.hidden.filter((each) => each !== id) : [...value.hidden, id],
                      })
                    }
                  >
                    <CheckboxIndicator />
                  </Checkbox>
                  {column.header}
                </label>
              </SortableItem>
            );
          }}
        </Sortable>
      </PopoverContent>
    </Popover>
  );
}
