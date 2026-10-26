/* A screenshot on this site is drawn at column width, a fraction of the
   screen it shows. Each one becomes a button that opens it in a native
   <dialog>: showModal gives the backdrop, Escape and a focus trap for free,
   and closing hands focus back to the button. Without JavaScript the images
   stay plain images. */

/* The largest candidate in a srcset is the file as captured. */
function fullSource(image: HTMLImageElement) {
  let best = { url: image.currentSrc || image.src, width: image.naturalWidth || image.width };
  for (const candidate of image.srcset.split(',')) {
    const [url, descriptor] = candidate.trim().split(/\s+/);
    const width = Number.parseInt(descriptor ?? '', 10);
    if (url && descriptor?.endsWith('w') && width > best.width) best = { url, width };
  }
  return best;
}

export function enlargeImages() {
  /* A screen the home frames as a window is already drawn at the page's width. */
  const images = [...document.querySelectorAll<HTMLImageElement>('.sl-markdown-content img')].filter(
    (image) => !image.closest('a, button, .tw-window'),
  );
  if (images.length === 0) return;

  const dialog = document.createElement('dialog');
  dialog.className = 'tw-lightbox';
  dialog.innerHTML =
    '<button type="button" class="tw-lightbox-close" aria-label="Close">' +
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' +
    '</button><img alt="" decoding="async" />';
  const close = dialog.querySelector('button')!;
  const view = dialog.querySelector('img')!;
  document.body.append(dialog);

  let opener: HTMLElement | null = null;
  close.addEventListener('click', () => dialog.close());
  /* A tap anywhere but the picture closes it: the backdrop and the margin
     around the image are the dialog itself. */
  dialog.addEventListener('click', (event) => {
    if (event.target !== view) dialog.close();
  });
  dialog.addEventListener('close', () => {
    document.documentElement.classList.remove('tw-lightbox-open');
    opener?.focus();
    opener = null;
  });

  for (const image of images) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tw-zoom';
    button.setAttribute('aria-haspopup', 'dialog');
    /* The button's name is the image's alt text, which it contains. */
    image.replaceWith(button);
    button.append(image);
    button.addEventListener('click', () => {
      const { url, width } = fullSource(image);
      view.src = url;
      view.alt = image.alt;
      /* Screenshots are captured at twice their CSS size: shown no larger than
         the screen they were taken from, sharp on a retina display, and
         otherwise fitted to the window (the stylesheet's max-height). */
      view.style.maxWidth = `min(${Math.round(width / 2)}px, 100%)`;
      opener = button;
      document.documentElement.classList.add('tw-lightbox-open');
      dialog.showModal();
      close.focus();
    });
  }
}
