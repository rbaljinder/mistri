/**
 * The components a store opens, handed to it by the shell.
 *
 * A store (the menu, the palette, the composer, the page builder) holds a
 * surface's state and opens it, and the surface's component imports that
 * store to read the state. If the store imported the component back the two
 * would be one file-loop: an edit to either selects the other's suites and
 * neither loads alone. So imports point one way, component to store, and the
 * shell (app.js) says which component draws each surface, once at startup.
 * A surface the shell has not registered is a wiring error, so it throws.
 */

/** @type {Map<string, import('react').ComponentType<any>>} */
const surfaces = new Map();

/**
 * @param {'overflowMenu' | 'palette' | 'composer' | 'pageBuilder'} name
 * @param {import('react').ComponentType<any>} component
 */
export function registerSurface(name, component) {
  surfaces.set(name, component);
}

/** @param {'overflowMenu' | 'palette' | 'composer' | 'pageBuilder'} name */
export function surfaceOf(name) {
  const component = surfaces.get(name);
  if (!component) throw new Error(`No component is registered for the ${name} surface.`);
  return component;
}
