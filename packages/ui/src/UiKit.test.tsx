/* A kit is refused in words before it draws anything, and a slot it leaves out draws as the platform's own. */
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Button } from './Button.js';
import { Switch } from './Switch.js';
import * as everything from './index.js';
import { Modal } from './Modal.js';
import {
  SLOT_NAMES,
  UiKitProvider,
  defaultUiKit,
  defineUiKit,
  dress,
  extendUiKit,
  installUiKit,
  uiKitProblems,
  useComponentScope,
  usePopupHost,
} from './UiKit.js';
import { ComponentStyleScope } from './internal/ComponentStyleScope.js';

const Plain = (props: { children?: React.ReactNode }) => <button data-kit="button">{props.children}</button>;

const roots: Array<ReturnType<typeof createRoot>> = [];
function draw(node: React.ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return host;
}

afterEach(() => {
  // Taken down, not only taken out of the page: a dialog still mounted keeps the page behind it from a press.
  for (const root of roots.splice(0)) act(() => root.unmount());
  installUiKit(undefined);
  document.body.replaceChildren();
});

describe('defineUiKit', () => {
  it('returns a frozen copy of a kit it accepts', () => {
    const kit = defineUiKit({ Button: Plain });
    expect(kit.Button).toBe(Plain);
    expect(Object.isFrozen(kit)).toBe(true);
  });

  it('refuses a slot it does not have, naming the nearest one', () => {
    expect(() => defineUiKit({ button: Plain } as never)).toThrow(/no slot named "button" \(did you mean "Button"\?\)/);
    expect(() => defineUiKit({ Buton: Plain } as never)).toThrow(/did you mean "Button"/);
    expect(() => defineUiKit({ Sparkline: Plain } as never)).toThrow(/no slot named "Sparkline"; the slots are Button, ButtonLink/);
  });

  it('refuses a slot given something that is not a component', () => {
    expect(uiKitProblems({ Button: 'button' })).toEqual([
      'gives "Button" something that is not a component: a slot takes a function that draws it.',
    ]);
  });

  it("refuses part of a menu's family", () => {
    const [problem] = uiKitProblems({ DropMenu: Plain, DropItem: Plain });
    expect(problem).toMatch(/draws DropMenu, DropItem but not DropGroup, DropSeparator/);
  });

  it('says a value that is not a kit at all is missing its export', () => {
    for (const value of [undefined, null, 'kit', [Plain]]) expect(uiKitProblems(value)[0]).toMatch(/no default export made by defineUiKit/);
  });
});

describe('the seam', () => {
  it('lists every slot once, each with its default drawing', () => {
    expect(new Set(SLOT_NAMES).size).toBe(SLOT_NAMES.length);
    expect(Object.keys(defaultUiKit)).toContain('Button');
  });

  /* A component the package hands out and a kit cannot reach is one a design system has to live with: the seam is
     every drawing, so a name added to the index without a slot fails here until it has one. */
  it('has a slot for every component the package draws, and a default for every slot', () => {
    // The whole package is loaded (the import above), so every slotted module has filled its default.
    expect(SLOT_NAMES.filter((name) => typeof defaultUiKit[name] !== 'function')).toEqual([]);
    const NOT_DRAWN_BY_A_KIT = ['Icon', 'UiKitProvider', 'ComponentStyleScope', 'InCardContext', 'UiSurfaceSeamContext'];
    const components = Object.entries(everything)
      .filter(([name, value]) => /^[A-Z][a-z]/.test(name) && typeof value === 'function' && !NOT_DRAWN_BY_A_KIT.includes(name))
      .map(([name]) => name);
    expect(components.filter((name) => !(SLOT_NAMES as readonly string[]).includes(name))).toEqual([]);
  });

  it('draws the default where no kit is given', () => {
    const host = draw(<Button>Save</Button>);
    expect(host.querySelector('button[data-slot="button"]')?.textContent).toBe('Save');
  });

  it("draws a provider's kit with the same props", () => {
    const host = draw(
      <UiKitProvider kit={{ Button: Plain }}>
        <Button>Save</Button>
      </UiKitProvider>,
    );
    expect(host.querySelector('[data-kit="button"]')?.textContent).toBe('Save');
  });

  it('layers a provider over the kit around it, and draws with its kit alone when asked', () => {
    const Toggle = () => <i data-kit="switch" />;
    installUiKit({ Switch: Toggle });
    const inside = (alone: boolean) =>
      draw(
        <UiKitProvider kit={{ Button: Plain }} alone={alone}>
          <Button>Save</Button>
          <Switch />
        </UiKitProvider>,
      );
    // The provider says nothing of the switch, so the installed kit still draws it.
    const layered = inside(false);
    expect(layered.querySelector('[data-kit="button"]')).not.toBeNull();
    expect(layered.querySelector('[data-kit="switch"]')).not.toBeNull();
    const alone = inside(true);
    expect(alone.querySelector('[data-kit="button"]')).not.toBeNull();
    expect(alone.querySelector('[data-kit="switch"]')).toBeNull();
    expect(alone.querySelector('[role="switch"]')).not.toBeNull();
    // A provider inside a provider: the inner one's slot, the outer one's for the rest.
    const Inner = () => <b data-kit="inner" />;
    const nested = draw(
      <UiKitProvider kit={{ Button: Plain }}>
        <UiKitProvider kit={{ Switch: Inner }}>
          <Button>Save</Button>
          <Switch />
        </UiKitProvider>
      </UiKitProvider>,
    );
    expect(nested.querySelector('[data-kit="button"]')).not.toBeNull();
    expect(nested.querySelector('[data-kit="inner"]')).not.toBeNull();
  });

  it('dresses a default: the platform’s own control, handed to the kit with the props it was drawn with', () => {
    const kit = defineUiKit({ Button: dress('Button', (Default, props) => <Default {...props} data-dressed="" size="lg" />) });
    const host = draw(
      <UiKitProvider kit={kit}>
        <Button variant="primary">Save</Button>
      </UiKitProvider>,
    );
    const button = host.querySelector('button')!;
    expect(button.textContent).toBe('Save');
    expect(button.hasAttribute('data-dressed')).toBe(true);
    // The default itself, not the slot again: a dressed slot that drew the slot would never end.
    expect(host.querySelectorAll('button')).toHaveLength(1);
  });

  it('makes one kit of several, a later one over an earlier, and holds the result to a kit’s rules', () => {
    const Other = () => <i />;
    const kit = extendUiKit({ Button: Plain, Switch: Other }, { Button: Other });
    expect(kit.Button).toBe(Other);
    expect(kit.Switch).toBe(Other);
    expect(Object.isFrozen(kit)).toBe(true);
    expect(() => extendUiKit({ Button: Plain }, { DropMenu: Plain } as never)).toThrow(/draws DropMenu but not/);
  });

  it('tells a kit where its own popup goes and under whose name', () => {
    const seen: { host?: HTMLElement; scope?: string } = {};
    /* A kit's control as it is written: a ref on its own trigger, read once the trigger is in the page. */
    const Probe = () => {
      const trigger = useRef<HTMLSpanElement>(null);
      seen.host = usePopupHost(trigger);
      seen.scope = useComponentScope();
      return <span ref={trigger} />;
    };
    draw(
      <ComponentStyleScope.Provider value="release-editor">
        <Modal ariaLabel="Edit" onClose={() => {}}>
          <Probe />
        </Modal>
      </ComponentStyleScope.Provider>,
    );
    // Read after the effect that looks for the dialog: the probe draws again once it is found.
    expect(seen.scope).toBe('release-editor');
    expect(seen.host?.getAttribute('role') ?? seen.host?.tagName.toLowerCase()).toMatch(/dialog/);
  });

  it('draws an installed kit with no provider, and the default again once it is taken away', () => {
    installUiKit({ Button: Plain });
    expect(draw(<Button>Save</Button>).querySelector('[data-kit="button"]')).not.toBeNull();
    installUiKit(undefined);
    expect(draw(<Button>Save</Button>).querySelector('[data-kit="button"]')).toBeNull();
  });

  it("fills a change's details a kit left out, as a person's change, and passes on the ones it gave", () => {
    const heard: unknown[][] = [];
    const Bare = (props: { checked?: boolean; onCheckedChange?: (checked: boolean) => void }) => (
      <button data-kit="switch" onClick={() => props.onCheckedChange?.(!props.checked)} />
    );
    const host = draw(
      <UiKitProvider kit={{ Switch: Bare }}>
        <Switch checked={false} onCheckedChange={(...args) => heard.push(args)} />
      </UiKitProvider>,
    );
    const press = host.querySelector<HTMLButtonElement>('[data-kit="switch"]')!;
    act(() => {
      press.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      press.click();
    });
    expect(heard).toEqual([[true, { reason: 'toggle', source: 'pointer' }]]);

    const given = { reason: 'toggle' as const, source: 'keyboard' as const };
    const Full = (props: { onCheckedChange?: (checked: boolean, details: typeof given) => void }) => (
      <button data-kit="full" onClick={() => props.onCheckedChange?.(true, given)} />
    );
    const again = draw(
      <UiKitProvider kit={{ Switch: Full }}>
        <Switch onCheckedChange={(...args) => heard.push(args)} />
      </UiKitProvider>,
    );
    act(() => again.querySelector<HTMLButtonElement>('[data-kit="full"]')!.click());
    expect(heard[1]?.[1]).toBe(given);
  });
  it("keeps a kit's change callback one function across renders, and calls the caller's latest", () => {
    const seen: unknown[] = [];
    const Capture = (props: { onCheckedChange?: (checked: boolean) => void }) => {
      seen.push(props.onCheckedChange);
      return <button data-kit="capture" onClick={() => props.onCheckedChange?.(true)} />;
    };
    const first: unknown[][] = [];
    const second: unknown[][] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const view = (heard: unknown[][]) => (
      <UiKitProvider kit={{ Switch: Capture }}>
        <Switch onCheckedChange={(...args) => heard.push(args)} />
      </UiKitProvider>
    );
    act(() => root.render(view(first)));
    act(() => root.render(view(second)));
    expect(seen.length).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(1);
    act(() => host.querySelector<HTMLButtonElement>('[data-kit="capture"]')!.click());
    expect(first).toEqual([]);
    expect(second).toHaveLength(1);
  });

  it("gives a hand to details a kit passed that name none, keeping a Base UI kit's cancel live and never a raw none", () => {
    const heard: unknown[][] = [];
    let canceled = false;
    const raw = {
      reason: 'none',
      event: new Event('base-ui'),
      cancel: () => (canceled = true),
      get isCanceled() {
        return canceled;
      },
    };
    const Pass = (props: { onCheckedChange?: (checked: boolean, details: unknown) => void }) => (
      <button data-kit="pass" onClick={() => props.onCheckedChange?.(true, raw)} />
    );
    const host = draw(
      <UiKitProvider kit={{ Switch: Pass as never }}>
        <Switch onCheckedChange={(...args) => heard.push(args)} />
      </UiKitProvider>,
    );
    act(() => host.querySelector<HTMLButtonElement>('[data-kit="pass"]')!.click());
    const details = heard[0]?.[1] as typeof raw & { source: string };
    expect(details).toMatchObject({ reason: 'toggle', source: 'program' });
    details.cancel();
    expect(details.isCanceled).toBe(true);
  });
});
