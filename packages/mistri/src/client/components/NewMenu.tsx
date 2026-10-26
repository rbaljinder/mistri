/**
 * The header's New menu (`ui.shell.new`): one quiet button beside
 * the bell, listing every way this reader may make something — a list's New
 * form, a signed-in form — so the menu beside it lists places only. The
 * lines are newMenuModel.ts's reading, the same the palette lists; none
 * left for this reader, no button. A chunk of its own (app.js loads it
 * where an App declares the menu), so an App without one never fetches it.
 * A run of lines written under one group (`{ label, children }`) is a labelled
 * group of the menu: its heading is the group's name to a screen reader, and
 * the arrows walk the lines straight through from one group to the next.
 */
import { Fragment } from 'react';
import { DropGroup, DropItem, DropMenu, DropSeparator } from '@mistriwork/ui/DropMenu.js';
import { Icon } from '@mistriwork/kit/client/components/Icon.js';
import type { NewMenuEntry } from '../../shared/appNewMenu.js';
import { appNewEntries, openNewEntry } from '@mistriwork/kit/client/components/newMenuModel.js';
import { say } from '../copy/shell/components/NewMenu.js';
import './NewMenu.css';

export function NewMenu({ entries, onOpen }: { entries: readonly NewMenuEntry[]; onOpen: (entry: NewMenuEntry) => void }) {
  if (!entries.length) return null;
  const marked = entries.some((entry) => entry.icon);
  return (
    <DropMenu
      className="new-menu"
      triggerClassName="ghost new-menu-trigger"
      triggerTitle={say('createSomething')}
      /* "+ New", the words a list's own New button says (NewRecordButton.tsx): one way to say it in the App. On a phone
         the bar is one row and the button is its mark (NewMenu.css); its name is still "New". */
      label={
        <>
          <span className="new-menu-words">{say('plusNew')}</span>
          <span className="new-menu-mark" aria-hidden="true">
            +
          </span>
        </>
      }
      triggerLabel={say('new')}
      popupClassName="more-list new-menu-popup"
    >
      {runs(entries).map(({ group, lines }, index) => {
        const items = lines.map((entry) => (
          <DropItem key={entry.view} className="new-menu-item" onClick={() => onOpen(entry)}>
            {/* Icons on every line or none: where a sibling has one, a line without keeps its empty slot, so the labels line up. */}
            {entry.icon ? <Icon name={entry.icon} /> : marked && <span className="new-menu-slot" aria-hidden="true" />}
            <span>{entry.label}</span>
          </DropItem>
        ));
        return (
          <Fragment key={group === undefined ? `run-${lines[0].view}` : `group-${group}`}>
            {index > 0 && <DropSeparator className="new-menu-sep" />}
            {group === undefined ? (
              items
            ) : (
              <DropGroup labelClassName="new-menu-group-label" label={group}>
                {items}
              </DropGroup>
            )}
          </Fragment>
        );
      })}
    </DropMenu>
  );
}

/** The lines as runs: each group's lines together under its heading, a line outside every group in a run of its own kind. */
function runs(entries: readonly NewMenuEntry[]): Array<{ group?: string; lines: NewMenuEntry[] }> {
  const out: Array<{ group?: string; lines: NewMenuEntry[] }> = [];
  for (const entry of entries) {
    const last = out.at(-1);
    if (last && last.group === entry.group) last.lines.push(entry);
    else out.push({ ...(entry.group === undefined ? {} : { group: entry.group }), lines: [entry] });
  }
  /* Make before run: a line that opens a list's New form (it has a table) leads a line that runs a form's command. */
  for (const run of out) run.lines.sort((a, b) => Number(b.table !== undefined) - Number(a.table !== undefined));
  return out;
}

/** The menu over a served App, as the shell mounts it: this reader's lines, each opened where its New is. */
export function AppNewMenu({ app }: { app: Parameters<typeof appNewEntries>[0] & object }) {
  return <NewMenu entries={appNewEntries(app)} onOpen={(entry) => openNewEntry(app, entry)} />;
}
