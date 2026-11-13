/**
 * The conformance suite a control kit is held to (Preview): what the platform's screens rely on from each slot,
 * written as checks a test runner calls. A kit's own test file runs it —
 *
 *     import { test } from 'vitest';
 *     import { uiKitConformance } from '@mistriwork/ui/conformance.js';
 *     import kit from './kit.js';
 *     uiKitConformance(kit, test);
 *
 * — in a DOM environment (happy-dom or jsdom). It imports no test library: the runner's `test` is handed in, a
 * failure is a thrown Error that says which slot broke which promise, and the events are dispatched by hand the way a
 * browser sends them, so a kit is judged by what a reader does rather than by how the kit is built.
 *
 * The roles are the contract, not the markup: a button is a `button`, a listbox lists `option`s, a menu `menuitem`s, a
 * dialog is a `dialog` named by its `ariaLabel`. Every check renders through the kit with `UiKitProvider`, so a slot the
 * kit leaves out is checked as the platform draws it; the default kit (`{}`) passes every check.
 */
import { act, createRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Avatar } from './Avatar.js';
import { Button, ButtonLink } from './Button.js';
import { CheckCards, Checkbox, ChoiceCards, Consent, YesNo } from './Choices.js';
import { DateField, type DateFieldWords } from './DateField.js';
import { Drawer } from './Drawer.js';
import { DropGroup, DropItem, DropMenu, DropSeparator } from './DropMenu.js';
import { Dropdown, MultiDropdown } from './Dropdown.js';
import { Modal, type ModalHandle } from './Modal.js';
import { Pagination } from './Pagination.js';
import { Popover } from './Popover.js';
import { MultiSelect, Select } from './Select.js';
import { SensitiveField } from './SensitiveField.js';
import { Slider } from './Slider.js';
import { Switch } from './Switch.js';
import { Tabs } from './Tabs.js';
import { MaskedField, MoneyField, TextField } from './TextField.js';
import { Tooltip } from './Tooltip.js';
import { Typeahead } from './Typeahead.js';
import { UiKitProvider, type UiKit } from './UiKit.js';
import type { ChangeDetails } from './changeDetails.js';
import { checkPatterns } from './conformancePatterns.js';
import { masks } from './masks.js';

export { checkPatterns, type CheckPatternsOptions } from './conformancePatterns.js';

/** The runner's `test` (Vitest's, Jest's, node:test's): a name and an async body. */
type ConformanceTest = (name: string, body: () => Promise<void>) => unknown;

/* ---- A browser's events, by hand ---- */

function fail(message: string): never {
  throw new Error(message);
}
function check(holds: unknown, message: string): asserts holds {
  if (!holds) fail(message);
}

const settle = (ms = 0) => act(() => new Promise<void>((done) => setTimeout(done, ms)));

/* Waits for something to appear (a popup is drawn after a frame or two), and says what never did. */
async function until<T>(find: () => T | null | undefined | false, what: string, timeout = 1500): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const found = find();
    if (found) return found;
    if (Date.now() > end) fail(what);
    await settle(10);
  }
}

function pointer(type: string, init: MouseEventInit): Event {
  return typeof PointerEvent === 'function'
    ? new PointerEvent(type, { pointerType: 'mouse', isPrimary: true, ...init })
    : new MouseEvent(type, init);
}

/* A press as a mouse makes one: the pointer and mouse events a press is made of, then the click. */
async function click(element: Element): Promise<void> {
  const init = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1 };
  await act(async () => {
    element.dispatchEvent(pointer('pointerdown', init));
    element.dispatchEvent(new MouseEvent('mousedown', init));
    if (element instanceof HTMLElement && element.tabIndex >= 0) element.focus();
    element.dispatchEvent(pointer('pointerup', { ...init, buttons: 0 }));
    element.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
    element.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
  });
  await settle();
}

/* A key on what has the focus; Enter and Space on a button activate it when nothing stopped them, as a browser does. */
async function press(key: string, target: Element | null = document.activeElement): Promise<void> {
  check(target, `nothing has the focus to press ${key} on`);
  const init = { key, bubbles: true, cancelable: true, composed: true };
  await act(async () => {
    const down = new KeyboardEvent('keydown', init);
    target.dispatchEvent(down);
    const activates = key === 'Enter' || key === ' ';
    if (activates && !down.defaultPrevented && target instanceof HTMLButtonElement && !target.disabled) target.click();
    target.dispatchEvent(new KeyboardEvent('keyup', init));
  });
  await settle();
}

/* Typing into a React-controlled box: the native setter, then the input event React listens for. */
async function type(input: HTMLInputElement | HTMLTextAreaElement, text: string): Promise<void> {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

/* The page as it stands, held to the ARIA patterns (conformancePatterns.ts), its keys pressed inside `act`. */
async function patterns(slot: string): Promise<void> {
  const problems = await checkPatterns(document.body, { act: (step) => act(step) });
  check(problems.length === 0, `${slot}: ${problems.join('; ')}`);
}

/* ---- Roles and names, read the way assistive technology reads them ---- */

const IMPLICIT: Record<string, string> = { BUTTON: 'button', TEXTAREA: 'textbox', SELECT: 'combobox', DIALOG: 'dialog', NAV: 'navigation' };
const INPUTS: Record<string, string> = { checkbox: 'checkbox', radio: 'radio', range: 'slider', button: 'button', submit: 'button' };

function roleOf(element: Element): string | undefined {
  const explicit = element.getAttribute('role');
  if (explicit) return explicit.split(' ')[0];
  if (element.tagName === 'A' && element.hasAttribute('href')) return 'link';
  if (element.tagName === 'INPUT') {
    const kind = (element.getAttribute('type') ?? 'text').toLowerCase();
    if (kind === 'hidden') return undefined;
    return INPUTS[kind] ?? (element.hasAttribute('list') ? 'combobox' : 'textbox');
  }
  return IMPLICIT[element.tagName];
}

const text = (element: Element | null | undefined) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();

function nameOf(element: Element): string {
  const label = element.getAttribute('aria-label');
  if (label) return label.trim();
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy)
    return labelledBy
      .split(/\s+/)
      .map((id) => text(document.getElementById(id)))
      .join(' ')
      .trim();
  if (element.id) {
    const forLabel = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
    if (forLabel) return text(forLabel);
  }
  const wrapping = element.closest('label');
  if (wrapping && wrapping !== element) return text(wrapping);
  if (element instanceof HTMLInputElement && element.type !== 'button') return element.title || element.placeholder || '';
  return text(element) || element.getAttribute('title') || '';
}

const hidden = (element: Element) => element.closest('[hidden], [aria-hidden="true"], [inert]') !== null;

function all(role: string, within: ParentNode = document.body): Element[] {
  return [...within.querySelectorAll('*')].filter((element) => roleOf(element) === role && !hidden(element));
}

/* The first element with the role whose name starts with `name` (a listbox's button says its label and its value). */
function find(role: string, name?: string, within: ParentNode = document.body): Element | undefined {
  return all(role, within).find((element) => name === undefined || nameOf(element).startsWith(name));
}

function get(role: string, name: string | undefined, slot: string, within?: ParentNode): Element {
  return find(role, name, within) ?? fail(`${slot}: no ${role}${name ? ` named "${name}"` : ''} is drawn`);
}

function showsText(words: string, slot: string, within: ParentNode = document.body): void {
  check((within as Element).textContent?.includes(words) ?? false, `${slot}: the words "${words}" it was given are not shown`);
}

/* ---- One check: draw it through the kit, run the body, take it down ---- */

interface Mounted {
  host: HTMLElement;
  rerender(node: ReactNode): Promise<void>;
}

function runner(kit: UiKit, test: ConformanceTest) {
  return (name: string, body: (mount: (node: ReactNode) => Promise<Mounted>) => Promise<void>) =>
    test(`UI kit conformance: ${name}`, async () => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const roots: Array<{ root: Root; host: HTMLElement }> = [];
      const mount = async (node: ReactNode): Promise<Mounted> => {
        const host = document.body.appendChild(document.createElement('div'));
        const root = createRoot(host);
        roots.push({ root, host });
        const draw = (n: ReactNode) => act(async () => root.render(<UiKitProvider kit={kit}>{n}</UiKitProvider>));
        await draw(node);
        await settle();
        return { host, rerender: draw };
      };
      try {
        await body(mount);
      } finally {
        for (const { root, host } of roots) {
          await act(async () => root.unmount());
          host.remove();
        }
        // A portal a kit forgot to take down would be read by the next check.
        document.body.replaceChildren();
      }
    });
}

/* Records what a callback was told. */
function heard<A extends unknown[]>() {
  const calls: A[] = [];
  const fn = (...args: A) => {
    calls.push(args);
  };
  return Object.assign(fn, { calls });
}

/* A change callback's details, where the kit gave them: a kit may leave them out (the seam fills them in), but what it
   gives must be the shape every caller reads, not an event or a word of its own in their place. */
function heardDetails(callback: { calls: unknown[][] }, at: number, what: string): void {
  for (const args of callback.calls) {
    const details = args[at] as Partial<ChangeDetails> | null | undefined;
    if (details === undefined) continue;
    check(
      typeof details === 'object' &&
        details !== null &&
        typeof details.reason === 'string' &&
        details.reason !== '' &&
        (details.source === 'pointer' || details.source === 'keyboard' || details.source === 'program') &&
        (details.event === undefined || details.event instanceof Event),
      `${what}: its second word is not change details, { reason, source, event? }`,
    );
  }
}

const DATE_WORDS: DateFieldWords = {
  dateTimePattern: 'YYYY-MM-DD HH:MM',
  enterDateAndTime: 'Enter a date and time.',
  enterDate: (format) => `Enter a date as ${format}.`,
  dateAndTimeFormat: 'Date and time format.',
  dateFormat: (format) => `Date format: ${format}.`,
  openWithKeys: 'Alt and Down arrow opens the calendar.',
  chooseDate: (label) => `Pick a day for ${label ?? 'it'}`,
  calendar: (label) => `Days of ${label ?? 'it'}`,
  previousMonth: 'Month before',
  nextMonth: 'Month after',
  clear: 'Empty it',
  today: 'This day',
};

const ITEMS = [
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' },
];

function Typed({
  pick,
  onText,
  empty,
}: {
  pick: (item: string) => void;
  onText?: (text: string, details?: ChangeDetails) => void;
  empty?: string;
}) {
  const [typed, setTyped] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <Typeahead
      text={typed}
      onText={(next, details) => {
        onText?.(next, details);
        setTyped(next);
        setOpen(true);
      }}
      items={['Alder', 'Birch'].filter((item) => item.toLowerCase().startsWith(typed.toLowerCase()))}
      itemKey={(item) => item}
      itemLabel={(item) => item}
      itemClassName={() => ''}
      renderItem={(item) => item}
      onPick={(item) => {
        pick(item);
        setTyped(item);
        setOpen(false);
      }}
      open={open}
      onOpenChange={setOpen}
      inputProps={{ 'aria-label': 'Tree' }}
      popupClassName="conformance-popup"
      listClassName="conformance-list"
      empty={empty}
    />
  );
}

function Menu({ run }: { run: (what: string) => void }) {
  return (
    <DropMenu label="Row actions">
      <DropGroup label="Change">
        <DropItem onClick={() => run('edit')}>Edit row</DropItem>
        <DropItem disabled onClick={() => run('lock')}>
          Lock row
        </DropItem>
      </DropGroup>
      <DropSeparator />
      <DropItem onClick={() => run('remove')}>Remove row</DropItem>
    </DropMenu>
  );
}

/**
 * Registers the conformance checks for `kit` with the runner's `test`. Each check names the slot and the promise it
 * holds the slot to; a slot the kit leaves out is checked as the platform draws it.
 */
export function uiKitConformance(kit: UiKit, test: ConformanceTest): void {
  const it = runner(kit, test);

  it('Button shows its words, is pressed, and refuses a press while disabled', async (mount) => {
    const pressed = heard();
    const { rerender } = await mount(<Button onClick={pressed}>Save changes</Button>);
    await click(get('button', 'Save changes', 'Button'));
    check(pressed.calls.length === 1, 'Button: a click did not reach onClick');
    await rerender(
      <Button onClick={pressed} disabled>
        Save changes
      </Button>,
    );
    await click(get('button', 'Save changes', 'Button'));
    check(pressed.calls.length === 1, 'Button: a disabled button still ran onClick');
  });

  it('ButtonLink is a link to its address with its words', async (mount) => {
    await mount(
      <ButtonLink href="/files/report.csv" intent="primary">
        Download report
      </ButtonLink>,
    );
    const link = get('link', 'Download report', 'ButtonLink');
    check(link.getAttribute('href') === '/files/report.csv', 'ButtonLink: the link does not go to its href');
  });

  it('TextField is named by its label, shows its value, reports what is typed, and is disabled when told', async (mount) => {
    const changed = heard<[string, ChangeDetails?]>();
    const { rerender } = await mount(<TextField label="Company" hint="As it is registered" value="Acme" onChange={changed} />);
    showsText('As it is registered', 'TextField');
    const box = get('textbox', 'Company', 'TextField') as HTMLInputElement;
    check(box.value === 'Acme', `TextField: the box shows "${box.value}", not its value "Acme"`);
    await type(box, 'Acme Ltd');
    check(changed.calls.at(-1)?.[0] === 'Acme Ltd', 'TextField: onChange was not told the typed value');
    heardDetails(changed, 1, 'TextField: onChange');
    await rerender(<TextField label="Company" value="Acme" onChange={changed} disabled />);
    check((get('textbox', 'Company', 'TextField') as HTMLInputElement).disabled, 'TextField: disabled did not disable the box');
  });

  it('MaskedField shows its value through the mask and reports the raw value', async (mount) => {
    const changed = heard<[string, ChangeDetails?]>();
    await mount(<MaskedField label="Phone" mask={masks.phone} value="5551234567" onChange={changed} />);
    const box = get('textbox', 'Phone', 'MaskedField') as HTMLInputElement;
    check(box.value === '555-123-4567', `MaskedField: the box shows "${box.value}", not the masked "555-123-4567"`);
    await type(box, '555-123-9');
    check(changed.calls.at(-1)?.[0] === '5551239', 'MaskedField: onChange was not told the raw value');
    heardDetails(changed, 1, 'MaskedField: onChange');
  });

  it('MoneyField and SensitiveField are named by their labels and say the words they are given', async (mount) => {
    await mount(
      <>
        <MoneyField label="Amount" value="1200" onChange={() => {}} />
        <SensitiveField
          label="Tax number"
          value="123456789"
          onChange={() => {}}
          mask={masks.ssn}
          showLabel="Reveal it"
          hideLabel="Hide it"
        />
      </>,
    );
    get('textbox', 'Amount', 'MoneyField');
    get('button', 'Reveal it', 'SensitiveField');
  });

  it('Checkbox and Consent are named by their labels, turn on when clicked, and are disabled when told', async (mount) => {
    const ticked = heard<[boolean, ChangeDetails?]>();
    const agreed = heard<[boolean, ChangeDetails?]>();
    const { rerender } = await mount(
      <>
        <Checkbox label="Send a copy" checked={false} onChange={ticked} />
        <Consent label="I agree to the terms" checked={false} onChange={agreed} />
      </>,
    );
    await click(get('checkbox', 'Send a copy', 'Checkbox'));
    check(ticked.calls.at(-1)?.[0] === true, 'Checkbox: a click on an unchecked box did not report true');
    await click(get('checkbox', 'I agree to the terms', 'Consent'));
    check(agreed.calls.at(-1)?.[0] === true, 'Consent: a click on an unchecked box did not report true');
    heardDetails(ticked, 1, 'Checkbox: onChange');
    heardDetails(agreed, 1, 'Consent: onChange');
    await rerender(<Checkbox label="Send a copy" checked onChange={ticked} disabled />);
    const box = get('checkbox', 'Send a copy', 'Checkbox') as HTMLInputElement;
    check(box.disabled || box.getAttribute('aria-disabled') === 'true', 'Checkbox: disabled did not disable the box');
  });

  it('YesNo, ChoiceCards and CheckCards say their words and report the pick', async (mount) => {
    const answered = heard<[string, ChangeDetails?]>();
    const chosen = heard<[string[], ChangeDetails?]>();
    const toggled = heard<[number, boolean, ChangeDetails?]>();
    await mount(
      <>
        <YesNo label="Is it urgent?" value="" onChange={answered} yes="Indeed" no="Not at all" />
        <ChoiceCards label="Size" options={ITEMS} value={[]} onChange={chosen} />
        <CheckCards
          cards={[
            { key: 'a', label: 'Email me', on: false },
            { key: 'b', label: 'Text me', on: false },
          ]}
          onToggle={toggled}
        />
      </>,
    );
    showsText('Is it urgent?', 'YesNo');
    await click(get('radio', 'Indeed', 'YesNo'));
    check(answered.calls.at(-1)?.[0] === 'yes', 'YesNo: picking the yes word did not report "yes"');
    await click(find('radio', 'High') ?? find('checkbox', 'High') ?? fail('ChoiceCards: no card named "High" is drawn'));
    check(chosen.calls.at(-1)?.[0]?.join() === 'high', 'ChoiceCards: picking a card did not report its value');
    await click(get('checkbox', 'Text me', 'CheckCards'));
    check(toggled.calls.at(-1)?.slice(0, 2).join() === '1,true', 'CheckCards: turning the second card on did not report (1, true)');
    heardDetails(answered, 1, 'YesNo: onChange');
    heardDetails(chosen, 1, 'ChoiceCards: onChange');
    heardDetails(toggled, 2, 'CheckCards: onToggle');
  });

  it('Switch is named by its label, turns on when clicked, and is disabled when told', async (mount) => {
    const switched = heard<[boolean, ChangeDetails?]>();
    const { rerender } = await mount(<Switch label="Notify the owner" checked={false} onCheckedChange={switched} />);
    await click(find('switch', 'Notify the owner') ?? get('checkbox', 'Notify the owner', 'Switch'));
    check(switched.calls.at(-1)?.[0] === true, 'Switch: a click on an off switch did not report true');
    heardDetails(switched, 1, 'Switch: onCheckedChange');
    await rerender(<Switch label="Notify the owner" checked={false} onCheckedChange={switched} disabled />);
    const control = find('switch', 'Notify the owner') ?? get('checkbox', 'Notify the owner', 'Switch');
    check(
      (control as HTMLButtonElement).disabled || control.getAttribute('aria-disabled') === 'true' || control.hasAttribute('data-disabled'),
      'Switch: disabled did not disable the switch',
    );
  });

  it('Slider is named by its label and shows its value', async (mount) => {
    await mount(<Slider label="Budget" value={40} onChange={() => {}} min={0} max={100} />);
    showsText('Budget', 'Slider');
    showsText('40', 'Slider');
  });

  it('Dropdown says its choice, opens from the keyboard, reports a pick, closes on Escape, and is disabled when told', async (mount) => {
    const changed = heard<[string, ChangeDetails?]>();
    const { rerender } = await mount(<Dropdown ariaLabel="Priority" items={ITEMS} value="low" onChange={changed} />);
    const trigger = get('button', 'Priority', 'Dropdown') as HTMLElement;
    showsText('Low', 'Dropdown', trigger);
    trigger.focus();
    await press('ArrowDown', trigger);
    const list = await until(() => find('listbox'), 'Dropdown: ArrowDown on the button did not open a listbox');
    check(all('option', list).map(text).join().includes('High'), 'Dropdown: the listbox does not list its items');
    await press('Escape', document.activeElement ?? list);
    await until(() => !find('listbox'), 'Dropdown: Escape did not close the listbox');
    await until(
      () => document.activeElement === get('button', 'Priority', 'Dropdown'),
      'Dropdown: Escape did not hand the focus back to its button',
    );
    await click(get('button', 'Priority', 'Dropdown'));
    const option = await until(() => find('option', 'High'), 'Dropdown: a click on the button did not list the options');
    await click(option);
    check(changed.calls.at(-1)?.[0] === 'high', 'Dropdown: picking an option did not report its value');
    heardDetails(changed, 1, 'Dropdown: onChange');
    await rerender(<Dropdown ariaLabel="Priority" items={ITEMS} value="low" onChange={changed} disabled />);
    const off = get('button', 'Priority', 'Dropdown') as HTMLButtonElement;
    check(off.disabled || off.getAttribute('aria-disabled') === 'true', 'Dropdown: disabled did not disable its button');
  });

  it('Select, MultiSelect and MultiDropdown are named and say their choices', async (mount) => {
    await mount(
      <>
        <Select label="Stage" options={ITEMS} value="high" onChange={() => {}} />
        <MultiSelect label="Tags" options={ITEMS} value={['low']} onChange={() => {}} />
        <MultiDropdown ariaLabel="Levels" items={ITEMS} value={['high']} onChange={() => {}} />
      </>,
    );
    showsText('Stage', 'Select');
    showsText('High', 'Select', get('button', 'Stage', 'Select'));
    showsText('Low', 'MultiSelect', get('button', 'Tags', 'MultiSelect'));
    showsText('High', 'MultiDropdown', get('button', 'Levels', 'MultiDropdown'));
  });

  it('Typeahead reports typing, lists matches, and picks the lit one with the keyboard', async (mount) => {
    const picked = heard<[string]>();
    const typed = heard<[string, ChangeDetails?]>();
    await mount(<Typed pick={picked} onText={typed} />);
    const box = get('combobox', 'Tree', 'Typeahead') as HTMLInputElement;
    await type(box, 'b');
    check(typed.calls.at(-1)?.[0] === 'b', 'Typeahead: onText was not told the typed text');
    heardDetails(typed, 1, 'Typeahead: onText');
    const list = await until(() => find('listbox'), 'Typeahead: typing did not open a list of matches');
    check(all('option', list).map(text).join() === 'Birch', 'Typeahead: the list does not show the matching item');
    await press('ArrowDown', box);
    await press('Enter', box);
    await until(() => picked.calls.at(-1)?.[0] === 'Birch', 'Typeahead: ArrowDown then Enter did not pick the lit item');
  });

  it('DateField shows its value, reports what is typed, names its calendar button with its words, and is disabled when told', async (mount) => {
    const changed = heard<[string, ChangeDetails?]>();
    const { rerender } = await mount(
      <DateField id="due" aria-label="Due" words={DATE_WORDS} calendarIcon={null} value="2026-03-14" onChange={changed} locale="en-US" />,
    );
    const box = get('textbox', 'Due', 'DateField') as HTMLInputElement;
    check(box.value.length > 0, 'DateField: the box does not show its value');
    await type(box, '2026-04-01');
    check(changed.calls.at(-1)?.[0] === '2026-04-01', 'DateField: onChange was not told the typed text');
    heardDetails(changed, 1, 'DateField: onChange');
    get('button', 'Pick a day for', 'DateField');
    await rerender(
      <DateField
        id="due"
        aria-label="Due"
        words={DATE_WORDS}
        calendarIcon={null}
        value="2026-03-14"
        onChange={changed}
        locale="en-US"
        disabled
      />,
    );
    check((get('textbox', 'Due', 'DateField') as HTMLInputElement).disabled, 'DateField: disabled did not disable the box');
  });

  it('Modal is a dialog named by ariaLabel; Escape and its handle close it once; the focus goes back', async (mount) => {
    const closed = heard();
    const handle = createRef<ModalHandle>();
    const { host } = await mount(<button type="button">Opener</button>);
    const opener = get('button', 'Opener', 'Modal', host) as HTMLButtonElement;
    opener.focus();
    const { rerender } = await mount(
      <Modal ariaLabel="Edit the row" onClose={closed} ref={handle}>
        <p>The row's fields</p>
        <button type="button">Inside</button>
      </Modal>,
    );
    const dialog = await until(() => find('dialog', 'Edit the row'), 'Modal: no dialog named by its ariaLabel is drawn');
    showsText("The row's fields", 'Modal', dialog);
    await until(() => dialog.contains(document.activeElement), 'Modal: the focus did not move into the dialog when it opened');
    await press('Escape', document.activeElement ?? dialog);
    check(closed.calls.length === 1, `Modal: Escape told onClose ${closed.calls.length} times, not once`);
    await rerender(null);
    await until(() => document.activeElement === opener, 'Modal: the focus did not go back to what had it before the dialog opened');

    const again = heard();
    await rerender(
      <Modal ariaLabel="Edit the row" onClose={again} ref={handle} beforeClose={() => false}>
        <button type="button">Inside</button>
      </Modal>,
    );
    await until(() => handle.current, 'Modal: ref was not given a handle');
    await act(async () => handle.current?.close());
    check(again.calls.length === 0, 'Modal: the handle closed it though beforeClose said no');
    const twice = heard();
    await rerender(
      <Modal ariaLabel="Edit the row" onClose={twice} ref={handle}>
        <button type="button">Inside</button>
      </Modal>,
    );
    await act(async () => {
      handle.current?.close();
      handle.current?.close();
    });
    await settle();
    check(twice.calls.length === 1, `Modal: closing by its handle twice told onClose ${twice.calls.length} times, not once`);
  });

  it('Drawer is a dialog with its title and its close word', async (mount) => {
    const changed = heard<[boolean]>();
    await mount(
      <Drawer open title="Filters" closeLabel="Put it away" onOpenChange={changed}>
        <p>Pick what to show</p>
      </Drawer>,
    );
    const dialog = await until(() => find('dialog'), 'Drawer: no dialog is drawn while open');
    showsText('Filters', 'Drawer', dialog);
    showsText('Pick what to show', 'Drawer', dialog);
    await click(get('button', 'Put it away', 'Drawer', dialog));
    check(changed.calls.at(-1)?.[0] === false, 'Drawer: its close button did not report onOpenChange(false)');
  });

  it('Popover and Tooltip draw their trigger, and an open popover its content', async (mount) => {
    await mount(
      <>
        <Popover trigger={<span>More about it</span>} open ariaLabel="Details">
          <p>The long story</p>
        </Popover>
        <Tooltip trigger={<span>Hover me</span>}>A short note</Tooltip>
      </>,
    );
    showsText('More about it', 'Popover');
    showsText('Hover me', 'Tooltip');
    await until(() => document.body.textContent?.includes('The long story'), 'Popover: an open popover does not show its content');
  });

  it('DropMenu opens from the keyboard, runs an item, skips a disabled one, and closes on Escape', async (mount) => {
    const ran = heard<[string]>();
    await mount(<Menu run={ran} />);
    const trigger = get('button', 'Row actions', 'DropMenu') as HTMLElement;
    trigger.focus();
    await press('ArrowDown', trigger);
    const menu = await until(() => find('menu'), 'DropMenu: ArrowDown on the trigger did not open a menu');
    check(all('menuitem', menu).map(text).join() === 'Edit row,Lock row,Remove row', 'DropMenu: the menu does not list its items in order');
    get('group', 'Change', 'DropGroup', menu);
    get('separator', undefined, 'DropSeparator', menu);
    const locked = get('menuitem', 'Lock row', 'DropItem', menu);
    check(
      locked.getAttribute('aria-disabled') === 'true' || (locked as HTMLButtonElement).disabled,
      'DropItem: a disabled item is not marked disabled',
    );
    await press('Escape', document.activeElement ?? menu);
    await until(() => !find('menu'), 'DropMenu: Escape did not close the menu');
    await until(
      () => document.activeElement === get('button', 'Row actions', 'DropMenu'),
      'DropMenu: Escape did not hand the focus back to the trigger',
    );
    await click(get('button', 'Row actions', 'DropMenu'));
    await click(await until(() => find('menuitem', 'Remove row'), 'DropMenu: a click on the trigger did not open the menu'));
    check(ran.calls.at(-1)?.[0] === 'remove', 'DropItem: clicking an item did not run it');
    await until(() => !find('menu'), 'DropMenu: running an item did not close the menu');
  });

  it("popups opened inside a dialog are drawn inside it, in the dialog's focus trap", async (mount) => {
    await mount(
      <div role="dialog" aria-label="Enclosing" data-conformance-dialog="">
        <Dropdown ariaLabel="Priority" items={ITEMS} value="low" onChange={() => {}} />
        <Menu run={() => {}} />
        <Typed pick={() => {}} />
      </div>,
    );
    const dialog = document.querySelector('[data-conformance-dialog]') ?? fail('the enclosing dialog is gone');
    await click(get('button', 'Priority', 'Dropdown', dialog));
    const list = await until(() => find('listbox'), 'Dropdown: a click did not open its listbox inside a dialog');
    check(dialog.contains(list), 'Dropdown: its listbox was drawn outside the dialog it was opened in');
    await press('Escape', document.activeElement ?? list);
    await until(() => !find('listbox'), 'Dropdown: Escape did not close the listbox');
    await click(get('button', 'Row actions', 'DropMenu', dialog));
    const menu = await until(() => find('menu'), 'DropMenu: a click did not open its menu inside a dialog');
    check(dialog.contains(menu), 'DropMenu: its menu was drawn outside the dialog it was opened in');
    await press('Escape', document.activeElement ?? menu);
    await until(() => !find('menu'), 'DropMenu: Escape did not close the menu');
    await type(get('combobox', 'Tree', 'Typeahead', dialog) as HTMLInputElement, 'a');
    const matches = await until(() => find('listbox'), 'Typeahead: typing did not open its list inside a dialog');
    check(dialog.contains(matches), 'Typeahead: its list was drawn outside the dialog it was opened in');
  });

  it('Tabs name their tabs, and choosing one reports it and shows its panel', async (mount) => {
    const chose = heard<[string, ChangeDetails?]>();
    await mount(
      <Tabs
        ariaLabel="Record sections"
        defaultValue="details"
        onValueChange={chose}
        tabs={[
          { value: 'details', label: 'Details', children: <p>The details panel</p> },
          { value: 'history', label: 'History', children: <p>The history panel</p> },
        ]}
      />,
    );
    get('tab', 'Details', 'Tabs');
    showsText('The details panel', 'Tabs');
    await click(get('tab', 'History', 'Tabs'));
    check(chose.calls.at(-1)?.[0] === 'history', 'Tabs: choosing a tab did not report its value');
    heardDetails(chose, 1, 'Tabs: onValueChange');
    await until(() => document.body.textContent?.includes('The history panel'), 'Tabs: the chosen tab does not show its panel');
  });

  it('Pagination says its words and reports the page asked for', async (mount) => {
    const went = heard<[number, ChangeDetails?]>();
    await mount(
      <Pagination page={2} pages={5} onPageChange={went} ariaLabel="Invoices, pages" words={{ previous: 'Earlier', next: 'Later' }} />,
    );
    get('navigation', 'Invoices, pages', 'Pagination');
    await click(get('button', 'Later', 'Pagination'));
    check(went.calls.at(-1)?.[0] === 3, 'Pagination: its next button did not ask for the next page');
    await click(get('button', 'Earlier', 'Pagination'));
    check(went.calls.at(-1)?.[0] === 1, 'Pagination: its previous button did not ask for the page before');
    heardDetails(went, 1, 'Pagination: onPageChange');
  });

  it('Avatar draws a picture or the initials of its name', async (mount) => {
    const { host } = await mount(<Avatar name="Ada Lovelace" />);
    check(
      host.textContent?.includes('AL') || host.querySelector('img, svg, [role="img"]'),
      'Avatar: neither initials nor a picture is drawn',
    );
  });

  it('an open Dropdown, DropMenu and Typeahead hold to their ARIA patterns', async (mount) => {
    const { rerender } = await mount(<Dropdown ariaLabel="Priority" items={ITEMS} value="low" onChange={() => {}} />);
    const trigger = get('button', 'Priority', 'Dropdown') as HTMLElement;
    trigger.focus();
    await press('ArrowDown', trigger);
    await until(() => find('listbox'), 'Dropdown: ArrowDown on the button did not open a listbox');
    await patterns('Dropdown');
    await rerender(<Menu run={() => {}} />);
    const opener = get('button', 'Row actions', 'DropMenu') as HTMLElement;
    opener.focus();
    await press('ArrowDown', opener);
    await until(() => find('menu'), 'DropMenu: ArrowDown on the trigger did not open a menu');
    await patterns('DropMenu');
    await rerender(<Typed pick={() => {}} />);
    await type(get('combobox', 'Tree', 'Typeahead') as HTMLInputElement, 'b');
    await until(() => find('listbox'), 'Typeahead: typing did not open a list of matches');
    await patterns('Typeahead');
    /* Nothing matches: the empty message is a status beside the list, never inside a listbox, and no listbox is left
       with no option to hold. */
    await rerender(<Typed pick={() => {}} empty="No tree by that name" />);
    await type(get('combobox', 'Tree', 'Typeahead') as HTMLInputElement, 'zz');
    await until(
      () => document.body.textContent?.includes('No tree by that name'),
      'Typeahead: a query that matches nothing did not show its empty message',
    );
    check(!find('listbox'), 'Typeahead: an empty list is drawn as a listbox with no option');
    await patterns('Typeahead, nothing matched');
  });

  it('Tabs, YesNo, ChoiceCards and Switch hold to their ARIA patterns', async (mount) => {
    await mount(
      <>
        <Tabs
          ariaLabel="Record sections"
          defaultValue="history"
          tabs={[
            { value: 'details', label: 'Details', children: <p>The details panel</p> },
            { value: 'history', label: 'History', children: <p>The history panel</p> },
            { value: 'files', label: 'Files', children: <p>The files panel</p> },
          ]}
        />
        <YesNo label="Billable" value="yes" onChange={() => {}} yes="Yes" no="No" />
        <ChoiceCards label="Size" options={ITEMS} value={['low']} onChange={() => {}} />
        <Switch label="Notify me" checked onCheckedChange={() => {}} />
      </>,
    );
    await patterns('Tabs, YesNo, ChoiceCards and Switch');
    check(find('tab', 'History')?.getAttribute('aria-selected') === 'true', 'checkPatterns: reading the tabs left another tab chosen');
  });

  it('an open Modal and Drawer hold to the dialog pattern', async (mount) => {
    const { rerender } = await mount(
      <Modal ariaLabel="Edit the row" onClose={() => {}}>
        <button type="button">Inside</button>
      </Modal>,
    );
    const dialog = await until(() => find('dialog', 'Edit the row'), 'Modal: no dialog named by its ariaLabel is drawn');
    await until(() => dialog.contains(document.activeElement), 'Modal: the focus did not move into the dialog when it opened');
    await patterns('Modal');
    await rerender(
      <Drawer open title="Filters" closeLabel="Put it away" onOpenChange={() => {}}>
        <p>Pick what to show</p>
      </Drawer>,
    );
    await until(() => find('dialog', 'Filters'), 'Drawer: no dialog named by its title is drawn while open');
    await patterns('Drawer');
  });
}
