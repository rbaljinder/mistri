/* A carried copy is drawn on the page's top layer, outside the thing it was lifted from and outside whatever that
   thing is in. A host that keeps a page's styles to the page (mistri scopes a page's sheet to the page's own
   element) leaves the copy bare there: a card's name turns into a blue link and its parts fall into a heap. So
   what each part looks like is written onto its copy as the copy leaves. UI SDK does this for the copy itself, for
   the few properties a box has; these are the ones a layout adds, and everything for the parts inside. A
   pseudo-element cannot be written this way and is missing from the copy. */
const BOX = ['display', 'grid-template-columns', 'row-gap', 'column-gap', 'align-items', 'color', 'font-family', 'font-size'];

export function dress(from: Element, to: Element, whole = false): void {
  if (to instanceof HTMLElement || to instanceof SVGElement) {
    const computed = getComputedStyle(from);
    for (const name of whole ? computed : BOX) to.style.setProperty(name, computed.getPropertyValue(name));
  }
  for (let at = 0; at < from.children.length; at += 1) {
    const child = to.children[at];
    if (child) dress(from.children[at]!, child, true);
  }
}

/* How much the page around an element is zoomed: what it measures on the screen over what it is laid out at. A
   host may zoom its root (mistri does, for density: 1.12 at its default), and under a zoom a pointer's pixels and
   the stylesheet's are not the same pixels, which every drag has to answer for. */
export function zoomOf(el: HTMLElement): number {
  const laid = el.offsetWidth;
  const zoom = laid ? el.getBoundingClientRect().width / laid : 1;
  return Math.abs(zoom - 1) < 0.005 ? 1 : zoom;
}

/* Puts a carried copy right under a zoom. UI SDK places the copy and moves it in the screen's pixels, and the copy
   stands inside the zoomed page, so it is drawn larger than what it copies by the zoom and runs ahead of the
   pointer by the zoom: at mistri's widest density a card stood a hand's width from the pointer carrying it. The
   copy is therefore taken back out of the zoom (so the place and the size UI SDK gave it are true), and what it
   holds is put in a box that is zoomed again and wears the source's own look, so the card is the size it was. */
function unzoom(source: HTMLElement, copy: HTMLElement): void {
  const zoom = zoomOf(source);
  if (zoom === 1) return;
  const inner = source.ownerDocument.createElement('div');
  const look = getComputedStyle(source);
  for (const name of look) inner.style.setProperty(name, look.getPropertyValue(name));
  Object.assign(inner.style, {
    position: 'static',
    boxSizing: 'border-box',
    width: `${source.offsetWidth}px`,
    height: `${source.offsetHeight}px`,
    margin: '0',
    translate: 'none',
    rotate: 'none',
    transform: 'none',
    opacity: '1',
    zoom: String(zoom),
  });
  while (copy.firstChild) inner.append(copy.firstChild);
  copy.append(inner);
  Object.assign(copy.style, {
    display: 'block',
    padding: '0',
    border: '0',
    background: 'none',
    borderRadius: `${parseFloat(look.borderTopLeftRadius) * zoom}px`,
    zoom: String(1 / zoom),
  });
}

/* Dresses the copy UI SDK's own drags make (`createReorder` with a preview, `createTransfer`), which appears on the
   body some pixels after the press. Watches from the press until the pointer lifts, and returns the way to stop. */
export function dressCopyOf(source: HTMLElement): () => void {
  const page = source.ownerDocument;
  const seen = new MutationObserver((changes) => {
    for (const change of changes)
      for (const added of change.addedNodes)
        if (added instanceof HTMLElement && added.hasAttribute('data-drag-preview')) {
          dress(source, added);
          unzoom(source, added);
        }
  });
  const stop = () => {
    seen.disconnect();
    page.removeEventListener('pointerup', stop, true);
    page.removeEventListener('pointercancel', stop, true);
  };
  seen.observe(page.body, { childList: true });
  page.addEventListener('pointerup', stop, true);
  page.addEventListener('pointercancel', stop, true);
  return stop;
}
