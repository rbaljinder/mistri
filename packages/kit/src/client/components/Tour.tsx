/**
 * A short walk around the interface, once: a ring on the control, a card
 * beside it, a scrim over everything else. The stops and the memory of
 * having seen it stay in `tour.js`; this is the card.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { trapFocus, viewportBox, viewportSize } from '../core.js';
import { say } from '../copy/shell/components/Tour.js';
import { addHostListener, removeHostListener, shellQuery } from '../shellHost.js';

export interface Stop {
  anchor: string | string[] | null;
  title: string;
  body: string;
  code?: string;
}

/** The first spelling of the anchor that is on screen at all; `undefined` when none is. */
export function anchorFor(anchor: Stop['anchor']): HTMLElement | null | undefined {
  if (!anchor) return null;
  for (const selector of [anchor].flat()) {
    const node = shellQuery<HTMLElement>(selector);
    if (!node) continue;
    // screen-px: only asks "is it drawn at all", never where.
    const box = node.getBoundingClientRect();
    /* Zero-sized covers `display: none`, a collapsed sidebar, and a button the toolbar has dropped at this width. */
    if (box.width > 0 && box.height > 0) return node;
  }
  return undefined;
}

export function Tour({ stops, onEnd }: { stops: Stop[]; onEnd: () => void }) {
  const [at, setAt] = useState(0);
  const scrim = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const stop = stops[at];
  const last = at === stops.length - 1;
  const go = (delta: number) => {
    const to = at + delta;
    if (to < 0) return;
    if (to >= stops.length) {
      onEnd();
      return;
    }
    setAt(to);
  };

  /* The scrim already blocks the mouse; without the trap the keyboard walked straight past it into the table underneath. */
  useEffect(() => {
    const release = trapFocus(card.current!) as (() => void) | undefined;
    return () => release?.();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onEnd();
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        go(1);
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        go(-1);
      }
    };
    addHostListener(document, 'keydown', onKey, true);
    return () => removeHostListener(document, 'keydown', onKey, true);
  });
  useEffect(() => {
    next.current?.focus();
  }, [at]);

  /* Put the ring on the anchor and the card beside it. Four sides, tried in
     order of preference, and the first that fits wins: beside is what a tall
     anchor wants, below is what a wide one wants, so both are offered and
     the geometry decides. Capturing scroll, because the thing that scrolls
     is a pane inside the page. */
  useLayoutEffect(() => {
    const place = () => {
      const cardNode = card.current;
      const ringNode = ring.current;
      const scrimNode = scrim.current;
      if (!cardNode || !ringNode || !scrimNode) return;
      const node = stop.anchor ? anchorFor(stop.anchor) : null;
      if (!node) {
        /* The anchorless stop, and the fallback if an anchor vanished mid-tour. Centred, with no ring, which is honest about pointing at nothing. */
        ringNode.hidden = true;
        scrimNode.classList.add('dim');
        cardNode.style.top = '50%';
        cardNode.style.left = '50%';
        cardNode.style.transform = 'translate(-50%, -50%)';
        return;
      }
      cardNode.style.transform = '';
      scrimNode.classList.remove('dim');
      const box = viewportBox(node);
      const pad = 6;
      ringNode.hidden = false;
      ringNode.style.top = `${box.top - pad}px`;
      ringNode.style.left = `${box.left - pad}px`;
      ringNode.style.width = `${box.width + pad * 2}px`;
      ringNode.style.height = `${box.height + pad * 2}px`;
      const gap = 14;
      const edge = 8;
      const size = viewportBox(cardNode);
      const { width: vw, height: vh } = viewportSize();
      const centreX = () => box.left + box.width / 2 - size.width / 2;
      const centreY = () => box.top + box.height / 2 - size.height / 2;
      const sides = [
        { fits: vh - box.bottom - gap >= size.height + edge, top: box.bottom + gap, left: centreX() },
        { fits: vw - box.right - gap >= size.width + edge, top: centreY(), left: box.right + gap },
        { fits: box.top - gap >= size.height + edge, top: box.top - gap - size.height, left: centreX() },
        { fits: box.left - gap >= size.width + edge, top: centreY(), left: box.left - gap - size.width },
      ];
      /* Nothing fits — centred is the least bad answer. */
      const chosen = sides.find((s) => s.fits) ?? { top: centreY(), left: centreX() };
      const clamp = (value: number, max: number) => Math.min(Math.max(edge, value), Math.max(edge, max - edge));
      cardNode.style.top = `${clamp(chosen.top, vh - size.height)}px`;
      cardNode.style.left = `${clamp(chosen.left, vw - size.width)}px`;
    };
    place();
    addHostListener(window, 'resize', place);
    addHostListener(window, 'scroll', place, true);
    return () => {
      removeHostListener(window, 'resize', place);
      removeHostListener(window, 'scroll', place, true);
    };
  }, [stop]);

  return (
    <>
      {/* A click outside ends it rather than advancing: advancing on a stray click is how someone loses the stop they were reading. */}
      <div ref={scrim} className="tour-scrim" onClick={onEnd} />
      <div ref={ring} className="tour-ring" aria-hidden="true" />
      <div ref={card} className="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title">
        <p className="tour-step">{say('tourStep', { step: at + 1, count: stops.length })}</p>
        <h2 id="tour-title" className="tour-title">
          {stop.title}
        </h2>
        {stop.code ? <code className="tour-code">{stop.code}</code> : null}
        <p className="tour-body">{stop.body}</p>
        <div className="tour-actions">
          {/* "Skip" while there is more; on the last stop "Done" already says it. */}
          <button type="button" className="ghost tour-skip" hidden={last} onClick={onEnd}>
            {say('skip')}
          </button>
          <button type="button" className="ghost" hidden={at === 0} onClick={() => go(-1)}>
            {say('common.back')}
          </button>
          <button ref={next} type="button" className="tour-next" onClick={() => (last ? onEnd() : go(1))}>
            {last ? say('common.done') : say('common.next')}
          </button>
        </div>
      </div>
    </>
  );
}
