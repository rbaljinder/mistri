/**
 * A related list of image files drawn as a gallery: one large lead photo
 * and a strip of thumbnails under it. A thumbnail chooses the lead; the lead
 * opens the lightbox at that photo, and closing it leaves the lead on the
 * photo the reader was last looking at. The strip is one tab stop, moved
 * with the arrow keys, Home and End — the house tab strip's gesture.
 *
 * With more than one photo the lead carries a previous and a next button, so
 * a pointer steps through the photos where they are, without opening the
 * lightbox. They are siblings of what opens it, not inside it: a button inside
 * a button is invalid, and each keeps its own name for a screen reader. The
 * photo is a frame, and what opens it a button over the frame that stops at the
 * steps' columns, so the three targets meet and never overlap: drawn as one
 * button under the steps, a phone's tap beside a step's edge opened the photo.
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import type { LightboxImage } from './Lightbox.js';
import { onDemand } from './onDemand.js';
import { Empty } from './Notes.js';
import { say } from '../copy/lists/components/Gallery.js';
import { imageSources, imageFallbackSet, MEDIA_IMAGE_SIZES } from '@mistriwork/engine/shared/imageWidths.js';

/* The lightbox draws its own dialog, fetched the first time a photo is opened. */
const Lightbox = onDemand(() => import('./Lightbox.js'), 'Lightbox', { quiet: true });

/** `thumb` is the strip's smaller copy of `src`, when the file resource keeps one. */
export interface GalleryItem extends LightboxImage {
  id: string;
  thumb?: string;
}

const STEPS: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };

function Chevron({ back }: { back?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        d={back ? 'M10 3.5L5.5 8l4.5 4.5' : 'M6 3.5l4.5 4.5L6 12.5'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Gallery({ items, label, emptyText }: { items: GalleryItem[]; label: string; emptyText: string }) {
  const [current, setCurrent] = useState(0);
  const [viewing, setViewing] = useState<number | null>(null);
  const lead = useRef<HTMLButtonElement>(null);
  const thumbs = useRef<Array<HTMLButtonElement | null>>([]);
  if (!items.length) return <Empty className="gallery-empty" text={emptyText} />;
  const at = Math.min(current, items.length - 1);
  const shown = items[at];
  const step = (by: number) => setCurrent((at + by + items.length) % items.length);
  const onThumbKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const move = STEPS[event.key];
    const to = move ? (index + move + items.length) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
    if (to < 0) return;
    event.preventDefault();
    setCurrent(to);
    thumbs.current[to]?.focus();
  };
  return (
    <div className="gallery" role="group" aria-label={label}>
      <div className="gallery-stage">
        <div className={`gallery-lead${items.length > 1 ? ' has-steps' : ''}`}>
          <picture>
            {imageSources(shown.src).map((source) => (
              <source key={source.type} type={source.type} srcSet={source.srcSet} sizes={MEDIA_IMAGE_SIZES} />
            ))}
            <img
              className="gallery-lead-image"
              src={shown.src}
              srcSet={imageFallbackSet(shown.src)}
              sizes={MEDIA_IMAGE_SIZES}
              alt=""
              decoding="async"
            />
          </picture>
          {items.length > 1 && (
            <span className="gallery-count" aria-hidden="true">
              {at + 1} / {items.length}
            </span>
          )}
          <button
            type="button"
            ref={lead}
            className="gallery-open"
            onClick={() => setViewing(at)}
            aria-label={`${say('viewPhotoLarger', { number: at + 1, total: items.length })}${shown.alt ? `: ${shown.alt}` : ''}`}
          />
        </div>
        {items.length > 1 && (
          <>
            <button type="button" className="gallery-step is-prev" aria-label={say('showThePreviousPhoto')} onClick={() => step(-1)}>
              <Chevron back />
            </button>
            <button type="button" className="gallery-step is-next" aria-label={say('showTheNextPhoto')} onClick={() => step(1)}>
              <Chevron />
            </button>
          </>
        )}
      </div>
      {shown.caption && <p className="gallery-caption">{shown.caption}</p>}
      {items.length > 1 && (
        <div className="gallery-strip" role="group" aria-label={say('chooseAPhoto')}>
          {items.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className="gallery-thumb"
              ref={(button) => {
                thumbs.current[index] = button;
              }}
              aria-label={`${say('photo', { number: index + 1, total: items.length })}${item.alt ? `: ${item.alt}` : ''}`}
              aria-current={index === at ? 'true' : undefined}
              tabIndex={index === at ? 0 : -1}
              onClick={() => setCurrent(index)}
              onKeyDown={(event) => onThumbKey(event, index)}
            >
              <img src={item.thumb ?? item.src} alt="" loading="lazy" decoding="async" />
            </button>
          ))}
        </div>
      )}
      {viewing !== null && (
        <Lightbox
          images={items}
          start={viewing}
          label={label}
          finalFocus={lead}
          onClose={(index) => {
            setCurrent(index);
            setViewing(null);
          }}
        />
      )}
    </div>
  );
}
