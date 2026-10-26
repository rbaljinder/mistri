/**
 * `@mistriwork/mistri/react/next`: the shell under Next's App Router, in a catch-all route
 * (`app/crm/[[...rest]]/page.tsx`). Every entry of @mistriwork/mistri/react is a client module.
 *
 *   'use client';
 *   export default function Crm() {
 *     return (
 *       <Provider endpoint="/api/tw" navigator={useNextNavigator()}>
 *         <App app="compass" basePath="/crm" />
 *       </Provider>
 *     );
 *   }
 */
import type { Navigator } from './react.js';

export declare function useNextNavigator(): Navigator;
