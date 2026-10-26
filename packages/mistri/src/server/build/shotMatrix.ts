/**
 * `mistri shot --matrix`: each route in every built-in look and the App's own (`defineTheme`), light and dark, at a desk and on a phone — what a
 * reader sees whichever look, scheme and device they chose, which no single picture says. The files have
 * predictable names, `<route>-<look>-<light|dark>-<desk|phone>.png` in `--out` (under `matrix/` in the default directory), and `index.html` beside
 * them lays each route out as a grid (a row per look, a column per scheme and size) to review at a glance.
 * scripts/visual-matrix.mjs reviews changed pictures against a baseline and is not shipped; this is for the person
 * or agent who has an App and no baseline.
 */
export const MATRIX_MODES = ['light', 'dark'] as const;
export const MATRIX_SIZES = ['desk', 'phone'] as const;

export const matrixFile = (route: string, look: string, mode: string, size: string) => `${route}-${look}-${mode}-${size}.png`;

const escaped = (text: string) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

interface MatrixRoute {
  name: string;
  path: string;
}

/** The contact page: one grid per route, rows the looks, columns the schemes and sizes, every picture linked at full size. */
export function matrixIndex(app: string, routes: readonly MatrixRoute[], looks: ReadonlyArray<{ id: string; label: string }>): string {
  const columns = MATRIX_MODES.flatMap((mode) => MATRIX_SIZES.map((size) => ({ mode, size })));
  const figure = (route: MatrixRoute, look: string, mode: string, size: string) => {
    const file = escaped(matrixFile(route.name, look, mode, size));
    return `<figure class="${size}"><a href="${file}"><img loading="lazy" src="${file}" alt="${escaped(route.path)} in ${escaped(look)}, ${mode}, ${size}"></a><figcaption>${mode} · ${size}</figcaption></figure>`;
  };
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<title>${escaped(app)} — look matrix</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 16px; background: #f4f4f4; color: #222; }
  h2 { margin: 24px 0 4px; } h3 { margin: 12px 0 4px; font-size: 13px; color: #555; }
  .row { display: grid; grid-template-columns: 5fr 2fr 5fr 2fr; gap: 8px; align-items: start; }
  figure { margin: 0; background: #fff; border: 1px solid #ddd; }
  img { width: 100%; display: block; } figcaption { padding: 4px 6px; font-size: 12px; color: #444; }
</style>
<h1>${escaped(app)} — ${routes.length * looks.length * columns.length} pictures</h1>
${routes
  .map(
    (route) =>
      `<h2>${escaped(route.path)}</h2>${looks
        .map(
          (look) =>
            `<h3>${escaped(look.label)}</h3><div class="row">${columns.map(({ mode, size }) => figure(route, look.id, mode, size)).join('')}</div>`,
        )
        .join('')}`,
  )
  .join('\n')}
`;
}
