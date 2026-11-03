/**
 * A host's page builder, as the kit's shell reads it (`installShell({ editPage })`,
 * packages/kit/src/client/shellMode.js): the one shell that authors pages is the
 * database browser's, in its own repository. A component test that holds the kit
 * to opening it mocks this module, and test/shellBridge.ts installs whatever it
 * then answers.
 */
export async function openBuilder(_page: unknown, _options: Record<string, unknown> = {}): Promise<void> {}
