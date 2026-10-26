/**
 * The schema, taken out of tablewalk.
 *
 * A diagram you can only look at inside the tool is a diagram that never
 * reaches the design review, the pull request, or the person who asked what
 * this database looks like. The whole point of drawing it is to be able to
 * hand it to someone.
 *
 * Four formats, because they answer four different questions:
 *
 *   - **SVG** for the picture, at any size, still readable when someone zooms
 *     into the corner of it.
 *   - **PNG** for the places that will not take an SVG — a chat message, a
 *     slide, an issue comment.
 *   - **Mermaid** for a repository. GitHub renders it inline, so an ER diagram
 *     in a README stays a diagram and, more importantly, diffs as text when
 *     the schema changes.
 *   - **Markdown** and **JSON** for reading and for feeding to something else.
 *
 * All of them export *what is selected*. The diagram's focus filter already
 * narrows sixty-six tables to the eight someone cares about, and an export
 * that ignored that would hand back the hairball they had just finished
 * escaping.
 */
import { download } from './export.js';
import { selection, toMarkdown, toMermaid, toSchemaJson } from '@mistriwork/engine/shared/schematext.js';
import { say } from './copy/workbench/schemaexport.js';

export { selection, toMarkdown, toMermaid, toSchemaJson };
import { state } from './core.js';
import { shellBody } from './shellHost.js';

/* ---------- the picture ---------- */

/* Properties worth carrying into a standalone file. Everything the diagram's
   appearance depends on and nothing else — a full computed-style dump would
   inline several hundred declarations per node and produce a file too large to
   open. */
const PAINTED = [
  'fill-opacity',
  'stroke-width',
  'stroke-dasharray',
  'font-family',
  'font-size',
  'font-weight',
  'letter-spacing',
  'opacity',
  'text-anchor',
  'text-transform',
];

/* Written even when the value is `none`, which the rest are not.
   `fill: none` on an edge is not the absence of a fill — SVG's initial fill is
   black, so dropping the declaration as a default turned every curve into a
   solid black wedge and the diagram into an inkblot. */
const ALWAYS = ['fill', 'stroke'];

/**
 * A copy of the drawing that stands on its own.
 *
 * The diagram on screen gets its colours from the page's stylesheet, so
 * serialising the live SVG produces a file of black-on-transparent shapes —
 * technically the same drawing and unrecognisable as it. Every painted
 * property is read off the rendered element and written onto the clone, which
 * is the only way to get a file that looks like what was on screen.
 *
 * The pan-and-zoom transform is dropped and the viewBox set to the drawing's
 * own extent, so the export is the whole diagram rather than the part of it
 * that happened to be in the window.
 */
function standaloneSvg(svg, size) {
  const clone = svg.cloneNode(true);
  const from = svg.querySelectorAll('*');
  const to = clone.querySelectorAll('*');

  for (let i = 0; i < from.length; i += 1) {
    const computed = getComputedStyle(from[i]);
    const declarations = [...ALWAYS, ...PAINTED]
      .map((property) => {
        const value = computed.getPropertyValue(property);
        if (!value) return '';
        if (ALWAYS.includes(property)) return `${property}:${value}`;
        return value !== 'none' && value !== 'normal' ? `${property}:${value}` : '';
      })
      .filter(Boolean)
      .join(';');
    if (declarations) to[i].setAttribute('style', declarations);
  }

  const content = clone.querySelector('g');
  if (content) content.removeAttribute('transform');
  clone.setAttribute('viewBox', `0 0 ${Math.ceil(size.width)} ${Math.ceil(size.height)}`);
  clone.setAttribute('width', String(Math.ceil(size.width)));
  clone.setAttribute('height', String(Math.ceil(size.height)));
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.style.removeProperty('width');
  clone.style.removeProperty('height');

  /* An explicit background. SVG has none, so a diagram exported from a light
     page and opened on a dark one is invisible ink. */
  const page = getComputedStyle(shellBody()).backgroundColor;
  const backing = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  backing.setAttribute('width', '100%');
  backing.setAttribute('height', '100%');
  backing.setAttribute('fill', page || '#ffffff');
  clone.insertBefore(backing, clone.firstChild);

  return new XMLSerializer().serializeToString(clone);
}

/**
 * The same drawing, rasterised.
 *
 * At twice the size, because a PNG of a diagram is nearly always looked at on
 * a display with more pixels than CSS says, and one rendered at 1× is the
 * blurry screenshot this feature exists to replace.
 */
async function svgToPng(markup, size, scale = 2) {
  const blob = new Blob([markup], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(say('theDiagramCouldNotBeRendered')));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(size.width * scale);
    canvas.height = Math.ceil(size.height * scale);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ---------- saving ---------- */

const stamp = () => new Date().toISOString().slice(0, 10);

function base(schema, only) {
  const slug = String(schema.label ?? 'schema')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  /* The filename says it is a subset. A file called `erp-schema.md` holding
     eight of sixty-five tables misleads whoever opens it next week, and they
     have no way to tell. */
  const part = only?.size ? `-${only.size}-tables` : '';
  return `${slug || 'schema'}${part}-${stamp()}`;
}

/** @param {string} kind
 * @param {{schema?: import('@mistriwork/engine/shared/schema.js').SchemaSubset, only?: Set<string> | null, svg?: SVGSVGElement, size?: {width: number, height: number}}} options
 */
export async function exportSchema(kind, { schema = state.schema, only, svg, size } = {}) {
  const name = base(schema, only);
  switch (kind) {
    case 'markdown':
      download(`${name}.md`, toMarkdown(schema, only), 'text/markdown');
      return;
    case 'json':
      download(`${name}.json`, toSchemaJson(schema, only), 'application/json');
      return;
    case 'mermaid':
      download(`${name}.mmd`, toMermaid(schema, only), 'text/plain');
      return;
    case 'svg': {
      if (!svg) throw new Error(say('thereIsNoDiagram'));
      download(`${name}.svg`, standaloneSvg(svg, size), 'image/svg+xml');
      return;
    }
    case 'png': {
      if (!svg) throw new Error(say('thereIsNoDiagram'));
      const blob = await svgToPng(standaloneSvg(svg, size), size);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${name}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      return;
    }
    default:
      throw new Error(say('unknownExportFormat', { kind }));
  }
}
