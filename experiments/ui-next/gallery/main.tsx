import './layers.css';
import '@fontsource-variable/inter';
import '@ui-sdk/core/web.css';
import '../src/style.css';
import './gallery.css';
/* The faces mistri's looks are set in (Barlow, Inter under its own name, IBM Plex Mono), from the kit. A rule costs
   nothing until a line is drawn in its family. */
import '../../../packages/kit/src/client/fonts/faces.css';
/* Puts on what the reader wore last, before the first draw. */
import { wornFaces } from './theming';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

/* The page is first drawn in its own face where that can be had at once. A face that arrives after the first
   draw re-wraps whatever fitted its line by a pixel, and what is under it moves; the library's stand-in face
   (theme/tokens.css) is measured to Inter's width but cannot match it string for string. So the two weights the
   first screen is set in are asked for, and the draw waits for them a moment and no longer: on a slow line the
   page is drawn in the stand-in and the face swaps in, as it would have. */
const draw = () =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
const faces = Promise.all(
  ['400 1em "Inter Variable"', '600 1em "Inter Variable"', ...wornFaces()].map((face) => document.fonts.load(face).catch(() => [])),
);
void Promise.race([faces, new Promise((settle) => window.setTimeout(settle, 400))]).then(draw, draw);
