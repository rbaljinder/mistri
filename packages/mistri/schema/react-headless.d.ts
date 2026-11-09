/**
 * `@mistriwork/mistri/react/headless`: an App's typed reads and commands inside a host's own screens, and nothing of
 * mistri's drawn. The host draws every element; mistri is its backend, held to one surface the App declares
 * (`defineSurface`, `surfaces/*.surface.ts`): a read or command the surface does not name is refused (403).
 *
 *   'use client';
 *   import { Provider, useRows, useCommand } from '@mistriwork/mistri/react/headless';
 *
 *   export default function Leads() {
 *     return (
 *       <Provider endpoint="/api/mistri" app="compass" surface="leads">
 *         <LeadList />
 *       </Provider>
 *     );
 *   }
 *
 * The hooks are the page hooks, held to the surface's reads and commands. No stylesheet, no shell, no lazy chunk.
 */
import type * as ReactTypes from 'react';
import type { Auth, Navigator } from './react.js';
import type { PageForm } from './page.js';

export type { Auth, Navigator } from './react.js';

export interface HeadlessProviderProps {
  /** Where the mistri server answers: `/api/mistri` (same origin, recommended) or `https://mistri.example.com/tools`. */
  endpoint: string;
  auth?: Auth;
  /** The App's id. */
  app: string;
  /** The surface's key, as `defineSurface` names it. */
  surface: string;
  /** The front end's own prefix for the addresses `useHref` writes (`/crm`); default '' (its root). */
  basePath?: string;
  /** The host router's address, from an adapter. Default: `window.history`. */
  navigator?: Navigator;
  /** What is drawn until the surface has opened (and on the server). */
  fallback?: ReactTypes.ReactNode;
  children?: ReactTypes.ReactNode;
}

/** Opens the surface, then provides its reads and commands to the hooks below it. Draws nothing of its own. */
export declare function Provider(props: HeadlessProviderProps): ReactTypes.ReactElement;

export { useHref, useRecord, useRows } from './page.js';
export { useAction, useBreakdown, useCommand, useOptions } from './ui.js';
/** One of the form views the surface declares: its draft as it stands, and the form. Every submit is still granted by the server. */
export declare function useForm(view: string): PageForm;
