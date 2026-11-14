import { CaretUpDown, Plus } from '@phosphor-icons/react';
import { useAsyncOptions } from '@ui-sdk/react/async-options';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxStatus,
} from '@ui-sdk/react/combobox';
import { type ReactNode, useState } from 'react';
import { FieldFrame, type Option } from './fields';
import { words } from './words';

export type LookupFieldProps = {
  label: string;
  name?: string;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  required?: boolean;
  tip?: ReactNode;
  disabled?: boolean;
  /* Finds the options for what was typed. Its signal is aborted when a newer search replaces this one, so an
     answer that comes back late is never shown over a newer one. */
  load: (query: string, options: { signal: AbortSignal }) => Promise<Option[]>;
  value?: string | null;
  defaultValue?: string;
  onValueChange?: (value: string | null) => void;
  placeholder?: string;
  /* Offers to make what was typed, where nothing found is called exactly that: "Add “Juniper Row”". */
  onCreate?: (text: string) => void;
  /* What one of these is called, for the lines that say how the search is going: `resident`. */
  noun?: string;
};

/* What marks the row that makes something apart from an option's value. */
const CREATE = '~~create';

/* A box with a list that is looked up as the reader types: too many to hand over at once, or kept somewhere else.
   The search waits for a pause in the typing, a search that is overtaken is dropped, and what was found stays in
   view while the next is on its way, so the list never blinks empty between two keys. The list always says where
   it stands (searching, how many it found, that it could not look), and where the caller can make one, the thing
   typed is offered as a new one when nothing found is called exactly that. */
export function LookupField({
  label,
  name,
  hint,
  error,
  optional,
  required,
  tip,
  disabled,
  load,
  value,
  defaultValue,
  onValueChange,
  placeholder,
  onCreate,
  noun = 'match',
}: LookupFieldProps) {
  const [query, setQuery] = useState('');
  const found = useAsyncOptions<Option>(load, { debounce: 250, immediate: true });
  const typed = query.trim();
  const exact = found.items.some((option) => option.label.toLowerCase() === typed.toLowerCase());
  const offer = Boolean(onCreate && typed && !exact && found.status !== 'loading');
  return (
    <FieldFrame {...{ label, hint, error, optional, required, tip, disabled }}>
      <Combobox
        name={name}
        // The offer to add is one of the items, so the arrows reach it as they reach what was found.
        items={offer ? [...found.items, { value: CREATE, label: typed }] : found.items}
        filter={false}
        status={found.status}
        value={value}
        defaultValue={defaultValue}
        onQueryChange={(next) => {
          setQuery(String(next));
          found.setQuery(String(next));
        }}
        onValueChange={(next, details) => {
          if (next === CREATE) {
            details.cancel();
            onCreate?.(typed);
            return;
          }
          onValueChange?.(next === null ? null : String(next));
        }}
      >
        <div data-slot="adorned" data-kind="combo">
          <ComboboxInput placeholder={placeholder} />
          <CaretUpDown aria-hidden="true" />
        </div>
        <ComboboxContent>
          <ComboboxStatus>
            {(state) =>
              state.status === 'error' ? words.couldNotLook : state.loading ? words.searching : words.found(found.items.length, noun)
            }
          </ComboboxStatus>
          <ComboboxEmpty>
            {(state) => (state.empty && !state.loading && !offer ? words.nothingCalled(String(state.query)) : null)}
          </ComboboxEmpty>
          <ComboboxList>
            {(state) => (
              <>
                {(state.items as Option[]).map((option) =>
                  option.value === CREATE ? (
                    <ComboboxItem key={CREATE} value={CREATE} label={typed} data-kind="action" data-first="">
                      <Plus aria-hidden="true" weight="bold" />
                      {words.addNew(typed)}
                    </ComboboxItem>
                  ) : (
                    <ComboboxItem key={option.value} value={option.value} label={option.label} disabled={option.disabled}>
                      {option.icon}
                      {option.hint ? (
                        <span data-slot="option-words">
                          {option.label}
                          <small>{option.hint}</small>
                        </span>
                      ) : (
                        option.label
                      )}
                    </ComboboxItem>
                  ),
                )}
              </>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </FieldFrame>
  );
}
