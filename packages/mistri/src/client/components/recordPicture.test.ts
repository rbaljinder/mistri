import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPicture, enterRecord, keepStill, showPicture, takePicture, takeStill } from './recordPicture.js';

function body(): HTMLElement {
  const element = document.createElement('div');
  element.className = 'peekpanel-body';
  element.id = 'record-body';
  element.innerHTML = '<label for="name-field">Name</label><input id="name-field"><button id="save">Save</button>';
  document.body.append(element);
  element.scrollTop = 40;
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("the record dialog's still", () => {
  it('copies the body without a single id, hidden from assistive technology, where the reader had scrolled', () => {
    const picture = takePicture(body())!;
    expect(picture.node.className).toBe('peekpanel-body');
    expect(picture.node.id).toBe('');
    expect(picture.node.querySelectorAll('[id]')).toHaveLength(0);
    expect(picture.node.getAttribute('aria-hidden')).toBe('true');
    expect(picture.scrollTop).toBe(body().scrollTop);
    expect(takePicture(null)).toBeNull();
  });

  it('is shown in an inert host, replacing any still before it, and cleared at once', () => {
    const host = document.createElement('div');
    document.body.append(host);
    expect(clearPicture(host)).toBe(false);
    showPicture(host, takePicture(body())!);
    showPicture(host, takePicture(body())!);
    expect(host.inert).toBe(true);
    expect(host.children).toHaveLength(1);
    expect(host.querySelector('button')?.textContent).toBe('Save');
    expect(clearPicture(host)).toBe(true);
    expect(host.childElementCount).toBe(0);
    expect(clearPicture(null)).toBe(false);
  });

  it('lets the next record fade in, unless the reader asked for less motion', () => {
    const element = body();
    const animate = vi.fn();
    Object.defineProperty(element, 'animate', { value: animate, configurable: true });
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query }));
    enterRecord(element);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.calls[0][0]).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query }));
    enterRecord(element);
    expect(animate).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('enters nothing under a theme whose pace is still, as under reduced motion, its 0ms read as no fade at all', () => {
    const element = body();
    const animate = vi.fn();
    Object.defineProperty(element, 'animate', { value: animate, configurable: true });
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query }));
    document.documentElement.dataset.lookMotion = 'still';
    enterRecord(element);
    expect(animate).not.toHaveBeenCalled();
    document.documentElement.dataset.lookMotion = 'brisk';
    enterRecord(element);
    expect(animate).toHaveBeenCalledTimes(1);
    delete document.documentElement.dataset.lookMotion;
    vi.unstubAllGlobals();
  });
});

describe("a split pane's still, kept across the remount", () => {
  it('passes once to the next pane of the same split, at the height it had', () => {
    const element = body();
    Object.defineProperty(element, 'offsetHeight', { value: 320, configurable: true });
    keepStill('issue\u0000inbox', element);
    const still = takeStill('issue\u0000inbox');
    expect(still?.height).toBe(320);
    expect(still?.picture.node.querySelector('button')?.textContent).toBe('Save');
    expect(takeStill('issue\u0000inbox')).toBeNull();
  });

  it('is not taken by another split, nor after its moment has passed', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    keepStill('issue\u0000inbox', body());
    expect(takeStill('comment\u0000updates')).toBeNull();
    keepStill('issue\u0000inbox', body());
    now.mockReturnValue(1_000 + 1_501);
    expect(takeStill('issue\u0000inbox')).toBeNull();
    keepStill('issue\u0000inbox', null);
    expect(takeStill('issue\u0000inbox')).toBeNull();
  });
});
