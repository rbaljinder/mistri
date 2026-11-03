/**
 * A host's Undo, as the kit's shell reads it (`installShell({ undo })`,
 * packages/kit/src/client/shellMode.js): an App has none, and the shell that
 * has one is the database browser's, in its own repository. A component test
 * that holds the kit to calling it after a write mocks this module
 * (`vi.mock('…/test/hostUndo.js', …)`), and test/shellBridge.ts installs
 * whatever it then answers.
 */
export async function refreshUndo(): Promise<void> {}

export async function undoLast(_expectedId?: number): Promise<void> {}

export function undoToast(_undoId: unknown, _after?: () => void): { label: string; run: () => Promise<void> } | undefined {
  return undefined;
}
