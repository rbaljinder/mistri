import { ClockCounterClockwise, MagnifyingGlass } from '@phosphor-icons/react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandItemIcon,
  CommandList,
  CommandSeparator,
} from '@ui-sdk/react/command';
import { Dialog, DialogBackdrop, DialogContent, DialogShortcut, DialogTitle, DialogTrigger } from '@ui-sdk/react/dialog';
import { type ReactNode, useState } from 'react';
import { words } from './words';

export type PaletteCommand = {
  value: string;
  label: string;
  icon?: ReactNode;
  /* Other words it is found by: `bill` for Charges. */
  keywords?: string[];
  /* A word at its end: where it goes, its key. */
  hint?: ReactNode;
};
export type PaletteGroup = { label: string; commands: PaletteCommand[] };

const RECENT = 'm-palette:';
const recalled = (key: string | undefined): string[] => {
  try {
    return key ? (JSON.parse(window.localStorage.getItem(RECENT + key) ?? '[]') as string[]) : [];
  } catch {
    return [];
  }
};

/* Everything a reader can go to or do, found by typing: a search box in the bar that opens on a press or on Ctrl
   or Cmd with K, over UI SDK's command. What was run last is offered first while nothing is typed, since what a
   reader wants is most often what they wanted a minute ago; once they type, the whole list is ranked and the
   recent ones are found where they belong. */
export function CommandPalette({
  groups,
  onAction,
  label,
  placeholder,
  remember,
}: {
  groups: PaletteGroup[];
  onAction: (value: string) => void;
  /* The words in the box before it is opened. */
  label?: string;
  placeholder?: string;
  /* A name to keep the last few commands run under, in this browser. */
  remember?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<string[]>(() => recalled(remember));
  const all = new Map(groups.flatMap((group) => group.commands.map((command) => [command.value, command] as const)));
  const lately = query ? [] : recent.map((value) => all.get(value)).filter((command): command is PaletteCommand => command !== undefined);

  const run = (value: string) => {
    // A recent one is listed twice, under its own value and under a recent's.
    const plain = value.startsWith('~recent:') ? value.slice(8) : value;
    const next = [plain, ...recent.filter((other) => other !== plain)].slice(0, 4);
    setRecent(next);
    try {
      if (remember) window.localStorage.setItem(RECENT + remember, JSON.stringify(next));
    } catch {
      // Nothing kept: the command still runs.
    }
    setOpen(false);
    setQuery('');
    onAction(plain);
  };
  const item = (command: PaletteCommand, value = command.value) => (
    <CommandItem key={value} value={value} keywords={command.keywords}>
      {command.icon && <CommandItemIcon>{command.icon}</CommandItemIcon>}
      {command.label}
      {command.hint && <span data-slot="menu-item-hint">{command.hint}</span>}
    </CommandItem>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <DialogTrigger shortcut="mod+k" data-part="palette-trigger">
        <MagnifyingGlass aria-hidden="true" />
        <span>{label ?? words.searchAll}</span>
        <DialogShortcut />
      </DialogTrigger>
      <DialogBackdrop />
      <DialogContent data-part="palette">
        <DialogTitle data-kind="visually-hidden">{words.commandPalette}</DialogTitle>
        <Command query={query} onQueryChange={setQuery} onAction={(value) => run(String(value))}>
          <div data-part="palette-search">
            <MagnifyingGlass aria-hidden="true" />
            <CommandInput aria-label={words.searchCommands} placeholder={placeholder ?? words.typeCommand} />
          </div>
          <CommandEmpty>{words.nothingMatchesOption}</CommandEmpty>
          <CommandList>
            {lately.length > 0 && (
              <>
                <CommandGroup>
                  <CommandGroupLabel>{words.recent}</CommandGroupLabel>
                  {lately.map((command) => item({ ...command, icon: <ClockCounterClockwise /> }, `~recent:${command.value}`))}
                </CommandGroup>
                <CommandSeparator />
              </>
            )}
            {groups.map((group, index) => (
              <div key={group.label} style={{ display: 'contents' }}>
                {index > 0 && <CommandSeparator />}
                <CommandGroup>
                  <CommandGroupLabel>{group.label}</CommandGroupLabel>
                  {group.commands.map((command) => item(command))}
                </CommandGroup>
              </div>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
