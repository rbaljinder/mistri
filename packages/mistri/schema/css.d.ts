/**
 * A component's stylesheet: `import './PickWalk.css'` in a widget, which
 * mistri bundles beside the component. The import is for its effect, and
 * TypeScript 7 checks that a side-effect import resolves, so an App that
 * typechecks its widgets needs this declaration. `@mistriwork/mistri/app` and
 * `@mistriwork/mistri/ui` reference it, so an App does not write its own.
 */
declare module '*.css';
