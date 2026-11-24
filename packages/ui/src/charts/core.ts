/**
 * The charts' rules with no drawing in them: scales and levels, axis labels, paths and arcs, reading and saying a
 * value. This is the entry the kit's dashboard charts import (`@mistriwork/ui/charts/core.js`), so it re-exports
 * only modules that import neither React nor a renderer: a first page that draws a chart must not carry the page
 * charts with it. `chartCore.test.ts` holds that.
 */
export * from './chartFormat.js';
export * from './chartPath.js';
export * from './chartScale.js';
