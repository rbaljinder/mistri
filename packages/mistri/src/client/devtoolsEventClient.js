/**
 * TanStack's devtools event client, as the production build has it: silent.
 *
 * TanStack Form (the New dialog's form state) talks to the TanStack devtools
 * through this client, which retries a connection every second for a panel
 * no reader of this tool ever opens. vite.config.ts puts this module in its
 * place in `vite build` only; from source the real client is served, for a
 * developer who does run the devtools.
 */
export class EventClient {
  /** @param {{ pluginId: string }} options */
  constructor({ pluginId }) {
    this.pluginId = pluginId;
  }
  getPluginId() {
    return this.pluginId;
  }
  /** @param {string} type @param {unknown} payload */
  createEventPayload(type, payload) {
    return { type: `${this.pluginId}:${type}`, payload, pluginId: this.pluginId };
  }
  emit() {}
  on() {
    return () => {};
  }
  onAll() {
    return () => {};
  }
  onAllPluginEvents() {
    return () => {};
  }
}
