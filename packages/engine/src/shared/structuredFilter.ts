/*
 * The validated filter both execution and the HTTP contract speak: conditions
 * over columns or view paths, with scalar values. Parsers may build looser
 * drafts; this is the shape they validate into.
 */
import type { Op } from './filter.js';

export type StructuredScalar = string | number | boolean | null;
/** A validated condition, shared by execution and transport. Parsing may build
 * broader draft types; execution must validate them before claiming this shape. */
type StructuredCondition<Field extends 'column' | 'path'> = Record<Field, string> &
  (
    | { op: 'isNull' | 'isNotNull'; value?: StructuredScalar }
    | { op: 'in'; value: StructuredScalar[] }
    | { op: Exclude<Op, 'isNull' | 'isNotNull' | 'in'>; value: StructuredScalar }
    /* Another column, by path: a view's alone, and only a comparison. */
    | (Field extends 'path' ? { op: '=' | '!=' | '>' | '>=' | '<' | '<='; other: string; value?: undefined } : never)
  );
export interface StructuredFilter<Field extends 'column' | 'path' = 'column'> {
  groups: Array<Array<StructuredCondition<Field>>>;
}
