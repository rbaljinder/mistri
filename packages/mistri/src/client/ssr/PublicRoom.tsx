/**
 * A public room as a plain document, for the HTML the server sends a
 * signed-out visitor (server/http/publicPage.ts reads it): a list's cards,
 * each its record's link, title, figure, facts and lead photo; or a record's
 * photos, description and facts. Drawn only on the server. It sits in the
 * content pane, hidden like the rest of the page until the client has its
 * room complete (index.html's startup hold), which then replaces it whole —
 * so nothing a reader sees ever moves from one to the other. A crawler, a
 * link preview and a reader without scripts read it as it is.
 */
import type { PublicImage, PublicRoom as Room } from '../../shared/publicDocument.js';
import { CARD_IMAGE_SIZES, imageSources, imageFallbackSet, MEDIA_IMAGE_SIZES } from '@mistriwork/engine/shared/imageWidths.js';
import { say } from '../copy/lists/ssr/PublicRoom.js';

/* Lazy, every one: the document is hidden from a scripted reader until the
   room replaces it, so its pictures are for a crawler, which reads the
   addresses, and a reader without scripts, who scrolls to them. Eager, React
   would also ask the browser to preload each, ahead of the room's own. */
function Picture({ image, sizes }: { image: PublicImage; sizes: string }) {
  const srcSet = imageFallbackSet(image.src);
  /* Its true proportions and average colour, when known (server/http/publicPictures.ts): the room is held and the
     picture arrives into a patch of its own colour. */
  const room = image.width && image.height ? { width: image.width, height: image.height } : {};
  return (
    <picture>
      {imageSources(image.src).map((source) => (
        <source key={source.type} type={source.type} srcSet={source.srcSet} sizes={sizes} />
      ))}
      <img
        src={image.src}
        {...(srcSet ? { srcSet, sizes } : {})}
        {...room}
        {...(image.color ? { style: { backgroundColor: image.color } } : {})}
        alt={image.alt}
        decoding="async"
        loading="lazy"
      />
    </picture>
  );
}

export function PublicRoom({ room }: { room: Room }) {
  if (room.kind === 'list')
    return (
      <article className="public-document">
        <h1>{room.title}</h1>
        <ul aria-label={room.title}>
          {room.items.map((item) => (
            <li key={item.href}>
              <a href={item.href}>
                {item.image && <Picture image={item.image} sizes={CARD_IMAGE_SIZES} />}
                <h2>{item.title}</h2>
              </a>
              {item.value && <p>{item.value}</p>}
              {item.badge && <p>{item.badge}</p>}
              {item.facts.length > 0 && <p>{item.facts.map((fact) => fact.text).join(' · ')}</p>}
              {item.description && <p>{item.description}</p>}
            </li>
          ))}
        </ul>
      </article>
    );
  return (
    <article className="public-document">
      {room.up && (
        <nav aria-label={say('wayUp')}>
          <a href={room.up.href}>{room.up.label}</a>
        </nav>
      )}
      <h1>{room.title}</h1>
      {room.images.map((image, index) => (
        <Picture key={image.src} image={image} sizes={index ? '25vw' : MEDIA_IMAGE_SIZES} />
      ))}
      {room.description && <p>{room.description}</p>}
      {room.facts.length > 0 && (
        <dl>
          {room.facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.text}</dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}
