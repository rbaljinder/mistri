/**
 * `layoutPoint`: where a pointer is inside an element, in the layout pixels the page draws and styles in. The density
 * preference zooms the root, so a pointer event's client coordinates and an element's drawn box are both screen pixels
 * while `left`, `translate` and a column's width are layout pixels; a page that hit-tests or drags by the one and
 * places by the other lands off by the zoom. This answers on the one ruler the shell measures with.
 */
import { viewportBox, viewportScale } from '@mistriwork/ui/internal/ruler.js';

export function layoutPoint(event: { clientX: number; clientY: number }, element: Element): { x: number; y: number } {
  const zoom = viewportScale();
  const box = viewportBox(element);
  return { x: event.clientX / zoom - box.left, y: event.clientY / zoom - box.top };
}
