/* A kit is refused in words before it draws anything, and a slot it leaves out draws as the platform's own. */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Button } from './Button.js';
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
});
