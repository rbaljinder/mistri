/**
 * A public form's page draws the App's own input components too: the form's payload says where each one it draws is
 * served (`components`, http/formRoutes.ts), and this installs the shell's loader over them, so the kit's input slot
 * (inputRenderers.tsx) finds them as a signed-in form does through the App payload (appComponents.ts). Loaded only by
 * a form that draws one (FormSurface.tsx formArrives), never in the public first paint; the module itself, and the
 * page's side of `@mistriwork/mistri/ui` it needs, come the first time a field is drawn by one, the platform's control standing
 * in until then.
 */
import { installShell, shell } from '@mistriwork/kit/client/shellMode.js';

type ServedInputs = Readonly<Record<string, { href: string; css?: string }>>;

export function installPublicInputs(served: ServedInputs): void {
  const prior = shell().components;
  installShell({
    components: {
      load: (id) =>
        Object.hasOwn(served, id)
          ? import('./componentLoader.js').then(({ loadServedComponent }) => loadServedComponent(id, served[id]))
          : prior.load(id),
      builtIn: (name) => import('../builtInInputs.js').then(({ builtInInput }) => builtInInput(name)),
      useKey: prior.useKey,
    },
  });
}
