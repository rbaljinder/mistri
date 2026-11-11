/**
 * The slots a control kit may fill and the rules a kit is held to before it draws (UiKit.tsx, Preview), in a module
 * with no React and no primitive in it: an App's load and `mistri check` judge a kit with these on the server, where
 * an App's own typecheck follows the import and has no JSX to read a primitive's module with.
 */
/** Every slot a kit may fill, in the order the docs list them. */
export const SLOT_NAMES = [
  'Button',
  'ButtonLink',
  'TextField',
  'MaskedField',
  'MoneyField',
  'SensitiveField',
  'Select',
  'MultiSelect',
  'Dropdown',
  'MultiDropdown',
  'Typeahead',
  'DateField',
  'Checkbox',
  'YesNo',
  'ChoiceCards',
  'CheckCards',
  'Consent',
  'Switch',
  'Slider',
  'Modal',
  'Drawer',
  'Popover',
  'Tooltip',
  'DropMenu',
  'DropGroup',
  'DropItem',
  'DropSeparator',
  'Tabs',
  'Pagination',
  'Avatar',
] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

/* The parts that share one state of their own: a kit that drew a menu's items but not its menu would hand Base UI's
   items a menu they cannot find. */
const FAMILIES: ReadonlyArray<readonly SlotName[]> = [['DropMenu', 'DropGroup', 'DropItem', 'DropSeparator']];

const isSlot = (name: string): name is SlotName => (SLOT_NAMES as readonly string[]).includes(name);

/* The slot a misspelled name was meant to be: one letter's case, or two edits, away. */
function nearest(name: string): string | undefined {
  const lower = name.toLowerCase();
  return SLOT_NAMES.find((slot) => slot.toLowerCase() === lower) ?? SLOT_NAMES.find((slot) => edits(slot.toLowerCase(), lower) <= 2);
}
function edits(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/**
 * What is wrong with a value offered as a kit, each as the rest of a sentence that begins with the kit's name ("the
 * UI kit (./ui/kit.tsx) has no slot named …"); none for a kit. `mistri check` and an App's load say the same.
 */
export function uiKitProblems(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return ['has no default export made by defineUiKit: export default defineUiKit({ Button, … }).'];
  const problems: string[] = [];
  const names = Object.keys(value);
  for (const name of names) {
    if (!isSlot(name)) {
      const near = nearest(name);
      problems.push(`has no slot named "${name}"${near ? ` (did you mean "${near}"?)` : ''}; the slots are ${SLOT_NAMES.join(', ')}.`);
      continue;
    }
    const component = (value as Record<string, unknown>)[name];
    if (typeof component !== 'function' && !(component && typeof component === 'object'))
      problems.push(`gives "${name}" something that is not a component: a slot takes a function that draws it.`);
  }
  for (const family of FAMILIES) {
    const given = family.filter((name) => names.includes(name));
    if (given.length && given.length < family.length)
      problems.push(
        `draws ${given.join(', ')} but not ${family.filter((name) => !given.includes(name)).join(', ')}: a menu's parts share the menu's state, so a kit draws all ${family.length} or none.`,
      );
  }
  return problems;
}
