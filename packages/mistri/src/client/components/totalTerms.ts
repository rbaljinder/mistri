/* What a total adds up, shared by the New form's live summary (FormLines.tsx) and a document's totals on paper
   (Document.tsx), so a discount is said taken off in both. */
import type { ComputedNode } from '@mistriwork/engine/shared/computed.js';

/**
 * The parts a total adds up, each with its sign: `subtotal - discount +
 * shipping + tax` → subtotal, −discount, shipping, tax. Undefined where the
 * total is not a sum of named parts (a product, a condition): then the
 * summary is the live names alone.
 */
export function sumTerms(node: ComputedNode, sign = 1, out: Array<{ path: string; sign: number }> = []) {
  if (node.k === 'path') out.push({ path: node.path, sign });
  else if (node.k === 'neg') return sumTerms(node.of, -sign, out);
  else if (node.k === 'op' && (node.op === '+' || node.op === '-')) {
    if (!sumTerms(node.left, sign, out)) return undefined;
    if (!sumTerms(node.right, node.op === '-' ? -sign : sign, out)) return undefined;
  } else return undefined;
  return out;
}
