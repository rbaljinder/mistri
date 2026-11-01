/**
 * The header's ··· menu — in an App, its settings gear — over Base UI's Menu.
 *
 * The registry behind it is menu.js's: modules add their commands there,
 * the palette lists the same commands, and this draws them when the menu
 * opens — read at open, not at registration, so a detail that describes
 * current state ("credit_limit on customer 4") is the state now, and a
 * `checked` item reflects the toggle as it stands. Base UI owns what a
 * menu owes the keyboard — arrows, Home/End, typeahead, Escape back to the
 * trigger, outside click — and the roles and `aria-expanded` that go with
 * them. The open state is held here so the shell can be told about it.
 */
import { useRef, useState, useSyncExternalStore } from 'react';
import { Menu } from '@base-ui/react/menu';
import { detailOf, menuItems, menuMode, menuVersion, settingsInAccount, whenMenuChanges } from '../menu.js';
import { layoutViewport, zoomAnchor } from '@mistriwork/ui/internal/anchor.js';
import { Icon } from './Icon.js';
import { say } from '../copy/shell/components/OverflowMenu.js';
import { popupContainer } from '../shellHost.js';
import { useMessageLanguage } from './useMessageLanguage.js';

interface Item {
  label: string;
  onSelect: () => void;
  checked?: () => boolean;
  detail?: string | (() => string);
  group?: string;
  category?: string;
}

/** The registry's items, grouped by category, for whichever menu holds them (this one, or the account's). */
export function MenuRegistryItems() {
  useSyncExternalStore(whenMenuChanges, menuVersion, menuVersion);
  const items = menuItems() as Item[];
  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const category = item.category ?? say('tools');
    const entries = groups.get(category) ?? [];
    entries.push(item);
    groups.set(category, entries);
  }
  return (
    <>
      {[...groups].map(([category, entries]) => (
        <Menu.Group key={category}>
          {/* A heading that only repeats its one item ("Preferences" over "Preferences…") says nothing twice. */}
          {!(
            entries.length === 1 &&
            entries[0].label
              .replace(/[….]+$/, '')
              .trim()
              .toLowerCase() === category.trim().toLowerCase()
          ) && <Menu.GroupLabel className="more-group-label">{category}</Menu.GroupLabel>}
          {entries.map((item, i) => {
            const ticks = entries.some((entry) => entry.checked?.() != null);
            const checked = item.checked?.() ?? null;
            const body = (
              <>
                {/* A tick column when a sibling is a toggle, so labels line up; a run of plain items has none to indent them. */}
                {ticks && (
                  <span className="more-tick" aria-hidden="true">
                    {checked ? '✓' : ''}
                  </span>
                )}
                <span className="more-label">{item.label}</span>
                {detailOf(item) ? <span className="more-detail">{detailOf(item)}</span> : null}
              </>
            );
            return checked === null ? (
              <Menu.Item
                key={`${item.group ?? ''}|${item.label}|${i}`}
                className={ticks ? 'more-item' : 'more-item no-tick'}
                onClick={() => item.onSelect()}
              >
                {body}
              </Menu.Item>
            ) : (
              <Menu.CheckboxItem
                key={`${item.group ?? ''}|${item.label}|${i}`}
                className={checked ? 'more-item checked' : 'more-item'}
                checked={checked}
                closeOnClick
                onCheckedChange={() => item.onSelect()}
              >
                {body}
              </Menu.CheckboxItem>
            );
          })}
        </Menu.Group>
      ))}
    </>
  );
}

export function OverflowMenu() {
  const [open, setOpen] = useState(false);
  useSyncExternalStore(whenMenuChanges, menuVersion, menuVersion);
  /* Its label is said again when a visitor's language arrives with the App. */
  useMessageLanguage();
  const trigger = useRef<HTMLButtonElement>(null);
  /* In an App what the menu holds is the reader's settings — Preferences and the
     dark mode — so it wears the settings mark and
     says "Settings": an unlabelled "···" beside the account menu was a second
     menu nobody could tell from the first. Signed in, the settings are the
     account menu's (SignIn.tsx) and the gear goes: one menu at the bar's end,
     not two side by side. The Workbench's menu is its tools, and keeps "···". */
  const app = menuMode() === 'app';
  if (app && settingsInAccount()) return null;
  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger
        render={
          <button
            type="button"
            id="more-button"
            className={app ? 'icon-button more-settings' : 'icon-button'}
            title={app ? say('common.settings') : say('common.more')}
            aria-label={app ? say('common.settings') : say('common.more')}
            ref={trigger}
          />
        }
      >
        {app ? <Icon name="gear" className="more-settings-icon" /> : <span aria-hidden="true">···</span>}
      </Menu.Trigger>
      <Menu.Portal container={popupContainer()}>
        <Menu.Positioner
          anchor={() => (trigger.current ? zoomAnchor(trigger.current) : null)}
          positionMethod="fixed"
          side="bottom"
          align="end"
          sideOffset={6}
          collisionBoundary={layoutViewport()}
          collisionPadding={8}
          style={{ zIndex: 70 }}
        >
          <Menu.Popup className="more-list">
            <MenuRegistryItems />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
