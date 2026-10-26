/** Skip unrelated fixture startup for a filtered visual check. Keep the same
 * subject substring matching as the matrix; dynamic page lists must be opened
 * before they can be filtered, so retain them conservatively. */
export function selectVisualApps(apps, filter) {
  if (!filter) return apps;
  return apps.filter((app) => {
    const pages = [...(app.signedOut ?? []), ...app.pages];
    return (!pages.length && app.start) || pages.some(([name]) => filter.split(',').some((part) => `${app.id}/${name}`.includes(part)));
  });
}
