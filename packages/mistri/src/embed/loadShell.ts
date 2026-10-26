/**
 * The shell, loaded the first time a mistri element is on screen: the one
 * place the entry reaches it, so it stays a chunk of its own (index.tsx says
 * why) and a test can stand in for it.
 */
export type ShellModule = typeof import('./shell.js');

export const loadShell = (): Promise<ShellModule> => import('./shell.js');
