/**
 * Photos one at a time, as large as the screen allows: the image fitted to
 * the viewport, Previous and Next, "3 of 8", the caption. The arrow keys
 * step, Escape closes (the house Modal's), a sideways swipe steps on touch,
 * and the neighbours are fetched ahead so a step shows a photo, not a wait.
 * Closing hands focus back to what opened it, and tells the opener which
 * photo was last in view.
 *
 * A step swaps a finished photo for a finished photo: nothing slides, since
 * stepping is the frequent gesture here. The box itself enters with the
 * popover's fade, and only where motion is welcome.
 */
import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import { Modal, type ModalHandle } from '@mistriwork/ui/Modal.js';
import { say } from '../copy/record/components/Lightbox.js';

export interface LightboxImage {
  src: string;
  alt: string;
  caption?: string;
}

interface LightboxProps {
  images: LightboxImage[];
  start: number;
  /** Told once, with the photo that was in view. */
  onClose: (index: number) => void;
  /** What the dialog is called: "Photos of 2021 Toyota Corolla". */
  label: string;
  finalFocus?: RefObject<HTMLElement | null>;
}

/** How far a finger travels sideways before it means "the next one". */
const SWIPE = 40;

export function Lightbox({ images, start, onClose, label, finalFocus }: LightboxProps) {
  const count = images.length;
  const [index, setIndex] = useState(() => Math.max(0, Math.min(start, count - 1)));
  const shown = useRef(index);
  shown.current = index;
  const modal = useRef<ModalHandle>(null);
  const closer = useRef<HTMLButtonElement>(null);
  const touch = useRef<{ x: number; y: number; id: number } | null>(null);
  const step = (by: number) => setIndex((current) => (current + by + count) % count);

  /* The photos either side, asked for now, so the next step is already here. */
  useEffect(() => {
    if (count < 2) return;
    for (const at of [index + 1, index - 1]) {
      const image = new Image();
      image.decoding = 'async';
      image.src = images[(at + count) % count].src;
    }
  }, [index, count, images]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse') touch.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const from = touch.current;
    touch.current = null;
    if (!from || from.id !== event.pointerId || count < 2) return;
    const dx = event.clientX - from.x;
    if (Math.abs(dx) >= SWIPE && Math.abs(dx) > Math.abs(event.clientY - from.y)) step(dx < 0 ? 1 : -1);
  };
  const photo = images[index];
  return (
    <Modal
      className="lightbox"
      plain
      ref={modal}
      aria-label={label}
      initialFocus={closer}
      onClose={() => onClose(shown.current)}
      {...(finalFocus ? { finalFocus } : {})}
    >
      <div
        className="lightbox-body"
        onKeyDown={(event) => {
          if (count < 2 || event.altKey || event.ctrlKey || event.metaKey) return;
          if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            event.preventDefault();
            step(event.key === 'ArrowRight' ? 1 : -1);
          }
        }}
      >
        <div className="lightbox-bar">
          <span className="lightbox-count" aria-live="polite">
            {index + 1} {say('of', { count })}
          </span>
          <button type="button" ref={closer} className="lightbox-close" onClick={() => modal.current?.close()}>
            {say('common.close')}
          </button>
        </div>
        <div
          className="lightbox-stage"
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            touch.current = null;
          }}
        >
          {count > 1 && (
            <button type="button" className="lightbox-step lightbox-prev" aria-label={say('previousPhoto')} onClick={() => step(-1)}>
              <svg viewBox="0 0 20 20" width="22" height="22" aria-hidden="true" focusable="false">
                <path
                  d="M12.5 4.5 7 10l5.5 5.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
          <figure className="lightbox-figure">
            <img className="lightbox-image" src={photo.src} alt={photo.alt} draggable={false} />
            {photo.caption && <figcaption className="lightbox-caption">{photo.caption}</figcaption>}
          </figure>
          {count > 1 && (
            <button type="button" className="lightbox-step lightbox-next" aria-label={say('nextPhoto')} onClick={() => step(1)}>
              <svg viewBox="0 0 20 20" width="22" height="22" aria-hidden="true" focusable="false">
                <path
                  d="M7.5 4.5 13 10l-5.5 5.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
