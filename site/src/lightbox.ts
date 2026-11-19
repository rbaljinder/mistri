/* A screenshot on this site is drawn at column width, a fraction of the
   screen it shows. Each one becomes a button that opens it in a native
   <dialog>: showModal gives the backdrop, Escape and a focus trap for free,
   and closing hands focus back to the button. Inside, the picture zooms
   (wheel, trackpad or touch pinch, double-click, the toolbar, + - 0) and
   pans when zoomed (drag, arrows). Without JavaScript the images stay plain
   images. */

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
  const icon = (path: string) =>
    `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="${path}" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>`;
  dialog.innerHTML =
    `<button type="button" class="tw-lightbox-close" aria-label="Close">${icon('M6 6l12 12M18 6L6 18')}</button>` +
    '<img alt="" decoding="async" draggable="false" />' +
    '<div class="tw-lightbox-tools" role="toolbar" aria-label="Zoom">' +
    `<button type="button" data-zoom="out" aria-label="Zoom out">${icon('M6 12h12')}</button>` +
    '<button type="button" data-zoom="reset" class="tw-lightbox-level" aria-label="Fit to window">100%</button>' +
    `<button type="button" data-zoom="in" aria-label="Zoom in">${icon('M6 12h12M12 6v12')}</button>` +
    '</div>';
  const close = dialog.querySelector<HTMLButtonElement>('.tw-lightbox-close')!;
  const view = dialog.querySelector('img')!;
  const level = dialog.querySelector<HTMLButtonElement>('.tw-lightbox-level')!;
  document.body.append(dialog);

  /* Zoom is a transform on the fitted picture: scale 1 is the picture as it
     opened, and the offset moves its centre. Nothing is re-laid out while
     zooming, so a wheel or a pinch stays smooth on a large screenshot. */
  const MOST = 8;
  let scale = 1;
  let x = 0;
  let y = 0;
  /* A drag that moved the picture is not also a click that closes it. */
  let dragged = false;

  /* The offset is held so the picture never leaves an empty edge on a side
     it overflows, and stays centred on a side it does not. */
  function clamp() {
    const spareX = Math.max(0, (view.offsetWidth * scale - dialog.clientWidth) / 2 + 16);
    const spareY = Math.max(0, (view.offsetHeight * scale - dialog.clientHeight) / 2 + 16);
    x = Math.min(spareX, Math.max(-spareX, x));
    y = Math.min(spareY, Math.max(-spareY, y));
  }
  function draw() {
    clamp();
    view.style.transform = scale === 1 ? '' : `translate(${x}px, ${y}px) scale(${scale})`;
    dialog.classList.toggle('tw-lightbox-zoomed', scale > 1);
    level.textContent = `${Math.round(scale * 100)}%`;
  }
  /* Zoom to `next`, keeping the point under (px, py) where it is. */
  function zoomTo(next: number, px?: number, py?: number) {
    next = Math.min(MOST, Math.max(1, next));
    const box = view.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const ox = (px ?? cx) - cx;
    const oy = (py ?? cy) - cy;
    const ratio = next / scale;
    x += ox - ox * ratio;
    y += oy - oy * ratio;
    scale = next;
    if (scale === 1) x = y = 0;
    draw();
  }
  function reset() {
    scale = 1;
    x = y = 0;
    draw();
  }

  const pointers = new Map<number, { x: number; y: number }>();
  let settle: ReturnType<typeof setTimeout> | undefined;
  dialog.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      /* Wheel steps arrive many a second: drawn without the eased transition. */
      dialog.classList.add('tw-lightbox-dragging');
      clearTimeout(settle);
      settle = setTimeout(() => {
        if (pointers.size === 0) dialog.classList.remove('tw-lightbox-dragging');
      }, 150);
      /* A trackpad pinch arrives as a wheel with ctrlKey and small deltas; a
         mouse wheel as larger steps. Both scale by the same curve. */
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      zoomTo(scale * Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002)), event.clientX, event.clientY);
    },
    { passive: false },
  );
  /* A dblclick is a MouseEvent with no pointerType, and a phone fires one
     after the second tap the touch handler below already zoomed on; it would
     zoom straight back out. So it is ignored for a moment after a touch. */
  let touchedAt = -Infinity;
  view.addEventListener('dblclick', (event) => {
    if (event.timeStamp - touchedAt < 500) return;
    zoomTo(scale > 1 ? 1 : 2.5, event.clientX, event.clientY);
  });

  /* One pointer pans a zoomed picture; two pinch it. The dialog listens, not
     the picture, so a second finger landing beside a small picture still
     pinches. The buttons keep their own taps. */
  let pinch = 0;
  let lastTap = 0;
  let onPicture = false;
  dialog.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return;
    /* No pointer capture: it would retarget the following click to the
       dialog, and a click on the dialog closes it. The dialog fills the
       window, so the pointer cannot leave it anyway. */
    onPicture = event.target === view;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    dragged = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
    dialog.classList.add('tw-lightbox-dragging');
  });
  dialog.addEventListener('pointermove', (event) => {
    const last = pointers.get(event.pointerId);
    if (!last) return;
    const now = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, now);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const span = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch > 0) zoomTo((scale * span) / pinch, (a.x + b.x) / 2, (a.y + b.y) / 2);
      pinch = span;
      dragged = true;
    } else if (scale > 1 && (now.x !== last.x || now.y !== last.y)) {
      x += now.x - last.x;
      y += now.y - last.y;
      dragged = true;
      draw();
    }
  });
  const release = (event: PointerEvent) => {
    if (!pointers.delete(event.pointerId)) return;
    pinch = 0;
    if (pointers.size === 0) dialog.classList.remove('tw-lightbox-dragging');
    if (event.pointerType === 'touch') touchedAt = event.timeStamp;
    /* Touch has no reliable dblclick: two quick taps on the picture zoom. */
    if (event.type === 'pointerup' && event.pointerType === 'touch' && !dragged && onPicture) {
      if (event.timeStamp - lastTap < 300) {
        lastTap = 0;
        zoomTo(scale > 1 ? 1 : 2.5, event.clientX, event.clientY);
      } else lastTap = event.timeStamp;
    }
  };
  dialog.addEventListener('pointerup', release);
  dialog.addEventListener('pointercancel', release);

  dialog.querySelector('.tw-lightbox-tools')!.addEventListener('click', (event) => {
    const which = (event.target as Element).closest<HTMLElement>('[data-zoom]')?.dataset.zoom;
    if (which === 'in') zoomTo(scale * 1.5);
    else if (which === 'out') zoomTo(scale / 1.5);
    else if (which === 'reset') reset();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const step = 48;
    const keys: Record<string, () => void> = {
      '+': () => zoomTo(scale * 1.5),
      '=': () => zoomTo(scale * 1.5),
      '-': () => zoomTo(scale / 1.5),
      '0': reset,
      ArrowLeft: () => ((x += step), draw()),
      ArrowRight: () => ((x -= step), draw()),
      ArrowUp: () => ((y += step), draw()),
      ArrowDown: () => ((y -= step), draw()),
    };
    const run = keys[event.key];
    /* Arrows pan only a zoomed picture; at fit they are left to the page. */
    if (!run || (event.key.startsWith('Arrow') && scale === 1)) return;
    event.preventDefault();
    run();
  });

  let opener: HTMLElement | null = null;
  close.addEventListener('click', () => dialog.close());
  /* A tap on the backdrop or the margin around the picture closes it: those
     are the dialog itself. A zoomed picture steps back to fit first, so a
     stray tap while panning does not throw the view away. */
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    if (dragged) dragged = false;
    else if (scale > 1) reset();
    else dialog.close();
  });
  dialog.addEventListener('close', () => {
    document.documentElement.classList.remove('tw-lightbox-open');
    reset();
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
