/* The second word of every change callback: which hand moved the value, and Base UI's details in the same shape. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* The last hand is the module's own state, kept from load: each test loads it fresh, so no test hears another's press. */
let changeDetails: typeof import('./changeDetails.js').changeDetails;
let changeSource: typeof import('./changeDetails.js').changeSource;
let fromBaseUi: typeof import('./changeDetails.js').fromBaseUi;
let keptDetails: typeof import('./changeDetails.js').keptDetails;
beforeEach(async () => {
  vi.resetModules();
  ({ changeDetails, changeSource, fromBaseUi, keptDetails } = await import('./changeDetails.js'));
});
afterEach(() => vi.unstubAllGlobals());

describe('changeSource', () => {
  it('names the hand an event says it came from', () => {
    expect(changeSource(undefined)).toBe('program');
    expect(changeSource(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe('keyboard');
    expect(changeSource(new MouseEvent('click', { detail: 1 }))).toBe('pointer');
  });

  it('reads a click that counted no presses by the press before it: Enter or Space, or a synthetic pointer click', () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
    expect(changeSource(new MouseEvent('click', { detail: 0 }))).toBe('keyboard');
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(changeSource(new MouseEvent('click', { detail: 0 }))).toBe('pointer');
  });

  it('takes the last press on the page for an event that does not say', () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
    expect(changeSource(new Event('input'))).toBe('keyboard');
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(changeSource(new Event('input'))).toBe('pointer');
  });
});

describe('a change that carries an event, before any key or pointer press', () => {
  it('is never the page: one fallback, a pointer, for every way the hand cannot be read', () => {
    expect(changeSource(new Event('input'))).toBe('pointer');
    expect(changeSource(new Event('change'))).toBe('pointer');
    expect(changeSource(new MouseEvent('click', { detail: 0 }))).toBe('pointer');
    expect(keptDetails('toggle').source).toBe('pointer');
    expect(changeDetails('input-change', new Event('input')).source).toBe('pointer');
  });

  it('follows the last press once there is one, the same for all three', () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
    expect(changeSource(new Event('input'))).toBe('keyboard');
    expect(changeSource(new MouseEvent('click', { detail: 0 }))).toBe('keyboard');
    expect(keptDetails('toggle').source).toBe('keyboard');
  });
});

describe('loaded where there is no document (a server render)', () => {
  it('does not throw, and still answers', async () => {
    vi.stubGlobal('document', undefined);
    vi.resetModules();
    const server = await import('./changeDetails.js');
    expect(server.changeSource(undefined)).toBe('program');
    expect(server.changeSource(new Event('input'))).toBe('pointer');
  });
});

describe('changeDetails', () => {
  it("reads a React event's native event, and says the page made a change with no event", () => {
    const native = new KeyboardEvent('keydown');
    expect(changeDetails('select', { nativeEvent: native })).toEqual({ reason: 'select', source: 'keyboard', event: native });
    expect(changeDetails('select')).toEqual({ reason: 'select', source: 'program' });
  });
});

describe('fromBaseUi', () => {
  it("keeps Base UI's reason, and puts this primitive's word where Base UI says only none", () => {
    const press = new MouseEvent('click', { detail: 1 });
    expect(fromBaseUi({ reason: 'escape-key', event: press }, 'implicit')).toMatchObject({
      reason: 'escape-key',
      source: 'pointer',
      event: press,
    });
    expect(fromBaseUi({ reason: 'none', event: press }, 'toggle').reason).toBe('toggle');
    expect(fromBaseUi({ reason: 'none', event: press }, 'implicit').reason).toBe('implicit');
  });

  it("reads Base UI's stand-in event as the page's own change", () => {
    expect(fromBaseUi({ reason: 'imperative-action', event: new Event('base-ui') }, 'implicit')).toEqual({
      reason: 'imperative-action',
      source: 'program',
    });
  });
});

describe('keptDetails', () => {
  it("calls a kit's change a person's, by the last hand on the page, never the page's own", () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
    expect(keptDetails('toggle')).toEqual({ reason: 'toggle', source: 'keyboard' });
  });
});
