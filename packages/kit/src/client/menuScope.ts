export type MenuMode = 'app' | 'workbench';
export type MenuScope = MenuMode | 'both';

/** Presentation scope, not authorization. Server permissions remain authoritative. */
export function commandsForMode<T extends { scope?: MenuScope }>(items: readonly T[], mode: MenuMode): T[] {
  return items.filter((item) => !item.scope || item.scope === 'both' || item.scope === mode);
}
