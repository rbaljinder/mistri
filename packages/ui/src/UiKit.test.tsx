/* A kit is refused in words before it draws anything, and a slot it leaves out draws as the platform's own. */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Button } from './Button.js';
import { Switch } from './Switch.js';
import { SLOT_NAMES, UiKitProvider, defaultUiKit, defineUiKit, installUiKit, uiKitProblems } from './UiKit.js';

const Plain = (props: { children?: React.ReactNode }) => <button data-kit="button">{props.children}</button>;

function draw(node: React.ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  act(() => createRoot(host).render(node));
  return host;
}

afterEach(() => {
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
    expect(() => defineUiKit({ Carousel: Plain } as never)).toThrow(/no slot named "Carousel"; the slots are Button, ButtonLink/);
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

  it('draws the default where no kit is given', () => {
    const host = draw(<Button>Save</Button>);
    expect(host.querySelector('button.btn')?.textContent).toBe('Save');
  });

  it("draws a provider's kit with the same props", () => {
    const host = draw(
      <UiKitProvider kit={{ Button: Plain }}>
        <Button>Save</Button>
      </UiKitProvider>,
    );
    expect(host.querySelector('[data-kit="button"]')?.textContent).toBe('Save');
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

  it("gives a hand to details a kit passed that name none, keeping Base UI's cancel live and never a raw none", () => {
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
